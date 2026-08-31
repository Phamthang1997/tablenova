//! Stream: adding/deleting entries, and the whole consumer-group side.

use serde_json::{Value, json};

use crate::redis_db::conn::{ensure_writable, take_conn};
use crate::redis_db::value::{as_i64, as_text, pairs_to_json};

// Stream entries are immutable in Redis — there is no "edit entry", only XADD/XDEL.
// An empty `id` means "*" (let the server assign the next id).
#[tauri::command]
pub async fn redis_stream_add(
    conn_id: String,
    key: String,
    id: String,
    fields: Vec<Value>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        if fields.is_empty() {
            return Err("Stream cần ít nhất một field".to_string());
        }
        ensure_writable(&state, &conn_id)?;
        let mut c = take_conn(&state, &conn_id)?;
        let id = id.trim();
        let mut cmd = redis::cmd("XADD");
        cmd.arg(&key).arg(if id.is_empty() { "*" } else { id });
        for f in &fields {
            cmd.arg(f.get("field").and_then(|v| v.as_str()).unwrap_or(""))
                .arg(f.get("value").and_then(|v| v.as_str()).unwrap_or(""));
        }
        let new_id: String = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
        Ok(json!({ "success": true, "id": new_id }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_del(conn_id: String, key: String, id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_writable(&state, &conn_id)?;
        let mut c = take_conn(&state, &conn_id)?;
        let removed: i64 = redis::cmd("XDEL")
            .arg(&key)
            .arg(&id)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "success": true, "removed": removed }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_groups(conn_id: String, key: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let mut c = take_conn(&state, &conn_id)?;
        let reply: redis::Value = redis::cmd("XINFO")
            .arg("GROUPS")
            .arg(&key)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        let groups: Vec<Value> = match &reply {
            redis::Value::Array(items) => items.iter().map(pairs_to_json).collect(),
            _ => Vec::new(),
        };
        Ok(json!({ "success": true, "groups": groups }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_consumers(
    conn_id: String,
    key: String,
    group: String,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let mut c = take_conn(&state, &conn_id)?;
        let reply: redis::Value = redis::cmd("XINFO")
            .arg("CONSUMERS")
            .arg(&key)
            .arg(&group)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        let consumers: Vec<Value> = match &reply {
            redis::Value::Array(items) => items.iter().map(pairs_to_json).collect(),
            _ => Vec::new(),
        };
        Ok(json!({ "success": true, "consumers": consumers }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_pending(
    conn_id: String,
    key: String,
    group: String,
    count: Option<usize>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let mut c = take_conn(&state, &conn_id)?;
        // Extended form: [[id, consumer, idle-ms, delivery-count], …]
        let reply: redis::Value = redis::cmd("XPENDING")
            .arg(&key)
            .arg(&group)
            .arg("-")
            .arg("+")
            .arg(count.unwrap_or(200).clamp(1, 5000))
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        let pending: Vec<Value> = match &reply {
            redis::Value::Array(items) => items
                .iter()
                .filter_map(|it| {
                    let redis::Value::Array(a) = it else {
                        return None;
                    };
                    if a.len() < 4 {
                        return None;
                    }
                    Some(json!({
                        "id": as_text(&a[0]),
                        "consumer": as_text(&a[1]),
                        "idleMs": as_i64(&a[2]),
                        "deliveryCount": as_i64(&a[3]),
                    }))
                })
                .collect(),
            _ => Vec::new(),
        };
        Ok(json!({ "success": true, "pending": pending }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_ack(
    conn_id: String,
    key: String,
    group: String,
    ids: Vec<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_writable(&state, &conn_id)?;
        if ids.is_empty() {
            return Ok(json!({ "success": true, "acked": 0 }));
        }
        let mut c = take_conn(&state, &conn_id)?;
        let acked: i64 = redis::cmd("XACK")
            .arg(&key)
            .arg(&group)
            .arg(&ids)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "success": true, "acked": acked }))
    })
    .await
}

#[tauri::command]
pub async fn redis_stream_claim(
    conn_id: String,
    key: String,
    group: String,
    consumer: String,
    min_idle_ms: i64,
    ids: Vec<String>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        ensure_writable(&state, &conn_id)?;
        if ids.is_empty() {
            return Ok(json!({ "success": true, "claimed": 0 }));
        }
        let mut c = take_conn(&state, &conn_id)?;
        let reply: redis::Value = redis::cmd("XCLAIM")
            .arg(&key)
            .arg(&group)
            .arg(&consumer)
            .arg(min_idle_ms)
            .arg(&ids)
            .arg("JUSTID")
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
        let claimed = match &reply {
            redis::Value::Array(items) => items.len(),
            _ => 0,
        };
        Ok(json!({ "success": true, "claimed": claimed }))
    })
    .await
}
