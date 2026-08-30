//! Keyspace analysis: sampling keys, grouping them by namespace, estimating memory.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::redis_db::conn::take_conn;
use crate::redis_db::keys::manage::BULK_BATCH;
use crate::redis_db::live::register_cancel;
use crate::redis_db::value::{as_i64, as_text};

// ---- Database analysis ----

// Same ceiling RedisInsight uses. Past this the report is extrapolated from the sample and
// says so — a number presented as exact would be a lie on a database with millions of keys.
pub(crate) const ANALYZE_SAMPLE_MAX: usize = 10_000;

/// First namespace segment of a key (`user:42:name` -> `user`). Depth 1 is enough for a
/// report; the sidebar's tree does the deeper grouping.
pub(crate) fn namespace_of(key: &str) -> String {
    match key.split_once(':') {
        Some((head, _)) if !head.is_empty() => head.to_string(),
        _ => "(no namespace)".to_string(),
    }
}

#[tauri::command]
pub async fn redis_analyze_db(
    conn_id: String,
    sample: Option<usize>,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let cancel = register_cancel(&state, &query_id)?;
    let limit = sample.unwrap_or(ANALYZE_SAMPLE_MAX).clamp(100, 200_000);
    let mut c = take_conn(&state, &conn_id)?;
    let dbsize: i64 = redis::cmd("DBSIZE").query_async(&mut c).await.unwrap_or(0);

    let mut by_type: HashMap<String, (i64, i64)> = HashMap::new();
    let mut by_ns: HashMap<String, (i64, i64)> = HashMap::new();
    // no expiry / <1h / <1d / <7d / >=7d
    let mut ttl_buckets = [0i64; 5];
    let mut top: Vec<(String, i64, String)> = Vec::new();
    let mut sampled = 0usize;
    let mut cursor: u64 = 0;

    let outcome: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) || sampled >= limit {
            break Ok(());
        }
        let scan: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(BULK_BATCH)
            .query_async(&mut c)
            .await;
        let (next, keys) = match scan {
            Ok(v) => v,
            Err(e) => break Err(e.to_string()),
        };
        if !keys.is_empty() {
            // One pipeline per batch: three round trips per key would make a 10k sample
            // 30k round trips.
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k);
                pipe.cmd("TTL").arg(k);
                pipe.cmd("MEMORY").arg("USAGE").arg(k);
            }
            let raw: Vec<redis::Value> = match pipe.query_async(&mut c).await {
                Ok(v) => v,
                Err(e) => break Err(e.to_string()),
            };
            for (i, k) in keys.iter().enumerate() {
                if sampled >= limit {
                    break;
                }
                let ktype = raw.get(i * 3).map(as_text).unwrap_or_default();
                let ttl = raw.get(i * 3 + 1).map(as_i64).unwrap_or(-1);
                let bytes = raw.get(i * 3 + 2).map(as_i64).unwrap_or(0);
                sampled += 1;

                let e = by_type.entry(ktype.clone()).or_insert((0, 0));
                e.0 += 1;
                e.1 += bytes;
                let n = by_ns.entry(namespace_of(k)).or_insert((0, 0));
                n.0 += 1;
                n.1 += bytes;
                let bucket = match ttl {
                    t if t < 0 => 0,
                    t if t < 3600 => 1,
                    t if t < 86_400 => 2,
                    t if t < 604_800 => 3,
                    _ => 4,
                };
                ttl_buckets[bucket] += 1;
                top.push((k.clone(), bytes, ktype));
            }
            let _ = channel.send(json!({ "type": "progress", "sampled": sampled, "total": dbsize }));
        }
        cursor = next;
        if cursor == 0 {
            break Ok(());
        }
    };

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }
    if let Err(msg) = outcome {
        let _ = channel.send(json!({ "type": "error", "message": msg }));
        return Ok(json!({ "success": false, "message": msg }));
    }

    top.sort_by(|a, b| b.1.cmp(&a.1));
    top.truncate(20);
    let sampled_bytes: i64 = by_type.values().map(|(_, b)| *b).sum();
    // Extrapolation, only meaningful when the scan stopped early.
    let estimated_bytes = if sampled > 0 && dbsize > sampled as i64 {
        Some(sampled_bytes as f64 * (dbsize as f64 / sampled as f64))
    } else {
        None
    };
    let mut warnings: Vec<String> = Vec::new();
    if dbsize > sampled as i64 {
        warnings.push(format!(
            "Chỉ phân tích {} key lấy mẫu — số liệu là ước lượng.",
            sampled
        ));
    }

    let to_rows = |m: HashMap<String, (i64, i64)>| {
        let mut rows: Vec<Value> = m
            .into_iter()
            .map(|(name, (count, bytes))| json!({ "name": name, "count": count, "bytes": bytes }))
            .collect();
        rows.sort_by(|a, b| {
            b["bytes"].as_i64().unwrap_or(0).cmp(&a["bytes"].as_i64().unwrap_or(0))
        });
        rows
    };

    let result = json!({
        "success": true,
        "dbsize": dbsize,
        "sampled": sampled,
        "sampledBytes": sampled_bytes,
        "estimatedBytes": estimated_bytes,
        "byType": to_rows(by_type),
        "byNamespace": to_rows(by_ns).into_iter().take(30).collect::<Vec<Value>>(),
        "ttlBuckets": {
            "noExpiry": ttl_buckets[0],
            "under1h": ttl_buckets[1],
            "under1d": ttl_buckets[2],
            "under7d": ttl_buckets[3],
            "over7d": ttl_buckets[4],
        },
        "topKeys": top.into_iter().map(|(k, b, t)| json!({ "key": k, "bytes": b, "type": t })).collect::<Vec<Value>>(),
        "warnings": warnings,
        "cancelled": cancel.load(Ordering::Relaxed),
    });
    let _ = channel.send(json!({ "type": "done" }));
    Ok(result)
}
