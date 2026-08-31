//! Converting Redis values into JSON, and reading text/binary safely.
//!
//! `lossy_text` turns non-UTF-8 bytes into U+FFFD — that is exactly why the `binary` flag blocks
//! editing, and why the keyspace export/import does NOT go through this path but uses DUMP/RESTORE.

use serde_json::{Value, json};

// redis::Value -> serde_json::Value (recursive), for redis_execute_cmd.
pub(crate) fn redis_value_to_json(v: &redis::Value) -> Value {
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

// A collection element is shipped as text so the UI can show it, but a value that is not
// valid UTF-8 would come back mangled by the lossy conversion — flag it so the editor can
// refuse to write it back (the round-trip would replace the real bytes with U+FFFD).
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_err()
}

pub(crate) fn lossy_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

// Plain-text view of a reply cell. Used by the caps probe and the SLOWLOG parser, which
// both read hand-shaped replies where the driver's typed decoding does not fit.
pub(crate) fn as_text(v: &redis::Value) -> String {
    match v {
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::VerbatimString { text, .. } => text.clone(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::Double(d) => d.to_string(),
        redis::Value::Okay => "OK".to_string(),
        _ => String::new(),
    }
}

pub(crate) fn parse_info(text: &str) -> Value {
    let mut sections = serde_json::Map::new();
    let mut cur = serde_json::Map::new();
    let mut cur_name = String::from("Server");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
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

// ---- Slow log ----

pub(crate) fn as_i64(v: &redis::Value) -> i64 {
    match v {
        redis::Value::Int(i) => *i,
        other => as_text(other).parse().unwrap_or(0),
    }
}

// ---- Stream consumer groups ----

// XINFO/XPENDING replies are field-value sequences (flat array on RESP2, map on RESP3).
// Decoded generically rather than into a typed struct so a newer server adding a field does
// not make the whole reply undecodable.
pub(crate) fn pairs_to_json(v: &redis::Value) -> Value {
    let pairs: Vec<(String, &redis::Value)> = match v {
        redis::Value::Array(a) => a
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| (as_text(&c[0]), &c[1]))
            .collect(),
        redis::Value::Map(m) => m.iter().map(|(k, val)| (as_text(k), val)).collect(),
        other => return redis_value_to_json(other),
    };
    let mut obj = serde_json::Map::new();
    for (k, val) in pairs {
        obj.insert(k, redis_value_to_json(val));
    }
    Value::Object(obj)
}
