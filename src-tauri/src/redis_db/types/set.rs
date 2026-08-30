//! Set: adding and removing one member.

use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};

#[tauri::command]
pub async fn redis_set_member(
    conn_id: String,
    key: String,
    member: String,
    old_member: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let added: i64 = redis::cmd("SADD").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_member.filter(|o| *o != member) {
        let _: i64 = redis::cmd("SREM").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true, "added": added }))
}).await
}

#[tauri::command]
pub async fn redis_set_del_member(conn_id: String, key: String, member: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("SREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}).await
}
