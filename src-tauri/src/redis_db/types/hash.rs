//! Hash: writing and deleting one field.

use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};

// ---- Element-level edits ----
// Editing one element must NOT go through redis_set_key: that command has REPLACE semantics
// (DEL then rebuild), which drops the TTL and rewrites every element of the collection — a
// hash with 100k fields would be resent in full to change one value. Each command below maps
// to the single Redis command for that edit, so the rest of the key is untouched.
//
// "Renaming" the identity part of an element (hash field, set/zset member) has no atomic Redis
// command: write the new one first, then remove the old, so a failure leaves a duplicate
// rather than losing the value.

#[tauri::command]
pub async fn redis_hash_set(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    field: String,
    value: String,
    old_field: Option<String>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: i64 = redis::cmd("HSET").arg(&key).arg(&field).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_field.filter(|o| *o != field) {
        let _: i64 = redis::cmd("HDEL").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_hash_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, field: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("HDEL").arg(&key).arg(&field)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}
