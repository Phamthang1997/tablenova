//! List: writing by index, pushing to the head/tail, and removing one element.

use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};

#[tauri::command]
pub async fn redis_list_set(conn_id: String, key: String, index: i64, value: String) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("LSET").arg(&key).arg(index).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_list_push(conn_id: String, key: String, value: String, at_head: bool) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let len: i64 = redis::cmd(if at_head { "LPUSH" } else { "RPUSH" }).arg(&key).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "length": len }))
}

// Redis has no "delete by index": overwrite the slot with a sentinel nobody else can hold,
// then LREM exactly that one occurrence. The timestamp keeps the sentinel unique so a
// concurrent delete on the same list cannot remove the wrong element.
#[tauri::command]
pub async fn redis_list_del(conn_id: String, key: String, index: i64) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sentinel = format!("__tablenova_deleted__{}__{}", index, nanos);
    let _: String = redis::cmd("LSET").arg(&key).arg(index).arg(&sentinel)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    let removed: i64 = redis::cmd("LREM").arg(&key).arg(1).arg(&sentinel)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}
