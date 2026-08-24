//! Hai luồng chảy liên tục: Pub/Sub và MONITOR. Cả hai đều cần connection RIÊNG.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::redis_db::conn::{dedicated_client, ensure_writable, take_conn};
use crate::redis_db::value::{is_binary, lossy_text};

pub(crate) fn register_cancel(state: &crate::AppState, query_id: &str) -> Result<Arc<AtomicBool>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    flags.insert(query_id.to_string(), cancel.clone());
    Ok(cancel)
}

pub(crate) fn drop_cancel(app: &tauri::AppHandle, query_id: &str) {
    if let Some(st) = app.try_state::<crate::AppState>() {
        if let Ok(mut flags) = st.cancel_flags.lock() {
            flags.remove(query_id);
        }
    }
}

#[tauri::command]
pub async fn redis_pubsub_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    if channels.is_empty() && patterns.is_empty() {
        return Err("Chưa chọn channel để nghe".to_string());
    }
    let client = dedicated_client(&state, &conn_id).await?;
    let mut ps = client
        .get_async_pubsub()
        .await
        .map_err(|e| format!("Không mở được kết nối riêng cho Redis: {}", e))?;
    for ch in &channels {
        ps.subscribe(ch).await.map_err(|e| e.to_string())?;
    }
    for p in &patterns {
        ps.psubscribe(p).await.map_err(|e| e.to_string())?;
    }
    let cancel = register_cancel(&state, &query_id)?;

    // The command returns as soon as the subscription is live; messages arrive on the Channel
    // until the UI cancels. `into_on_message` (not `on_message`) so the stream owns the
    // connection and can be moved into the task.
    tauri::async_runtime::spawn(async move {
        let mut stream = ps.into_on_message();
        let mut total = 0usize;
        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            // A timeout rather than a plain await: without it a silent channel would never
            // let the cancel flag be observed and the task would leak.
            match tokio::time::timeout(Duration::from_millis(400), stream.next()).await {
                Ok(Some(msg)) => {
                    let payload = msg.get_payload_bytes().to_vec();
                    total += 1;
                    let _ = channel.send(json!({
                        "type": "message",
                        "channel": msg.get_channel_name(),
                        "pattern": msg.get_pattern::<String>().ok(),
                        "payload": lossy_text(&payload),
                        "binary": is_binary(&payload),
                    }));
                }
                Ok(None) => break,
                Err(_) => continue,
            }
        }
        let _ = channel.send(json!({ "type": "stopped", "total": total }));
        drop_cancel(&app, &query_id);
    });

    Ok(json!({ "success": true }))
}

/// PUBLISH is a side effect other clients observe, so it counts as a write.
#[tauri::command]
pub async fn redis_publish(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    channel_name: String,
    payload: String,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let receivers: i64 = redis::cmd("PUBLISH")
        .arg(&channel_name)
        .arg(&payload)
        .query_async(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "receivers": receivers }))
}

// MONITOR makes the server echo every command it executes — on a busy instance that is both
// a lot of traffic and a real slowdown. The session therefore stops itself; it never runs
// until the user remembers to switch it off.
pub(crate) const MONITOR_MAX_LINES: usize = 50_000;

pub(crate) const MONITOR_MAX_SECS: u64 = 60;

#[tauri::command]
pub async fn redis_monitor_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    let client = dedicated_client(&state, &conn_id).await?;
    let monitor = client
        .get_async_monitor()
        .await
        .map_err(|e| format!("Không mở được kết nối riêng cho Redis: {}", e))?;
    let cancel = register_cancel(&state, &query_id)?;

    tauri::async_runtime::spawn(async move {
        let mut stream = monitor.into_on_message::<String>();
        let deadline = Instant::now() + Duration::from_secs(MONITOR_MAX_SECS);
        let mut total = 0usize;
        let reason = loop {
            if cancel.load(Ordering::Relaxed) {
                break "cancelled";
            }
            if total >= MONITOR_MAX_LINES {
                break "limit";
            }
            if Instant::now() >= deadline {
                break "timeout";
            }
            match tokio::time::timeout(Duration::from_millis(400), stream.next()).await {
                Ok(Some(line)) => {
                    total += 1;
                    let _ = channel.send(json!({ "type": "line", "line": line }));
                }
                Ok(None) => break "closed",
                Err(_) => continue,
            }
        };
        let _ = channel.send(json!({
            "type": "stopped",
            "reason": reason,
            "total": total,
            "maxLines": MONITOR_MAX_LINES,
            "maxSecs": MONITOR_MAX_SECS,
        }));
        drop_cancel(&app, &query_id);
    });

    Ok(json!({ "success": true, "maxLines": MONITOR_MAX_LINES, "maxSecs": MONITOR_MAX_SECS }))
}
