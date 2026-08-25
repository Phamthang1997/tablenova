//! Exporting / importing a keyspace by prefix, using DUMP/RESTORE.
//!
//! It uses Redis' own payload rather than a human-readable serializer: both existing read paths
//! lose data (`lossy_text`, strings truncated at `STRING_PREVIEW_MAX`), and silently losing data
//! is the worst possible failure for a backup feature. The cost: the payload carries an RDB version
//! footer, so it only restores into a Redis of the same version OR newer.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};
use crate::redis_db::value::{as_i64, as_text};

// ---- Exporting / importing a keyspace by prefix (DUMP / RESTORE) ----
//
// Why DUMP/RESTORE and not a readable JSON serializer: both existing read paths are
// UNFAITHFUL. `fetch_elements` puts every element through `lossy_text` (non-UTF-8 bytes become
// U+FFFD — see the `binary` flag the UI uses to block editing), and `redis_get_key` truncates strings at
// `STRING_PREVIEW_MAX`. An export built on those two would corrupt data with no warning —
// exactly the worst kind of failure for a backup feature. A DUMP payload is raw bytes produced by Redis
// itself: exact to the byte, and it covers the types the app has no viewer for (ReJSON, TimeSeries, vector set).
//
// The trade-off has to be stated to the user: a DUMP payload carries an RDB version footer, so importing into an
// **older** Redis fails with "DUMP payload version or checksum are wrong". The same version or newer
// works. The frontend dialog says so explicitly.

/// The cap on keys per round. One DUMP round returns every value through a single IPC message, so without
/// a cap a batch miscomputed by the frontend becomes a few hundred MB in one call.
pub(crate) const TRANSFER_BATCH_MAX: usize = 5_000;

/// DUMP + PTTL + TYPE for a batch of keys. The payload goes out as base64 (not as the number array `redis_get_key`
/// uses for `bytes`): same content, ~3× smaller over IPC, and it can be written straight into the NDJSON file.
#[tauri::command]
pub async fn redis_dump_keys(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    if keys.is_empty() {
        return Ok(json!({ "success": true, "entries": [], "missing": [] }));
    }
    if keys.len() > TRANSFER_BATCH_MAX {
        return Err(format!("Mỗi lượt chỉ nhận tối đa {} key", TRANSFER_BATCH_MAX));
    }
    let mut c = take_conn(&state, &conn_id)?;

    // Reads can be pipelined: DUMP of a key that no longer exists returns Nil rather than an error, so one key
    // can never break the whole batch. The write path (`redis_restore_keys`) does not have that property.
    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("DUMP").arg(k);
        pipe.cmd("PTTL").arg(k);
        pipe.cmd("TYPE").arg(k);
    }
    let raw: Vec<redis::Value> = pipe.query_async(&mut c).await.map_err(|e| e.to_string())?;

    let mut entries = Vec::with_capacity(keys.len());
    let mut missing: Vec<String> = Vec::new();
    for (i, k) in keys.iter().enumerate() {
        // A key that expired or was deleted between the SCAN and the DUMP -> Nil. That is not an error, but it
        // must not be silent either: it goes into `missing` so the export states exactly how many keys it holds.
        let payload = match raw.get(i * 3) {
            Some(redis::Value::BulkString(b)) => Some(b.clone()),
            _ => None,
        };
        let Some(bytes) = payload else {
            missing.push(k.clone());
            continue;
        };
        entries.push(json!({
            "key": k,
            "type": raw.get(i * 3 + 2).map(as_text).unwrap_or_default(),
            // PTTL: -1 = no TTL, -2 = no such key. Keep the milliseconds, do not round down to
            // seconds the way `TTL` does: a key with 500ms left stored as 0 seconds has lost its TTL.
            "ttlMs": raw.get(i * 3 + 1).map(as_i64).unwrap_or(-1),
            "payload": B64.encode(&bytes),
        }));
    }

    Ok(json!({ "success": true, "entries": entries, "missing": missing }))
}

/// RESTORE a batch of exported records. `replace` = overwrite an existing key (RESTORE … REPLACE).
///
/// **One key at a time, deliberately not pipelined.** A pipeline reports only the FIRST error, and this batch
/// is not idempotent when `replace = false`: the server still executes the later keys, so re-running the batch
/// to attribute errors would hit BUSYKEY for the very keys it had just created and report them as "already
/// existed, skipped". An import that misstates what it wrote is worse than a slow one; the frontend batches
/// small, so the progress bar still moves steadily.
#[tauri::command]
pub async fn redis_restore_keys(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    entries: Vec<Value>,
    replace: bool,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    if entries.len() > TRANSFER_BATCH_MAX {
        return Err(format!("Mỗi lượt chỉ nhận tối đa {} key", TRANSFER_BATCH_MAX));
    }
    let mut c = take_conn(&state, &conn_id)?;
    let mut restored = 0usize;
    let mut skipped = 0usize;
    let mut failed: Vec<Value> = Vec::new();

    for e in &entries {
        let key = e.get("key").and_then(|v| v.as_str()).unwrap_or_default();
        let b64 = e.get("payload").and_then(|v| v.as_str()).unwrap_or_default();
        // An incomplete record was already dropped by `redisTransfer.ts` when the file was read (it has `t()` to speak
        // the active language, which this side does not) — this branch is only the final backstop.
        if key.is_empty() || b64.is_empty() {
            failed.push(json!({ "key": key, "error": "missing key or payload" }));
            continue;
        }
        let bytes = match B64.decode(b64) {
            Ok(b) => b,
            Err(_) => {
                failed.push(json!({ "key": key, "error": "invalid base64 payload" }));
                continue;
            }
        };
        // RESTORE takes the TTL in milliseconds, 0 = no expiry. PTTL returns -1 for a key with no TTL and
        // -2 for a key that does not exist; both must become 0, not a negative number (the server refuses it).
        let ttl_ms = e.get("ttlMs").and_then(|v| v.as_i64()).unwrap_or(-1);
        let mut cmd = redis::cmd("RESTORE");
        cmd.arg(key).arg(if ttl_ms > 0 { ttl_ms } else { 0 }).arg(bytes);
        if replace {
            cmd.arg("REPLACE");
        }
        match cmd.query_async::<redis::Value>(&mut c).await {
            Ok(_) => restored += 1,
            Err(err) => {
                // BUSYKEY: the key exists and the user did not ask to overwrite. That is a "skip" exactly as they
                // intended, not an error — folding it into `failed` would make a perfectly ordinary import
                // look like thousands of errors.
                let msg = err.to_string();
                if err.code() == Some("BUSYKEY") || msg.contains("BUSYKEY") {
                    skipped += 1;
                } else {
                    failed.push(json!({ "key": key, "error": msg }));
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    }))
}
