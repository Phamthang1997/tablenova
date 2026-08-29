//! INFO and the CLI console.

use serde_json::{json, Value};

use crate::redis_db::cmds::{is_blocking_cmd, is_read_only_cmd, select_db_arg, token_name, tokenize};
use crate::redis_db::conn::take_conn;
use crate::redis_db::session::select_db_inner;
use crate::redis_db::value::{parse_info, redis_value_to_json};

#[tauri::command]
pub async fn redis_info(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let mut c = take_conn(&state, &conn_id)?;
    let text: String = redis::cmd("INFO").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "info": parse_info(&text), "raw": text }))
}

#[tauri::command]
pub async fn redis_execute_cmd(state: tauri::State<'_, crate::AppState>, conn_id: String, command: String) -> Result<Value, String> {
    let tokens = tokenize(&command)?;
    if tokens.is_empty() {
        return Err("Lệnh rỗng".to_string());
    }
    let name = token_name(&tokens[0]);

    // Would put the shared multiplexed connection into push/blocking mode and break every
    // other feature using it — refused before the connection is touched at all.
    if is_blocking_cmd(&tokens) {
        return Err(format!(
            "Lệnh '{}' cần kết nối riêng — dùng tab Pub/Sub hoặc Profiler",
            name
        ));
    }
    // `SELECT n` is routed through the same path as the database picker: sent blind it would
    // switch this connection's database while every other tab open on it still showed the old
    // index — and with one `conn_id` per db index (§2.1) there is no longer any such thing as
    // "this connection's database changed". It resolves to the connection FOR that index instead,
    // and `switchDb` tells the frontend to move the workspace there. Nothing mutates behind the
    // back of a tab that is still open on the old index.
    if let Some(idx) = select_db_arg(&tokens) {
        let res = select_db_inner(&state, &conn_id, idx).await?;
        return Ok(json!({
            "success": true,
            "result": "OK",
            "selectedDb": idx,
            "switchDb": { "dbIndex": idx, "connId": res.get("connId").cloned().unwrap_or(Value::Null) },
        }));
    }
    // The read-only gate lives here, not in the UI: this command carries arbitrary text, which
    // is exactly how `FLUSHALL` used to get through while every button was disabled.
    if state.connections.is_read_only(&conn_id) && !is_read_only_cmd(&tokens) {
        return Err(format!("Lệnh '{}' bị chặn ở chế độ chỉ đọc", name));
    }

    let mut c = take_conn(&state, &conn_id)?;
    let cmd_name = String::from_utf8_lossy(&tokens[0]).to_string();
    let mut cmd = redis::cmd(&cmd_name);
    for a in &tokens[1..] {
        // Bytes, not str: an argument may be binary (`"\xff\x00"`), and a lossy conversion
        // here would write U+FFFD into the database.
        cmd.arg(&a[..]);
    }
    match cmd.query_async::<redis::Value>(&mut c).await {
        Ok(val) => Ok(json!({ "success": true, "result": redis_value_to_json(&val) })),
        Err(e) => Ok(json!({ "success": false, "message": e.to_string() })),
    }
}
