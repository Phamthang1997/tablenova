//! Duyệt keyspace: SCAN một trang, và SCAN chảy về theo lô có thể huỷ.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::redis_db::conn::take_conn;

// Quét keys bằng SCAN (non-blocking) + TYPE + TTL cho từng key qua pipeline.
#[tauri::command]
pub async fn redis_scan_keys(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    pattern: String,
    cursor: u64,
    count: usize,
    type_filter: Option<String>,
) -> Result<Value, String> {
    // Không truyền TYPE cho SCAN: tham số này chỉ có ở Redis 6.0+ và nhiều bản tương thích
    // (KeyDB/Dragonfly) không hỗ trợ -> "syntax error". Lọc theo kiểu được xử lý phía client.
    let _ = &type_filter;
    let mut c = take_conn(&state, &conn_id)?;
    let mut cmd = redis::cmd("SCAN");
    cmd.arg(cursor).arg("MATCH").arg(&pattern).arg("COUNT").arg(count);
    let (next, keys): (u64, Vec<String>) = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;

    let mut items = Vec::with_capacity(keys.len());
    if !keys.is_empty() {
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k);
            pipe.cmd("TTL").arg(k);
        }
        let raw: Vec<redis::Value> = pipe.query_async(&mut c).await.map_err(|e| e.to_string())?;
        for (i, k) in keys.iter().enumerate() {
            let ktype = raw.get(i * 2).and_then(|v| redis::from_redis_value::<String>(v.clone()).ok()).unwrap_or_default();
            let ttl = raw.get(i * 2 + 1).and_then(|v| redis::from_redis_value::<i64>(v.clone()).ok()).unwrap_or(-1);
            items.push(json!({ "key": k, "type": ktype, "ttl": ttl }));
        }
    }

    Ok(json!({ "success": true, "cursor": next, "keys": items }))
}

// Stream toàn bộ key qua Channel: vừa SCAN vừa đẩy từng batch (kèm type/ttl) cho tới khi cursor về 0.
// Dừng giữa chừng bằng cancel_query(query_id) (tái dùng cancel_flags của AppState).
#[tauri::command]
pub async fn redis_scan_stream(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    pattern: String,
    count: usize,
    query_id: String,
    channel: Channel<Value>,
    start_cursor: Option<u64>,
) -> Result<Value, String> {
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
}
