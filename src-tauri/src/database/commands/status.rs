//! Trạng thái kết nối: ping độ trễ của mọi kết nối, và bản mô tả đầy đủ của một kết nối.

use serde_json::{json, Value};
use sqlx::Row;

use crate::database::DbKind;

#[derive(serde::Serialize)]
pub struct ConnectionStatusInfo {
    pub is_connected: bool,
    pub db_type: String,
    pub conn_type: String,
    pub host: String,
    pub latency_ms: u64,
    /// Server version as the server reports it ("8.4.3", "16.2 (Debian…)"), empty when unreadable.
    pub server_version: String,
    /// Account the session is authenticated as. Empty for SQLite (there is none).
    pub user: String,
    /// Database the session is currently using.
    pub database: String,
    /// TCP port. 0 for SQLite.
    pub port: u16,
    /// Negotiated TLS cipher suite. Empty when the session is not encrypted.
    pub cipher: String,
    /// Negotiated TLS protocol version. Empty when the session is not encrypted.
    pub tls_version: String,
}

/// Latency của **mọi** kết nối đang mở, một `SELECT 1` cho mỗi cái, chạy song song.
///
/// Không dùng `get_connection_status` cho việc này: lệnh đó còn hỏi version, user và TLS, tức 3–5
/// round trip cho *một* kết nối. Gọi nó N lần mỗi khi mở Quick Switcher là bắt một cái menu chờ vài
/// trăm ms — đó chính là lý do lệnh này tồn tại riêng.
///
/// **Đi thẳng vào pool, không qua `execute_raw_sql_generic`.** Nếu đi qua đó thì `should_route` sẽ
/// đẩy câu này vào phiên transaction khi người dùng đang bật commit thủ công, và `run_raw` gọi
/// `ensure_begin` ở câu **đầu tiên bất kể nó là gì** — một cú ping nền sẽ âm thầm MỞ transaction
/// trên mọi kết nối, rồi bộ đếm "đang chờ commit" nói về những thứ người dùng chưa từng gõ. Ping là
/// thao tác đọc trạng thái; nó không được để lại dấu vết nào.
///
/// Không nhận `conn_id`: đây là câu hỏi về registry, giống `list_connections`, không phải về một kết
/// nối. Lỗi của một kết nối trả về `ok: false` chứ không làm cả lệnh thất bại — một server đã ngắt
/// là *thông tin* mà UI cần hiện, không phải lỗi che nốt N-1 kết nối còn lại.
#[tauri::command]
pub async fn ping_connections(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let handles = state.connections.handles()?;
    let pings = futures_util::future::join_all(handles.into_iter().map(|(id, conn)| async move {
        let started = std::time::Instant::now();
        let ok = match &conn.kind {
            // SQLite là handle dùng chung sau `Mutex`: một `SELECT 1` là vi giây, nhưng khoá đang bị
            // giữ bởi một truy vấn dài thì ping sẽ chờ theo. Đó là sự thật đáng hiện — kết nối ấy
            // *đang* bận — nên không cố lách bằng `try_lock`.
            DbKind::Sqlite(arc) => arc
                .lock()
                .map(|c| c.execute_batch("SELECT 1;").is_ok())
                .unwrap_or(false),
            DbKind::Postgres(pool) => sqlx::query("SELECT 1;").execute(pool).await.is_ok(),
            DbKind::Mysql(pool) => sqlx::query("SELECT 1;").execute(pool).await.is_ok(),
        };
        json!({ "connId": &*id, "ok": ok, "latencyMs": started.elapsed().as_millis() as u64 })
    }))
    .await;
    Ok(json!({ "success": true, "pings": pings }))
}

impl ConnectionStatusInfo {
    fn disconnected() -> Self {
        ConnectionStatusInfo {
            is_connected: false,
            db_type: String::new(),
            conn_type: "loc".to_string(),
            host: String::new(),
            latency_ms: 0,
            server_version: String::new(),
            user: String::new(),
            database: String::new(),
            port: 0,
            cipher: String::new(),
            tls_version: String::new(),
        }
    }
}

/// Giá trị của một biến trạng thái MySQL (`SHOW SESSION STATUS LIKE …`).
///
/// Nhận nguyên câu lệnh dạng literal chứ không ghép tên biến vào chuỗi: sqlx 0.9
/// chỉ cài `SqlSafeStr` cho `&'static str`, và ở đây cũng chẳng có gì động —
/// tên biến luôn là hằng, nên không cần tới `AssertSqlSafe` như các chỗ dựng SQL
/// từ tên bảng/cột trong file này.
///
/// Chạy trên một connection khác trong pool vẫn cho kết quả đúng: cấu hình TLS
/// là của cả pool nên mọi session đều thương lượng ra cùng cipher/version.
/// MySQL trả `Ssl_cipher` là chuỗi rỗng khi phiên không mã hoá.
async fn mysql_status_var(pool: &sqlx::MySqlPool, sql: &'static str) -> String {
    match sqlx::query(sql).fetch_optional(pool).await {
        // Cột 1 là `Value`; lấy theo chỉ số chứ không theo tên cho khớp quy ước
        // chống trùng tên cột của file này.
        Ok(Some(row)) => row.try_get::<String, _>(1).unwrap_or_default(),
        _ => String::new(),
    }
}

/// Trả về trạng thái kết nối DB hiện tại, loại kết nối (loc/ssh/ssl/rem) và độ trễ ping (ms).
#[tauri::command]
pub async fn get_connection_status(
    // `State`/`AppState` không được import ở đầu file — mọi command khác trong file đều viết
    // đường dẫn đầy đủ, giữ nguyên quy ước đó.
    state: tauri::State<'_, crate::AppState>, conn_id: String,
) -> Result<ConnectionStatusInfo, String> {
    let start = std::time::Instant::now();
    let (conn, db_type, config, has_ssh) = {
        // `.ok()`, không phải `?`: không có kết nối SQL là trạng thái được DUNG THỨ ở đây — nhánh
        // Redis phía dưới mới là câu trả lời khi đó. Dùng `?` sẽ biến "chưa kết nối SQL" thành lỗi
        // và chặn luôn đường Redis.
        match state.connections.acquire(&conn_id).ok() {
            Some(ctx) => (
                Some(ctx.conn().clone()),
                ctx.server().db_type.clone(),
                Some(ctx.server().config()),
                ctx.server().ssh_tunnel.is_some(),
            ),
            None => (None, String::new(), None, false),
        }
    };

    let conn = match conn {
        Some(c) => c,
        None => {
            // Check Redis connection
            // Cùng `conn_id`, chỉ khác loại kết nối. Redis đã nằm trong registry nên không còn
            // phải hỏi một state toàn cục "có kết nối Redis nào không" — câu hỏi đó không có câu
            // trả lời đúng khi hai kết nối Redis cùng mở.
            let (redis_conn, redis_config, redis_db_index, has_redis_ssh, caps) =
                match state.connections.acquire_redis(&conn_id) {
                    Ok(ctx) => (
                        Some(ctx.conn()),
                        Some(ctx.config()),
                        ctx.db_index(),
                        ctx.has_ssh_tunnel(),
                        ctx.caps(),
                    ),
                    Err(_) => (None, None, 0, false, crate::redis_db::RedisCaps::default()),
                };

            if let Some(mut r_conn) = redis_conn {
                let start = std::time::Instant::now();
                let _ = redis::cmd("PING").query_async::<String>(&mut r_conn).await;
                let latency_ms = start.elapsed().as_millis() as u64;

                let host = redis_config
                    .as_ref()
                    .and_then(|c| c.get("host"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("localhost")
                    .to_string();

                let port = redis_config
                    .as_ref()
                    .and_then(|c| c.get("port"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(6379) as u16;

                let user = redis_config
                    .as_ref()
                    .and_then(|c| c.get("username").or_else(|| c.get("user")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default")
                    .to_string();

                let ssl_mode = redis_config
                    .as_ref()
                    .and_then(|c| c.get("sslMode"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("DISABLED");

                let conn_type = if has_redis_ssh
                    || redis_config
                        .as_ref()
                        .and_then(|c| c.get("useSshTunnel"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                {
                    "ssh".to_string()
                } else if ssl_mode != "DISABLED" {
                    "ssl".to_string()
                } else if host == "localhost"
                    || host == "127.0.0.1"
                    || host == "::1"
                    || host.starts_with("127.")
                {
                    "loc".to_string()
                } else {
                    "rem".to_string()
                };

                let database = format!("db{}", redis_db_index);
                let server_version = caps.version;

                return Ok(ConnectionStatusInfo {
                    is_connected: true,
                    db_type: "redis".to_string(),
                    conn_type,
                    host,
                    latency_ms,
                    server_version,
                    user,
                    database,
                    port,
                    cipher: if ssl_mode != "DISABLED" { "TLS".to_string() } else { String::new() },
                    tls_version: if ssl_mode != "DISABLED" { ssl_mode.to_string() } else { String::new() },
                });
            }

            return Ok(ConnectionStatusInfo::disconnected());
        }
    };

    match &conn.kind {
        DbKind::Sqlite(arc) => {
            if let Ok(conn) = arc.lock() {
                let _ = conn.execute_batch("SELECT 1;");
            }
        }
        DbKind::Postgres(pool) => {
            let _ = sqlx::query("SELECT 1;").execute(pool).await;
        }
        DbKind::Mysql(pool) => {
            let _ = sqlx::query("SELECT 1;").execute(pool).await;
        }
    }
    let latency_ms = start.elapsed().as_millis() as u64;

    // Thông tin phiên hiển thị trong popover kết nối. Mọi truy vấn ở đây đều
    // "best effort": lỗi thì để trống chứ không làm hỏng cả status pill.
    // Phần TLS tách khỏi phần version/user vì `pg_stat_ssl` không tồn tại trên
    // Postgres cũ — gộp chung thì một server cũ mất luôn cả version lẫn user.
    let (server_version, session_user, session_db, cipher, tls_version) = match &conn.kind {
        DbKind::Sqlite(arc) => {
            let version = arc
                .lock()
                .ok()
                .and_then(|c| {
                    c.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))
                        .ok()
                })
                .unwrap_or_default();
            (version, String::new(), String::new(), String::new(), String::new())
        }
        DbKind::Postgres(pool) => {
            // `current_user`/`current_database()` có kiểu `name`, sqlx không giải mã
            // thẳng sang String được nên phải ép ::text.
            let (version, user, db) = match sqlx::query(
                "SELECT current_setting('server_version'), current_user::text, current_database()::text",
            )
            .fetch_optional(pool)
            .await
            {
                Ok(Some(r)) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                    r.try_get::<String, _>(2).unwrap_or_default(),
                ),
                _ => (String::new(), String::new(), String::new()),
            };
            let (cipher, tls) = match sqlx::query(
                "SELECT COALESCE(cipher, ''), COALESCE(version, '') \
                 FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
            )
            .fetch_optional(pool)
            .await
            {
                Ok(Some(r)) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                ),
                _ => (String::new(), String::new()),
            };
            (version, user, db, cipher, tls)
        }
        DbKind::Mysql(pool) => {
            let (version, user, db) = match sqlx::query(
                "SELECT VERSION(), CURRENT_USER(), COALESCE(DATABASE(), '')",
            )
            .fetch_optional(pool)
            .await
            {
                Ok(Some(r)) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                    r.try_get::<String, _>(2).unwrap_or_default(),
                ),
                _ => (String::new(), String::new(), String::new()),
            };
            let cipher = mysql_status_var(pool, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
            let tls = mysql_status_var(pool, "SHOW SESSION STATUS LIKE 'Ssl_version'").await;
            (version, user, db, cipher, tls)
        }
    };

    let host = config
        .as_ref()
        .and_then(|c| c.get("host"))
        .and_then(|v| v.as_str())
        .unwrap_or("localhost")
        .to_string();

    let conn_type = if db_type == "sqlite" {
        "loc".to_string()
    } else if has_ssh
        || config
            .as_ref()
            .and_then(|c| c.get("useSshTunnel"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    {
        "ssh".to_string()
    } else if config
        .as_ref()
        .and_then(|c| c.get("sslEnabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || config
            .as_ref()
            .and_then(|c| c.get("sslMode"))
            .and_then(|v| v.as_str())
            .unwrap_or("DISABLED")
            != "DISABLED"
    {
        "ssl".to_string()
    } else if host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.starts_with("127.")
    {
        "loc".to_string()
    } else {
        "rem".to_string()
    };

    let port = config
        .as_ref()
        .and_then(|c| c.get("port"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u16;

    // SQLite không có khái niệm "database đang dùng" — hiển thị đường dẫn file thay vào đó.
    let database = if session_db.is_empty() {
        config
            .as_ref()
            .and_then(|c| c.get("database").or_else(|| c.get("sqlitePath")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        session_db
    };

    Ok(ConnectionStatusInfo {
        is_connected: true,
        db_type,
        conn_type,
        host,
        latency_ms,
        server_version,
        user: session_user,
        database,
        port,
        cipher,
        tls_version,
    })
}
