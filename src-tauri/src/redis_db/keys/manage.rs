//! Key operations that need no knowledge of the type: delete, TTL, rename, delete by pattern, FLUSHDB.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::redis_db::conn::{ensure_writable, take_conn};

#[tauri::command]
pub async fn redis_delete_keys(conn_id: String, keys: Vec<String>) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    if keys.is_empty() {
        return Ok(json!({ "success": true, "deleted": 0 }));
    }
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let deleted: i64 = redis::cmd("UNLINK").arg(&keys).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "deleted": deleted }))
}).await
}

#[tauri::command]
pub async fn redis_set_ttl(conn_id: String, key: String, ttl: i64) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    if ttl < 0 {
        let _: i64 = redis::cmd("PERSIST").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    } else {
        let _: i64 = redis::cmd("EXPIRE").arg(&key).arg(ttl).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}).await
}

#[tauri::command]
pub async fn redis_rename_key(conn_id: String, old_key: String, new_key: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("RENAME").arg(&old_key).arg(&new_key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}).await
}

#[tauri::command]
pub async fn redis_flush_db(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("FLUSHDB").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}).await
}

// ---- Bulk delete ----

pub(crate) const BULK_BATCH: usize = 500;

/// Deletes every key matching a pattern, in batches, with progress and cancel.
///
/// Kept separate from `redis_delete_keys` (which takes an explicit list): the point here is
/// that the caller does *not* know the keys, so the count can only be reported as it goes.
/// `UNLINK` rather than `DEL` so freeing memory happens off the main thread.
#[tauri::command]
pub async fn redis_delete_by_pattern(
    conn_id: String,
    pattern: String,
    type_filter: Option<String>,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    ensure_writable(&state, &conn_id)?;
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("Chưa có pattern để xoá".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel.clone());
    }
    let type_filter = type_filter.filter(|t| !t.is_empty());
    let mut c = take_conn(&state, &conn_id)?;
    let mut cursor: u64 = 0;
    let mut scanned = 0usize;
    let mut deleted = 0i64;

    let outcome: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Ok(());
        }
        let scan: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(BULK_BATCH)
            .query_async(&mut c)
            .await;
        let (next, keys) = match scan {
            Ok(v) => v,
            Err(e) => break Err(e.to_string()),
        };
        scanned += keys.len();

        // Type filtering is client-side for the same reason as the key browser: `SCAN TYPE`
        // is Redis 6.0+ and KeyDB/Dragonfly answer it with a syntax error.
        let keys = match (&type_filter, keys.is_empty()) {
            (_, true) => keys,
            (None, _) => keys,
            (Some(want), _) => {
                let mut pipe = redis::pipe();
                for k in &keys {
                    pipe.cmd("TYPE").arg(k);
                }
                let types: Vec<String> = match pipe.query_async(&mut c).await {
                    Ok(v) => v,
                    Err(e) => break Err(e.to_string()),
                };
                keys.into_iter()
                    .zip(types)
                    .filter(|(_, t)| t == want)
                    .map(|(k, _)| k)
                    .collect()
            }
        };

        if !keys.is_empty() {
            match redis::cmd("UNLINK").arg(&keys).query_async::<i64>(&mut c).await {
                Ok(n) => deleted += n,
                Err(e) => break Err(e.to_string()),
            }
        }
        let _ = channel.send(json!({ "type": "progress", "scanned": scanned, "deleted": deleted }));
        cursor = next;
        if cursor == 0 {
            break Ok(());
        }
    };

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }
    match outcome {
        Ok(()) => {
            let _ = channel.send(json!({
                "type": "done",
                "scanned": scanned,
                "deleted": deleted,
                "cancelled": cancel.load(Ordering::Relaxed),
            }));
            Ok(json!({ "success": true, "scanned": scanned, "deleted": deleted }))
        }
        Err(msg) => {
            let _ = channel.send(json!({ "type": "error", "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}).await
}
