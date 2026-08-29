//! Writing a WHOLE key: create/overwrite per type, plus the raw-byte write for the HEX editor.

use serde_json::{json, Value};

use crate::redis_db::caps::caps_of;
use crate::redis_db::cmds::version_at_least;
use crate::redis_db::conn::{ensure_writable, take_conn};

// Create/overwrite one key per type. REPLACE semantics: delete the old key, then rebuild it from the payload.
#[tauri::command]
pub async fn redis_set_key(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let caps = caps_of(&state, &conn_id);
    let mut c = take_conn(&state, &conn_id)?;
    let key = payload.get("key").and_then(|v| v.as_str()).ok_or("Thiếu key")?.to_string();
    let kind = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("string").to_string();
    let ttl = payload.get("ttl").and_then(|v| v.as_i64()).unwrap_or(-1);

    // Delete the old key for a clean overwrite (except for a string, which is SET directly).
    if kind != "string" {
        let _: i64 = redis::cmd("DEL").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }

    match kind.as_str() {
        "string" => {
            let val = payload.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let mut cmd = redis::cmd("SET");
            cmd.arg(&key).arg(val);
            // Editing a value must not drop the key's expiry. Plain SET clears it, so keep it
            // where the server supports KEEPTTL (6.0+); an explicit `ttl` below still wins.
            if ttl <= 0 && version_at_least((caps.major, caps.minor), (6, 0)) {
                cmd.arg("KEEPTTL");
            }
            let _: redis::Value = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
        }
        "hash" => {
            if let Some(fields) = payload.get("fields").and_then(|v| v.as_array()) {
                if !fields.is_empty() {
                    let mut cmd = redis::cmd("HSET");
                    cmd.arg(&key);
                    for f in fields {
                        let field = f.get("field").and_then(|v| v.as_str()).unwrap_or("");
                        let value = f.get("value").and_then(|v| v.as_str()).unwrap_or("");
                        cmd.arg(field).arg(value);
                    }
                    let _: i64 = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
                }
            }
        }
        "list" => {
            if let Some(items) = payload.get("items").and_then(|v| v.as_array()) {
                if !items.is_empty() {
                    let mut cmd = redis::cmd("RPUSH");
                    cmd.arg(&key);
                    for it in items { cmd.arg(it.as_str().unwrap_or("")); }
                    let _: i64 = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
                }
            }
        }
        "set" => {
            if let Some(members) = payload.get("members").and_then(|v| v.as_array()) {
                if !members.is_empty() {
                    let mut cmd = redis::cmd("SADD");
                    cmd.arg(&key);
                    for m in members { cmd.arg(m.as_str().unwrap_or("")); }
                    let _: i64 = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
                }
            }
        }
        "zset" => {
            if let Some(entries) = payload.get("entries").and_then(|v| v.as_array()) {
                if !entries.is_empty() {
                    let mut cmd = redis::cmd("ZADD");
                    cmd.arg(&key);
                    for e in entries {
                        let score = e.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let member = e.get("member").and_then(|v| v.as_str()).unwrap_or("");
                        cmd.arg(score).arg(member);
                    }
                    let _: i64 = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
                }
            }
        }
        other => return Err(format!("Chưa hỗ trợ set cho kiểu \"{}\"", other)),
    }

    if ttl > 0 {
        let _: i64 = redis::cmd("EXPIRE").arg(&key).arg(ttl).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }

    Ok(json!({ "success": true }))
}

// ---- Binary-safe string write ----

/// Writes a string value from raw bytes, which is what makes the HEX editor able to *save*.
/// `redis_set_key` takes a `&str` and therefore can only write text.
///
/// `KEEPTTL` (Redis 6.0+) is used when available: editing a value should not silently drop
/// the key's expiry, which plain `SET` does.
#[tauri::command]
pub async fn redis_set_key_bytes(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let caps = caps_of(&state, &conn_id);
    let mut c = take_conn(&state, &conn_id)?;
    let mut cmd = redis::cmd("SET");
    cmd.arg(&key).arg(&bytes[..]);
    if version_at_least((caps.major, caps.minor), (6, 0)) {
        cmd.arg("KEEPTTL");
    }
    let _: redis::Value = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "length": bytes.len() }))
}
