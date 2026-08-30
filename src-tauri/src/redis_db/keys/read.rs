//! Reading one key: its type, its TTL, and its elements page by page.

use redis::aio::MultiplexedConnection;
use serde_json::{json, Value};

use crate::redis_db::caps::{caps_of, RedisCaps};
use crate::redis_db::cmds::version_at_least;
use crate::redis_db::conn::take_conn;
use crate::redis_db::value::{is_binary, lossy_text, redis_value_to_json};

// Elements per page. HGETALL/LRANGE 0 -1/SMEMBERS/ZRANGE 0 -1 used to read a whole key at
// once, which is O(N) on Redis' single thread — a hash with a million fields blocked the
// *server*, not just the app, then shipped the whole thing through IPC and rendered a
// million table rows.
pub(crate) const ELEMENT_PAGE: usize = 200;

// A string value is read whole (GET has no range-free alternative that is cheaper), but only
// the first megabyte is shipped: past that the editor is not usable anyway and the JSON
// byte array costs several bytes per byte of value.
pub(crate) const STRING_PREVIEW_MAX: usize = 1024 * 1024;

/// Number of elements in a collection, so the UI can show "200 of 1,048,576" instead of
/// pretending the page is the whole key. `None` for types with no cheap count.
pub(crate) async fn element_count(c: &mut MultiplexedConnection, key: &str, kind: &str) -> Option<i64> {
    let cmd = match kind {
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "stream" => "XLEN",
        _ => return None,
    };
    redis::cmd(cmd).arg(key).query_async(c).await.ok()
}

/// One page of a collection.
///
/// `cursor` is an opaque string on purpose — its meaning differs per type and the frontend
/// must not encode that knowledge:
///   hash/set  SCAN-family cursor, `done` when it comes back 0
///   zset      rank offset (`ZRANGE`, **not** ZSCAN: ZSCAN returns an arbitrary order and
///             score order is the entire point of a zset)
///   list      element index
///   stream    id of the last entry read
///
/// Rank/index paging can skip or repeat an element if someone else writes between two pages;

/// that is a deliberate trade (refresh fixes it) and the UI says so.
pub(crate) async fn fetch_elements(
    c: &mut MultiplexedConnection,
    key: &str,
    kind: &str,
    cursor: &str,
    count: usize,
    filter: Option<&str>,
    caps: &RedisCaps,
) -> Result<(Vec<Value>, String, bool), String> {
    let count = count.clamp(1, 5000);
    match kind {
        "hash" => {
            let cur: u64 = cursor.parse().unwrap_or(0);
            let mut cmd = redis::cmd("HSCAN");
            cmd.arg(key).arg(cur);
            if let Some(p) = filter.filter(|p| !p.is_empty()) {
                cmd.arg("MATCH").arg(p);
            }
            cmd.arg("COUNT").arg(count);
            let (next, flat): (u64, Vec<Vec<u8>>) =
                cmd.query_async(c).await.map_err(|e| e.to_string())?;
            let items = flat
                .chunks(2)
                .filter(|p| p.len() == 2)
                .map(|p| {
                    json!({
                        "field": lossy_text(&p[0]),
                        "value": lossy_text(&p[1]),
                        // `binary` locks editing (a lossy round-trip would replace real bytes
                        // with U+FFFD); `binaryKey` also locks deleting, because HDEL
                        // identifies the element by the field name we would send back lossy.
                        "binary": is_binary(&p[0]) || is_binary(&p[1]),
                        "binaryKey": is_binary(&p[0]),
                    })
                })
                .collect();
            Ok((items, next.to_string(), next == 0))
        }
        "set" => {
            let cur: u64 = cursor.parse().unwrap_or(0);
            let mut cmd = redis::cmd("SSCAN");
            cmd.arg(key).arg(cur);
            if let Some(p) = filter.filter(|p| !p.is_empty()) {
                cmd.arg("MATCH").arg(p);
            }
            cmd.arg("COUNT").arg(count);
            let (next, members): (u64, Vec<Vec<u8>>) =
                cmd.query_async(c).await.map_err(|e| e.to_string())?;
            let items = members
                .iter()
                .map(|m| {
                    json!({
                        "value": lossy_text(m),
                        "binary": is_binary(m),
                        "binaryKey": is_binary(m),
                    })
                })
                .collect();
            Ok((items, next.to_string(), next == 0))
        }
        "list" => {
            let start: i64 = cursor.parse().unwrap_or(0);
            let stop = start + count as i64 - 1;
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE")
                .arg(key)
                .arg(start)
                .arg(stop)
                .query_async(c)
                .await
                .map_err(|e| e.to_string())?;
            let n = items.len();
            let out = items
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    json!({
                        // Absolute index: LSET/LREM-by-index operate on it, so the page offset
                        // must be baked in here rather than recomputed in the UI.
                        "index": start + i as i64,
                        "value": lossy_text(v),
                        "binary": is_binary(v),
                        "binaryKey": false,
                    })
                })
                .collect();
            Ok((out, (start + n as i64).to_string(), n < count))
        }
        "zset" => {
            let start: i64 = cursor.parse().unwrap_or(0);
            let stop = start + count as i64 - 1;
            let entries: Vec<(Vec<u8>, f64)> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(start)
                .arg(stop)
                .arg("WITHSCORES")
                .query_async(c)
                .await
                .map_err(|e| e.to_string())?;
            let n = entries.len();
            let out = entries
                .iter()
                .map(|(m, s)| {
                    json!({
                        "member": lossy_text(m),
                        "score": s,
                        "binary": is_binary(m),
                        "binaryKey": is_binary(m),
                    })
                })
                .collect();
            Ok((out, (start + n as i64).to_string(), n < count))
        }
        "stream" => {
            // Exclusive ranges (`(id`) need Redis 6.2. Older servers (and forks) get an
            // inclusive read of count+1 and the already-shown first entry is dropped.
            let exclusive = version_at_least((caps.major, caps.minor), (6, 2));
            let first_page = cursor.is_empty();
            let start_arg = if first_page {
                "-".to_string()
            } else if exclusive {
                format!("({}", cursor)
            } else {
                cursor.to_string()
            };
            let fetch = if first_page || exclusive { count } else { count + 1 };
            let reply: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
                .arg(key)
                .arg(&start_arg)
                .arg("+")
                .arg("COUNT")
                .arg(fetch)
                .query_async(c)
                .await
                .map_err(|e| e.to_string())?;
            let mut ids = reply.ids;
            if !first_page && !exclusive && ids.first().map(|e| e.id == cursor).unwrap_or(false) {
                ids.remove(0);
            }
            let n = ids.len();
            let last = ids.last().map(|e| e.id.clone()).unwrap_or_else(|| cursor.to_string());
            let out = ids
                .into_iter()
                .map(|entry| {
                    let fields: Vec<Value> = entry
                        .map
                        .iter()
                        .map(|(f, v)| json!({ "field": f, "value": redis_value_to_json(v) }))
                        .collect();
                    json!({ "id": entry.id, "fields": fields })
                })
                .collect();
            Ok((out, last, n < count))
        }
        other => Err(format!("Chưa hỗ trợ phân trang cho kiểu '{}'", other)),
    }
}

#[tauri::command]
pub async fn redis_get_key(conn_id: String, key: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let caps = caps_of(&state, &conn_id);
    let mut c = take_conn(&state, &conn_id)?;
    let t: String = redis::cmd("TYPE").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    if t == "none" {
        return Err(format!("Key \"{}\" không tồn tại.", key));
    }
    let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    let memory: Option<i64> = redis::cmd("MEMORY").arg("USAGE").arg(&key).query_async(&mut c).await.unwrap_or(None);
    let length = element_count(&mut c, &key, &t).await;

    let value: Value = match t.as_str() {
        "string" => {
            let total: i64 = redis::cmd("STRLEN").arg(&key).query_async(&mut c).await.unwrap_or(0);
            let truncated = total > STRING_PREVIEW_MAX as i64;
            let bytes: Option<Vec<u8>> = if truncated {
                redis::cmd("GETRANGE").arg(&key).arg(0).arg(STRING_PREVIEW_MAX as i64 - 1)
                    .query_async(&mut c).await.map_err(|e| e.to_string())?
            } else {
                redis::cmd("GET").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?
            };
            let bytes = bytes.unwrap_or_default();
            let text = std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
            json!({
                "kind": "string",
                "bytes": bytes,
                "text": text,
                "truncated": truncated,
                "totalLength": total,
            })
        }
        // Every collection ships the *first page* and the cursor to continue from. One shape
        // for all four (`elements`) so the UI has a single paging path.
        "hash" | "list" | "set" | "zset" | "stream" => {
            let (elements, next_cursor, done) =
                fetch_elements(&mut c, &key, &t, "", ELEMENT_PAGE, None, &caps).await?;
            json!({ "kind": t, "elements": elements, "nextCursor": next_cursor, "done": done })
        }
        // ReJSON-RL, TSDB-TYPE, vectorset, MBbloom--… Returning `{ kind: other }` used to make
        // the panel render nothing at all, with no hint that the type is simply not handled.
        other => json!({ "kind": "unsupported", "redisType": other }),
    };

    Ok(json!({
        "success": true,
        "key": key,
        "type": t,
        "ttl": ttl,
        "memory": memory,
        "length": length,
        "value": value,
    }))
}).await
}

/// Next page of a collection. `cursor` comes back from the previous call (or `redis_get_key`).
#[tauri::command]
pub async fn redis_get_elements(
    conn_id: String,
    key: String,
    kind: String,
    cursor: String,
    count: Option<usize>,
    filter: Option<String>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let caps = caps_of(&state, &conn_id);
    let mut c = take_conn(&state, &conn_id)?;
    let (elements, next_cursor, done) = fetch_elements(
        &mut c,
        &key,
        &kind,
        &cursor,
        count.unwrap_or(ELEMENT_PAGE),
        filter.as_deref(),
        &caps,
    )
    .await?;
    Ok(json!({
        "success": true,
        "kind": kind,
        "elements": elements,
        "nextCursor": next_cursor,
        "done": done,
    }))
}).await
}
