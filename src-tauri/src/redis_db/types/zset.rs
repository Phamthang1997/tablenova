//! Sorted set: thêm và xoá một member.

use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};

#[tauri::command]
pub async fn redis_zset_add(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    member: String,
    score: f64,
    old_member: Option<String>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    // ZADD upserts, so changing only the score of an existing member needs nothing else.
    let _: i64 = redis::cmd("ZADD").arg(&key).arg(score).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_member.filter(|o| *o != member) {
        let _: i64 = redis::cmd("ZREM").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_zset_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, member: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("ZREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}
