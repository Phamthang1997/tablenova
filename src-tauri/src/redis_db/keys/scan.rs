//! Walking the keyspace: SCAN one page, and a cancellable SCAN streamed in batches.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::redis_db::conn::take_conn;

// Scan keys with SCAN (non-blocking) + TYPE + TTL per key through a pipeline.
#[tauri::command]
pub async fn redis_scan_keys(
    conn_id: String,
    pattern: String,
    cursor: u64,
    count: usize,
    type_filter: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        // TYPE is not passed to SCAN: that argument only exists in Redis 6.0+ and many compatible servers
        // (KeyDB/Dragonfly) do not support it -> "syntax error". Filtering by type is done client-side.
        let _ = &type_filter;
        let mut c = take_conn(&state, &conn_id)?;
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(count);
        let (next, keys): (u64, Vec<String>) =
            cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;

        let mut items = Vec::with_capacity(keys.len());
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k);
                pipe.cmd("TTL").arg(k);
            }
            let raw: Vec<redis::Value> =
                pipe.query_async(&mut c).await.map_err(|e| e.to_string())?;
            for (i, k) in keys.iter().enumerate() {
                let ktype = raw
                    .get(i * 2)
                    .and_then(|v| redis::from_redis_value::<String>(v.clone()).ok())
                    .unwrap_or_default();
                let ttl = raw
                    .get(i * 2 + 1)
                    .and_then(|v| redis::from_redis_value::<i64>(v.clone()).ok())
                    .unwrap_or(-1);
                items.push(json!({ "key": k, "type": ktype, "ttl": ttl }));
            }
        }

        Ok(json!({ "success": true, "cursor": next, "keys": items }))
    })
    .await
}

// Stream every key over a Channel: SCAN and push each batch (with type/ttl) until the cursor returns to 0.
// Stop it midway with cancel_query(query_id) (reusing AppState's cancel_flags).
#[tauri::command]
pub async fn redis_scan_stream(
    conn_id: String,
    pattern: String,
    count: usize,
    query_id: String,
    channel: Channel<Value>,
    start_cursor: Option<u64>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel.clone());
    }

    let mut c = take_conn(&state, &conn_id)?;
    // Resumable: the browser stops the scan when it hits its key cap and continues from the
    // cursor it was given, instead of restarting from the beginning.
    let mut cursor: u64 = start_cursor.unwrap_or(0);
    let mut total = 0usize;
    let outcome: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Ok(());
        }
        let scan: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(count)
            .query_async(&mut c).await;
        let (next, keys) = match scan {
            Ok(v) => v,
            Err(e) => break Err(e.to_string()),
        };
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k);
                pipe.cmd("TTL").arg(k);
            }
            let raw: Vec<redis::Value> = match pipe.query_async(&mut c).await {
                Ok(v) => v,
                Err(e) => break Err(e.to_string()),
            };
            let mut items = Vec::with_capacity(keys.len());
            for (i, k) in keys.iter().enumerate() {
                let ktype = raw.get(i * 2).and_then(|v| redis::from_redis_value::<String>(v.clone()).ok()).unwrap_or_default();
                let ttl = raw.get(i * 2 + 1).and_then(|v| redis::from_redis_value::<i64>(v.clone()).ok()).unwrap_or(-1);
                items.push(json!({ "key": k, "type": ktype, "ttl": ttl }));
            }
            total += items.len();
            // The cursor to continue from travels with the batch: the UI needs it to resume
            // after stopping at its cap.
            let _ = channel.send(json!({ "type": "keys", "keys": items, "cursor": next }));
        }
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
            let _ = channel.send(json!({ "type": "done", "total": total, "cancelled": cancel.load(Ordering::Relaxed) }));
            Ok(json!({ "success": true }))
        }
        Err(msg) => {
            let _ = channel.send(json!({ "type": "error", "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}).await
}
