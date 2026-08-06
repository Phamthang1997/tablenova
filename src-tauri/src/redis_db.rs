// Hỗ trợ Redis như một loại DB thứ 4 — TÁCH BIỆT khỏi enum DbConnection (SQL) để không phá vỡ
// hàng loạt match sẵn có. Kết nối Redis lưu trong RedisState riêng của AppState.
// Dùng redis::aio::MultiplexedConnection (Clone rẻ) theo pattern: lock -> clone -> drop lock -> await.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::{json, Value};
use redis::aio::MultiplexedConnection;
use tauri::ipc::Channel;

pub struct RedisState {
    pub conn: Mutex<Option<MultiplexedConnection>>,
    pub config: Mutex<Option<Value>>, // để reconnect khi đổi db index
    pub db_index: Mutex<i64>,
}

impl RedisState {
    pub fn new() -> Self {
        Self { conn: Mutex::new(None), config: Mutex::new(None), db_index: Mutex::new(0) }
    }
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn build_redis_url(config: &Value, db_index: i64) -> String {
    let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(6379);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let ssl = config.get("sslEnabled").and_then(|v| v.as_bool()).unwrap_or(false)
        || config.get("useSsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let scheme = if ssl { "rediss" } else { "redis" };

    let auth = if !password.is_empty() {
        format!("{}:{}@", url_encode(user), url_encode(password))
    } else {
        String::new()
    };
    format!("{}://{}{}:{}/{}", scheme, auth, host, port, db_index)
}

async fn make_conn(url: &str) -> Result<MultiplexedConnection, String> {
    let client = redis::Client::open(url).map_err(|e| e.to_string())?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Không thể kết nối Redis: {}", e))
}

// Lấy một handle connection đã clone (drop lock trước khi await).
fn take_conn(state: &crate::AppState) -> Result<MultiplexedConnection, String> {
    let g = state.redis.conn.lock().map_err(|e| e.to_string())?;
    g.clone().ok_or_else(|| "Chưa kết nối Redis".to_string())
}

// redis::Value -> serde_json::Value (đệ quy), phục vụ redis_execute_cmd.
fn redis_value_to_json(v: &redis::Value) -> Value {
    match v {
        redis::Value::Nil => Value::Null,
        redis::Value::Int(i) => json!(i),
        redis::Value::BulkString(b) => json!(String::from_utf8_lossy(b)),
        redis::Value::SimpleString(s) => json!(s),
        redis::Value::Okay => json!("OK"),
        redis::Value::Array(arr) => Value::Array(arr.iter().map(redis_value_to_json).collect()),
        other => json!(format!("{:?}", other)),
    }
}

fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut in_s, mut in_d) = (false, false);
    for c in input.chars() {
        match c {
            '\'' if !in_d => in_s = !in_s,
            '"' if !in_s => in_d = !in_d,
            ' ' | '\t' if !in_s && !in_d => {
                if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

// A collection element is shipped as text so the UI can show it, but a value that is not
// valid UTF-8 would come back mangled by the lossy conversion — flag it so the editor can
// refuse to write it back (the round-trip would replace the real bytes with U+FFFD).
fn is_binary(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_err()
}

fn lossy_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn parse_info(text: &str) -> Value {
    let mut sections = serde_json::Map::new();
    let mut cur = serde_json::Map::new();
    let mut cur_name = String::from("Server");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some(rest) = line.strip_prefix("# ") {
            if !cur.is_empty() {
                sections.insert(cur_name.clone(), Value::Object(std::mem::take(&mut cur)));
            }
            cur_name = rest.trim().to_string();
        } else if let Some((k, v)) = line.split_once(':') {
            cur.insert(k.to_string(), json!(v));
        }
    }
    if !cur.is_empty() {
        sections.insert(cur_name, Value::Object(cur));
    }
    Value::Object(sections)
}

// ---- Commands ----

#[tauri::command]
pub async fn redis_connect(state: tauri::State<'_, crate::AppState>, config: Value) -> Result<Value, String> {
    let db_index = config.get("dbIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    let url = build_redis_url(&config, db_index);
    let mut conn = make_conn(&url).await?;

    // PING để chắc chắn kết nối/authenticate OK.
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| format!("PING lỗi: {}", e))?;

    {
        let mut g = state.redis.conn.lock().map_err(|e| e.to_string())?;
        *g = Some(conn);
    }
    *state.redis.config.lock().map_err(|e| e.to_string())? = Some(config);
    *state.redis.db_index.lock().map_err(|e| e.to_string())? = db_index;

    Ok(json!({ "success": true, "dbIndex": db_index }))
}

#[tauri::command]
pub async fn redis_disconnect(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    *state.redis.conn.lock().map_err(|e| e.to_string())? = None;
    *state.redis.config.lock().map_err(|e| e.to_string())? = None;
    Ok(json!({ "success": true }))
}

// Đổi database index (0-15): reconnect với index mới (an toàn hơn SELECT trên connection multiplexed).
#[tauri::command]
pub async fn redis_select_db(state: tauri::State<'_, crate::AppState>, index: i64) -> Result<Value, String> {
    let config = state.redis.config.lock().map_err(|e| e.to_string())?.clone()
        .ok_or_else(|| "Chưa kết nối Redis".to_string())?;
    let url = build_redis_url(&config, index);
    let mut conn = make_conn(&url).await?;
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| e.to_string())?;
    *state.redis.conn.lock().map_err(|e| e.to_string())? = Some(conn);
    *state.redis.db_index.lock().map_err(|e| e.to_string())? = index;
    Ok(json!({ "success": true, "dbIndex": index }))
}

// Quét keys bằng SCAN (non-blocking) + TYPE + TTL cho từng key qua pipeline.
#[tauri::command]
pub async fn redis_scan_keys(
    state: tauri::State<'_, crate::AppState>,
    pattern: String,
    cursor: u64,
    count: usize,
    type_filter: Option<String>,
) -> Result<Value, String> {
    // Không truyền TYPE cho SCAN: tham số này chỉ có ở Redis 6.0+ và nhiều bản tương thích
    // (KeyDB/Dragonfly) không hỗ trợ -> "syntax error". Lọc theo kiểu được xử lý phía client.
    let _ = &type_filter;
    let mut c = take_conn(&state)?;
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
    pattern: String,
    count: usize,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel.clone());
    }

    let mut c = take_conn(&state)?;
    let mut cursor: u64 = 0;
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
            let _ = channel.send(json!({ "type": "keys", "keys": items }));
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

#[tauri::command]
pub async fn redis_get_key(state: tauri::State<'_, crate::AppState>, key: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let t: String = redis::cmd("TYPE").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    if t == "none" {
        return Err(format!("Key \"{}\" không tồn tại.", key));
    }
    let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    let memory: Option<i64> = redis::cmd("MEMORY").arg("USAGE").arg(&key).query_async(&mut c).await.unwrap_or(None);

    let value: Value = match t.as_str() {
        "string" => {
            let bytes: Option<Vec<u8>> = redis::cmd("GET").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
            let bytes = bytes.unwrap_or_default();
            let text = std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
            json!({ "kind": "string", "bytes": bytes, "text": text })
        }
        "hash" => {
            let pairs: Vec<(String, Vec<u8>)> = redis::cmd("HGETALL").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
            let fields: Vec<Value> = pairs.into_iter()
                .map(|(f, v)| json!({ "field": f, "value": lossy_text(&v), "binary": is_binary(&v) }))
                .collect();
            json!({ "kind": "hash", "fields": fields })
        }
        "list" => {
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(&key).arg(0).arg(-1).query_async(&mut c).await.map_err(|e| e.to_string())?;
            let items: Vec<Value> = items.into_iter()
                .map(|v| json!({ "value": lossy_text(&v), "binary": is_binary(&v) }))
                .collect();
            json!({ "kind": "list", "items": items })
        }
        "set" => {
            let members: Vec<Vec<u8>> = redis::cmd("SMEMBERS").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
            let members: Vec<Value> = members.into_iter()
                .map(|v| json!({ "value": lossy_text(&v), "binary": is_binary(&v) }))
                .collect();
            json!({ "kind": "set", "members": members })
        }
        "zset" => {
            let entries: Vec<(Vec<u8>, f64)> = redis::cmd("ZRANGE").arg(&key).arg(0).arg(-1).arg("WITHSCORES").query_async(&mut c).await.map_err(|e| e.to_string())?;
            let entries: Vec<Value> = entries.into_iter()
                .map(|(m, s)| json!({ "member": lossy_text(&m), "score": s, "binary": is_binary(&m) }))
                .collect();
            json!({ "kind": "zset", "entries": entries })
        }
        "stream" => {
            let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE").arg(&key).arg("-").arg("+").query_async(&mut c).await.map_err(|e| e.to_string())?;
            let entries: Vec<Value> = reply.ids.into_iter().map(|entry| {
                let fields: Vec<Value> = entry.map.iter().map(|(f, v)| json!({ "field": f, "value": redis_value_to_json(v) })).collect();
                json!({ "id": entry.id, "fields": fields })
            }).collect();
            json!({ "kind": "stream", "entries": entries })
        }
        other => json!({ "kind": other }),
    };

    Ok(json!({ "success": true, "key": key, "type": t, "ttl": ttl, "memory": memory, "value": value }))
}

// Tạo/ghi đè một key theo kiểu. Ngữ nghĩa REPLACE: xóa key cũ rồi dựng lại theo payload.
#[tauri::command]
pub async fn redis_set_key(state: tauri::State<'_, crate::AppState>, payload: Value) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let key = payload.get("key").and_then(|v| v.as_str()).ok_or("Thiếu key")?.to_string();
    let kind = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("string").to_string();
    let ttl = payload.get("ttl").and_then(|v| v.as_i64()).unwrap_or(-1);

    // Xóa key cũ để ghi đè sạch (trừ string sẽ SET trực tiếp).
    if kind != "string" {
        let _: i64 = redis::cmd("DEL").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }

    match kind.as_str() {
        "string" => {
            let val = payload.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let _: () = redis::cmd("SET").arg(&key).arg(val).query_async(&mut c).await.map_err(|e| e.to_string())?;
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

// ---- Element-level edits ----
// Editing one element must NOT go through redis_set_key: that command has REPLACE semantics
// (DEL then rebuild), which drops the TTL and rewrites every element of the collection — a
// hash with 100k fields would be resent in full to change one value. Each command below maps
// to the single Redis command for that edit, so the rest of the key is untouched.
//
// "Renaming" the identity part of an element (hash field, set/zset member) has no atomic Redis
// command: write the new one first, then remove the old, so a failure leaves a duplicate
// rather than losing the value.

#[tauri::command]
pub async fn redis_hash_set(
    state: tauri::State<'_, crate::AppState>,
    key: String,
    field: String,
    value: String,
    old_field: Option<String>,
) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let _: i64 = redis::cmd("HSET").arg(&key).arg(&field).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_field.filter(|o| *o != field) {
        let _: i64 = redis::cmd("HDEL").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_hash_del(state: tauri::State<'_, crate::AppState>, key: String, field: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let removed: i64 = redis::cmd("HDEL").arg(&key).arg(&field)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_list_set(state: tauri::State<'_, crate::AppState>, key: String, index: i64, value: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let _: String = redis::cmd("LSET").arg(&key).arg(index).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_list_push(state: tauri::State<'_, crate::AppState>, key: String, value: String, at_head: bool) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let len: i64 = redis::cmd(if at_head { "LPUSH" } else { "RPUSH" }).arg(&key).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "length": len }))
}

// Redis has no "delete by index": overwrite the slot with a sentinel nobody else can hold,
// then LREM exactly that one occurrence. The timestamp keeps the sentinel unique so a
// concurrent delete on the same list cannot remove the wrong element.
#[tauri::command]
pub async fn redis_list_del(state: tauri::State<'_, crate::AppState>, key: String, index: i64) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sentinel = format!("__tablenova_deleted__{}__{}", index, nanos);
    let _: String = redis::cmd("LSET").arg(&key).arg(index).arg(&sentinel)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    let removed: i64 = redis::cmd("LREM").arg(&key).arg(1).arg(&sentinel)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_set_member(
    state: tauri::State<'_, crate::AppState>,
    key: String,
    member: String,
    old_member: Option<String>,
) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let added: i64 = redis::cmd("SADD").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_member.filter(|o| *o != member) {
        let _: i64 = redis::cmd("SREM").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true, "added": added }))
}

#[tauri::command]
pub async fn redis_set_del_member(state: tauri::State<'_, crate::AppState>, key: String, member: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let removed: i64 = redis::cmd("SREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_zset_add(
    state: tauri::State<'_, crate::AppState>,
    key: String,
    member: String,
    score: f64,
    old_member: Option<String>,
) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    // ZADD upserts, so changing only the score of an existing member needs nothing else.
    let _: i64 = redis::cmd("ZADD").arg(&key).arg(score).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_member.filter(|o| *o != member) {
        let _: i64 = redis::cmd("ZREM").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_zset_del(state: tauri::State<'_, crate::AppState>, key: String, member: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let removed: i64 = redis::cmd("ZREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

// Stream entries are immutable in Redis — there is no "edit entry", only XADD/XDEL.
// An empty `id` means "*" (let the server assign the next id).
#[tauri::command]
pub async fn redis_stream_add(
    state: tauri::State<'_, crate::AppState>,
    key: String,
    id: String,
    fields: Vec<Value>,
) -> Result<Value, String> {
    if fields.is_empty() {
        return Err("Stream cần ít nhất một field".to_string());
    }
    let mut c = take_conn(&state)?;
    let id = id.trim();
    let mut cmd = redis::cmd("XADD");
    cmd.arg(&key).arg(if id.is_empty() { "*" } else { id });
    for f in &fields {
        cmd.arg(f.get("field").and_then(|v| v.as_str()).unwrap_or(""))
            .arg(f.get("value").and_then(|v| v.as_str()).unwrap_or(""));
    }
    let new_id: String = cmd.query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "id": new_id }))
}

#[tauri::command]
pub async fn redis_stream_del(state: tauri::State<'_, crate::AppState>, key: String, id: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let removed: i64 = redis::cmd("XDEL").arg(&key).arg(&id)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_delete_keys(state: tauri::State<'_, crate::AppState>, keys: Vec<String>) -> Result<Value, String> {
    if keys.is_empty() {
        return Ok(json!({ "success": true, "deleted": 0 }));
    }
    let mut c = take_conn(&state)?;
    let deleted: i64 = redis::cmd("UNLINK").arg(&keys).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "deleted": deleted }))
}

#[tauri::command]
pub async fn redis_set_ttl(state: tauri::State<'_, crate::AppState>, key: String, ttl: i64) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    if ttl < 0 {
        let _: i64 = redis::cmd("PERSIST").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    } else {
        let _: i64 = redis::cmd("EXPIRE").arg(&key).arg(ttl).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_rename_key(state: tauri::State<'_, crate::AppState>, old_key: String, new_key: String) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let _: String = redis::cmd("RENAME").arg(&old_key).arg(&new_key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_flush_db(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let _: String = redis::cmd("FLUSHDB").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_info(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let mut c = take_conn(&state)?;
    let text: String = redis::cmd("INFO").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "info": parse_info(&text), "raw": text }))
}

#[tauri::command]
pub async fn redis_execute_cmd(state: tauri::State<'_, crate::AppState>, command: String) -> Result<Value, String> {
    let tokens = tokenize(&command);
    if tokens.is_empty() {
        return Err("Lệnh rỗng".to_string());
    }
    let mut c = take_conn(&state)?;
    let mut cmd = redis::cmd(&tokens[0]);
    for a in &tokens[1..] {
        cmd.arg(a);
    }
    match cmd.query_async::<redis::Value>(&mut c).await {
        Ok(val) => Ok(json!({ "success": true, "result": redis_value_to_json(&val) })),
        Err(e) => Ok(json!({ "success": false, "message": e.to_string() })),
    }
}
