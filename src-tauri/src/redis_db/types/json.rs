//! ReJSON: read / write / delete by JSONPath. Requires the `ReJSON` module on the server.

use serde_json::{Value, json};

use crate::redis_db::caps::ensure_json_module;
use crate::redis_db::conn::{ensure_writable, take_conn};

#[tauri::command]
pub async fn redis_json_get(
    conn_id: String,
    key: String,
    path: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_json_module(&state, &conn_id)?;
        let mut c = take_conn(&state, &conn_id)?;
        let path = path
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| "$".to_string());
        let text: Option<String> = redis::cmd("JSON.GET")
            .arg(&key)
            .arg("INDENT")
            .arg("  ")
            .arg("NEWLINE")
            .arg("\n")
            .arg(&path)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "success": true, "path": path, "json": text }))
    })
    .await
}

#[tauri::command]
pub async fn redis_json_set(
    conn_id: String,
    key: String,
    path: String,
    value: String,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_writable(&state, &conn_id)?;
        ensure_json_module(&state, &conn_id)?;
        let mut c = take_conn(&state, &conn_id)?;
        let path = if path.trim().is_empty() {
            "$".to_string()
        } else {
            path
        };
        let _: String = redis::cmd("JSON.SET")
            .arg(&key)
            .arg(&path)
            .arg(&value)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "success": true }))
    })
    .await
}

#[tauri::command]
pub async fn redis_json_del(conn_id: String, key: String, path: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_writable(&state, &conn_id)?;
        ensure_json_module(&state, &conn_id)?;
        let mut c = take_conn(&state, &conn_id)?;
        let removed: i64 = redis::cmd("JSON.DEL")
            .arg(&key)
            .arg(&path)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "success": true, "removed": removed }))
    })
    .await
}
