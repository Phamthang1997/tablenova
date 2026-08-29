//! SLOWLOG: reading it, clearing it, and reading/writing the threshold.

use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};
use crate::redis_db::value::{as_i64, as_text};

// `SLOWLOG GET` entry: [id, unix-ts, duration-µs, [args…], client-addr, client-name].
// The last two fields only exist on Redis 4+, so they are read positionally and optional.
pub(crate) fn parse_slowlog_entry(v: &redis::Value) -> Option<Value> {
    let redis::Value::Array(a) = v else { return None };
    if a.len() < 4 {
        return None;
    }
    let args: Vec<String> = match &a[3] {
        redis::Value::Array(items) => items.iter().map(as_text).collect(),
        other => vec![as_text(other)],
    };
    Some(json!({
        "id": as_i64(&a[0]),
        "timestamp": as_i64(&a[1]),
        "durationUs": as_i64(&a[2]),
        "args": args,
        "clientAddr": a.get(4).map(as_text).unwrap_or_default(),
        "clientName": a.get(5).map(as_text).unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn redis_slowlog_get(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    count: Option<usize>,
) -> Result<Value, String> {
    let mut c = take_conn(&state, &conn_id)?;
    let n = count.unwrap_or(128).clamp(1, 1024);
    let reply: redis::Value = redis::cmd("SLOWLOG")
        .arg("GET")
        .arg(n)
        .query_async(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    let entries: Vec<Value> = match &reply {
        redis::Value::Array(items) => items.iter().filter_map(parse_slowlog_entry).collect(),
        _ => Vec::new(),
    };
    let len: i64 = redis::cmd("SLOWLOG").arg("LEN").query_async(&mut c).await.unwrap_or(0);
    // The two thresholds are server config; a user without CONFIG permission still gets the
    // entries, just no threshold display.
    let threshold: Vec<String> = redis::cmd("CONFIG")
        .arg("GET")
        .arg("slowlog-log-slower-than")
        .query_async(&mut c)
        .await
        .unwrap_or_default();
    let max_len: Vec<String> = redis::cmd("CONFIG")
        .arg("GET")
        .arg("slowlog-max-len")
        .query_async(&mut c)
        .await
        .unwrap_or_default();
    Ok(json!({
        "success": true,
        "entries": entries,
        "len": len,
        "thresholdUs": threshold.get(1).cloned(),
        "maxLen": max_len.get(1).cloned(),
    }))
}

/// `SLOWLOG RESET` discards the server's log — a mutation, so it obeys read-only mode.
#[tauri::command]
pub async fn redis_slowlog_reset(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("SLOWLOG").arg("RESET").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_slowlog_config(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    threshold_us: Option<i64>,
    max_len: Option<i64>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    if let Some(t) = threshold_us {
        let _: String = redis::cmd("CONFIG")
            .arg("SET")
            .arg("slowlog-log-slower-than")
            .arg(t)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(m) = max_len {
        let _: String = redis::cmd("CONFIG")
            .arg("SET")
            .arg("slowlog-max-len")
            .arg(m)
            .query_async(&mut c)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}
