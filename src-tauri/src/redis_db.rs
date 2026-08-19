// Hỗ trợ Redis như một loại DB thứ 4 — TÁCH BIỆT khỏi enum DbConnection (SQL) để không phá vỡ
// hàng loạt match sẵn có, nhưng nằm CHUNG registry `conn_id` với SQL
// (`docs/redis-ui-unification-plan.md` §2.3): một danh sách kết nối đang mở cho `DbRail`, một vòng
// đời, một cờ read-only. `RedisState` — một connection và một db_index cho cả app — đã bị xoá.
//
// Một `conn_id` = một `(server, db index)` (§2.1). Đổi db index là MỞ MỘT KẾT NỐI KHÁC, không phải
// đổi state dùng chung; đó là thứ giữ cho hai tab key mở trên hai db không đọc nhầm của nhau.
// Dùng redis::aio::MultiplexedConnection (Clone rẻ) theo pattern: lock -> clone -> drop lock -> await.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use futures_util::StreamExt;
use serde_json::{json, Value};
use redis::aio::MultiplexedConnection;
use tauri::Manager;
use tauri::ipc::Channel;

use crate::redis_cmds::{
    is_blocking_cmd, is_read_only_cmd, parse_version, select_db_arg, token_name, tokenize,
    version_at_least,
};

/// What the connected server can actually do. Probed once at connect instead of being
/// discovered by trying a command and catching the error: the app must work against Redis
/// 6/7/8, Valkey, KeyDB and Dragonfly, and "try it and see" turns every paged read into a
/// possible round trip wasted on a syntax error.
#[derive(Clone, Default)]
pub struct RedisCaps {
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// Lowercased module names from `MODULE LIST` (empty when the command is not allowed).
    pub modules: Vec<String>,
}

impl RedisCaps {
    pub fn has_module(&self, name: &str) -> bool {
        self.modules.iter().any(|m| m == name)
    }
    fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "major": self.major,
            "minor": self.minor,
            "modules": self.modules,
        })
    }
}

// `RedisState` đã bị xoá. Năm trường của nó giờ nằm trong registry, mỗi kết nối một bản:
// `conn`/`db_index`/`caps` trong `state::RedisConn`, `config`/`ssh_tunnel` trên
// `state::ServerHandle` (dùng chung giữa các db index của cùng server), `read_only` là cờ của
// `ConnEntry` — cùng một cờ mà SQL và thanh rail đọc, nên không còn hai nguồn sự thật.

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

/// Resolves the UI's SSL fields into one of DISABLED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY.
///
/// Profiles saved before the Redis SSL tab existed carry only the on/off switch (`sslEnabled`),
/// and that switch meant `rediss://` with rustls' default full verification — so an absent mode
/// maps to VERIFY_IDENTITY, not to the weakest mode. PREFERRED is not offered for Redis (there
/// is no STARTTLS-style negotiation: a port either speaks TLS or it does not) but is mapped
/// defensively in case a profile switched type and kept the field.
fn redis_ssl_mode(config: &Value) -> String {
    let enabled = config.get("sslEnabled").and_then(|v| v.as_bool()).unwrap_or(false)
        || config.get("useSsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let mode = config.get("sslMode").and_then(|v| v.as_str()).unwrap_or("").trim();
    match mode {
        "" | "DISABLED" => if enabled { "VERIFY_IDENTITY" } else { "DISABLED" },
        "PREFERRED" => "VERIFY_IDENTITY",
        other => other,
    }
    .to_string()
}

fn build_redis_url(config: &Value, db_index: i64) -> String {
    let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(6379);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let mode = redis_ssl_mode(config);
    let scheme = if mode == "DISABLED" { "redis" } else { "rediss" };

    let auth = if !password.is_empty() {
        format!("{}:{}@", url_encode(user), url_encode(password))
    } else {
        String::new()
    };
    let mut url = format!("{}://{}{}:{}/{}", scheme, auth, host, port, db_index);
    // REQUIRED = mã hoá nhưng không kiểm tra chứng chỉ. redis-rs chỉ nhận cấu hình này qua
    // fragment `#insecure` của URL; url_encode đã escape '#' trong user/password nên fragment
    // này không thể bị chèn từ dữ liệu người dùng.
    if mode == "REQUIRED" {
        url.push_str("#insecure");
    }
    url
}

// Ba hàm đọc file PEM riêng thay vì một hàm có tham số "loại file": bảng backendErrors.ts dịch
// cả khung câu, một tham số tiếng Việt lồng bên trong sẽ nằm nguyên trong câu đã dịch.
fn read_ca_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được chứng chỉ CA '{}': {}", path, e))
}

fn read_client_cert_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được chứng chỉ client '{}': {}", path, e))
}

fn read_client_key_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được khoá client '{}': {}", path, e))
}

/// Reads the CA / client certificate files named by the SSL tab. Returns `None` when none are
/// set, which is the signal to use the system trust store through the plain URL path.
fn redis_tls_certs(config: &Value) -> Result<Option<redis::TlsCertificates>, String> {
    let field = |key: &str| {
        config
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let ca = field("sslCaPath");
    let cert = field("sslCertPath");
    let key = field("sslKeyPath");
    if ca.is_none() && cert.is_none() && key.is_none() {
        return Ok(None);
    }

    let client_tls = match (cert, key) {
        (Some(c), Some(k)) => Some(redis::ClientTlsConfig {
            client_cert: read_client_cert_pem(&c)?,
            client_key: read_client_key_pem(&k)?,
        }),
        (None, None) => None,
        // mTLS cần đủ cặp cert + key. Thiếu một nửa mà im lặng bỏ qua thì server từ chối kết nối
        // với một lỗi TLS khó hiểu, trong khi nguyên nhân thật nằm ở form.
        _ => return Err("mTLS cần cả chứng chỉ client và khoá client".to_string()),
    };
    let root_cert = match ca {
        Some(p) => Some(read_ca_pem(&p)?),
        None => None,
    };
    Ok(Some(redis::TlsCertificates { client_tls, root_cert }))
}

/// Builds the client for `config`. Shared by connect, the db-index switch and the dedicated
/// Pub/Sub-Profiler connection so all three speak TLS the same way.
fn make_client(config: &Value, db_index: i64) -> Result<redis::Client, String> {
    let mode = redis_ssl_mode(config);
    let url = build_redis_url(config, db_index);
    let certs = if mode == "DISABLED" { None } else { redis_tls_certs(config)? };

    let client = match certs {
        Some(c) => redis::Client::build_with_tls(url, c)
            .map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e))?,
        None => redis::Client::open(url).map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e))?,
    };

    // VERIFY_CA = kiểm tra chuỗi chứng chỉ nhưng bỏ qua tên miền. Phải đặt SAU build_with_tls:
    // hàm đó dựng lại tls_params từ các file chứng chỉ và sẽ xoá mất cờ nếu đặt trước.
    // Đây cũng là mode duy nhất dùng được khi Redis đi qua SSH tunnel, vì lúc đó chứng chỉ
    // được đối chiếu với 127.0.0.1.
    if mode == "VERIFY_CA" {
        let mut addr = client.get_connection_info().addr().clone();
        addr.set_danger_accept_invalid_hostnames(true);
        let info = client.get_connection_info().clone().set_addr(addr);
        return redis::Client::open(info).map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e));
    }
    Ok(client)
}

async fn make_conn(config: &Value, db_index: i64) -> Result<MultiplexedConnection, String> {
    let client = make_client(config, db_index)?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Không thể kết nối Redis: {}", e))
}

// Lấy một handle connection đã clone (drop lock trước khi await).
fn take_conn(state: &crate::AppState, conn_id: &str) -> Result<MultiplexedConnection, String> {
    Ok(state.connections.acquire_redis(conn_id)?.conn())
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

// Refuses every write when read-only mode is on. Called by each mutating command rather
// than by one wrapper, because there is no single funnel: the element editors talk to their
// own Redis command directly (see the block comment above `redis_hash_set`).
fn ensure_writable(state: &crate::AppState, conn_id: &str) -> Result<(), String> {
    if state.connections.is_read_only(conn_id) {
        return Err("Chế độ chỉ đọc: không thể ghi vào Redis".to_string());
    }
    Ok(())
}

fn caps_of(state: &crate::AppState, conn_id: &str) -> RedisCaps {
    state
        .connections
        .acquire_redis(conn_id)
        .map(|c| c.caps())
        .unwrap_or_default()
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

// Plain-text view of a reply cell. Used by the caps probe and the SLOWLOG parser, which
// both read hand-shaped replies where the driver's typed decoding does not fit.
fn as_text(v: &redis::Value) -> String {
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

// One entry of `MODULE LIST`. RESP2 gives a flat array (["name", <n>, "ver", <v>]),
// RESP3 a map — accept both rather than depending on the negotiated protocol.
fn module_name(v: &redis::Value) -> Option<String> {
    let pairs: Vec<(&redis::Value, &redis::Value)> = match v {
        redis::Value::Array(a) => a.chunks(2).filter(|c| c.len() == 2).map(|c| (&c[0], &c[1])).collect(),
        redis::Value::Map(m) => m.iter().map(|(k, val)| (k, val)).collect(),
        _ => return None,
    };
    pairs.into_iter().find_map(|(k, val)| {
        if as_text(k).eq_ignore_ascii_case("name") {
            Some(as_text(val).to_ascii_lowercase())
        } else {
            None
        }
    })
}

// Version + module list, read once per connection. Both lookups are best-effort: managed
// Redis often blocks MODULE LIST by ACL, and a fork may not report redis_version the same
// way — an empty result degrades to "assume the oldest behaviour", never to an error.
async fn probe_caps(conn: &mut MultiplexedConnection) -> RedisCaps {
    let text: String = redis::cmd("INFO")
        .arg("server")
        .query_async(conn)
        .await
        .unwrap_or_default();
    let version = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("redis_version:"))
        .unwrap_or("")
        .trim()
        .to_string();
    let (major, minor) = parse_version(&version);
    let modules = match redis::cmd("MODULE")
        .arg("LIST")
        .query_async::<redis::Value>(conn)
        .await
    {
        Ok(redis::Value::Array(items)) => items.iter().filter_map(module_name).collect(),
        _ => Vec::new(),
    };
    RedisCaps { version, major, minor, modules }
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

/// The name a Redis `(server, db index)` is filed under in the registry — the `db` field the rail
/// draws, and what `find` matches on so opening the same index twice is idempotent.
fn redis_db_name(index: i64) -> String {
    format!("db{}", index)
}

#[tauri::command]
pub async fn redis_connect(state: tauri::State<'_, crate::AppState>, config: Value) -> Result<Value, String> {
    let db_index = config.get("dbIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    // Mở SSH tunnel trước: conn_config trỏ về 127.0.0.1:<cổng chuyển tiếp>, và chính conn_config
    // đó được lưu lại để mọi lần reconnect sau (đổi db index, Pub/Sub, Profiler) dùng lại đúng
    // cổng này thay vì mở tunnel mới.
    let (conn_config, tunnel) = crate::database::apply_ssh_tunnel(&config, 6379).await?;
    let mut conn = make_conn(&conn_config, db_index).await?;

    // PING để chắc chắn kết nối/authenticate OK.
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| format!("PING lỗi: {}", e))?;

    let caps = probe_caps(&mut conn).await;
    let read_only = config.get("readOnly").and_then(|v| v.as_bool()).unwrap_or(false);

    let conn_id = crate::state::mint_id();
    // `ServerHandle` giữ config đã TUNNEL, khác với SQL (giữ config gốc rồi mở tunnel lại mỗi lần
    // dựng pool). Redis reconnect nhiều hơn — đổi db index, Pub/Sub, Profiler đều mở socket mới —
    // và tunnel đã sống sẵn ngay trên handle này, nên dựng lại là mở thừa một cổng chuyển tiếp.
    let server = Arc::new(crate::state::ServerHandle::new(
        crate::state::mint_id(),
        "redis".to_string(),
        conn_config,
        tunnel,
    ));
    state.connections.insert(
        conn_id.clone(),
        crate::state::ConnEntry {
            read_only,
            server,
            db: redis_db_name(db_index),
            conn: crate::state::LiveConn::Redis(crate::state::RedisConn {
                conn,
                db_index,
                caps: caps.clone(),
            }),
            // Redis không có schema. `None` chứ không phải `Some("")`: `pg_schema_of` mặc định
            // `public`, và một chuỗi rỗng ở đây sẽ đi vào scopeKey của frontend.
            current_schema: None,
        },
    )?;

    Ok(json!({
        "success": true,
        "connId": &*conn_id,
        "dbIndex": db_index,
        "caps": caps.to_json(),
        "readOnly": read_only,
    }))
}

/// Mirrors the app's read-only toggle into the backend. The toggle can be flipped after
/// connecting, so the value cannot be read from the connect config alone.
///
/// Writes the registry's own flag — there is no second Redis-only flag any more, so the rail, the
/// SQL guard and the Redis guard can no longer disagree about one connection.
#[tauri::command]
pub async fn redis_set_read_only(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    flag: bool,
) -> Result<Value, String> {
    state.connections.set_read_only(&conn_id, flag)?;
    Ok(json!({ "success": true, "readOnly": flag }))
}

#[tauri::command]
pub async fn redis_disconnect(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<Value, String> {
    // Dropping the entry releases its `Arc<ServerHandle>`; the SSH tunnel closes with the LAST
    // entry of that server, not with this one — which is the point of putting it there. Ngắt `db3`
    // trong khi `db0` của cùng server còn mở thì cổng chuyển tiếp phải sống tiếp.
    let entry = state.connections.remove(&conn_id)?;
    drop(entry);
    Ok(json!({ "success": true }))
}

/// Đổi database index (0-15).
///
/// Không còn đổi state dùng chung: nó **mở một kết nối khác** trên cùng server và trả về `conn_id`
/// của kết nối đó (§2.1). Frontend chuyển workspace sang id mới, đúng như khi mở database thứ hai
/// của một server Postgres. Idempotent — bấm `db3` hai lần trả về cùng một `conn_id`.
#[tauri::command]
pub async fn redis_select_db(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    index: i64,
) -> Result<Value, String> {
    select_db_inner(&state, &conn_id, index).await
}

// Shared by the command above and by the `SELECT n` interception in `redis_execute_cmd`, so
// the console cannot switch database behind the UI's back.
async fn select_db_inner(
    state: &crate::AppState,
    conn_id: &str,
    index: i64,
) -> Result<Value, String> {
    let (server, read_only) = {
        let ctx = state.connections.acquire_redis(conn_id)?;
        (ctx.server_arc(), ctx.read_only())
    };
    let db = redis_db_name(index);

    // Đã mở sẵn thì dùng lại, không mint pool thứ hai cho cùng một chỗ.
    if let Some(existing) = state.connections.find(&server.id, &db)? {
        return Ok(json!({ "success": true, "connId": &*existing, "dbIndex": index }));
    }

    let config = server.config();
    let mut conn = make_conn(&config, index).await?;
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| e.to_string())?;
    let caps = probe_caps(&mut conn).await;

    let new_id = crate::state::mint_id();
    state.connections.insert(
        new_id.clone(),
        crate::state::ConnEntry {
            // Kế thừa cờ read-only của kết nối mở ra nó: cùng một server, và ai đã đánh dấu
            // production chỉ đọc thì có ý nói mọi db index của nó. Cùng lý lẽ với `open_database`.
            read_only,
            // CÙNG `Arc<ServerHandle>`: một `ServerHandle` khác sẽ mở tunnel riêng và đóng nó ngay
            // khi kết nối đầu tiên biến mất.
            server,
            db,
            conn: crate::state::LiveConn::Redis(crate::state::RedisConn { conn, db_index: index, caps }),
            current_schema: None,
        },
    )?;
    Ok(json!({ "success": true, "connId": &*new_id, "dbIndex": index }))
}

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

// Elements per page. HGETALL/LRANGE 0 -1/SMEMBERS/ZRANGE 0 -1 used to read a whole key at
// once, which is O(N) on Redis' single thread — a hash with a million fields blocked the
// *server*, not just the app, then shipped the whole thing through IPC and rendered a
// million table rows.
const ELEMENT_PAGE: usize = 200;

// A string value is read whole (GET has no range-free alternative that is cheaper), but only
// the first megabyte is shipped: past that the editor is not usable anyway and the JSON
// byte array costs several bytes per byte of value.
const STRING_PREVIEW_MAX: usize = 1024 * 1024;

/// Number of elements in a collection, so the UI can show "200 of 1,048,576" instead of
/// pretending the page is the whole key. `None` for types with no cheap count.
async fn element_count(c: &mut MultiplexedConnection, key: &str, kind: &str) -> Option<i64> {
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
async fn fetch_elements(
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
pub async fn redis_get_key(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String) -> Result<Value, String> {
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
}

/// Next page of a collection. `cursor` comes back from the previous call (or `redis_get_key`).
#[tauri::command]
pub async fn redis_get_elements(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    kind: String,
    cursor: String,
    count: Option<usize>,
    filter: Option<String>,
) -> Result<Value, String> {
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
}

// Tạo/ghi đè một key theo kiểu. Ngữ nghĩa REPLACE: xóa key cũ rồi dựng lại theo payload.
#[tauri::command]
pub async fn redis_set_key(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let caps = caps_of(&state, &conn_id);
    let mut c = take_conn(&state, &conn_id)?;
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
    conn_id: String,
    key: String,
    field: String,
    value: String,
    old_field: Option<String>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: i64 = redis::cmd("HSET").arg(&key).arg(&field).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_field.filter(|o| *o != field) {
        let _: i64 = redis::cmd("HDEL").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_hash_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, field: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("HDEL").arg(&key).arg(&field)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_list_set(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, index: i64, value: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("LSET").arg(&key).arg(index).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_list_push(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, value: String, at_head: bool) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let len: i64 = redis::cmd(if at_head { "LPUSH" } else { "RPUSH" }).arg(&key).arg(&value)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "length": len }))
}

// Redis has no "delete by index": overwrite the slot with a sentinel nobody else can hold,
// then LREM exactly that one occurrence. The timestamp keeps the sentinel unique so a
// concurrent delete on the same list cannot remove the wrong element.
#[tauri::command]
pub async fn redis_list_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, index: i64) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
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
    conn_id: String,
    key: String,
    member: String,
    old_member: Option<String>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let added: i64 = redis::cmd("SADD").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    if let Some(old) = old_member.filter(|o| *o != member) {
        let _: i64 = redis::cmd("SREM").arg(&key).arg(&old)
            .query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true, "added": added }))
}

#[tauri::command]
pub async fn redis_set_del_member(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, member: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("SREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_zset_add(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    member: String,
    score: f64,
    old_member: Option<String>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
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
pub async fn redis_zset_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, member: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("ZREM").arg(&key).arg(&member)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

// Stream entries are immutable in Redis — there is no "edit entry", only XADD/XDEL.
// An empty `id` means "*" (let the server assign the next id).
#[tauri::command]
pub async fn redis_stream_add(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    id: String,
    fields: Vec<Value>,
) -> Result<Value, String> {
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
}

#[tauri::command]
pub async fn redis_stream_del(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, id: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("XDEL").arg(&key).arg(&id)
        .query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
}

#[tauri::command]
pub async fn redis_delete_keys(state: tauri::State<'_, crate::AppState>, conn_id: String, keys: Vec<String>) -> Result<Value, String> {
    if keys.is_empty() {
        return Ok(json!({ "success": true, "deleted": 0 }));
    }
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let deleted: i64 = redis::cmd("UNLINK").arg(&keys).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "deleted": deleted }))
}

#[tauri::command]
pub async fn redis_set_ttl(state: tauri::State<'_, crate::AppState>, conn_id: String, key: String, ttl: i64) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    if ttl < 0 {
        let _: i64 = redis::cmd("PERSIST").arg(&key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    } else {
        let _: i64 = redis::cmd("EXPIRE").arg(&key).arg(ttl).query_async(&mut c).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_rename_key(state: tauri::State<'_, crate::AppState>, conn_id: String, old_key: String, new_key: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("RENAME").arg(&old_key).arg(&new_key).query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_flush_db(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let _: String = redis::cmd("FLUSHDB").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_info(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let mut c = take_conn(&state, &conn_id)?;
    let text: String = redis::cmd("INFO").query_async(&mut c).await.map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "info": parse_info(&text), "raw": text }))
}

#[tauri::command]
pub async fn redis_execute_cmd(state: tauri::State<'_, crate::AppState>, conn_id: String, command: String) -> Result<Value, String> {
    let tokens = tokenize(&command)?;
    if tokens.is_empty() {
        return Err("Lệnh rỗng".to_string());
    }
    let name = token_name(&tokens[0]);

    // Would put the shared multiplexed connection into push/blocking mode and break every
    // other feature using it — refused before the connection is touched at all.
    if is_blocking_cmd(&tokens) {
        return Err(format!(
            "Lệnh '{}' cần kết nối riêng — dùng tab Pub/Sub hoặc Profiler",
            name
        ));
    }
    // `SELECT n` is routed through the same path as the database picker: sent blind it would
    // switch this connection's database while every other tab open on it still showed the old
    // index — and with one `conn_id` per db index (§2.1) there is no longer any such thing as
    // "this connection's database changed". It resolves to the connection FOR that index instead,
    // and `switchDb` tells the frontend to move the workspace there. Nothing mutates behind the
    // back of a tab that is still open on the old index.
    if let Some(idx) = select_db_arg(&tokens) {
        let res = select_db_inner(&state, &conn_id, idx).await?;
        return Ok(json!({
            "success": true,
            "result": "OK",
            "selectedDb": idx,
            "switchDb": { "dbIndex": idx, "connId": res.get("connId").cloned().unwrap_or(Value::Null) },
        }));
    }
    // The read-only gate lives here, not in the UI: this command carries arbitrary text, which
    // is exactly how `FLUSHALL` used to get through while every button was disabled.
    if state.connections.is_read_only(&conn_id) && !is_read_only_cmd(&tokens) {
        return Err(format!("Lệnh '{}' bị chặn ở chế độ chỉ đọc", name));
    }

    let mut c = take_conn(&state, &conn_id)?;
    let cmd_name = String::from_utf8_lossy(&tokens[0]).to_string();
    let mut cmd = redis::cmd(&cmd_name);
    for a in &tokens[1..] {
        // Bytes, not str: an argument may be binary (`"\xff\x00"`), and a lossy conversion
        // here would write U+FFFD into the database.
        cmd.arg(&a[..]);
    }
    match cmd.query_async::<redis::Value>(&mut c).await {
        Ok(val) => Ok(json!({ "success": true, "result": redis_value_to_json(&val) })),
        Err(e) => Ok(json!({ "success": false, "message": e.to_string() })),
    }
}

// ---- Bulk delete ----

const BULK_BATCH: usize = 500;

/// Deletes every key matching a pattern, in batches, with progress and cancel.
///
/// Kept separate from `redis_delete_keys` (which takes an explicit list): the point here is
/// that the caller does *not* know the keys, so the count can only be reported as it goes.
/// `UNLINK` rather than `DEL` so freeing memory happens off the main thread.
#[tauri::command]
pub async fn redis_delete_by_pattern(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    pattern: String,
    type_filter: Option<String>,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("Chưa có pattern để xoá".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel.clone());
    }
    let type_filter = type_filter.filter(|t| !t.is_empty());
    let mut c = take_conn(&state, &conn_id)?;
    let mut cursor: u64 = 0;
    let mut scanned = 0usize;
    let mut deleted = 0i64;

    let outcome: Result<(), String> = loop {
        if cancel.load(Ordering::Relaxed) {
            break Ok(());
        }
        let scan: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(BULK_BATCH)
            .query_async(&mut c)
            .await;
        let (next, keys) = match scan {
            Ok(v) => v,
            Err(e) => break Err(e.to_string()),
        };
        scanned += keys.len();

        // Type filtering is client-side for the same reason as the key browser: `SCAN TYPE`
        // is Redis 6.0+ and KeyDB/Dragonfly answer it with a syntax error.
        let keys = match (&type_filter, keys.is_empty()) {
            (_, true) => keys,
            (None, _) => keys,
            (Some(want), _) => {
                let mut pipe = redis::pipe();
                for k in &keys {
                    pipe.cmd("TYPE").arg(k);
                }
                let types: Vec<String> = match pipe.query_async(&mut c).await {
                    Ok(v) => v,
                    Err(e) => break Err(e.to_string()),
                };
                keys.into_iter()
                    .zip(types)
                    .filter(|(_, t)| t == want)
                    .map(|(k, _)| k)
                    .collect()
            }
        };

        if !keys.is_empty() {
            match redis::cmd("UNLINK").arg(&keys).query_async::<i64>(&mut c).await {
                Ok(n) => deleted += n,
                Err(e) => break Err(e.to_string()),
            }
        }
        let _ = channel.send(json!({ "type": "progress", "scanned": scanned, "deleted": deleted }));
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
            let _ = channel.send(json!({
                "type": "done",
                "scanned": scanned,
                "deleted": deleted,
                "cancelled": cancel.load(Ordering::Relaxed),
            }));
            Ok(json!({ "success": true, "scanned": scanned, "deleted": deleted }))
        }
        Err(msg) => {
            let _ = channel.send(json!({ "type": "error", "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}

// ---- Slow log ----

fn as_i64(v: &redis::Value) -> i64 {
    match v {
        redis::Value::Int(i) => *i,
        other => as_text(other).parse().unwrap_or(0),
    }
}

// `SLOWLOG GET` entry: [id, unix-ts, duration-µs, [args…], client-addr, client-name].
// The last two fields only exist on Redis 4+, so they are read positionally and optional.
fn parse_slowlog_entry(v: &redis::Value) -> Option<Value> {
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

// ---- Pub/Sub and Profiler ----
// Both need their OWN connection: `SUBSCRIBE` and `MONITOR` switch a connection into push
// mode, and the app's `MultiplexedConnection` is shared by every other Redis feature — using
// it here would break all of them (which is why `redis_execute_cmd` refuses these commands).
// Each session is stopped through the existing `cancel_query(query_id)` path.

/// Opens a second connection to the same server/database as the active one.
async fn dedicated_client(state: &crate::AppState, conn_id: &str) -> Result<redis::Client, String> {
    let ctx = state.connections.acquire_redis(conn_id)?;
    // Config + db index của CHÍNH kết nối này, không phải của một state toàn cục: Pub/Sub và
    // Profiler mở socket riêng, và socket đó phải nằm trên đúng db mà tab của nó đang xem.
    make_client(&ctx.config(), ctx.db_index())
        .map_err(|e| format!("Không mở được kết nối riêng cho Redis: {}", e))
}

fn register_cancel(state: &crate::AppState, query_id: &str) -> Result<Arc<AtomicBool>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    flags.insert(query_id.to_string(), cancel.clone());
    Ok(cancel)
}

fn drop_cancel(app: &tauri::AppHandle, query_id: &str) {
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
const MONITOR_MAX_LINES: usize = 50_000;
const MONITOR_MAX_SECS: u64 = 60;

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

// ---- RedisJSON ----

fn ensure_json_module(state: &crate::AppState, conn_id: &str) -> Result<(), String> {
    let caps = caps_of(state, conn_id);
    // An empty module list means MODULE LIST was refused (common on managed Redis), not that
    // there are no modules — in that case let the command itself decide.
    if caps.modules.is_empty() {
        return Ok(());
    }
    if caps.has_module("rejson") || caps.has_module("json") {
        return Ok(());
    }
    Err("Server không có module RedisJSON".to_string())
}

#[tauri::command]
pub async fn redis_json_get(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    path: Option<String>,
) -> Result<Value, String> {
    ensure_json_module(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let path = path.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "$".to_string());
    let text: Option<String> = redis::cmd("JSON.GET")
        .arg(&key)
        .arg("INDENT")
        .arg("  ")
        .arg("NEWLINE")
        .arg("\n")
        .arg(&path)
        .query_async(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "path": path, "json": text }))
}

#[tauri::command]
pub async fn redis_json_set(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    path: String,
    value: String,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    ensure_json_module(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let path = if path.trim().is_empty() { "$".to_string() } else { path };
    let _: String = redis::cmd("JSON.SET")
        .arg(&key)
        .arg(&path)
        .arg(&value)
        .query_async(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn redis_json_del(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    path: String,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    ensure_json_module(&state, &conn_id)?;
    let mut c = take_conn(&state, &conn_id)?;
    let removed: i64 = redis::cmd("JSON.DEL")
        .arg(&key)
        .arg(&path)
        .query_async(&mut c)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "success": true, "removed": removed }))
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

// ---- Stream consumer groups ----

// XINFO/XPENDING replies are field-value sequences (flat array on RESP2, map on RESP3).
// Decoded generically rather than into a typed struct so a newer server adding a field does
// not make the whole reply undecodable.
fn pairs_to_json(v: &redis::Value) -> Value {
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

#[tauri::command]
pub async fn redis_stream_groups(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
) -> Result<Value, String> {
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
}

#[tauri::command]
pub async fn redis_stream_consumers(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    group: String,
) -> Result<Value, String> {
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
}

#[tauri::command]
pub async fn redis_stream_pending(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    group: String,
    count: Option<usize>,
) -> Result<Value, String> {
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
                let redis::Value::Array(a) = it else { return None };
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
}

#[tauri::command]
pub async fn redis_stream_ack(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    group: String,
    ids: Vec<String>,
) -> Result<Value, String> {
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
}

#[tauri::command]
pub async fn redis_stream_claim(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    key: String,
    group: String,
    consumer: String,
    min_idle_ms: i64,
    ids: Vec<String>,
) -> Result<Value, String> {
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
}

// ---- Database analysis ----

// Same ceiling RedisInsight uses. Past this the report is extrapolated from the sample and
// says so — a number presented as exact would be a lie on a database with millions of keys.
const ANALYZE_SAMPLE_MAX: usize = 10_000;

/// First namespace segment of a key (`user:42:name` -> `user`). Depth 1 is enough for a
/// report; the sidebar's tree does the deeper grouping.
fn namespace_of(key: &str) -> String {
    match key.split_once(':') {
        Some((head, _)) if !head.is_empty() => head.to_string(),
        _ => "(no namespace)".to_string(),
    }
}

#[tauri::command]
pub async fn redis_analyze_db(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    sample: Option<usize>,
    query_id: String,
    channel: Channel<Value>,
) -> Result<Value, String> {
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
