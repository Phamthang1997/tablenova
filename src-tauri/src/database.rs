use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use rusqlite::Connection as SqliteConnection;
// ValueRef: cần cho nhánh dự phòng đọc byte thô trong decode_pg_cell!/decode_mysql_cell!.
use sqlx::{PgPool, MySqlPool, Row, Column, Executor, Statement, SqlSafeStr, ValueRef};
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::Manager;
use futures_util::TryStreamExt;
use crate::ssh_tunnel::SshTunnel;

// Chu kỳ làm mới token IAM (token sống 15 phút -> dựng lại pool trước khi hết hạn).
const IAM_REFRESH_SECS: u64 = 780;

// Số dòng gom lại trước mỗi lần đẩy batch qua Channel về frontend khi stream kết quả SQL.
const STREAM_BATCH: usize = 500;

// Timeout cho lệnh liệt kê database (nút "Tải danh sách" ở form kết nối).
// Mặc định của sqlx là 30s — quá lâu cho một thao tác dò thông tin, người dùng
// tưởng app treo. 10s đủ cho cả máy chủ ở xa mà vẫn báo lỗi sớm.
const LIST_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// Giải mã một ô dữ liệu Postgres sang serde_json::Value.
// Thử lần lượt nhiều kiểu để không mất dữ liệu: số nguyên/thực, bool, NUMERIC, ngày giờ, UUID, JSON, chuỗi, blob.
// Kiểu ngày/số thập phân/json/uuid được hỗ trợ nhờ bật feature trên sqlx-postgres (không kéo sqlx-sqlite).
macro_rules! decode_pg_cell {
    // `$col` may be a column name OR a 0-based index (both implement sqlx::ColumnIndex).
    // Callers reading a result set must pass the INDEX: `try_get` by name resolves to the
    // first column with that name, so `SELECT *` over joins would return that same first
    // value for every repeated name.
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col = $col;
        if let Ok(v) = row.try_get::<Option<i16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bool>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bigdecimal::BigDecimal>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col) { v.map(|x| json!(x.to_rfc3339())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<String>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        // Last resort: hand back the raw bytes the server sent.
        //
        // Every branch above asks sqlx to decode into a Rust type, and sqlx first checks that
        // the column's type id is compatible — so a type it has no mapping for (MySQL GEOMETRY
        // is the one that bit us: sakila's `address.location`) failed every branch and fell
        // into `Value::Null`. The cell then exported as NULL, and re-importing that dump died
        // on `location` being NOT NULL — silent data loss that only surfaced on the way back.
        // `try_get` is what enforces that check; calling Decode directly on the raw value skips
        // it, so anything the server sent survives as bytes. (`MySqlValueRef::as_bytes` is
        // pub(crate) in sqlx 0.9, hence going through Decode rather than reading it off.)
        else {
            match row.try_get_raw(col) {
                Ok(raw) if !raw.is_null() => {
                    match <Vec<u8> as sqlx::Decode<'_, sqlx::Postgres>>::decode(raw) {
                        // Postgres sends most of what lands here as text: an ENUM arrives as its
                        // label, and so do inet/interval/tsvector. Handing those back as an array
                        // of byte numbers would trade one wrong answer for another, so valid
                        // UTF-8 becomes a string and only genuinely binary payloads stay bytes.
                        Ok(b) => match std::str::from_utf8(&b) {
                            Ok(s) => json!(s),
                            Err(_) => json!(b),
                        },
                        Err(_) => Value::Null,
                    }
                }
                _ => Value::Null,
            }
        }
    }};
}

// Giải mã một ô dữ liệu MySQL (bao gồm cả kiểu số không dấu, DECIMAL, ngày giờ, JSON).
macro_rules! decode_mysql_cell {
    // Same contract as decode_pg_cell!: pass the 0-based INDEX when reading a result set.
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col = $col;
        if let Ok(v) = row.try_get::<Option<i8>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u8>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bool>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bigdecimal::BigDecimal>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col) { v.map(|x| json!(x.to_rfc3339())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<String>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        // Last resort: hand back the raw bytes the server sent.
        //
        // Every branch above asks sqlx to decode into a Rust type, and sqlx first checks that
        // the column's type id is compatible — so a type it has no mapping for (MySQL GEOMETRY
        // is the one that bit us: sakila's `address.location`) failed every branch and fell
        // into `Value::Null`. The cell then exported as NULL, and re-importing that dump died
        // on `location` being NOT NULL — silent data loss that only surfaced on the way back.
        // `try_get` is what enforces that check; calling Decode directly on the raw value skips
        // it, so anything the server sent survives as bytes. (`MySqlValueRef::as_bytes` is
        // pub(crate) in sqlx 0.9, hence going through Decode rather than reading it off.)
        else {
            match row.try_get_raw(col) {
                Ok(raw) if !raw.is_null() => {
                    match <Vec<u8> as sqlx::Decode<'_, sqlx::MySql>>::decode(raw) {
                        Ok(b) => json!(b),
                        Err(_) => Value::Null,
                    }
                }
                _ => Value::Null,
            }
        }
    }};
}

// Chuyển một giá trị JSON (do frontend gửi kèm tham số truy vấn) sang rusqlite Value để bind.
// Dùng cho parameterized query ở SQLite — tránh nội suy chuỗi (chống SQL injection).
fn json_to_sqlite_value(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SV;
    match v {
        Value::Null => SV::Null,
        Value::Bool(b) => SV::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) if n.is_i64() => SV::Integer(n.as_i64().unwrap()),
        Value::Number(n) if n.is_u64() => SV::Integer(n.as_u64().unwrap() as i64),
        Value::Number(n) => SV::Real(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => SV::Text(s.clone()),
        other => SV::Text(other.to_string()),
    }
}

// Bind lần lượt danh sách tham số JSON vào một sqlx::query cho Postgres (giữ nguyên kiểu để DB không báo lỗi cast).
fn bind_pg_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &[Value],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
            Value::Number(n) if n.is_u64() => q.bind(n.as_u64().unwrap() as i64),
            Value::Number(n) => q.bind(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => q.bind(s.clone()),
            other => q.bind(other.to_string()),
        };
    }
    q
}

// Bind lần lượt danh sách tham số JSON vào một sqlx::query cho MySQL.
fn bind_mysql_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &[Value],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
            Value::Number(n) if n.is_u64() => q.bind(n.as_u64().unwrap() as i64),
            Value::Number(n) => q.bind(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => q.bind(s.clone()),
            other => q.bind(other.to_string()),
        };
    }
    q
}

#[derive(Clone)]
pub enum DbConnection {
    Sqlite(Arc<Mutex<SqliteConnection>>),
    Postgres(PgPool),
    Mysql(MySqlPool),
}

pub struct DatabaseManager {
    pub connection: Option<DbConnection>,
    pub db_type: String,
    pub ssh_tunnel: Option<SshTunnel>,
    pub last_config: Option<Value>,
}

// Mã hóa thành phần user/password để tránh vỡ URL khi có ký tự đặc biệt (@, :, /, ...)
fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Dựng chuỗi kết nối Postgres kèm cấu hình SSL (sslmode + sslrootcert nếu có)
pub(crate) fn build_pg_url(config: &Value, db_override: Option<&str>) -> String {
    let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("localhost");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(5432);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let mut database = db_override.unwrap_or_else(|| config.get("database").and_then(|v| v.as_str()).unwrap_or(""));
    if database.trim().is_empty() {
        database = "postgres";
    }

    let mut url = format!(
        "postgres://{}:{}@{}:{}/{}",
        url_encode_component(user), url_encode_component(password), host, port, database
    );

    // SSL: map các giá trị UI (DISABLED/PREFERRED/REQUIRED/VERIFY_CA/VERIFY_IDENTITY) -> sslmode của Postgres
    let ssl_mode_ui = config.get("sslMode").and_then(|v| v.as_str()).unwrap_or("DISABLED");
    let ssl_enabled = config.get("sslEnabled").and_then(|v| v.as_bool()).unwrap_or(false) || ssl_mode_ui != "DISABLED";
    if ssl_enabled {
        let pg_mode = match ssl_mode_ui {
            "PREFERRED" => "prefer",
            "REQUIRED" => "require",
            "VERIFY_CA" => "verify-ca",
            "VERIFY_IDENTITY" => "verify-full",
            "DISABLED" => "require", // sslEnabled=true nhưng mode chưa đặt -> mặc định require
            other => other,
        };
        url.push_str(&format!("?sslmode={}", pg_mode));
        if let Some(ca) = config.get("sslCaPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&sslrootcert={}", ca));
        }
        if let Some(cert) = config.get("sslCertPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&sslcert={}", cert));
        }
        if let Some(key) = config.get("sslKeyPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&sslkey={}", key));
        }
    } else {
        // Phải nói rõ "disable": không truyền sslmode thì sqlx dùng default
        // PgSslMode::Prefer (vẫn bật TLS nếu server hỗ trợ) và còn đọc cả biến
        // môi trường PGSSLMODE -> UI chọn DISABLED mà thực tế lại đang mã hoá.
        url.push_str("?sslmode=disable");
    }
    url
}

// Dựng chuỗi kết nối MySQL kèm cấu hình SSL (ssl-mode + ssl-ca nếu có)
pub(crate) fn build_mysql_url(config: &Value, db_override: Option<&str>) -> String {
    let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("localhost");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(3306);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let mut database = db_override.unwrap_or_else(|| config.get("database").and_then(|v| v.as_str()).unwrap_or(""));
    if database.trim().is_empty() {
        database = "mysql";
    }

    let mut url = format!(
        "mysql://{}:{}@{}:{}/{}",
        url_encode_component(user), url_encode_component(password), host, port, database
    );

    // SSL: các giá trị UI trùng khớp với ssl-mode của sqlx MySQL
    let ssl_mode_ui = config.get("sslMode").and_then(|v| v.as_str()).unwrap_or("DISABLED");
    let ssl_enabled = config.get("sslEnabled").and_then(|v| v.as_bool()).unwrap_or(false) || ssl_mode_ui != "DISABLED";
    if ssl_enabled {
        let my_mode = if ssl_mode_ui == "DISABLED" { "REQUIRED" } else { ssl_mode_ui };
        url.push_str(&format!("?ssl-mode={}", my_mode));
        if let Some(ca) = config.get("sslCaPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&ssl-ca={}", ca));
        }
        if let Some(cert) = config.get("sslCertPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&ssl-cert={}", cert));
        }
        if let Some(key) = config.get("sslKeyPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&ssl-key={}", key));
        }
    } else {
        // Tương tự Postgres: default của sqlx là MySqlSslMode::Preferred.
        url.push_str("?ssl-mode=DISABLED");
    }
    url
}

// Nếu bật SSH, mở tunnel tới (host, port) hiện tại của config và trả về config đã chỉnh
// để trỏ kết nối tới 127.0.0.1:<local_port>. Trả về (config_dùng_để_kết_nối, tunnel).
pub(crate) async fn apply_ssh_tunnel(config: &Value, default_port: u16) -> Result<(Value, Option<SshTunnel>), String> {
    let use_ssh = config.get("useSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    if !use_ssh {
        return Ok((config.clone(), None));
    }
    let db_host = config.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let db_port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(default_port as u64) as u16;

    let tunnel = SshTunnel::open(config, db_host, db_port).await?;
    let local_port = tunnel.local_port;

    let mut tunneled = config.clone();
    if let Some(obj) = tunneled.as_object_mut() {
        obj.insert("host".to_string(), json!("127.0.0.1"));
        obj.insert("port".to_string(), json!(local_port));
    }
    Ok((tunneled, Some(tunnel)))
}

fn is_iam(config: &Value) -> bool {
    config.get("authMethod").and_then(|v| v.as_str()) == Some("aws_iam")
}

// Nếu dùng AWS IAM: sinh token và gán làm password cho conn_config, đồng thời ép SSL (IAM bắt buộc SSL).
// Token ký từ ORIGINAL config (host/region thật), nên gọi trước khi dùng conn_config đã qua tunnel.
pub(crate) fn apply_iam_password(orig_config: &Value, conn_config: &mut Value, default_port: u16) -> Result<(), String> {
    if !is_iam(orig_config) {
        return Ok(());
    }
    let token = crate::aws_iam::generate_rds_token(orig_config, default_port)?;
    if let Some(obj) = conn_config.as_object_mut() {
        obj.insert("password".to_string(), json!(token));
        let mode = obj.get("sslMode").and_then(|v| v.as_str()).unwrap_or("DISABLED");
        if mode == "DISABLED" || mode == "PREFERRED" {
            obj.insert("sslMode".to_string(), json!("REQUIRED"));
        }
        obj.insert("sslEnabled".to_string(), json!(true));
    }
    Ok(())
}

// Dựng lại pool IAM với token mới (không qua SSH tunnel — IAM refresh giả định kết nối trực tiếp RDS).
async fn build_iam_conn(db_type: &str, orig_config: &Value) -> Result<DbConnection, String> {
    let default_port = if db_type == "postgres" { 5432 } else { 3306 };
    let mut conn_config = orig_config.clone();
    apply_iam_password(orig_config, &mut conn_config, default_port)?;
    match db_type {
        "postgres" => Ok(DbConnection::Postgres(
            PgPool::connect(&build_pg_url(&conn_config, None)).await.map_err(|e| e.to_string())?,
        )),
        "mysql" => Ok(DbConnection::Mysql(
            MySqlPool::connect(&build_mysql_url(&conn_config, None)).await.map_err(|e| e.to_string())?,
        )),
        _ => Err("IAM chỉ hỗ trợ postgres/mysql".to_string()),
    }
}

// Task nền: cứ ~13 phút sinh token mới và thay pool, chừng nào kết nối vẫn còn "đời" (generation) này.
fn spawn_iam_refresh(app: tauri::AppHandle, db_type: String, config: Value, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(IAM_REFRESH_SECS)).await;
            let state = app.state::<crate::AppState>();
            if state.conn_generation.load(Ordering::SeqCst) != generation {
                break; // đã connect/disconnect khác -> dừng
            }
            // Replacing the pool would drop the connection an open manual transaction is pinned to,
            // silently losing everything the user has not committed. The token is still valid for
            // ~2 more minutes; wait for the next cycle instead.
            if crate::tx_session::is_open() {
                continue;
            }
            match build_iam_conn(&db_type, &config).await {
                Ok(new_conn) => {
                    if let Ok(mut m) = state.db_manager.lock() {
                        if state.conn_generation.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        m.connection = Some(new_conn);
                    }
                }
                Err(_) => { /* lỗi tạm thời -> thử lại chu kỳ sau */ }
            }
        }
    });
}

#[tauri::command]
pub async fn connect_db(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, config: Value) -> Result<Value, String> {
    let db_type = config.get("dbType").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // The old connection is about to be replaced: roll back and clear any manual transaction on it
    // first. Isolation levels are dialect-specific, so the whole transaction preference resets.
    {
        let prev = state.db_manager.lock().ok().and_then(|m| m.connection.clone());
        crate::tx_session::reset(prev.as_ref()).await;
    }

    // Mỗi lần connect tăng generation -> vô hiệu task refresh IAM của kết nối trước đó
    let generation = state.conn_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let mut ssh_tunnel: Option<SshTunnel> = None;

    let conn = match db_type.as_str() {
        "sqlite" => {
            let path = config.get("filePath").and_then(|v| v.as_str()).ok_or("Thiếu đường dẫn tệp SQLite")?;
            let conn = SqliteConnection::open(path).map_err(|e| e.to_string())?;
            DbConnection::Sqlite(Arc::new(Mutex::new(conn)))
        }
        "postgres" => {
            let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 5432).await?;
            ssh_tunnel = tunnel;
            apply_iam_password(&config, &mut conn_config, 5432)?;
            let url = build_pg_url(&conn_config, None);
            let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbConnection::Postgres(pool)
        }
        "mysql" => {
            let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 3306).await?;
            ssh_tunnel = tunnel;
            apply_iam_password(&config, &mut conn_config, 3306)?;
            let url = build_mysql_url(&conn_config, None);
            let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbConnection::Mysql(pool)
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    };

    {
        let mut manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        manager.connection = Some(conn);
        manager.db_type = db_type.clone();
        manager.ssh_tunnel = ssh_tunnel; // thay tunnel cũ (drop tunnel cũ nếu có)
        manager.last_config = Some(config.clone());
    }

    // Kết nối IAM: chạy task làm mới token định kỳ (token chỉ sống 15 phút)
    if is_iam(&config) && (db_type == "postgres" || db_type == "mysql") {
        spawn_iam_refresh(app, db_type, config, generation);
    }

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn disconnect_db(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    // Roll back an open manual transaction while the connection still exists. Dropping the pool
    // with a transaction open leaves the server holding its locks until it notices the socket died.
    {
        let prev = state.db_manager.lock().ok().and_then(|m| m.connection.clone());
        crate::tx_session::reset(prev.as_ref()).await;
    }
    // Vô hiệu task refresh IAM (nếu có)
    state.conn_generation.fetch_add(1, Ordering::SeqCst);
    let mut manager = state.db_manager.lock().map_err(|e| e.to_string())?;
    manager.connection = None;
    manager.db_type = String::new();
    manager.ssh_tunnel = None;
    manager.last_config = None;
    Ok(json!({ "success": true }))
}

// Lấy toàn bộ catalog (bảng + cột/kiểu/PK + FK) trong ÍT truy vấn để smart-completion nạp 1 lần
// thay vì gọi get_table_schema từng bảng. Chỉ MySQL/Postgres (dùng information_schema);
// SQLite trả về rỗng -> frontend fallback lazy per-table.
fn rows_of(res: &[Value]) -> Vec<Value> {
    res.get(0)
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}
fn cell<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// Makes the column names of a result set unique, in place.
///
/// Every row we hand to the frontend is a JSON object keyed by column name, so two
/// columns with the same name would collapse into one: `serde_json::Map::insert`
/// overwrites, and all but the last value is lost without any error. `SELECT *` over
/// a few joins hits this immediately — sakila's `film JOIN inventory JOIN store JOIN
/// address JOIN city` yields five `last_update` columns and three `film_id`s.
///
/// Repeats get a ` (2)`, ` (3)`, … suffix. The caller must build the row map from the
/// SAME (already uniquified) vector, so the frontend's `row[col]` lookups still
/// resolve — the suffix is the only thing that changes, and it shows up in the grid
/// header exactly where a duplicate really exists.
fn uniquify_columns(columns: &mut [String]) {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for i in 0..columns.len() {
        let base = columns[i].clone();
        // Scoped so the mutable borrow of `seen` ends before the lookup below.
        let count = {
            let c = seen.entry(base.clone()).or_insert(0);
            *c += 1;
            *c
        };
        if count == 1 {
            continue;
        }
        // A real column could already be named "x (2)", so keep bumping until free.
        let mut n = count;
        let mut candidate = format!("{base} ({n})");
        while seen.contains_key(&candidate) {
            n += 1;
            candidate = format!("{base} ({n})");
        }
        seen.insert(candidate.clone(), 1);
        columns[i] = candidate;
    }
}

#[tauri::command]
pub async fn get_full_catalog(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let (conn_type, db_type) = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        let ct = match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(c)) => DbConnection::Sqlite(c.clone()),
            Some(DbConnection::Postgres(p)) => DbConnection::Postgres(p.clone()),
            Some(DbConnection::Mysql(p)) => DbConnection::Mysql(p.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        };
        (ct, manager.db_type.clone())
    };

    let mut columns_map = serde_json::Map::new(); // table -> [{name,type,isPrimaryKey}]
    let mut fk_map = serde_json::Map::new();      // table -> [{column,refTable,refColumn}]

    if db_type == "mysql" {
        let col_sql = "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, col_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = columns_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "name": cell(&row, "c"), "type": cell(&row, "ty"), "isPrimaryKey": cell(&row, "k") == "PRI" }));
            }
        }
        let fk_sql = "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, fk_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = fk_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "column": cell(&row, "c"), "refTable": cell(&row, "rt"), "refColumn": cell(&row, "rc") }));
            }
        }
    } else if db_type == "postgres" {
        // format_type() so hover/completion shows `varchar(45)` like the MySQL branch
        // above (COLUMN_TYPE) instead of information_schema's bare `character varying`.
        let col_sql = "SELECT cl.relname::text AS t, a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS ty \
                       FROM pg_attribute a \
                       JOIN pg_class cl ON cl.oid = a.attrelid \
                       JOIN pg_namespace n ON n.oid = cl.relnamespace \
                       WHERE n.nspname = 'public' AND cl.relkind IN ('r','v','m','p','f') \
                         AND a.attnum > 0 AND NOT a.attisdropped \
                       ORDER BY cl.relname, a.attnum".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, col_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = columns_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "name": cell(&row, "c"), "type": cell(&row, "ty"), "isPrimaryKey": false }));
            }
        }
        // PK: đánh dấu isPrimaryKey
        let pk_sql = "SELECT tc.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, pk_sql).await?) {
            let t = cell(&row, "t");
            let c = cell(&row, "c");
            if let Some(arr) = columns_map.get_mut(t).and_then(|v| v.as_array_mut()) {
                for col in arr.iter_mut() {
                    if col.get("name").and_then(|v| v.as_str()) == Some(c) {
                        if let Some(o) = col.as_object_mut() { o.insert("isPrimaryKey".into(), json!(true)); }
                    }
                }
            }
        }
        let fk_sql = "SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'".to_string();
        for row in rows_of(&execute_raw_sql_generic(&conn_type, fk_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = fk_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "column": cell(&row, "c"), "refTable": cell(&row, "rt"), "refColumn": cell(&row, "rc") }));
            }
        }
    }
    // SQLite: trả rỗng -> frontend tự lazy per-table

    Ok(json!({ "columns": columns_map, "foreignKeys": fk_map }))
}

#[tauri::command]
pub async fn get_tables(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    
    let mut tables = Vec::new();
    
    match conn_type {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                let name: String = row.get(0)?;
                let table_type: String = row.get(1)?;
                Ok(json!({
                    "name": name,
                    "type": if table_type == "view" { "view" } else { "table" }
                }))
            }).map_err(|e| e.to_string())?;
            for row in rows {
                if let Ok(val) = row {
                    tables.push(val);
                }
            }
        }
        DbConnection::Postgres(pool) => {
            // information_schema.tables has no materialized view in it (it is not in the SQL
            // standard), so a matview used to be invisible everywhere in the app — sidebar,
            // export, compare. pg_class.relkind = 'm' is the only place it shows up.
            let rows = sqlx::query(
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' \
                 UNION ALL \
                 SELECT c.relname, 'VIEW' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relkind = 'm'")
                .fetch_all(&pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let name: String = r.get(0);
                let t_type: String = r.get(1);
                tables.push(json!({
                    "name": name,
                    "type": if t_type == "VIEW" { "view" } else { "table" }
                }));
            }
        }
        DbConnection::Mysql(pool) => {
            let rows = sqlx::query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()")
                .fetch_all(&pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let name: String = r.get(0);
                let t_type: String = r.get(1);
                tables.push(json!({
                    "name": name,
                    "type": if t_type == "VIEW" { "view" } else { "table" }
                }));
            }
        }
    }
    
    Ok(json!({ "success": true, "tables": tables }))
}

#[tauri::command]
pub async fn get_table_data(
    state: tauri::State<'_, crate::AppState>,
    name: String,
    page: u32,
    limit: u32,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    filter: Option<String>,
) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let is_mysql = matches!(&conn_type, DbConnection::Mysql(_));
    // Ký tự trích dẫn định danh theo dialect: MySQL dùng backtick, còn lại dùng dấu nháy kép
    let q = if is_mysql { '`' } else { '"' };

    // WHERE: frontend đã dựng mệnh đề lọc đúng dialect, chỉ ghép thô vào sau WHERE
    let where_clause = match filter.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(f) => format!(" WHERE {}", f),
        None => String::new(),
    };

    // ORDER BY: chỉ nhận tên cột (được trích dẫn lại) + chiều ASC/DESC đã chuẩn hóa
    let order_clause = match sort_by.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(col) => {
            let dir = match sort_dir.as_deref() {
                Some(d) if d.eq_ignore_ascii_case("desc") => "DESC",
                _ => "ASC",
            };
            // loại bỏ ký tự trích dẫn có sẵn để tránh phá cú pháp, rồi tự bọc lại
            let safe_col = col.replace('`', "").replace('"', "");
            format!(" ORDER BY {}{}{} {}", q, safe_col, q, dir)
        }
        None => String::new(),
    };

    let offset = (page.saturating_sub(1)) * limit;
    let sql = format!(
        "SELECT * FROM {q}{name}{q}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}",
        q = q, name = name, where_clause = where_clause, order_clause = order_clause, limit = limit, offset = offset
    );
    let count_sql = format!(
        "SELECT COUNT(*) FROM {q}{name}{q}{where_clause}",
        q = q, name = name, where_clause = where_clause
    );
    
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    let mut total_count: i64 = 0;
    
    match &conn_type {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            
            // Lấy total count
            if let Ok(c) = conn.query_row(&count_sql, [], |r| r.get::<_, i64>(0)) {
                total_count = c;
            }

            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let col_count = stmt.column_count();
            for i in 0..col_count {
                columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
            }
            uniquify_columns(&mut columns);

            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut map = serde_json::Map::new();
                for i in 0..col_count {
                    let col_name = columns[i].clone();
                    let val: Value = match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                        Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                        Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                        Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                        _ => Value::Null,
                    };
                    map.insert(col_name, val);
                }
                rows_json.push(Value::Object(map));
            }
        }
        _ => {
            // Lấy total count cho Postgres/MySQL
            if let Ok(results) = execute_raw_sql_generic(&conn_type, count_sql).await {
                if let Some(first_res) = results.get(0) {
                    if let Some(data) = first_res.get("data").and_then(|v| v.as_array()) {
                        if let Some(row) = data.get(0).and_then(|r| r.as_object()) {
                            if let Some(val) = row.values().next() {
                                if let Some(c) = val.as_i64() {
                                    total_count = c;
                                } else if let Some(s) = val.as_str() {
                                    if let Ok(c) = s.parse::<i64>() {
                                        total_count = c;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let result = execute_raw_sql_generic(&conn_type, sql.clone()).await?;
            if let Some(first_res) = result.get(0) {
                if let Some(data) = first_res.get("data").and_then(|v| v.as_array()) {
                    rows_json = data.clone();
                }
                if let Some(cols) = first_res.get("columns").and_then(|v| v.as_array()) {
                    columns = cols.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect();
                }
            }
        }
    }
    
    Ok(json!({
        "success": true,
        "data": rows_json,
        "columns": columns,
        "totalCount": total_count
    }))
}

#[tauri::command]
pub async fn get_table_schema(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    
    let mut indexes = Vec::new();
    let mut foreign_keys = Vec::new();
    let mut columns = Vec::new();

    // Danh sách cột khóa chính thật sự (dùng cho Postgres/MySQL; SQLite lấy trực tiếp từ PRAGMA)
    let pk_cols = get_primary_key_columns(&conn_type, &name).await;

    match &conn_type {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let sql = format!("PRAGMA table_info(\"{}\")", name);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let col_name: String = row.get("name").map_err(|e| e.to_string())?;
                let col_type: String = row.get("type").map_err(|e| e.to_string())?;
                let notnull: i32 = row.get("notnull").map_err(|e| e.to_string())?;
                let pk: i32 = row.get("pk").map_err(|e| e.to_string())?;
                let def_val: Option<String> = row.get("dflt_value").map_err(|e| e.to_string())?;
                
                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": notnull == 0,
                    "isPrimaryKey": pk > 0,
                    "defaultValue": def_val,
                    "autoIncrement": pk > 0 && col_type.to_uppercase() == "INTEGER"
                }));
            }

            // Lấy danh sách Indexes của SQLite
            let idx_sql = format!("PRAGMA index_list(\"{}\")", name);
            let mut idx_stmt = conn.prepare(&idx_sql).map_err(|e| e.to_string())?;
            let mut idx_rows = idx_stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = idx_rows.next().map_err(|e| e.to_string())? {
                let idx_name: String = row.get("name").map_err(|e| e.to_string())?;
                let unique: bool = row.get::<_, i32>("unique").map_err(|e| e.to_string())? == 1;

                // Lấy các cột tương ứng của index này
                let info_sql = format!("PRAGMA index_info(\"{}\")", idx_name);
                let mut info_stmt = conn.prepare(&info_sql).map_err(|e| e.to_string())?;
                let mut info_rows = info_stmt.query([]).map_err(|e| e.to_string())?;
                let mut cols_in_idx = Vec::new();
                while let Some(i_row) = info_rows.next().map_err(|e| e.to_string())? {
                    let col_name: String = i_row.get("name").map_err(|e| e.to_string())?;
                    cols_in_idx.push(col_name);
                }

                indexes.push(json!({
                    "name": idx_name,
                    "columns": cols_in_idx.join(", "),
                    "unique": unique,
                    "type": if unique { "UNIQUE" } else { "INDEX" },
                    "method": "BTREE"
                }));
            }

            // Lấy danh sách Foreign Keys của SQLite
            let fk_sql = format!("PRAGMA foreign_key_list(\"{}\")", name);
            let mut fk_stmt = conn.prepare(&fk_sql).map_err(|e| e.to_string())?;
            let mut fk_rows = fk_stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = fk_rows.next().map_err(|e| e.to_string())? {
                let from_col: String = row.get("from").map_err(|e| e.to_string())?;
                let to_table: String = row.get("table").map_err(|e| e.to_string())?;
                let to_col: String = row.get("to").map_err(|e| e.to_string())?;
                let id: i32 = row.get("id").map_err(|e| e.to_string())?;
                foreign_keys.push(json!({
                    "name": format!("fk_{}_{}_{}", name, from_col, id),
                    "column": from_col,
                    "refTable": to_table,
                    "refColumn": to_col
                }));
            }
        }
        DbConnection::Postgres(pool) => {
            // format_type() instead of information_schema.data_type: the latter drops
            // length/precision (`character varying`, `numeric`) so the structure editor
            // could neither show `varchar(45)` nor round-trip it into ALTER TABLE.
            // Two different things, and a dump has to treat them differently:
            //   attgenerated <> ''  = GENERATED ALWAYS AS (...) STORED — a computed column.
            //     Postgres refuses any write to it, so it must be left OUT of the INSERT.
            //   attidentity = 'a'   = GENERATED ALWAYS AS IDENTITY. It stays IN the INSERT
            //     (dropping it would renumber the rows and break every foreign key pointing
            //     at them), but the statement then needs OVERRIDING SYSTEM VALUE.
            //     attidentity = 'd' (BY DEFAULT) accepts a plain INSERT.
            let sql = format!(
                "SELECT a.attname::text AS column_name,
                        format_type(a.atttypid, a.atttypmod) AS data_type,
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                        pg_get_expr(d.adbin, d.adrelid) AS column_default,
                        a.attgenerated <> '' AS is_generated,
                        a.attidentity = 'a' AS is_identity_always
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE n.nspname = 'public' AND c.relname = '{}'
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum", name.replace('\'', "''")
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let col_name: String = r.get("column_name");
                let col_type: String = r.get("data_type");
                let is_nullable: String = r.get("is_nullable");
                let column_default: Option<String> = r.try_get("column_default").ok();
                let is_generated: bool = r.try_get("is_generated").unwrap_or(false);
                let is_identity_always: bool = r.try_get("is_identity_always").unwrap_or(false);
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": column_default.as_ref().map(|d| d.contains("nextval")).unwrap_or(false),
                    "extra": serde_json::Value::Null,
                    "generated": is_generated,
                    "identityAlways": is_identity_always
                }));
            }

            // Lấy danh sách Indexes của Postgres
            let idx_sql = format!(
                "SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, am.amname AS index_method, pg_get_indexdef(ix.indexrelid) AS index_def
                 FROM pg_class t
                 JOIN pg_index ix ON t.oid = ix.indrelid
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_am am ON i.relam = am.oid
                 WHERE t.relkind = 'r' AND t.relname = '{}'", name
            );
            if let Ok(idx_rows) = sqlx::query(sqlx::AssertSqlSafe(idx_sql)).fetch_all(pool).await {
                for r in idx_rows {
                    let idx_name: String = r.get(0);
                    let unique: bool = r.get(1);
                    let is_primary: bool = r.get(2);
                    let method: String = r.get(3);
                    let index_def: String = r.get(4);
                    
                    let columns_str = if let Some(start) = index_def.rfind('(') {
                        if let Some(end) = index_def.rfind(')') {
                            index_def[start + 1..end].to_string()
                        } else {
                            "".to_string()
                        }
                    } else {
                        "".to_string()
                    };

                    indexes.push(json!({
                        "name": idx_name,
                        "columns": columns_str,
                        "unique": unique || is_primary,
                        "type": if is_primary { "PRIMARY" } else if unique { "UNIQUE" } else { "INDEX" },
                        "method": method.to_uppercase()
                    }));
                }
            }

            // Lấy danh sách Foreign Keys của Postgres
            let fk_sql = format!(
                "SELECT tc.constraint_name AS name, kcu.column_name AS column, ccu.table_name AS ref_table, ccu.column_name AS ref_column
                 FROM information_schema.table_constraints AS tc
                 JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                 JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{}'", name
            );
            if let Ok(fk_rows) = sqlx::query(sqlx::AssertSqlSafe(fk_sql)).fetch_all(pool).await {
                for r in fk_rows {
                    let fk_name: String = r.get("name");
                    let from_col: String = r.get("column");
                    let to_table: String = r.get("ref_table");
                    let to_col: String = r.get("ref_column");
                    foreign_keys.push(json!({
                        "name": fk_name,
                        "column": from_col,
                        "refTable": to_table,
                        "refColumn": to_col
                    }));
                }
            }
        }
        DbConnection::Mysql(pool) => {
            // COLUMN_TYPE, not DATA_TYPE: the former carries length/precision and the
            // unsigned/zerofill flags (`varchar(45)`, `int(10) unsigned`, `enum('a','b')`),
            // which the structure editor both displays and feeds back into MODIFY COLUMN.
            let sql = format!(
                "SELECT column_name, column_type, is_nullable, column_default, extra, character_set_name, collation_name
                 FROM information_schema.columns
                 WHERE table_name = '{}' AND table_schema = DATABASE()
                 ORDER BY ordinal_position", name
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let col_name: String = r.get(0);
                let col_type: String = r.get(1);
                let is_nullable: String = r.get(2);
                let column_default: Option<String> = r.try_get(3).ok();
                let extra: String = r.get(4);
                let char_set: Option<String> = r.try_get(5).ok();
                let collation: Option<String> = r.try_get(6).ok();
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": extra.contains("auto_increment"),
                    "extra": if extra.trim().is_empty() { serde_json::Value::Null } else { serde_json::Value::String(extra.clone()) },
                    // EXTRA reads "VIRTUAL GENERATED" / "STORED GENERATED". Writing such a
                    // column is MySQL error 3105, so a dump must leave it out of the INSERT.
                    "generated": extra.to_uppercase().contains("GENERATED"),
                    "characterSet": char_set,
                    "collation": collation
                }));
            }

            // Lấy danh sách Indexes của MySQL
            let idx_sql = format!("SHOW INDEX FROM `{}`", name);
            if let Ok(idx_rows) = sqlx::query(sqlx::AssertSqlSafe(idx_sql)).fetch_all(pool).await {
                use std::collections::HashMap;
                let mut idx_map: HashMap<String, (Vec<String>, bool, String)> = HashMap::new();
                for r in idx_rows {
                    let key_name: String = r.try_get("Key_name").or_else(|_| r.try_get("KEY_NAME")).unwrap_or_default();
                    let col_name: String = r.try_get("Column_name").or_else(|_| r.try_get("COLUMN_NAME")).unwrap_or_default();
                    let non_unique: i64 = r.try_get::<i64, _>("Non_unique")
                        .or_else(|_| r.try_get::<i64, _>("NON_UNIQUE"))
                        .or_else(|_| r.try_get::<i32, _>("Non_unique").map(|v| v as i64))
                        .or_else(|_| r.try_get::<i32, _>("NON_UNIQUE").map(|v| v as i64))
                        .unwrap_or(1);
                    let index_type: String = r.try_get("Index_type")
                        .or_else(|_| r.try_get("INDEX_TYPE"))
                        .unwrap_or_else(|_| "BTREE".to_string());
                    let entry = idx_map.entry(key_name).or_insert((Vec::new(), non_unique == 0, index_type));
                    entry.0.push(col_name);
                }
                for (idx_name, (cols, unique, method)) in idx_map {
                    let is_primary = idx_name == "PRIMARY";
                    indexes.push(json!({
                        "name": idx_name,
                        "columns": cols.join(", "),
                        "unique": unique || is_primary,
                        "type": if is_primary { "PRIMARY" } else if unique { "UNIQUE" } else { "INDEX" },
                        "method": method.to_uppercase()
                    }));
                }
            }

            // Lấy danh sách Foreign Keys của MySQL
            let fk_sql = format!(
                "SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS `column`, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND REFERENCED_TABLE_NAME IS NOT NULL", name
            );
            if let Ok(fk_rows) = sqlx::query(sqlx::AssertSqlSafe(fk_sql)).fetch_all(pool).await {
                for r in fk_rows {
                    let fk_name: String = r.get(0);
                    let from_col: String = r.get(1);
                    let to_table: String = r.get(2);
                    let to_col: String = r.get(3);
                    foreign_keys.push(json!({
                        "name": fk_name,
                        "column": from_col,
                        "refTable": to_table,
                        "refColumn": to_col
                    }));
                }
            }
        }
    }
    
    Ok(json!({
        "success": true,
        "columns": columns,
        "indexes": indexes,
        "foreignKeys": foreign_keys
    }))
}

// Sinh câu lệnh SQL thay đổi cấu trúc bảng dựa trên payload DDL nhận từ frontend
fn generate_alter_sqls(table_name: &str, payload: &Value, db_type: &str) -> Vec<String> {
    let mut sqls = Vec::new();
    
    let added = payload.get("added").and_then(|v| v.as_array());
    let dropped = payload.get("dropped").and_then(|v| v.as_array());
    let renamed = payload.get("renamed").and_then(|v| v.as_array());
    let modified = payload.get("modified").and_then(|v| v.as_array());
    
    let added_indexes = payload.get("addedIndexes").and_then(|v| v.as_array());
    let dropped_indexes = payload.get("droppedIndexes").and_then(|v| v.as_array());
    
    let added_fks = payload.get("addedFKs").and_then(|v| v.as_array());
    let dropped_fks = payload.get("droppedFKs").and_then(|v| v.as_array());

    // 1. Thêm cột mới
    if let Some(arr) = added {
        for col in arr {
            if let Some(col_name) = col.get("name").and_then(|v| v.as_str()) {
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_nullable = col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(true);
                let default_val = col.get("defaultValue").and_then(|v| {
                    if v.is_null() { None } else { Some(v.to_string()) }
                });
                
                let null_str = if is_nullable { "NULL" } else { "NOT NULL" };
                let default_str = if let Some(d) = default_val {
                    if d.trim().is_empty() || d == "null" {
                        "".to_string()
                    } else if d.to_uppercase() == "CURRENT_TIMESTAMP" {
                        format!(" DEFAULT {}", d)
                    } else {
                        format!(" DEFAULT '{}'", d.replace("'", "''"))
                    }
                } else {
                    "".to_string()
                };

                let sql = format!("ALTER TABLE `{}` ADD COLUMN `{}` {}{} {}", table_name, col_name, col_type, default_str, null_str);
                sqls.push(sql);
            }
        }
    }

    // 2. Xóa cột
    if let Some(arr) = dropped {
        for col_name in arr {
            if let Some(name) = col_name.as_str() {
                if db_type == "sqlite" {
                    // SQLite không hỗ trợ DROP COLUMN trực tiếp ở một số bản cũ, tuy nhiên sqlite3 hiện tại đã hỗ trợ ALTER TABLE DROP COLUMN
                    sqls.push(format!("ALTER TABLE `{}` DROP COLUMN `{}`", table_name, name));
                } else {
                    sqls.push(format!("ALTER TABLE `{}` DROP COLUMN `{}`", table_name, name));
                }
            }
        }
    }

    // 3. Đổi tên cột
    if let Some(arr) = renamed {
        for item in arr {
            let old_name = item.get("oldName").and_then(|v| v.as_str()).unwrap_or("");
            let new_name = item.get("newName").and_then(|v| v.as_str()).unwrap_or("");
            if !old_name.is_empty() && !new_name.is_empty() {
                sqls.push(format!("ALTER TABLE `{}` RENAME COLUMN `{}` TO `{}`", table_name, old_name, new_name));
            }
        }
    }

    // 4. Sửa cột (Kiểu dữ liệu / Nullable)
    if let Some(arr) = modified {
        for col in arr {
            if let Some(col_name) = col.get("name").and_then(|v| v.as_str()) {
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_nullable = col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(true);
                let null_str = if is_nullable { "NULL" } else { "NOT NULL" };
                
                if db_type == "mysql" {
                    sqls.push(format!("ALTER TABLE `{}` MODIFY COLUMN `{}` {} {}", table_name, col_name, col_type, null_str));
                } else if db_type == "postgres" {
                    sqls.push(format!("ALTER TABLE \"{}\" ALTER COLUMN \"{}\" TYPE {}", table_name, col_name, col_type));
                    let null_action = if is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                    sqls.push(format!("ALTER TABLE \"{}\" ALTER COLUMN \"{}\" {}", table_name, col_name, null_action));
                } else {
                    // SQLite không hỗ trợ thay đổi trực tiếp thuộc tính cột, cảnh báo cho người dùng
                }
            }
        }
    }

    // 5. Xóa Index
    if let Some(arr) = dropped_indexes {
        for idx in arr {
            if let Some(idx_name) = idx.as_str() {
                if db_type == "mysql" {
                    sqls.push(format!("ALTER TABLE `{}` DROP INDEX `{}`", table_name, idx_name));
                } else {
                    sqls.push(format!("DROP INDEX `{}`", idx_name));
                }
            }
        }
    }

    // 6. Thêm Index
    if let Some(arr) = added_indexes {
        for idx in arr {
            if let Some(idx_name) = idx.get("name").and_then(|v| v.as_str()) {
                let cols = idx.get("columns").and_then(|v| v.as_str()).unwrap_or("");
                let is_unique = idx.get("unique").and_then(|v| v.as_bool()).unwrap_or(false);
                let idx_type = idx.get("type").and_then(|v| v.as_str()).unwrap_or("INDEX");
                let method = idx.get("method").and_then(|v| v.as_str()).unwrap_or("BTREE");
                
                let unique_str = if is_unique || idx_type == "UNIQUE" { "UNIQUE" } else { "" };
                
                if db_type == "mysql" {
                    let sql = match idx_type {
                        "FULLTEXT" => format!(
                            "CREATE FULLTEXT INDEX `{}` ON `{}` ({})",
                            idx_name, table_name, cols
                        ),
                        "SPATIAL" => format!(
                            "CREATE SPATIAL INDEX `{}` ON `{}` ({})",
                            idx_name, table_name, cols
                        ),
                        _ => format!(
                            "CREATE {} INDEX `{}` ON `{}` ({}) USING {}",
                            unique_str, idx_name, table_name, cols, method
                        ),
                    };
                    sqls.push(sql);
                } else if db_type == "postgres" {
                    sqls.push(format!(
                        "CREATE {} INDEX \"{}\" ON \"{}\" USING {} ({})",
                        unique_str, idx_name, table_name, method.to_lowercase(), cols
                    ));
                } else {
                    sqls.push(format!(
                        "CREATE {} INDEX `{}` ON `{}` ({})",
                        unique_str, idx_name, table_name, cols
                    ));
                }
            }
        }
    }

    // 7. Xóa Khóa ngoại
    if let Some(arr) = dropped_fks {
        for fk in arr {
            if let Some(fk_name) = fk.get("name").and_then(|v| v.as_str()) {
                if db_type == "mysql" {
                    sqls.push(format!("ALTER TABLE `{}` DROP FOREIGN KEY `{}`", table_name, fk_name));
                } else if db_type == "postgres" {
                    sqls.push(format!("ALTER TABLE \"{}\" DROP CONSTRAINT \"{}\"", table_name, fk_name));
                }
            }
        }
    }

    // 8. Thêm Khóa ngoại (kèm On Update / On Delete)
    if let Some(arr) = added_fks {
        for fk in arr {
            let col = fk.get("column").and_then(|v| v.as_str()).unwrap_or("");
            let ref_table = fk.get("refTable").and_then(|v| v.as_str()).unwrap_or("");
            let ref_col = fk.get("refColumn").and_then(|v| v.as_str()).unwrap_or("");
            let on_update = fk.get("onUpdate").and_then(|v| v.as_str()).unwrap_or("NO ACTION");
            let on_delete = fk.get("onDelete").and_then(|v| v.as_str()).unwrap_or("NO ACTION");

            if !col.is_empty() && !ref_table.is_empty() && !ref_col.is_empty() {
                let fk_name = format!("fk_{}_{}_{}", table_name, col, ref_table);
                match db_type {
                    "mysql" => sqls.push(format!(
                        "ALTER TABLE `{}` ADD CONSTRAINT `{}` FOREIGN KEY (`{}`) REFERENCES `{}` (`{}`) ON UPDATE {} ON DELETE {}",
                        table_name, fk_name, col, ref_table, ref_col, on_update, on_delete
                    )),
                    "postgres" => sqls.push(format!(
                        "ALTER TABLE \"{}\" ADD CONSTRAINT \"{}\" FOREIGN KEY (\"{}\") REFERENCES \"{}\" (\"{}\") ON UPDATE {} ON DELETE {}",
                        table_name, fk_name, col, ref_table, ref_col, on_update, on_delete
                    )),
                    // SQLite không hỗ trợ thêm khóa ngoại qua ALTER TABLE — bỏ qua (cần tạo lại bảng)
                    _ => {}
                }
            }
        }
    }

    sqls
}

#[tauri::command]
pub async fn alter_table_schema(state: tauri::State<'_, crate::AppState>, name: String, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let db_type = match &conn_type {
        DbConnection::Sqlite(_) => "sqlite",
        DbConnection::Postgres(_) => "postgres",
        DbConnection::Mysql(_) => "mysql",
    };

    let sqls = generate_alter_sqls(&name, &payload, db_type);
    for sql in sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn preview_alter_schema(state: tauri::State<'_, crate::AppState>, name: String, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let db_type = match &conn_type {
        DbConnection::Sqlite(_) => "sqlite",
        DbConnection::Postgres(_) => "postgres",
        DbConnection::Mysql(_) => "mysql",
    };

    let sqls = generate_alter_sqls(&name, &payload, db_type);
    Ok(json!({ "success": true, "sql": sqls.join(";\n") }))
}

#[tauri::command]
pub async fn execute_query(state: tauri::State<'_, crate::AppState>, sql: String, params: Option<Vec<Value>>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    // Có tham số -> bind ở tầng driver (parameterized, một câu lệnh). Không có -> giữ nguyên hành vi cũ.
    let params = params.unwrap_or_default();
    let results = if params.is_empty() {
        execute_raw_sql_generic(&conn_type, sql.clone()).await?
    } else {
        run_bound_query(&conn_type, sql.clone(), &params).await?
    };
    Ok(json!({ "success": true, "results": results }))
}

// Dòng này có phải lệnh `DELIMITER <token>` của client mysql? Trả về token mới.
// Dùng `get(..9)` chứ không `[..9]`: cắt theo byte giữa một ký tự nhiều byte (tiếng Việt...)
// sẽ panic, còn `get` trả None.
fn delimiter_token_of_line(line: &str) -> Option<&str> {
    let t = line.trim_start_matches([' ', '\t']);
    if !t.get(..9)?.eq_ignore_ascii_case("DELIMITER") { return None; }
    let rest = &t[9..];
    if !rest.starts_with([' ', '\t']) { return None; }
    let token = rest.trim(); // trim cắt luôn '\r' của file CRLF
    if token.is_empty() || token.contains(char::is_whitespace) { return None; }
    Some(token)
}

// Đọc lệnh DELIMITER tại đầu dòng `i` (chỉ mục ký tự trong `chars`).
// Trả về (token mới, chỉ mục ngay sau dòng đó). Lệnh này KHÔNG phải SQL: gửi xuống server sẽ lỗi.
fn read_delimiter_command(chars: &[char], i: usize) -> Option<(String, usize)> {
    let line_end = chars[i..].iter().position(|&c| c == '\n').map(|p| i + p).unwrap_or(chars.len());
    let line: String = chars[i..line_end].iter().collect();
    let token = delimiter_token_of_line(&line)?.to_string();
    let next = if line_end < chars.len() { line_end + 1 } else { chars.len() };
    Some((token, next))
}

// `chars[i..]` có khớp đúng dấu kết thúc câu đang dùng?
fn matches_delimiter(chars: &[char], i: usize, delim: &[char]) -> bool {
    if i + delim.len() > chars.len() { return false; }
    chars[i..i + delim.len()] == *delim
}

// Tách một chuỗi SQL nhiều câu lệnh thành từng câu. Nhận biết:
//   - chuỗi trích dẫn ('..', "..", `..`) và escape bằng '\'
//   - comment `-- ...`, `# ...`, `/* ... */`
//   - khối dollar-quote của Postgres ($$ ... $$, $tag$ ... $tag$) — thân function chứa dấu ';'
//   - lệnh DELIMITER của MySQL — đổi dấu kết thúc câu để viết được thân trigger/procedure
// Nếu không xử lý 2 mục cuối, một file có function/trigger sẽ bị cắt giữa thân hàm và có thể
// chạy nhầm một câu nằm bên trong nó.
/// Bỏ khoảng trắng và comment ở ĐẦU câu lệnh, trả về phần bắt đầu bằng từ khoá SQL thật.
///
/// Splitter giữ nguyên comment trong text của câu lệnh, nên trong dump của mysqldump thì
///     `-- Dumping data for table `store`` + newline + `LOCK TABLES `store` WRITE`
/// là MỘT câu lệnh bắt đầu bằng "--". Phân loại theo text thô sẽ nhận sai hết:
/// LOCK/UNLOCK TABLES không bị bỏ, `SET`/`USE` không được coi là lệnh cấp phiên.
pub(crate) fn strip_leading_comments(stmt: &str) -> &str {
    let b = stmt.as_bytes();
    let mut i = 0usize;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        // Comment dòng: -- ... hoặc # ...
        if (i + 1 < b.len() && b[i] == b'-' && b[i + 1] == b'-') || (i < b.len() && b[i] == b'#') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Comment khối: /* ... */ (kể cả comment điều kiện /*!40101 ... */ của MySQL)
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        break;
    }
    // i luôn dừng sau '\n' / '*/' / khoảng trắng ASCII nên vẫn là biên ký tự UTF-8.
    &stmt[i.min(stmt.len())..]
}

/// Phần đầu câu lệnh, in hoa — đủ để phân loại bằng `is_skipped_stmt`/`is_session_level_stmt`.
///
/// Chỉ 4-5 từ đầu quyết định loại câu lệnh, nên `to_uppercase()` trên CẢ câu là vô ích và đắt:
/// nó cấp phát một bản copy của từng câu INSERT, tức là copy lại toàn bộ dump một lần nữa.
/// Từ khoá dài nhất cần so là `START TRANSACTION` (17 ký tự) nên 32 byte là đủ rộng.
fn upper_head(body: &str) -> String {
    let mut end = body.len().min(32);
    // Cắt theo byte thì phải lùi về biên ký tự UTF-8 (câu lệnh có thể mở đầu bằng ký tự nhiều byte).
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_uppercase()
}

// Lệnh của dump mà restore KHÔNG được chạy lại:
//   - LOCK/UNLOCK TABLES: mysqldump thêm vào cho nhanh. `LOCK TABLES x WRITE` có tên bảng nên
//     lọt qua bộ lọc, còn `UNLOCK TABLES` thì không -> khoá treo lại và bảng kế tiếp bị lỗi
//     1100 "was not locked with LOCK TABLES". Bỏ cả cặp là an toàn nhất, nhất là khi người
//     dùng chỉ chọn một phần bảng.
//   - BEGIN/START TRANSACTION/COMMIT/ROLLBACK: transaction do chính hàm này quản lý; chạy lại
//     lệnh của dump (nhất là ROLLBACK) có thể huỷ phần đã nhập.
/// Statement text as it appears in an error message.
///
/// The framing is `Lỗi khi chạy lệnh SQL: {statement}. Chi tiết: {cause}` (kept verbatim so the
/// regex in `backendErrors.ts` still matches), which puts the statement first — and a multi-row
/// INSERT is now hundreds of KB, so the cause was pushed far below the visible area of the error
/// dialog and users saw a wall of VALUES with no reason attached. Only the head is needed to
/// recognise which statement failed.
///
/// The marker is a bare `…` on purpose: any word here would be a user-visible string escaping
/// through the error channel untranslated, and `backendErrors.ts` matches this message with a
/// regex that passes the interpolated text straight through.
fn stmt_for_error(stmt: &str) -> String {
    const MAX: usize = 400;
    if stmt.len() <= MAX {
        return stmt.to_string();
    }
    let mut end = MAX;
    while end > 0 && !stmt.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &stmt[..end])
}

fn is_skipped_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("LOCK TABLES")
        || stmt_upper.starts_with("UNLOCK TABLES")
        || stmt_upper.starts_with("START TRANSACTION")
        || stmt_upper == "BEGIN"
        || stmt_upper.starts_with("BEGIN;")
        || stmt_upper.starts_with("BEGIN WORK")
        || stmt_upper.starts_with("COMMIT")
        || stmt_upper.starts_with("ROLLBACK")
}

// Lệnh cấp phiên/schema trong một tệp dump: luôn chạy dù người dùng chỉ chọn một phần bảng
// (không nhắc tên bảng nào nên bộ lọc theo bảng sẽ bỏ sót), và lỗi của chúng KHÔNG huỷ cả
// lần restore — dump của dialect khác thường có `SET NAMES`/`SET @@...` mà server hiện tại
// không hiểu, còn `CREATE SCHEMA` thì lỗi nếu schema đã tồn tại.
fn is_session_level_stmt(stmt_upper: &str) -> bool {
    stmt_upper.starts_with("USE ")
        || stmt_upper.starts_with("SET ")
        // PRAGMA is the SQLite spelling of the same thing — the header this app writes opens
        // with `PRAGMA foreign_keys = OFF;`, which names no table and would otherwise be
        // filtered out. A PRAGMA the current server does not know must not abort the restore
        // either, which is exactly what this list means.
        || stmt_upper.starts_with("PRAGMA ")
        || stmt_upper.starts_with("CREATE DATABASE")
        || stmt_upper.starts_with("CREATE SCHEMA")
}

// Câu lệnh có nhắc tới một trong các bảng được chọn không (so khớp theo biên từ để
// `film` không khớp `film_actor`).
//
// Regex được biên dịch MỘT lần cho cả lần restore, không phải theo từng cặp (câu lệnh × bảng):
// một dump 10MB có ~50.000 câu lệnh, nhân 22 bảng là hơn một triệu lần `Regex::new()` — bước
// lọc này từng tốn nhiều thời gian hơn cả lúc chạy SQL thật, và nó xảy ra TRƯỚC khi gửi
// `start` về UI nên người dùng chỉ thấy "Đang chuẩn bị..." đứng im.
pub(crate) struct TableMatcher {
    /// Một regex alternation cho tất cả bảng: quét mỗi câu lệnh một lượt thay vì một lượt/bảng.
    re: Option<regex::Regex>,
    /// Dự phòng khi regex không dựng được (tên bảng quá lạ / danh sách quá lớn).
    lowered: Vec<String>,
}

impl TableMatcher {
    pub(crate) fn new(tables: &[String]) -> Self {
        if tables.is_empty() {
            return Self { re: None, lowered: Vec::new() };
        }
        let alts: Vec<String> = tables.iter().map(|t| regex::escape(t)).collect();
        // (?i) thay cho việc lowercase từng câu lệnh: `to_lowercase()` cấp phát một bản copy
        // của mỗi câu INSERT, tức là copy lại cả dump.
        let re = regex::Regex::new(&format!(r"(?i)\b(?:{})\b", alts.join("|"))).ok();
        Self {
            re,
            lowered: tables.iter().map(|t| t.to_lowercase()).collect(),
        }
    }

    pub(crate) fn matches(&self, stmt: &str) -> bool {
        if let Some(re) = &self.re {
            return re.is_match(stmt);
        }
        let lower = stmt.to_lowercase();
        self.lowered.iter().any(|t| lower.contains(t))
    }
}

// Tên database trong lệnh `USE <db>` (để reconnect sau khi restore xong).
fn use_db_name(stmt: &str) -> Option<String> {
    let parts: Vec<&str> = stmt.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let name = parts[1]
        .trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'')
        .to_string();
    if name.is_empty() { None } else { Some(name) }
}

// Statement head is `CREATE [OR REPLACE] [TEMP|TEMPORARY] [DEFINER=...] TRIGGER`.
fn is_create_trigger_head(seg: &str) -> bool {
    let head = strip_leading_comments(seg).trim_start();
    let mut words = head.split_whitespace();
    if !words.next().is_some_and(|w| w.eq_ignore_ascii_case("CREATE")) {
        return false;
    }
    for w in words.take(4) {
        if w.eq_ignore_ascii_case("TRIGGER") {
            return true;
        }
        let is_modifier = w.eq_ignore_ascii_case("OR")
            || w.eq_ignore_ascii_case("REPLACE")
            || w.eq_ignore_ascii_case("TEMP")
            || w.eq_ignore_ascii_case("TEMPORARY")
            // MySQL writes the whole clause as one token: DEFINER=`root`@`localhost`
            || w.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("DEFINER"));
        if !is_modifier {
            return false;
        }
    }
    false
}

/// Is this `;` still INSIDE a trigger body rather than the end of the statement?
///
/// A `BEGIN ... END` body carries its own `;`, so splitting on the first one yields a truncated
/// `CREATE TRIGGER ... BEGIN UPDATE t SET ...;` — SQLite answers "incomplete input" and the whole
/// restore rolls back. MySQL avoids this with the client-side `DELIMITER` command, SQLite has no
/// such thing, so the rule has to live here. It is what `sqlite3_complete()` does: a statement
/// starting with CREATE TRIGGER only ends at the `;` that directly follows the `END` keyword.
///
/// Requiring `BEGIN` matters: a Postgres trigger (`... EXECUTE FUNCTION f();`) and MySQL's
/// single-statement form (`... FOR EACH ROW SET NEW.a = 1;`) have no BEGIN block, and making
/// them wait for an `END` would swallow the rest of the dump into one statement.
///
/// Twin of `insideTriggerBody()` in src/sql/statements.ts — keep both in sync.
fn trigger_stmt_incomplete(seg: &str) -> bool {
    if !is_create_trigger_head(seg) {
        return false;
    }
    let b: Vec<char> = seg.chars().collect();
    let n = b.len();
    let mut i = 0usize;
    let mut has_begin = false;
    let mut last_word_is_end = false;

    while i < n {
        let c = b[i];
        let peek = if i + 1 < n { Some(b[i + 1]) } else { None };

        if (c == '-' && peek == Some('-')) || (c == '#' && !matches!(peek, Some('>') | Some('-'))) {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && peek == Some('*') {
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            i += 1;
            while i < n {
                if b[i] == '\\' && quote != '`' {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    if quote == '\'' && i + 1 < n && b[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            last_word_is_end = false;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let s = i;
            while i < n && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '$') {
                i += 1;
            }
            let word: String = b[s..i].iter().collect();
            if word.eq_ignore_ascii_case("BEGIN") {
                has_begin = true;
            }
            last_word_is_end = word.eq_ignore_ascii_case("END");
            continue;
        }
        if !c.is_whitespace() {
            last_word_is_end = false;
        }
        i += 1;
    }

    has_begin && !last_word_is_end
}

// Cheap pre-check for the rule above: skip leading whitespace/comments and compare six chars.
// A dump of INSERTs bails out on the first character instead of rebuilding every statement
// into a String only to find it is not a trigger.
fn seg_may_be_create(chars: &[char], from: usize, to: usize) -> bool {
    let mut i = from;
    loop {
        while i < to && chars[i].is_whitespace() {
            i += 1;
        }
        if i + 1 < to && chars[i] == '-' && chars[i + 1] == '-' {
            while i < to && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if i + 1 < to && chars[i] == '/' && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < to && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(to);
            continue;
        }
        break;
    }
    const KW: [char; 6] = ['C', 'R', 'E', 'A', 'T', 'E'];
    if i + KW.len() > to {
        return false;
    }
    KW.iter()
        .enumerate()
        .all(|(k, ch)| chars[i + k].to_ascii_uppercase() == *ch)
}

fn split_sql_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let n = chars.len();
    // `DELIMITER` chỉ có ở script MySQL; ở đó '$$' là dấu kết thúc câu chứ không phải dollar-quote.
    let mysql_script = sql.lines().any(|l| delimiter_token_of_line(l).is_some());

    let mut out: Vec<String> = Vec::new();
    let mut delim: Vec<char> = vec![';'];
    let mut start = 0usize; // đầu câu lệnh đang gom
    let mut at_line_start = true;
    let mut i = 0usize;

    let push_stmt = |out: &mut Vec<String>, from: usize, to: usize| {
        let s: String = chars[from..to].iter().collect();
        let s = s.trim().to_string();
        if !s.is_empty() { out.push(s); }
    };

    while i < n {
        let c = chars[i];
        let peek = if i + 1 < n { Some(chars[i + 1]) } else { None };

        // Comment dòng: -- ... | # ...  ('#>' và '#-' là toán tử jsonb của Postgres, không phải comment)
        if (c == '-' && peek == Some('-')) || (c == '#' && !matches!(peek, Some('>') | Some('-'))) {
            while i < n && chars[i] != '\n' { i += 1; }
            at_line_start = true;
            i += 1; // bỏ qua '\n'
            continue;
        }
        // Comment khối: /* ... */
        if c == '/' && peek == Some('*') {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') { i += 1; }
            i = (i + 2).min(n);
            at_line_start = false;
            continue;
        }
        // Chuỗi / identifier có dấu: bỏ qua nguyên khối (kể cả escape \' và '' )
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            i += 1;
            while i < n {
                if chars[i] == '\\' && quote != '`' { i += 2; continue; }
                if chars[i] == quote {
                    if quote == '\'' && i + 1 < n && chars[i + 1] == '\'' { i += 2; continue; }
                    i += 1;
                    break;
                }
                i += 1;
            }
            at_line_start = false;
            continue;
        }
        // Khối dollar-quote của Postgres: $$ ... $$ hoặc $tag$ ... $tag$ (không phải $1, ${x})
        if !mysql_script && c == '$' {
            let mut j = i + 1;
            while j < n && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') { j += 1; }
            if j < n && chars[j] == '$' && (j == i + 1 || chars[i + 1].is_ascii_alphabetic() || chars[i + 1] == '_') {
                let tag: Vec<char> = chars[i..=j].to_vec();
                let mut k = j + 1;
                while k < n && !matches_delimiter(&chars, k, &tag) { k += 1; }
                i = if k < n { k + tag.len() } else { n };
                at_line_start = false;
                continue;
            }
        }
        // Lệnh DELIMITER (đầu dòng): đổi dấu kết thúc câu, bản thân dòng đó không phải câu lệnh
        if at_line_start {
            if let Some((token, next)) = read_delimiter_command(&chars, i) {
                push_stmt(&mut out, start, i);
                delim = token.chars().collect();
                start = next;
                i = next;
                at_line_start = true;
                continue;
            }
        }
        // Dấu kết thúc câu đang hiệu lực
        if matches_delimiter(&chars, i, &delim) {
            // A ';' inside a trigger's BEGIN...END body is not the end of the statement. Only
            // while the delimiter is still ';': a MySQL script that issued DELIMITER already
            // protects the body that way.
            if delim.len() == 1
                && delim[0] == ';'
                && seg_may_be_create(&chars, start, i)
                && trigger_stmt_incomplete(&chars[start..i].iter().collect::<String>())
            {
                i += 1;
                at_line_start = false;
                continue;
            }
            push_stmt(&mut out, start, i);
            i += delim.len();
            start = i;
            at_line_start = false;
            continue;
        }

        at_line_start = c == '\n';
        i += 1;
    }

    push_stmt(&mut out, start, n);
    out
}

// Chạy nhiều câu lệnh SQL, mỗi câu trả về một bộ kết quả riêng (phục vụ nhiều result tab ở SqlEditor)
#[tauri::command]
pub async fn execute_multi_query(state: tauri::State<'_, crate::AppState>, sql: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let statements = split_sql_statements(&sql);
    let mut results: Vec<Value> = Vec::new();

    for stmt in statements {
        match execute_raw_sql_generic(&conn_type, stmt.clone()).await {
            Ok(mut res) => {
                if let Some(first) = res.drain(..).next() {
                    let mut obj = first.as_object().cloned().unwrap_or_default();
                    obj.insert("query".to_string(), json!(stmt));
                    results.push(Value::Object(obj));
                }
            }
            Err(e) => {
                // Trả về các kết quả đã chạy được + thông báo lỗi ở câu lệnh gặp sự cố
                return Ok(json!({
                    "success": false,
                    "results": results,
                    "message": format!("Lỗi tại câu lệnh:\n{}\n\nChi tiết: {}", stmt, e)
                }));
            }
        }
    }

    Ok(json!({ "success": true, "results": results }))
}

// ---- Streaming SQL cho SQL Editor ----
// Chạy (nhiều) câu lệnh và ĐẨY kết quả theo từng batch qua Channel về frontend thay vì gom hết rồi trả một lần.
// Nhờ đó dòng đầu hiện gần như tức thì, UI không đơ, và có thể DỪNG giữa chừng qua cancel_query.
// Giao thức message gửi qua channel (đều có trường "type"):
//   { type:"columns", stmtIndex, query, columns:[...] }   -> bắt đầu 1 câu lệnh
//   { type:"rows",    stmtIndex, rows:[{...}, ...] }        -> 1 batch dữ liệu
//   { type:"done",    stmtCount, cancelled }                -> tất cả câu lệnh xong
//   { type:"error",   stmtIndex, message }                  -> lỗi, dừng stream
#[tauri::command]
pub async fn execute_query_stream(
    state: tauri::State<'_, crate::AppState>,
    sql: String,
    query_id: String,
    channel: Channel<Value>,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    // Đăng ký cờ hủy để cancel_query có thể dừng vòng lặp stream đang chạy
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel_flag.clone());
    }

    let params = params.unwrap_or_default();
    let outcome = stream_sql_statements(&conn_type, &sql, &params, &channel, &cancel_flag).await;

    // Luôn gỡ cờ khi kết thúc (dù thành công hay lỗi)
    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }

    match outcome {
        Ok((stmt_count, cancelled)) => {
            let _ = channel.send(json!({ "type": "done", "stmtCount": stmt_count, "cancelled": cancelled }));
            Ok(json!({ "success": true }))
        }
        Err((stmt_index, msg)) => {
            let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_index, "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}

// Đánh dấu một truy vấn đang stream cần dừng. Không lỗi nếu query_id không còn tồn tại.
#[tauri::command]
pub async fn cancel_query(state: tauri::State<'_, crate::AppState>, query_id: String) -> Result<Value, String> {
    let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&query_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "success": true }))
}

// Tách và stream lần lượt từng câu lệnh. Trả về (số câu lệnh đã chạy, có bị hủy không).
// Lỗi trả về (chỉ số câu lệnh gặp lỗi, thông báo).
async fn stream_sql_statements(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(usize, bool), (usize, String)> {
    let statements = split_sql_statements(sql);
    // Tham số truy vấn (parameterized) chỉ hỗ trợ đúng MỘT câu lệnh: binding theo vị trí
    // không thể phân bổ an toàn qua nhiều câu lệnh. Báo lỗi rõ ràng thay vì đoán mò.
    if !params.is_empty() && statements.len() > 1 {
        return Err((0, "Tham số truy vấn chỉ hỗ trợ một câu lệnh. Vui lòng chạy từng câu lệnh riêng hoặc tắt Tham số Truy vấn.".to_string()));
    }
    let mut idx = 0usize;
    for stmt in statements {
        if cancel.load(Ordering::Relaxed) {
            return Ok((idx, true));
        }
        // params chỉ áp cho câu lệnh duy nhất (đã chặn multi-statement ở trên).
        stream_one_statement(conn, &stmt, params, idx, channel, cancel)
            .await
            .map_err(|e| (idx, e))?;
        idx += 1;
    }
    Ok((idx, cancel.load(Ordering::Relaxed)))
}

// Stream kết quả của MỘT câu lệnh: emit "columns" rồi các batch "rows".
async fn stream_one_statement(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    // Manual transaction mode: this is the SQL editor's path, so it is the one where the user
    // actually types BEGIN/COMMIT. See tx_session.rs.
    if crate::tx_session::should_route(conn, sql) {
        return crate::tx_session::run_stream(conn, sql, params, stmt_index, channel, cancel).await;
    }
    match conn {
        DbConnection::Sqlite(conn_arc) => sqlite_stream(conn_arc, sql, params, stmt_index, channel, cancel).await,
        DbConnection::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_stream(&mut conn, sql, params, stmt_index, channel, cancel).await
        }
        DbConnection::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_stream(&mut conn, sql, params, stmt_index, channel, cancel).await
        }
    }
}

// Split out of `stream_one_statement` so the pinned transaction session runs the same body.
// SQLite needs no pinning — `DbConnection::Sqlite` is one shared handle already.

pub(crate) async fn sqlite_stream(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    // rusqlite là đồng bộ -> chạy trong spawn_blocking để không chặn runtime async.
    let conn_arc = conn_arc.clone();
    let channel = channel.clone();
    let cancel = cancel.clone();
    let sql = sql.to_string();
    let sqlite_params: Vec<rusqlite::types::Value> = params.iter().map(json_to_sqlite_value).collect();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = conn_arc.lock().map_err(|e| e.to_string())?;
        let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
        let col_count = stmt.column_count();
        // Câu lệnh không trả về cột (INSERT/UPDATE/DELETE/DDL...) -> execute và báo số dòng ảnh hưởng.
        if col_count == 0 {
            let affected = stmt
                .execute(rusqlite::params_from_iter(sqlite_params.iter()))
                .map_err(|e| e.to_string())?;
            let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": affected }));
            return Ok(());
        }
        let mut columns = Vec::with_capacity(col_count);
        for i in 0..col_count {
            columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
        }
        uniquify_columns(&mut columns);
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));

        let mut rows = stmt.query(rusqlite::params_from_iter(sqlite_params.iter())).map_err(|e| e.to_string())?;
        let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match rows.next().map_err(|e| e.to_string())? {
                Some(row) => {
                    let mut map = serde_json::Map::new();
                    for i in 0..col_count {
                        let val: Value = match row.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                            Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                            Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                            Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                            Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                            _ => Value::Null,
                        };
                        map.insert(columns[i].clone(), val);
                    }
                    batch.push(Value::Object(map));
                    if batch.len() >= STREAM_BATCH {
                        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
                    }
                }
                None => break,
            }
        }
        if !batch.is_empty() {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn pg_stream(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let trimmed = sql.trim().to_uppercase();
    if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
        return Ok(());
    }
    // Dò xem câu lệnh có trả về cột không (qua prepared statement). Nếu không -> execute + báo affected.
    let returns_rows = match (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
        Ok(st) => !st.columns().is_empty(),
        Err(_) => true, // prepare lỗi -> cứ thử fetch theo đường cũ
    };
    if !returns_rows {
        let r = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
        return Ok(());
    }
    let mut columns: Vec<String> = Vec::new();
    let pg_query = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let mut stream = pg_query.fetch(&mut *conn);
    let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
    while let Some(r) = stream.try_next().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if columns.is_empty() {
            for col in r.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
            let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
        }
        let mut map = serde_json::Map::new();
        // Read by index: `columns` now holds the de-duplicated names, and reading by
        // name would hand back the first same-named column's value for every repeat.
        for (i, col_name) in columns.iter().enumerate() {
            let val: Value = decode_pg_cell!(&r, i);
            map.insert(col_name.clone(), val);
        }
        batch.push(Value::Object(map));
        if batch.len() >= STREAM_BATCH {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
        }
    }
    // The row stream borrows the connection; it must be released before the connection can
    // be used again for the column-name probe below.
    drop(stream);
    if !batch.is_empty() {
        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
    }
    if columns.is_empty() {
        // Probe on THIS connection: inside a manual transaction a second pooled connection
        // would block on the locks this one holds.
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
    }
    Ok(())
}

pub(crate) async fn mysql_stream(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let trimmed = sql.trim().to_uppercase();
    if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
        return Ok(());
    }
    // Dò xem câu lệnh có trả về cột không. Nếu không -> execute + báo affected.
    let returns_rows = match (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
        Ok(st) => !st.columns().is_empty(),
        Err(_) => {
            // Không prepare được (CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|EVENT -> lỗi 1295,
            // hoặc cú pháp lỗi). Chạy bằng text protocol: đúng cho DDL, còn cú pháp sai thì
            // lỗi thật của server được trả về ở đây.
            let r = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
            return Ok(());
        }
    };
    if !returns_rows {
        let r = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let _ = channel.send(json!({ "type": "affected", "stmtIndex": stmt_index, "query": sql, "affected": r.rows_affected() }));
        return Ok(());
    }
    let mut columns: Vec<String> = Vec::new();
    let mysql_query = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let mut stream = mysql_query.fetch(&mut *conn);
    let mut batch: Vec<Value> = Vec::with_capacity(STREAM_BATCH);
    while let Some(r) = stream.try_next().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if columns.is_empty() {
            for col in r.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
            let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
        }
        let mut map = serde_json::Map::new();
        // Read by index — see the Postgres branch above.
        for (i, col_name) in columns.iter().enumerate() {
            let val: Value = decode_mysql_cell!(&r, i);
            map.insert(col_name.clone(), val);
        }
        batch.push(Value::Object(map));
        if batch.len() >= STREAM_BATCH {
            let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
        }
    }
    // See the Postgres branch: the stream borrows the connection.
    drop(stream);
    if !batch.is_empty() {
        let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
    }
    if columns.is_empty() {
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
        let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
    }
    Ok(())
}

// Lấy danh sách cột khóa chính của một bảng theo từng dialect (hỗ trợ cả khóa chính tổ hợp).
async fn get_primary_key_columns(conn: &DbConnection, table: &str) -> Vec<String> {
    match conn {
        DbConnection::Sqlite(conn_arc) => {
            let mut cols: Vec<(i32, String)> = Vec::new();
            if let Ok(c) = conn_arc.lock() {
                let sql = format!("PRAGMA table_info(\"{}\")", table);
                if let Ok(mut stmt) = c.prepare(&sql) {
                    if let Ok(mut rows) = stmt.query([]) {
                        while let Ok(Some(row)) = rows.next() {
                            let pk: i32 = row.get("pk").unwrap_or(0);
                            if pk > 0 {
                                if let Ok(name) = row.get::<_, String>("name") {
                                    cols.push((pk, name));
                                }
                            }
                        }
                    }
                }
            }
            cols.sort_by_key(|(order, _)| *order);
            cols.into_iter().map(|(_, name)| name).collect()
        }
        DbConnection::Postgres(_) => {
            let sql = format!(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = '{}' AND tc.table_schema = 'public' \
                 ORDER BY kcu.ordinal_position",
                table.replace('\'', "''")
            );
            match execute_raw_sql_generic(conn, sql).await {
                Ok(results) => all_string_values(&results),
                Err(_) => Vec::new(),
            }
        }
        DbConnection::Mysql(_) => {
            let sql = format!(
                "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND CONSTRAINT_NAME = 'PRIMARY' \
                 ORDER BY ORDINAL_POSITION",
                table.replace('\'', "''")
            );
            match execute_raw_sql_generic(conn, sql).await {
                Ok(results) => all_string_values(&results),
                Err(_) => Vec::new(),
            }
        }
    }
}

// Tự dò tên cột khóa chính (lấy cột đầu tiên). Trả về None nếu không xác định được.
async fn detect_primary_key(conn: &DbConnection, table: &str) -> Option<String> {
    get_primary_key_columns(conn, table).await.into_iter().next()
}

// Lấy giá trị chuỗi ở ô đầu tiên của mỗi hàng trong kết quả execute_raw_sql_generic
fn all_string_values(results: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
        for row in data {
            if let Some(v) = row.as_object().and_then(|o| o.values().next()) {
                if let Some(s) = v.as_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn commit_changes(state: tauri::State<'_, crate::AppState>, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let table_name = payload.get("tableName").and_then(|v| v.as_str()).ok_or("Thiếu tên bảng")?;
    let changes = payload.get("changes").and_then(|v| v.as_array()).ok_or("Thiếu danh sách thay đổi")?;
    // Chế độ xem trước: chỉ dựng SQL, không thực thi
    let preview = payload.get("preview").and_then(|v| v.as_bool()).unwrap_or(false);

    // Xác định cột khóa chính: ưu tiên giá trị frontend gửi lên, nếu không có thì tự dò từ schema, cuối cùng mới fallback "id"
    let pk_col = match payload.get("primaryKey").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        Some(pk) => pk.to_string(),
        None => detect_primary_key(&conn_type, table_name).await.unwrap_or_else(|| "id".to_string()),
    };

    let is_pg = matches!(&conn_type, DbConnection::Postgres(_));
    let mut sqls: Vec<String> = Vec::new();

    for change in changes {
        let change_type = change.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let row_id = change.get("rowId").map(|v| {
            if v.is_string() {
                v.as_str().unwrap().to_string()
            } else {
                v.to_string()
            }
        }).unwrap_or_default();

        match change_type {
            "delete" => {
                let sql = format!("DELETE FROM `{}` WHERE `{}` = '{}'", table_name, pk_col, row_id.replace("'", "''"));
                sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
            }
            "insert" => {
                if let Some(new_data) = change.get("newData").and_then(|v| v.as_object()) {
                    let mut cols = Vec::new();
                    let mut vals = Vec::new();
                    for (k, v) in new_data {
                        cols.push(format!("`{}`", k));
                        if v.is_null() {
                            vals.push("NULL".to_string());
                        } else if v.is_string() {
                            vals.push(format!("'{}'", v.as_str().unwrap().replace("'", "''")));
                        } else {
                            vals.push(v.to_string());
                        }
                    }
                    let sql = format!(
                        "INSERT INTO `{}` ({}) VALUES ({})",
                        table_name,
                        cols.join(", "),
                        vals.join(", ")
                    );
                    sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
                }
            }
            "update" => {
                if let Some(new_data) = change.get("newData").and_then(|v| v.as_object()) {
                    let mut sets = Vec::new();
                    for (k, v) in new_data {
                        let val_str = if v.is_null() {
                            "NULL".to_string()
                        } else if v.is_string() {
                            format!("'{}'", v.as_str().unwrap().replace("'", "''"))
                        } else {
                            v.to_string()
                        };
                        sets.push(format!("`{}` = {}", k, val_str));
                    }
                    if !sets.is_empty() {
                        let sql = format!(
                            "UPDATE `{}` SET {} WHERE `{}` = '{}'",
                            table_name,
                            sets.join(", "),
                            pk_col,
                            row_id.replace("'", "''")
                        );
                        sqls.push(if is_pg { sql.replace("`", "\"") } else { sql });
                    }
                }
            }
            _ => {}
        }
    }

    // Xem trước: trả về danh sách SQL, không chạy
    if preview {
        return Ok(json!({ "success": true, "preview": true, "sqls": sqls }));
    }

    // Manual-commit mode: join the user's transaction instead of opening a nested one. They own the
    // commit point, so a failure here leaves the earlier statements pending for them to roll back —
    // which is the whole reason they turned auto-commit off.
    //
    // `use_session()`, NOT `is_open()`: the transaction does not exist until its first statement,
    // and pressing Save right after switching to manual is exactly that case. Checking `is_open()`
    // sent it down the auto-commit branch below and committed it.
    if crate::tx_session::use_session() {
        for sql in sqls {
            execute_raw_sql_generic(&conn_type, sql).await?;
        }
        return Ok(json!({ "success": true }));
    }

    // Auto-commit: the whole grid commit is one transaction, all or nothing.
    //
    // It used to run the statements one by one through `execute_raw_sql_generic`, which acquires a
    // NEW pooled connection per call — so a `BEGIN` sent that way would have landed on a different
    // session than the INSERT/UPDATEs and done nothing. `Exec` holds ONE connection for the whole
    // batch, which is what makes the rollback below real.
    //
    // Only DML gets built above. Do not add DDL to this batch: MySQL commits implicitly on DDL, so
    // the rollback would no longer undo everything.
    let mut exec = Exec::acquire(&conn_type).await?;
    let begin = if matches!(&conn_type, DbConnection::Mysql(_)) { "START TRANSACTION;" } else { "BEGIN;" };
    exec.run(begin.to_string()).await?;
    for sql in sqls {
        if let Err(e) = exec.run(sql.clone()).await {
            exec.try_run("ROLLBACK;").await;
            return Err(format!("Lỗi tại câu lệnh:\n{}\n\nChi tiết: {}", sql, e));
        }
    }
    exec.run("COMMIT;".to_string()).await?;

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn ai_chat(message: String) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "reply": format!("AI: Bạn vừa gửi: '{}'. Tính năng Copilot đang hoạt động offline thông qua Tauri Rust backend.", message)
    }))
}

#[tauri::command]
pub async fn export_table(_state: tauri::State<'_, crate::AppState>, _name: String, _format: String) -> Result<Value, String> {
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn restore_backup(
    state: tauri::State<'_, crate::AppState>,
    sql_content: String,
    tables: Vec<String>,
    // Kênh báo tiến độ về UI: {type:'start'|'progress'|'done', done, total}. Restore là một
    // lần gọi dài nên không có kênh thì UI chỉ vẽ được thanh vô định.
    // Bắt buộc (không dùng Option): Channel không impl Deserialize nên `Option<Channel<_>>`
    // không thoả CommandArg — frontend luôn tạo kênh, có cần dùng hay không thì tuỳ nó.
    on_progress: Channel<Value>,
    // Gặp lệnh lỗi thì bỏ qua và chạy tiếp, thay vì rollback toàn bộ (giống `mysql --force`).
    //
    // KHÔNG phải "tắt kiểm tra toàn vẹn": khoá ngoại vốn đã tắt sẵn ở mọi lần restore
    // (`SET FOREIGN_KEY_CHECKS = 0` / `SET CONSTRAINTS ALL DEFERRED` / `PRAGMA foreign_keys OFF`).
    // Thứ thật sự làm hỏng cả lần nhập là những lỗi không tắt được: `CREATE VIEW` đọc bảng
    // không có trong tệp, routine gọi hàm chưa tồn tại, kiểu dữ liệu server này không hiểu.
    // Chế độ này cứu lấy phần chạy được, đổi lại mất tính nguyên tử.
    continue_on_error: Option<bool>,
) -> Result<Value, String> {
    let continue_on_error = continue_on_error.unwrap_or(false);
    // Câu lệnh lỗi đã bỏ qua: đếm hết, nhưng chỉ giữ vài cái đầu để hiện cho người dùng.
    let mut failed_count: usize = 0;
    let mut failed_samples: Vec<Value> = Vec::new();
    const FAILED_SAMPLES_MAX: usize = 5;
    // Restore acquires its own connection and runs its own transaction. It would not corrupt the
    // user's open transaction — different session — but it would block on the locks that
    // transaction holds, and a frozen progress bar is a worse answer than a clear refusal.
    crate::tx_session::reject_if_manual_or_open("phục hồi dữ liệu")?;
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let mut statements_count = 0;
    let mut last_use_db: Option<String> = None;

    // Dùng CHUNG splitter với SQL editor: nó hiểu lệnh DELIMITER của MySQL và khối $$ của
    // Postgres, nên thân trigger/procedure/function không bị cắt ở dấu ';' bên trong.
    let statements = split_sql_statements(&sql_content);

    // Lọc TRƯỚC để biết tổng số câu lệnh sẽ chạy -> báo được phần trăm thật thay vì thanh vô định.
    // bool đi kèm = lệnh cấp phiên/schema (lỗi của nó không huỷ cả lần restore).
    let mut to_run: Vec<(String, bool)> = Vec::new();
    let matcher = TableMatcher::new(&tables);
    for q in statements {
        // Phân loại theo phần SAU comment đầu câu: dump của mysqldump luôn có
        // `-- Dumping data for table x` dán liền trước LOCK TABLES / INSERT.
        let body = strip_leading_comments(&q);
        let head = upper_head(body);
        if is_skipped_stmt(&head) {
            continue;
        }
        if body.is_empty() {
            // Câu chỉ còn comment. Comment ĐIỀU KIỆN của MySQL (`/*!40101 SET NAMES utf8mb4 */`)
            // là lệnh thật và ảnh hưởng tới charset/timezone của dữ liệu nhập -> vẫn phải chạy
            // (xếp vào cấp phiên để lỗi không huỷ cả lần restore). Comment thường thì bỏ.
            if q.contains("/*!") {
                to_run.push((q, true));
            }
            continue;
        }
        let session_level = is_session_level_stmt(&head);
        if session_level {
            if head.starts_with("USE ") {
                if let Some(db) = use_db_name(body) {
                    last_use_db = Some(db);
                }
            }
        } else if !matcher.matches(&q) {
            continue;
        }
        to_run.push((q, session_level));
    }

    // Đẩy mọi câu CREATE VIEW xuống cuối.
    //
    // Dump ghi view xen kẽ với bảng theo thứ tự alphabet — view `actor_info` của sakila đứng
    // ngay sau bảng `actor`, trước cả bảng `film` mà nó đọc — trong khi `CREATE VIEW` được
    // kiểm tra NGAY lúc chạy: MySQL trả 1146 "Table doesn't exist" và cả lần nhập bị rollback.
    // Bên xuất đã được sửa để ghi view sau bảng, nhưng những tệp dump đã có sẵn (và dump của
    // công cụ khác) thì không sửa được nữa, nên chỗ chạy cũng phải chịu được thứ tự sai.
    //
    // Chỉ CREATE VIEW được dời, và thứ tự tương đối giữa chúng được giữ nguyên (một view có thể
    // đọc view khác; export của app xếp sẵn theo phụ thuộc — xem `orderViewsByDependency`).
    // `DROP VIEW` nằm lại chỗ cũ là vô hại. Dời thêm loại câu lệnh khác thì có thể đổi nghĩa
    // của dump — ví dụ dump nào INSERT qua một updatable view sẽ hỏng.
    if let Ok(create_view_re) = regex::Regex::new(
        r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b",
    ) {
        // partition giữ nguyên thứ tự trong từng nhóm.
        let (rest, views): (Vec<_>, Vec<_>) = to_run
            .into_iter()
            .partition(|(q, _)| !create_view_re.is_match(strip_leading_comments(q)));
        to_run = rest;
        to_run.extend(views);
    }

    let total = to_run.len();
    let _ = on_progress.send(json!({ "type": "start", "total": total }));
    // Gửi mỗi PROGRESS_EVERY câu để không làm ngập IPC với dump hàng chục nghìn câu lệnh.
    const PROGRESS_EVERY: usize = 20;
    let send_progress = |done: usize| {
        let _ = on_progress.send(json!({ "type": "progress", "done": done, "total": total }));
    };


    match &conn_type {
        DbConnection::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;

            // 0. Dọn khoá còn treo trên connection này. LOCK TABLES là theo SESSION và pool thì
            //    tái dùng session: một lần restore trước đó chạy `LOCK TABLES x WRITE` mà không
            //    tới được `UNLOCK TABLES` sẽ để khoá lại, khiến lần sau ghi bảng khác báo lỗi
            //    1100 "was not locked with LOCK TABLES". Phải đứng TRƯỚC START TRANSACTION vì
            //    UNLOCK TABLES tự commit transaction đang mở.
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;

            // 1. Tắt khóa ngoại
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 0;").execute(&mut *conn).await;
            // 2. Bắt đầu Transaction
            let _ = sqlx::query("START TRANSACTION;").execute(&mut *conn).await;

            // 3. Chạy các lệnh
            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                // raw_sql = text protocol: MySQL KHÔNG cho CREATE/DROP TRIGGER|PROCEDURE|FUNCTION|
                // EVENT chạy qua prepared statement (lỗi 1295), mà dump thường có đủ mấy loại này.
                // Restore chỉ cần chạy, không đọc dòng nào, nên dùng text protocol cho tất cả.
                if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(q.clone())).execute(&mut *conn).await {
                    // Lệnh cấp phiên/schema lỗi thì bỏ qua; lỗi thật thì Rollback rồi trả lỗi.
                    if !session_level {
                        if continue_on_error {
                            // Lỗi một câu KHÔNG huỷ transaction của MySQL, nên phần đã ghi vẫn
                            // còn và chạy tiếp được ngay.
                            failed_count += 1;
                            if failed_samples.len() < FAILED_SAMPLES_MAX {
                                failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                            }
                            continue;
                        }
                        let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                        // Trả connection về pool ở trạng thái sạch, không để khoá/FK-check treo lại.
                        let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
                        let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            let _ = sqlx::query("COMMIT;").execute(&mut *conn).await;
            // 4. Trả connection về pool sạch sẽ: bỏ khoá (nếu dump có LOCK lọt qua) + bật lại FK
            let _ = sqlx::raw_sql("UNLOCK TABLES;").execute(&mut *conn).await;
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
        }
        _ => {
            // Tắt kiểm tra khóa ngoại và bắt đầu Transaction
            match &conn_type {
                DbConnection::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "SET CONSTRAINTS ALL DEFERRED;".to_string()).await;
                    let _ = execute_raw_sql_generic(&conn_type, "BEGIN;".to_string()).await;
                }
                DbConnection::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
                        let _ = conn.execute("BEGIN TRANSACTION;", []);
                    }
                }
                _ => {}
            }

            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                let exec_sql = match &conn_type {
                    DbConnection::Postgres(_) => q.replace("`", "\""),
                    _ => q.clone(),
                };
                // Postgres: một lỗi làm cả transaction chuyển sang trạng thái aborted (25P02),
                // mọi câu sau đó đều lỗi "current transaction is aborted". Muốn chạy tiếp thì
                // phải có điểm lùi cho từng câu. Chỉ trả giá 2 round trip khi người dùng bật
                // chế độ này; MySQL và SQLite không cần vì lỗi một câu không huỷ transaction.
                let pg_savepoint = continue_on_error && matches!(&conn_type, DbConnection::Postgres(_));
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                if let Err(e) = execute_raw_sql_generic(&conn_type, exec_sql).await {
                    if !session_level && continue_on_error {
                        if pg_savepoint {
                            let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK TO SAVEPOINT tn_restore_sp;".to_string()).await;
                        }
                        failed_count += 1;
                        if failed_samples.len() < FAILED_SAMPLES_MAX {
                            failed_samples.push(json!({ "sql": stmt_for_error(q), "error": e.to_string() }));
                        }
                        continue;
                    }
                    if !session_level {
                        // Rollback nếu có lỗi
                        match &conn_type {
                            DbConnection::Postgres(_) => {
                                let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK;".to_string()).await;
                            }
                            DbConnection::Sqlite(conn_arc) => {
                                if let Ok(conn) = conn_arc.lock() {
                                    let _ = conn.execute("ROLLBACK;", []);
                                    let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                                }
                            }
                            _ => {}
                        }
                        return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", stmt_for_error(q), e));
                    }
                    continue;
                }
                // Giải phóng điểm lùi ngay khi câu chạy xong, không để savepoint dồn lại.
                if pg_savepoint {
                    let _ = execute_raw_sql_generic(&conn_type, "RELEASE SAVEPOINT tn_restore_sp;".to_string()).await;
                }
                statements_count += 1;
                if idx % PROGRESS_EVERY == 0 || idx + 1 == total {
                    send_progress(idx + 1);
                }

            }

            // Commit transaction
            match &conn_type {
                DbConnection::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "COMMIT;".to_string()).await;
                }
                DbConnection::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("COMMIT;", []);
                    }
                }
                _ => {}
            }

            // Bật lại khóa ngoại
            match &conn_type {
                DbConnection::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = ON;", []);
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(ref db_name) = last_use_db {
        let (last_conf_opt, db_type, tunnel_port) = {
            let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
            (manager.last_config.clone(), manager.db_type.clone(),
             manager.ssh_tunnel.as_ref().map(|t| t.local_port))
        };

        if let Some(mut last_conf) = last_conf_opt {
            if let Some(obj) = last_conf.as_object_mut() {
                obj.insert("database".to_string(), json!(db_name));
                // Nếu đang dùng SSH tunnel, reconnect vẫn phải đi qua 127.0.0.1:<local_port>
                if let Some(port) = tunnel_port {
                    obj.insert("host".to_string(), json!("127.0.0.1"));
                    obj.insert("port".to_string(), json!(port));
                }
            }

            let new_conn = match db_type.as_str() {
                "postgres" => {
                    let url = build_pg_url(&last_conf, Some(db_name.as_str()));
                    let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbConnection::Postgres(pool))
                }
                "mysql" => {
                    let url = build_mysql_url(&last_conf, Some(db_name.as_str()));
                    let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbConnection::Mysql(pool))
                }
                _ => None
            };
            if let Some(c) = new_conn {
                let mut manager = state.db_manager.lock().map_err(|e| e.to_string())?;
                manager.connection = Some(c);
                manager.last_config = Some(last_conf);
            }
        }
    }

    let _ = on_progress.send(json!({ "type": "done", "done": total, "total": total, "statementsCount": statements_count }));

    Ok(json!({
        "success": true,
        "statementsCount": statements_count,
        "activeDatabase": last_use_db,
        // Chỉ khác 0 khi bật continue_on_error — UI phải nói rõ "đã nhập nhưng thiếu ngần này",
        // im lặng ở đây thì người dùng tin là nhập trọn vẹn.
        "failedCount": failed_count,
        "failedSamples": failed_samples
    }))
}

#[tauri::command]
pub async fn import_dbeaver() -> Result<Value, String> {
    Ok(json!({ "success": true, "connections": [] }))
}

#[tauri::command]
pub async fn restore_backup_old(_state: tauri::State<'_, crate::AppState>, _file_path: String, _tables: Vec<String>) -> Result<Value, String> {
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn import_new_table(state: tauri::State<'_, crate::AppState>, table_name: String, rows: Vec<Value>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    if rows.is_empty() {
        return Err("Không có dữ liệu để tạo bảng".to_string());
    }
    let is_mysql = matches!(&conn_type, DbConnection::Mysql(_));
    let is_pg = matches!(&conn_type, DbConnection::Postgres(_));
    let q = if is_mysql { '`' } else { '"' };

    // Cột = hợp các key (giữ thứ tự xuất hiện lần đầu).
    let mut col_order: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        if let Some(obj) = row.as_object() {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    col_order.push(k.clone());
                }
            }
        }
    }
    if col_order.is_empty() {
        return Err("Dữ liệu import không có cột nào".to_string());
    }

    // Suy kiểu mỗi cột: mọi giá trị non-null là số nguyên -> INT; là số (có phần thập phân) -> REAL/DOUBLE; còn lại -> TEXT.
    let mut defs: Vec<String> = Vec::new();
    for c in &col_order {
        let (mut all_int, mut all_num, mut any) = (true, true, false);
        for row in &rows {
            if let Some(v) = row.as_object().and_then(|o| o.get(c)) {
                if v.is_null() {
                    continue;
                }
                any = true;
                if !(v.is_i64() || v.is_u64()) {
                    all_int = false;
                }
                if !v.is_number() {
                    all_num = false;
                }
            }
        }
        let ty = if any && all_int {
            if is_pg || is_mysql { "BIGINT" } else { "INTEGER" }
        } else if any && all_num {
            if is_pg { "DOUBLE PRECISION" } else if is_mysql { "DOUBLE" } else { "REAL" }
        } else {
            "TEXT"
        };
        defs.push(format!("{q}{}{q} {}", c, ty));
    }

    let create_sql = format!("CREATE TABLE {q}{}{q} ({})", table_name, defs.join(", "));
    execute_raw_sql_generic(&conn_type, create_sql).await?;

    let inserted = bulk_insert(&conn_type, &table_name, &rows).await?;
    Ok(json!({ "success": true, "inserted": inserted }))
}

#[tauri::command]
pub async fn create_table(state: tauri::State<'_, crate::AppState>, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    
    let table_name = payload.get("tableName").and_then(|v| v.as_str()).ok_or("Thiếu tên bảng")?;

    let db_type = match &conn_type {
        DbConnection::Sqlite(_) => "sqlite",
        DbConnection::Postgres(_) => "postgres",
        DbConnection::Mysql(_) => "mysql",
    };
    let q = if db_type == "mysql" { '`' } else { '"' };

    let columns = payload.get("columns").and_then(|v| v.as_array());

    // Nếu không truyền cột nào -> giữ hành vi cũ: tạo bảng tối thiểu với 1 cột id khóa chính
    let create_sql = match columns {
        Some(cols) if !cols.is_empty() => {
            // Danh sách cột khóa chính
            let pk_cols: Vec<String> = cols.iter()
                .filter(|c| c.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false))
                .filter_map(|c| c.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            // Trường hợp đặc biệt: đúng 1 khóa chính và có tự tăng -> dùng cú pháp auto-increment ngay trên cột đó
            let single_auto_pk = pk_cols.len() == 1
                && cols.iter().any(|c| {
                    c.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false)
                        && c.get("autoIncrement").and_then(|v| v.as_bool()).unwrap_or(false)
                });

            let mut defs: Vec<String> = Vec::new();
            for col in cols {
                let name = match col.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                    Some(n) => n,
                    None => continue,
                };
                let col_type = col.get("type").and_then(|v| v.as_str()).unwrap_or("TEXT");
                let is_pk = col.get("isPrimaryKey").and_then(|v| v.as_bool()).unwrap_or(false);
                let nullable = col.get("nullable").and_then(|v| v.as_bool()).unwrap_or(true);
                let default_val = col.get("defaultValue").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

                if single_auto_pk && is_pk {
                    // Cột khóa chính tự tăng: cú pháp riêng theo từng dialect
                    let def = match db_type {
                        "mysql" => format!("{q}{name}{q} {ty} NOT NULL AUTO_INCREMENT PRIMARY KEY", q = q, name = name, ty = col_type),
                        "postgres" => format!("{q}{name}{q} SERIAL PRIMARY KEY", q = q, name = name),
                        _ => format!("{q}{name}{q} INTEGER PRIMARY KEY AUTOINCREMENT", q = q, name = name),
                    };
                    defs.push(def);
                    continue;
                }

                let mut def = format!("{q}{name}{q} {ty}", q = q, name = name, ty = col_type);
                if !nullable {
                    def.push_str(" NOT NULL");
                }
                if let Some(d) = default_val {
                    if d.eq_ignore_ascii_case("CURRENT_TIMESTAMP") || d == "0" || d.eq_ignore_ascii_case("true") || d.eq_ignore_ascii_case("false") || d == "''" {
                        def.push_str(&format!(" DEFAULT {}", d));
                    } else {
                        def.push_str(&format!(" DEFAULT '{}'", d.replace('\'', "''")));
                    }
                }
                defs.push(def);
            }

            // Nếu có nhiều khóa chính (hoặc khóa chính không tự tăng) -> thêm ràng buộc PRIMARY KEY ở cấp bảng
            if !single_auto_pk && !pk_cols.is_empty() {
                let pk_list = pk_cols.iter().map(|c| format!("{q}{c}{q}", q = q, c = c)).collect::<Vec<_>>().join(", ");
                defs.push(format!("PRIMARY KEY ({})", pk_list));
            }

            format!("CREATE TABLE {q}{name}{q} ({defs})", q = q, name = table_name, defs = defs.join(", "))
        }
        _ => match &conn_type {
            DbConnection::Mysql(_) => format!("CREATE TABLE `{}` (id INT AUTO_INCREMENT PRIMARY KEY)", table_name),
            _ => format!("CREATE TABLE \"{}\" (id INTEGER PRIMARY KEY)", table_name),
        },
    };

    execute_raw_sql_generic(&conn_type, create_sql).await?;

    // Sau khi tạo bảng, tạo tiếp Index & Foreign Key (nếu có) — tái dùng bộ sinh SQL đã sửa ở generate_alter_sqls
    let extra_payload = json!({
        "addedIndexes": payload.get("indexes").cloned().unwrap_or(json!([])),
        "addedFKs": payload.get("foreignKeys").cloned().unwrap_or(json!([])),
    });
    let extra_sqls = generate_alter_sqls(table_name, &extra_payload, db_type);
    for sql in extra_sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

    Ok(json!({ "success": true }))
}

// Bọc định danh theo dialect (MySQL backtick, còn lại double quote), nhân đôi ký tự đóng.
fn quote_ident(conn: &DbConnection, name: &str) -> String {
    match conn {
        DbConnection::Mysql(_) => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

// Bật/tắt kiểm tra khóa ngoại ở MỨC SESSION. Chỉ đúng khi mọi lệnh dùng chung một `Exec`.
// Dùng try_run: server từ chối (Postgres `session_replication_role` cần superuser) thì lệnh
// chính vẫn phải chạy, và lệnh khôi phục vẫn phải thử dù lệnh chính đã lỗi.
fn fk_checks_sql(conn: &DbConnection, on: bool) -> &'static str {
    match conn {
        DbConnection::Mysql(_) => {
            if on { "SET FOREIGN_KEY_CHECKS = 1" } else { "SET FOREIGN_KEY_CHECKS = 0" }
        }
        DbConnection::Postgres(_) => {
            if on { "SET session_replication_role = 'origin'" } else { "SET session_replication_role = 'replica'" }
        }
        DbConnection::Sqlite(_) => {
            if on { "PRAGMA foreign_keys = ON" } else { "PRAGMA foreign_keys = OFF" }
        }
    }
}

/// Runs a short sequence on ONE connection, optionally with foreign-key checks turned off around it.
///
/// Two requirements, and the pool satisfies neither on its own:
///  - **One connection**, or `SET FOREIGN_KEY_CHECKS` lands on a different session than the
///    statement it is meant to wrap and quietly does nothing.
///  - **The pinned session when the user is in manual-commit mode.** Taking a fresh connection
///    there would run the DROP/TRUNCATE outside their transaction and commit it — "manual commit"
///    that commits by itself. Note this is `use_session()`, not `is_open()`: the transaction does
///    not exist until its first statement, and this may well be that statement.
///
/// `optional` runs only if the main statement succeeded and its own failure is ignored.
async fn run_fk_wrapped(
    conn: &DbConnection,
    disable_fk: bool,
    sql: String,
    optional: Option<String>,
) -> Result<(), String> {
    if crate::tx_session::use_session() {
        // execute_raw_sql_generic routes to the pinned session, so all of these share one
        // connection exactly like the `Exec` branch below.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, false).to_string()).await;
        }
        let result = execute_raw_sql_generic(conn, sql).await;
        if result.is_ok() {
            if let Some(extra) = optional {
                let _ = execute_raw_sql_generic(conn, extra).await;
            }
        }
        // Restore even on failure: the session lives on and later statements must not inherit a
        // disabled foreign-key check.
        if disable_fk {
            let _ = execute_raw_sql_generic(conn, fk_checks_sql(conn, true).to_string()).await;
        }
        return result.map(|_| ());
    }

    let mut exec = Exec::acquire(conn).await?;
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, false)).await;
    }
    let result = exec.run(sql).await;
    if result.is_ok() {
        if let Some(extra) = optional {
            exec.try_run(&extra).await;
        }
    }
    // Khôi phục kể cả khi lỗi: connection quay lại pool (hoặc là handle SQLite dùng chung),
    // nếu không lệnh sau sẽ chạy trên session còn tắt kiểm tra khóa ngoại.
    if disable_fk {
        exec.try_run(fk_checks_sql(conn, true)).await;
    }
    result
}

// Xóa bảng/view. `cascade` và `ignore_fk` là 2 tuỳ chọn của dialog Delete ở sidebar.
#[tauri::command]
pub async fn drop_table(
    state: tauri::State<'_, crate::AppState>,
    name: String,
    is_view: Option<bool>,
    cascade: Option<bool>,
    ignore_fk: Option<bool>,
) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    let is_view = is_view.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    // Bỏ qua khóa ngoại không có nghĩa với view: view không nằm trong ràng buộc FK nào.
    let ignore_fk = ignore_fk.unwrap_or(false) && !is_view;

    // CASCADE chỉ Postgres mới thực thi thật: SQLite báo lỗi cú pháp, MySQL chấp nhận từ khóa
    // rồi bỏ qua -> người dùng tưởng đã xóa lan mà thực tế không. Từ chối còn hơn im lặng.
    if cascade && !matches!(conn_type, DbConnection::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    let keyword = if is_view { "DROP VIEW" } else { "DROP TABLE" };
    let sql = format!(
        "{} {}{}",
        keyword,
        quote_ident(&conn_type, &name),
        if cascade { " CASCADE" } else { "" }
    );

    run_fk_wrapped(&conn_type, ignore_fk, sql, None).await?;

    Ok(json!({ "success": true }))
}

// Giá trị AUTO_INCREMENT kế tiếp của một bảng MySQL, None nếu bảng không có cột tự tăng.
// Chỉ đọc (SELECT) nên chạy qua execute_raw_sql_generic được, không cần chung session với TRUNCATE.
async fn mysql_next_auto_increment(conn: &DbConnection, name: &str) -> Option<u64> {
    let sql = format!(
        "SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'",
        name.replace('\'', "''")
    );
    let results = execute_raw_sql_generic(conn, sql).await.ok()?;
    let cell = results.first()?.get("data")?.as_array()?.first()?.get("ai")?;
    // decode_mysql_cell! trả u64 thành số, nhưng nhận cả chuỗi cho chắc.
    cell.as_u64().or_else(|| cell.as_str()?.parse().ok())
}

// Xóa sạch dữ liệu nhưng giữ cấu trúc bảng.
// `restart_identity` / `disable_fk` / `cascade` là 3 tuỳ chọn của dialog Truncate ở sidebar.
#[tauri::command]
pub async fn truncate_table(
    state: tauri::State<'_, crate::AppState>,
    name: String,
    restart_identity: Option<bool>,
    disable_fk: Option<bool>,
    cascade: Option<bool>,
) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    let restart_identity = restart_identity.unwrap_or(false);
    let disable_fk = disable_fk.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    let quoted = quote_ident(&conn_type, &name);

    // Như DROP: chỉ Postgres có TRUNCATE ... CASCADE.
    if cascade && !matches!(conn_type, DbConnection::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    // MySQL luôn reset bộ đếm tự tăng bên trong TRUNCATE và không có cách tắt, nên "giữ nguyên
    // bộ đếm" phải làm thủ công: đọc giá trị trước, đặt lại sau. Đọc TRƯỚC khi truncate.
    let keep_auto_inc = match (&conn_type, restart_identity) {
        (DbConnection::Mysql(_), false) => mysql_next_auto_increment(&conn_type, &name).await,
        _ => None,
    };

    // Câu lệnh bắt buộc + câu lệnh "cố gắng" chạy sau (lỗi không tính là thất bại).
    let (sql, optional): (String, Option<String>) = match &conn_type {
        DbConnection::Mysql(_) => (
            format!("TRUNCATE TABLE {}", quoted),
            match (restart_identity, keep_auto_inc) {
                // InnoDB đã reset sẵn; vẫn phát lệnh để ý định rõ ràng và các engine khác hành xử
                // giống nhau. Bảng không có cột tự tăng -> bỏ qua lỗi.
                (true, _) => Some(format!("ALTER TABLE {} AUTO_INCREMENT = 1", quoted)),
                // Đặt lại giá trị cũ để id mới không dùng lại id đã xóa.
                (false, Some(v)) if v > 1 => {
                    Some(format!("ALTER TABLE {} AUTO_INCREMENT = {}", quoted, v))
                }
                _ => None,
            },
        ),
        DbConnection::Postgres(_) => (
            format!(
                "TRUNCATE TABLE {}{}{}",
                quoted,
                if restart_identity { " RESTART IDENTITY" } else { "" },
                if cascade { " CASCADE" } else { "" }
            ),
            None,
        ),
        // SQLite không có TRUNCATE -> DELETE FROM, và bộ đếm tự tăng nằm ở bảng phụ
        // sqlite_sequence mà DELETE không đụng tới. Bảng này chỉ tồn tại khi CSDL có
        // ít nhất một cột AUTOINCREMENT -> bỏ qua lỗi "no such table".
        DbConnection::Sqlite(_) => (
            format!("DELETE FROM {}", quoted),
            restart_identity.then(|| {
                format!("DELETE FROM sqlite_sequence WHERE name = '{}'", name.replace('\'', "''"))
            }),
        ),
    };

    run_fk_wrapped(&conn_type, disable_fk, sql, optional).await?;

    Ok(json!({ "success": true }))
}

// Trả về câu lệnh CREATE TABLE (định nghĩa) của bảng theo từng dialect
#[tauri::command]
pub async fn get_table_definition(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let ddl: String = match &conn_type {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([name.as_str()]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let s: String = row.get(0).map_err(|e| e.to_string())?;
                format!("{};", s)
            } else {
                return Err("Không tìm thấy định nghĩa bảng".to_string());
            }
        }
        DbConnection::Mysql(pool) => {
            let show_sql = format!("SHOW CREATE TABLE `{}`", name);
            let row = sqlx::query(sqlx::AssertSqlSafe(show_sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            // Cột thứ 2 là "Create Table" (bảng) hoặc "Create View" (view)
            let s: String = row.try_get("Create Table").or_else(|_| row.try_get("Create View")).map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbConnection::Postgres(_) => {
            // A view is NOT a table here. This branch used to hand-build `CREATE TABLE` for
            // every name it was given, so exporting a Postgres database emitted a CREATE TABLE
            // for each of its views — the re-import then had a real table shadowing the view
            // and none of the view logic. relkind decides: 'v' = view, 'm' = materialized view
            // (which CREATE ... WITH DATA populates on the spot, so no REFRESH is needed as
            // long as it is written after the tables it reads — which the dump order does).
            let relkind = {
                let sql = format!(
                    "SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = 'public' AND c.relname = '{}' LIMIT 1",
                    name.replace('\'', "''")
                );
                execute_raw_sql_generic(&conn_type, sql)
                    .await
                    .ok()
                    .and_then(|r| all_string_values(&r).into_iter().next())
                    .unwrap_or_default()
            };
            if relkind == "v" || relkind == "m" {
                let sql = format!(
                    "SELECT pg_get_viewdef('\"{}\"'::regclass, true) AS def",
                    name.replace('"', "\"\"")
                );
                let results = execute_raw_sql_generic(&conn_type, sql).await?;
                let body = all_string_values(&results)
                    .into_iter()
                    .next()
                    .ok_or("Không lấy được định nghĩa đối tượng")?;
                let body = body.trim().trim_end_matches(';');
                let kw = if relkind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
                return Ok(json!({
                    "success": true,
                    "sql": format!("CREATE {} \"{}\" AS\n{};", kw, name.replace('"', "\"\""), body)
                }));
            }

            // Postgres không có SHOW CREATE TABLE -> dựng lại từ metadata (cột + NOT NULL + DEFAULT + PRIMARY KEY)
            let pk_cols = get_primary_key_columns(&conn_type, &name).await;
            // format_type() keeps length/precision — see get_table_schema for why.
            let sql = format!(
                "SELECT a.attname::text AS column_name, \
                        format_type(a.atttypid, a.atttypmod) AS data_type, \
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, \
                        pg_get_expr(d.adbin, d.adrelid) AS column_default \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = 'public' AND c.relname = '{}' \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                name.replace('\'', "''")
            );
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            let mut defs: Vec<String> = Vec::new();
            if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    let o = match row.as_object() { Some(o) => o, None => continue };
                    let col = o.get("column_name").and_then(|v| v.as_str()).unwrap_or("");
                    let ty = o.get("data_type").and_then(|v| v.as_str()).unwrap_or("text");
                    let nullable = o.get("is_nullable").and_then(|v| v.as_str()).unwrap_or("YES") == "YES";
                    let default = o.get("column_default").and_then(|v| v.as_str());
                    let mut def = format!("  \"{}\" {}", col, ty);
                    if !nullable { def.push_str(" NOT NULL"); }
                    if let Some(d) = default { def.push_str(&format!(" DEFAULT {}", d)); }
                    defs.push(def);
                }
            }
            if !pk_cols.is_empty() {
                let pk_list = pk_cols.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
                defs.push(format!("  PRIMARY KEY ({})", pk_list));
            }
            format!("CREATE TABLE \"{}\" (\n{}\n);", name, defs.join(",\n"))
        }
    };

    Ok(json!({ "success": true, "sql": ddl }))
}

#[tauri::command]
pub async fn rename_table(state: tauri::State<'_, crate::AppState>, old_name: String, new_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    
    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!("RENAME TABLE `{}` TO `{}`", old_name, new_name),
        _ => format!("ALTER TABLE \"{}\" RENAME TO \"{}\"", old_name, new_name),
    };
    execute_raw_sql_generic(&conn_type, sql.clone()).await?;
    
    Ok(json!({ "success": true }))
}

// Định dạng một giá trị JSON thành literal SQL (theo cùng quy ước với commit_changes/export):
// null -> NULL, chuỗi -> '...' (escape nháy đơn), còn lại (số/bool) -> to_string().
fn sql_literal(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "NULL".to_string(),
        Some(Value::String(s)) => format!("'{}'", s.replace('\'', "''")),
        Some(other) => other.to_string(),
    }
}

// Chèn hàng loạt dòng vào một bảng đã tồn tại. Gộp mỗi BATCH dòng vào một câu INSERT nhiều VALUES.
// Cột lấy từ hợp (union) các key của các dòng, giữ thứ tự xuất hiện lần đầu.
async fn bulk_insert(conn: &DbConnection, table: &str, rows: &[Value]) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let is_mysql = matches!(conn, DbConnection::Mysql(_));
    let q = if is_mysql { '`' } else { '"' };

    let mut col_order: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(obj) = row.as_object() {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    col_order.push(k.clone());
                }
            }
        }
    }
    if col_order.is_empty() {
        return Err("Dữ liệu import không có cột nào".to_string());
    }

    let quoted_table = format!("{q}{}{q}", table);
    let cols_sql = col_order.iter().map(|c| format!("{q}{}{q}", c)).collect::<Vec<_>>().join(", ");

    const BATCH: usize = 500;
    let mut inserted = 0usize;
    for chunk in rows.chunks(BATCH) {
        let mut values_list: Vec<String> = Vec::with_capacity(chunk.len());
        for row in chunk {
            let obj = row.as_object();
            let vals: Vec<String> = col_order
                .iter()
                .map(|c| sql_literal(obj.and_then(|o| o.get(c))))
                .collect();
            values_list.push(format!("({})", vals.join(", ")));
        }
        // MySQL/SQLite/PG đều chấp nhận cú pháp INSERT nhiều VALUES.
        let sql = format!("INSERT INTO {} ({}) VALUES {};", quoted_table, cols_sql, values_list.join(", "));
        execute_raw_sql_generic(conn, sql).await?;
        inserted += chunk.len();
    }
    Ok(inserted)
}

#[tauri::command]
pub async fn import_table_data(state: tauri::State<'_, crate::AppState>, name: String, rows: Vec<Value>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    let inserted = bulk_insert(&conn_type, &name, &rows).await?;
    Ok(json!({ "success": true, "inserted": inserted }))
}

// Utility: executes raw SQL statements across all databases and maps to standard outputs
// MySQL báo 1295 "This command is not supported in the prepared statement protocol yet" cho
// CREATE/DROP TRIGGER, PROCEDURE, FUNCTION, EVENT... Những lệnh đó phải gửi bằng text protocol
// (sqlx::raw_sql) thay vì sqlx::query.
fn is_mysql_unprepared_error(err_text: &str) -> bool {
    err_text.contains("1295") || err_text.contains("not supported in the prepared statement protocol")
}

pub(crate) async fn execute_raw_sql_generic(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    // Manual transaction mode: the statement must run on the connection the transaction was opened
    // on, otherwise it neither sees nor joins the uncommitted work. See tx_session.rs.
    if crate::tx_session::should_route(conn, &sql) {
        return crate::tx_session::run_raw(conn, sql).await;
    }
    match conn {
        DbConnection::Sqlite(conn_arc) => sqlite_raw(conn_arc, &sql),
        DbConnection::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_raw(&mut conn, &sql).await
        }
        DbConnection::Mysql(pool) => {
            // Lấy 1 connection duy nhất từ pool để chạy câu lệnh, đảm bảo SET FOREIGN_KEY_CHECKS hoạt động xuyên suốt phiên
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_raw(&mut conn, &sql).await
        }
    }
}

// The three functions below are the row-building bodies that used to sit inline in
// `execute_raw_sql_generic`. They are split out so the SAME code runs whether the connection came
// from the pool or from the pinned manual-transaction session (tx_session.rs) — duplicating them
// would mean duplicating the two rules that every row-building site in this file must follow:
// `uniquify_columns` before any row is assembled, and cell decoding BY INDEX.

pub(crate) fn sqlite_raw(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
) -> Result<Vec<Value>, String> {
    let conn = conn_arc.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let mut columns = Vec::new();
    for i in 0..col_count {
        columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
    }
    uniquify_columns(&mut columns);

    let mut rows_json = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = serde_json::Map::new();
        for i in 0..col_count {
            let col_name = columns[i].clone();
            let val: Value = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                _ => Value::Null,
            };
            map.insert(col_name, val);
        }
        rows_json.push(Value::Object(map));
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn pg_raw(
    conn: &mut sqlx::PgConnection,
    sql: &str,
) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    if sql.to_uppercase().trim().starts_with("USE ") || sql.to_uppercase().trim().starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        return Ok(results);
    }
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_pg_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_pg_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    } else {
        // Prepare on THIS connection, not on the pool: inside a manual transaction a second
        // connection would block on the locks this one holds.
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
    }
    results.push(json!({ "columns": columns, "data": rows_json }));
    Ok(results)
}

pub(crate) async fn mysql_raw(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    if sql.to_uppercase().trim().starts_with("USE ") || sql.to_uppercase().trim().starts_with("CREATE DATABASE") {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        return Ok(results);
    }
    let rows = match sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).fetch_all(&mut *conn).await {
        Ok(r) => r,
        Err(e) if is_mysql_unprepared_error(&e.to_string()) => {
            // MySQL từ chối prepare một số lệnh (CREATE/DROP TRIGGER, PROCEDURE,
            // FUNCTION, EVENT...) -> chạy lại bằng text protocol.
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string()))
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            Vec::new()
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_mysql_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_mysql_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    } else {
        // Same reason as the Postgres branch: prepare on this connection.
        if let Ok(stmt) = (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
            for col in stmt.columns() {
                columns.push(col.name().to_string());
            }
            uniquify_columns(&mut columns);
        }
    }
    results.push(json!({ "columns": columns, "data": rows_json }));
    Ok(results)
}

/// One statement target: a pooled connection (Postgres/MySQL) or the shared SQLite handle.
///
/// A dedicated connection is the point. `execute_raw_sql_generic` acquires a NEW connection from
/// the pool per call, so `BEGIN` / `SET FOREIGN_KEY_CHECKS` / `SET session_replication_role` /
/// `PRAGMA foreign_keys` issued through it would land on a different session than the statements
/// they are meant to wrap, and quietly do nothing.
pub(crate) enum Exec {
    Sqlite(Arc<Mutex<SqliteConnection>>),
    Postgres(sqlx::pool::PoolConnection<sqlx::Postgres>),
    Mysql(sqlx::pool::PoolConnection<sqlx::MySql>),
}

impl Exec {
    /// Takes one connection out of the pool and holds it for the caller's whole sequence.
    pub(crate) async fn acquire(conn: &DbConnection) -> Result<Exec, String> {
        Ok(match conn {
            DbConnection::Sqlite(arc) => Exec::Sqlite(arc.clone()),
            DbConnection::Postgres(pool) => {
                Exec::Postgres(pool.acquire().await.map_err(|e| e.to_string())?)
            }
            DbConnection::Mysql(pool) => {
                Exec::Mysql(pool.acquire().await.map_err(|e| e.to_string())?)
            }
        })
    }

    pub(crate) async fn run(&mut self, sql: String) -> Result<(), String> {
        match self {
            Exec::Sqlite(arc) => {
                let conn = arc.lock().map_err(|e| e.to_string())?;
                conn.execute_batch(&sql).map_err(|e| e.to_string())
            }
            // raw_sql = text protocol. MySQL rejects some statements in the prepared protocol
            // (error 1295) and these statements carry literals only, so nothing is gained
            // by preparing them.
            Exec::Postgres(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut **c)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Exec::Mysql(c) => sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut **c)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }

    /// For statements whose failure must not abort the caller (a session flag the server refuses,
    /// an optional catalog table that does not exist).
    pub(crate) async fn try_run(&mut self, sql: &str) {
        let _ = self.run(sql.to_string()).await;
    }
}

// Như execute_raw_sql_generic nhưng bind tham số ở tầng driver (parameterized query).
// Chỉ dùng cho MỘT câu lệnh (vd EXPLAIN <query có :param>) — không tách nhiều câu lệnh.
// SQL truyền vào phải đã dùng placeholder native (`?` cho SQLite/MySQL, `$1..$n` cho Postgres).
async fn run_bound_query(conn: &DbConnection, sql: String, params: &[Value]) -> Result<Vec<Value>, String> {
    if crate::tx_session::should_route(conn, &sql) {
        return crate::tx_session::run_bound(conn, sql, params).await;
    }
    match conn {
        DbConnection::Sqlite(conn_arc) => sqlite_bound(conn_arc, &sql, params),
        DbConnection::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            pg_bound(&mut conn, &sql, params).await
        }
        DbConnection::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            mysql_bound(&mut conn, &sql, params).await
        }
    }
}

// Split out of `run_bound_query` for the same reason as `pg_raw`/`mysql_raw`: the pinned
// transaction session runs the identical body on its own connection.

pub(crate) fn sqlite_bound(
    conn_arc: &Arc<Mutex<SqliteConnection>>,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let conn = conn_arc.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let mut columns = Vec::new();
    for i in 0..col_count {
        columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
    }
    uniquify_columns(&mut columns);
    let sqlite_params: Vec<rusqlite::types::Value> = params.iter().map(json_to_sqlite_value).collect();
    let mut rows_json = Vec::new();
    let mut rows = stmt.query(rusqlite::params_from_iter(sqlite_params.iter())).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = serde_json::Map::new();
        for i in 0..col_count {
            let val: Value = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                _ => Value::Null,
            };
            map.insert(columns[i].clone(), val);
        }
        rows_json.push(Value::Object(map));
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn pg_bound(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let query = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let rows = query.fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_pg_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_pg_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

pub(crate) async fn mysql_bound(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let query = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params);
    let rows = query.fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    let mut rows_json = Vec::new();
    let mut columns = Vec::new();
    if !rows.is_empty() {
        for col in rows[0].columns() {
            columns.push(col.name().to_string());
        }
        uniquify_columns(&mut columns);
        for r in rows {
            let mut map = serde_json::Map::new();
            // By index, not name — see decode_mysql_cell!.
            for (i, col_name) in columns.iter().enumerate() {
                let val: Value = decode_mysql_cell!(&r, i);
                map.insert(col_name.clone(), val);
            }
            rows_json.push(Value::Object(map));
        }
    }
    Ok(vec![json!({ "columns": columns, "data": rows_json })])
}

// Pool tối giản chỉ để chạy 1 câu liệt kê database (1 connection, timeout ngắn).
async fn open_list_pool_pg(url: &str) -> Result<PgPool, String> {
    sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
        .max_connections(1)
        .acquire_timeout(LIST_DB_TIMEOUT)
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

async fn open_list_pool_mysql(url: &str) -> Result<MySqlPool, String> {
    sqlx::pool::PoolOptions::<sqlx::MySql>::new()
        .max_connections(1)
        .acquire_timeout(LIST_DB_TIMEOUT)
        .connect(url)
        .await
        .map_err(|e| e.to_string())
}

// Lỗi thuộc dạng "database không tồn tại" (MySQL 1049, Postgres 3D000) thì đáng
// thử lại bằng DB hệ thống; lỗi mạng/xác thực thì thử lại chỉ tốn thêm timeout.
fn is_unknown_database_err(err: &str) -> bool {
    err.contains("atabase")
}

#[tauri::command]
pub async fn get_databases_list(config: Value) -> Result<Value, String> {
    let db_type = config.get("dbType").and_then(|v| v.as_str()).unwrap_or("").to_string();
    
    let mut databases = Vec::new();
    
    match db_type.as_str() {
        "postgres" => {
            // Giữ tunnel sống trong suốt thao tác liệt kê (nếu bật SSH)
            let (conn_config, _tunnel) = apply_ssh_tunnel(&config, 5432).await?;
            // Ưu tiên database đang điền (user bị giới hạn quyền — vd Postgres
            // managed trên cloud — thường chỉ vào được đúng DB của mình). Nếu tên
            // đó không tồn tại (đang gõ dở) thì lùi về DB hệ thống "postgres".
            let pool = match open_list_pool_pg(&build_pg_url(&conn_config, None)).await {
                Ok(p) => p,
                Err(first) if is_unknown_database_err(&first) => {
                    open_list_pool_pg(&build_pg_url(&conn_config, Some("postgres")))
                        .await
                        .map_err(|_| first)?
                }
                Err(first) => return Err(first),
            };
            let rows = sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            for r in rows {
                if let Ok(name) = r.try_get::<String, _>("datname") {
                    databases.push(name);
                }
            }
        }
        "mysql" => {
            let (conn_config, _tunnel) = apply_ssh_tunnel(&config, 3306).await?;
            let pool = match open_list_pool_mysql(&build_mysql_url(&conn_config, None)).await {
                Ok(p) => p,
                Err(first) if is_unknown_database_err(&first) => {
                    open_list_pool_mysql(&build_mysql_url(&conn_config, Some("mysql")))
                        .await
                        .map_err(|_| first)?
                }
                Err(first) => return Err(first),
            };
            let rows = sqlx::query("SHOW DATABASES")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;
                
            for r in rows {
                if let Ok(name) = r.try_get::<String, _>(0) {
                    databases.push(name);
                }
            }
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    }
    
    databases.sort();
    Ok(json!({ "success": true, "databases": databases }))
}

// Liệt kê database bằng KẾT NỐI HIỆN TẠI (phục vụ switcher trong workspace)
#[tauri::command]
pub async fn list_databases(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Postgres(_) => "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname".to_string(),
        DbConnection::Mysql(_) => "SHOW DATABASES".to_string(),
        DbConnection::Sqlite(_) => return Ok(json!({ "success": true, "databases": [] })), // SQLite: 1 file = 1 DB
    };
    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut databases = all_string_values(&results);
    databases.sort();
    Ok(json!({ "success": true, "databases": databases }))
}

// Đổi database đang dùng: kết nối lại bằng last_config với database mới (đi qua SSH tunnel nếu đang bật)
#[tauri::command]
pub async fn switch_database(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
    // Switching database replaces the pool, so an open transaction would die without a word.
    // Refuse instead of choosing commit-or-rollback on the user's behalf.
    crate::tx_session::reject_if_open("đổi database")?;
    let (last_conf_opt, db_type, tunnel_port) = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        (manager.last_config.clone(), manager.db_type.clone(),
         manager.ssh_tunnel.as_ref().map(|t| t.local_port))
    };

    if db_type == "sqlite" {
        return Err("SQLite không hỗ trợ nhiều database trên một kết nối".to_string());
    }
    let mut stored_conf = last_conf_opt.ok_or("Chưa có cấu hình kết nối")?;
    if let Some(obj) = stored_conf.as_object_mut() {
        obj.insert("database".to_string(), json!(name));
    }

    // Config để dựng URL: nếu có tunnel thì trỏ qua 127.0.0.1:<local_port>
    let mut url_conf = stored_conf.clone();
    if let Some(port) = tunnel_port {
        if let Some(obj) = url_conf.as_object_mut() {
            obj.insert("host".to_string(), json!("127.0.0.1"));
            obj.insert("port".to_string(), json!(port));
        }
    }

    let new_conn = match db_type.as_str() {
        "postgres" => {
            let url = build_pg_url(&url_conf, Some(name.as_str()));
            let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbConnection::Postgres(pool)
        }
        "mysql" => {
            let url = build_mysql_url(&url_conf, Some(name.as_str()));
            let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbConnection::Mysql(pool)
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    };

    let mut manager = state.db_manager.lock().map_err(|e| e.to_string())?;
    manager.connection = Some(new_conn);
    manager.last_config = Some(stored_conf);
    Ok(json!({ "success": true, "database": name }))
}

// Tạo database mới (dùng kết nối hiện tại). encoding/collation là tùy chọn.
#[tauri::command]
pub async fn create_database(state: tauri::State<'_, crate::AppState>, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let name = payload.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).ok_or("Thiếu tên database")?;
    let encoding = payload.get("encoding").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    let collation = payload.get("collation").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

    let sql = match &conn_type {
        DbConnection::Mysql(_) => {
            let mut s = format!("CREATE DATABASE `{}`", name);
            if let Some(e) = encoding { s.push_str(&format!(" CHARACTER SET {}", e)); }
            if let Some(c) = collation { s.push_str(&format!(" COLLATE {}", c)); }
            s
        }
        DbConnection::Postgres(_) => {
            let mut s = format!("CREATE DATABASE \"{}\"", name);
            let mut opts: Vec<String> = Vec::new();
            if let Some(e) = encoding { opts.push(format!("ENCODING '{}'", e.replace('\'', "''"))); }
            if let Some(c) = collation { opts.push(format!("LC_COLLATE '{}'", c.replace('\'', "''"))); }
            if !opts.is_empty() {
                // TEMPLATE template0 cần khi đặt LC_* khác với template mặc định
                s.push_str(&format!(" WITH {} TEMPLATE template0", opts.join(" ")));
            }
            s
        }
        DbConnection::Sqlite(_) => return Err("SQLite không hỗ trợ tạo database (mỗi tệp là một database)".to_string()),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Xóa database (dùng kết nối hiện tại). Không thể xóa database đang kết nối.
#[tauri::command]
pub async fn drop_database(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!("DROP DATABASE `{}`", name),
        DbConnection::Postgres(_) => format!("DROP DATABASE \"{}\"", name),
        DbConnection::Sqlite(_) => return Err("SQLite không hỗ trợ xóa database".to_string()),
    };
    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Đổi tên database. Chỉ PostgreSQL hỗ trợ (và không được đổi tên DB đang kết nối tới).
#[tauri::command]
pub async fn rename_database(state: tauri::State<'_, crate::AppState>, old_name: String, new_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        // PG có lệnh đổi tên trực tiếp (không được đổi tên DB đang kết nối tới)
        DbConnection::Postgres(_) => format!("ALTER DATABASE \"{}\" RENAME TO \"{}\"", old_name, new_name),
        DbConnection::Mysql(_) => return Err("MySQL không hỗ trợ đổi tên database.".to_string()),
        DbConnection::Sqlite(_) => return Err("SQLite không hỗ trợ đổi tên database.".to_string()),
    };
    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Liệt kê các đối tượng CSDL của kết nối hiện tại: bảng, khung nhìn, hàm, thủ tục
#[tauri::command]
pub async fn get_database_objects(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let mut tables: Vec<String> = Vec::new();
    let mut views: Vec<String> = Vec::new();
    let mut functions: Vec<String> = Vec::new();
    let mut procedures: Vec<String> = Vec::new();

    // Tách bảng/khung nhìn từ kết quả (name_col, type_col) với giá trị đánh dấu view
    fn split_tables_views(results: &[Value], name_col: &str, type_col: &str, view_val: &str,
                          tables: &mut Vec<String>, views: &mut Vec<String>) {
        if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
            for row in data {
                if let Some(o) = row.as_object() {
                    let name = o.get(name_col).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if name.is_empty() { continue; }
                    let ty = o.get(type_col).and_then(|v| v.as_str()).unwrap_or("");
                    if ty.eq_ignore_ascii_case(view_val) { views.push(name); } else { tables.push(name); }
                }
            }
        }
    }

    match &conn_type {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let name: String = row.get(0).map_err(|e| e.to_string())?;
                let ty: String = row.get(1).map_err(|e| e.to_string())?;
                if ty == "view" { views.push(name); } else { tables.push(name); }
            }
            // SQLite không có hàm/thủ tục do người dùng định nghĩa
        }
        DbConnection::Postgres(_) => {
            // Materialized views: see the note in get_tables — information_schema has none.
            let tv = execute_raw_sql_generic(&conn_type,
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' \
                 UNION ALL \
                 SELECT c.relname, 'VIEW' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relkind = 'm' \
                 ORDER BY 1".to_string()).await?;
            split_tables_views(&tv, "table_name", "table_type", "VIEW", &mut tables, &mut views);

            let rt = execute_raw_sql_generic(&conn_type,
                "SELECT p.proname AS name, p.prokind::text AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f','p') ORDER BY p.proname".to_string())
                .await.unwrap_or_default();
            if let Some(data) = rt.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if name.is_empty() { continue; }
                        let kind = o.get("kind").and_then(|v| v.as_str()).unwrap_or("f");
                        if kind == "p" { procedures.push(name); } else { functions.push(name); }
                    }
                }
            }
        }
        DbConnection::Mysql(_) => {
            let tv = execute_raw_sql_generic(&conn_type, "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name".to_string()).await?;
            split_tables_views(&tv, "table_name", "table_type", "VIEW", &mut tables, &mut views);

            let rt = execute_raw_sql_generic(&conn_type,
                "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME".to_string())
                .await.unwrap_or_default();
            if let Some(data) = rt.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if name.is_empty() { continue; }
                        let kind = o.get("kind").and_then(|v| v.as_str()).unwrap_or("FUNCTION");
                        if kind.eq_ignore_ascii_case("PROCEDURE") { procedures.push(name); } else { functions.push(name); }
                    }
                }
            }
        }
    }

    // MySQL scheduled EVENTs. Only MySQL has them, and they are dumped like a routine (their
    // body carries its own `;`, so the export wraps them in a DELIMITER block).
    let mut events: Vec<String> = Vec::new();
    if matches!(conn_type, DbConnection::Mysql(_)) {
        let ev = execute_raw_sql_generic(
            &conn_type,
            "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME".to_string(),
        )
        .await
        .unwrap_or_default();
        for row in result_rows(&ev) {
            if let Some(name) = row_str(row, "name") {
                if !name.is_empty() {
                    events.push(name.to_string());
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "tables": tables,
        "views": views,
        "functions": functions,
        "procedures": procedures,
        "events": events
    }))
}

// Lấy định nghĩa (mã nguồn) của view / function / procedure
#[tauri::command]
pub async fn get_object_definition(state: tauri::State<'_, crate::AppState>, name: String, kind: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let ddl: String = match &conn_type {
        DbConnection::Mysql(pool) => {
            let stmt = match kind.as_str() {
                "function" => format!("SHOW CREATE FUNCTION `{}`", name),
                "procedure" => format!("SHOW CREATE PROCEDURE `{}`", name),
                "view" => format!("SHOW CREATE VIEW `{}`", name),
                "event" => format!("SHOW CREATE EVENT `{}`", name),
                _ => format!("SHOW CREATE TABLE `{}`", name),
            };
            let row = sqlx::query(sqlx::AssertSqlSafe(stmt)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let s: String = row.try_get("Create Event")
                .or_else(|_| row.try_get("Create Function"))
                .or_else(|_| row.try_get("Create Procedure"))
                .or_else(|_| row.try_get("Create View"))
                .or_else(|_| row.try_get("Create Table"))
                .map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbConnection::Postgres(_) => {
            let sql = match kind.as_str() {
                "function" | "procedure" => format!(
                    "SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '{}' LIMIT 1",
                    name.replace('\'', "''")
                ),
                "view" => format!("SELECT pg_get_viewdef('\"{}\"'::regclass, true) AS def", name.replace('"', "\"\"")),
                _ => return Err("Loại đối tượng không được hỗ trợ".to_string()),
            };
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            all_string_values(&results).into_iter().next().ok_or("Không lấy được định nghĩa đối tượng")?
        }
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1").map_err(|e| e.to_string())?;
            let mut rows = stmt.query([name.as_str()]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let s: String = row.get(0).map_err(|e| e.to_string())?;
                format!("{};", s)
            } else {
                return Err("Không tìm thấy định nghĩa".to_string());
            }
        }
    };

    Ok(json!({ "success": true, "sql": ddl }))
}

// Lấy danh sách encoding/collation được hỗ trợ theo hệ CSDL (dùng cho hộp thoại tạo database)
#[tauri::command]
pub async fn get_db_charsets(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    // Trích các giá trị của một cột từ kết quả execute_raw_sql_generic
    fn col_values(results: &[Value], col: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
            for row in data {
                if let Some(v) = row.as_object().and_then(|o| o.get(col)).and_then(|v| v.as_str()) {
                    out.push(v.to_string());
                }
            }
        }
        out
    }

    match &conn_type {
        DbConnection::Mysql(_) => {
            let cs_res = execute_raw_sql_generic(&conn_type, "SHOW CHARACTER SET".to_string()).await?;
            let mut encodings = col_values(&cs_res, "Charset");
            encodings.sort();

            let coll_res = execute_raw_sql_generic(&conn_type, "SHOW COLLATION".to_string()).await?;
            // Nhóm collation theo charset để UI lọc theo encoding đã chọn
            let mut by_enc: serde_json::Map<String, Value> = serde_json::Map::new();
            if let Some(data) = coll_res.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
                for row in data {
                    if let Some(o) = row.as_object() {
                        let collation = o.get("Collation").and_then(|v| v.as_str());
                        let charset = o.get("Charset").and_then(|v| v.as_str());
                        if let (Some(c), Some(cs)) = (collation, charset) {
                            let entry = by_enc.entry(cs.to_string()).or_insert_with(|| json!([]));
                            if let Some(arr) = entry.as_array_mut() { arr.push(json!(c)); }
                        }
                    }
                }
            }
            Ok(json!({ "success": true, "encodings": encodings, "collationsByEncoding": by_enc }))
        }
        DbConnection::Postgres(_) => {
            let enc_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE encoding >= 0 ORDER BY 1".to_string()).await?;
            let mut encodings = col_values(&enc_res, "enc");
            if !encodings.iter().any(|e| e == "UTF8") { encodings.insert(0, "UTF8".to_string()); }

            let coll_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT datcollate AS c FROM pg_database WHERE datcollate IS NOT NULL ORDER BY 1".to_string()).await?;
            let collations = col_values(&coll_res, "c");
            Ok(json!({ "success": true, "encodings": encodings, "collations": collations }))
        }
        DbConnection::Sqlite(_) => {
            Ok(json!({ "success": true, "encodings": [], "collations": [] }))
        }
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Tham số rỗng đầu tiên là TIÊU ĐỀ cửa sổ của `start`: thiếu nó thì đường dẫn
        // có dấu cách (đã được bọc nháy) bị hiểu thành tiêu đề và không mở gì cả.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_app_window_size(window: tauri::Window, width: u32, height: u32) -> Result<(), String> {
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: width as f64,
        height: height as f64,
    }));
    let _ = window.center();
    Ok(())
}

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
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionStatusInfo, String> {
    let start = std::time::Instant::now();
    let (conn, db_type, config, has_ssh) = {
        let mgr = state.db_manager.lock().map_err(|e| e.to_string())?;
        let conn = match &mgr.connection {
            Some(c) => c.clone(),
            None => return Ok(ConnectionStatusInfo::disconnected()),
        };
        (
            conn,
            mgr.db_type.clone(),
            mgr.last_config.clone(),
            mgr.ssh_tunnel.is_some(),
        )
    };

    match &conn {
        DbConnection::Sqlite(arc) => {
            if let Ok(conn) = arc.lock() {
                let _ = conn.execute_batch("SELECT 1;");
            }
        }
        DbConnection::Postgres(pool) => {
            let _ = sqlx::query("SELECT 1;").execute(pool).await;
        }
        DbConnection::Mysql(pool) => {
            let _ = sqlx::query("SELECT 1;").execute(pool).await;
        }
    }
    let latency_ms = start.elapsed().as_millis() as u64;

    // Thông tin phiên hiển thị trong popover kết nối. Mọi truy vấn ở đây đều
    // "best effort": lỗi thì để trống chứ không làm hỏng cả status pill.
    // Phần TLS tách khỏi phần version/user vì `pg_stat_ssl` không tồn tại trên
    // Postgres cũ — gộp chung thì một server cũ mất luôn cả version lẫn user.
    let (server_version, session_user, session_db, cipher, tls_version) = match &conn {
        DbConnection::Sqlite(arc) => {
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
        DbConnection::Postgres(pool) => {
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
        DbConnection::Mysql(pool) => {
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

// -------------------------------------------------------------
// ADVANCED SCHEMA & OBJECT MANAGEMENT (Triggers, Sequences, Partitions, Check Constraints, Routines, Views)
// -------------------------------------------------------------

// Rows of `execute_raw_sql_generic` are JSON OBJECTS keyed by column name
// (`{ columns: [...], data: [{col: val}] }`), never positional arrays. The four commands
// below used to read them with `row.as_array()`, which is always `None`: the loop body never
// ran, so every one of them returned an empty list on all three dialects and the matching UI
// (Structure > Triggers / Partitions / Check constraints, Sequence Manager) looked as if the
// database had no such objects. Read through these helpers, and address columns by the alias
// each query already declares.
fn result_rows(results: &[Value]) -> &[Value] {
    results
        .first()
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[])
}

fn row_str<'a>(row: &'a Value, col: &str) -> Option<&'a str> {
    row.get(col).and_then(|v| v.as_str())
}

// Counters arrive as a number on some drivers and as a string on others (MySQL BIGINT via
// information_schema, Postgres ::bigint) — accept both, like the code this replaces did.
fn row_i64(row: &Value, col: &str) -> i64 {
    row.get(col)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

#[tauri::command]
pub async fn get_table_triggers(state: tauri::State<'_, crate::AppState>, table_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!(
            "SELECT TRIGGER_NAME as name, ACTION_TIMING as timing, EVENT_MANIPULATION as event, ACTION_STATEMENT as statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE EVENT_OBJECT_TABLE = '{}' AND TRIGGER_SCHEMA = DATABASE()",
            table_name.replace('\'', "''")
        ),
        DbConnection::Postgres(_) => format!(
            "SELECT tr.tgname AS name, CASE WHEN tr.tgtype & 2 = 2 THEN 'BEFORE' WHEN tr.tgtype & 64 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing, CASE WHEN tr.tgtype & 4 = 4 THEN 'INSERT' WHEN tr.tgtype & 8 = 8 THEN 'DELETE' WHEN tr.tgtype & 16 = 16 THEN 'UPDATE' ELSE 'MANIPULATION' END AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '{}' AND n.nspname = 'public' AND NOT tr.tgisinternal",
            table_name.replace('\'', "''")
        ),
        DbConnection::Sqlite(_) => format!(
            "SELECT name, 'BEFORE' as timing, 'MANIPULATION' as event, sql as statement FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '{}'",
            table_name.replace('\'', "''")
        ),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut triggers: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        triggers.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "timing": row_str(row, "timing").unwrap_or("AFTER"),
            "event": row_str(row, "event").unwrap_or("INSERT"),
            "statement": row_str(row, "statement").unwrap_or("")
        }));
    }

    Ok(json!({ "success": true, "triggers": triggers }))
}

// Rebuild a runnable CREATE TRIGGER from what MySQL's information_schema exposes.
//
// MySQL is the only dialect that does not hand back the original statement: Postgres has
// pg_get_triggerdef() and SQLite stores the source in sqlite_master.sql, but
// INFORMATION_SCHEMA.TRIGGERS only has the pieces. `SHOW CREATE TRIGGER` would return the
// whole thing, yet it is one round trip per trigger and its output carries a DEFINER clause
// the dump has to strip anyway, so assembling it here costs one query for the whole database.
// ACTION_ORIENTATION is always 'ROW' in MySQL, hence the fixed FOR EACH ROW.
fn mysql_trigger_ddl(name: &str, table: &str, timing: &str, event: &str, body: &str) -> String {
    format!(
        "CREATE TRIGGER `{}` {} {} ON `{}` FOR EACH ROW\n{}",
        name,
        timing.trim(),
        event.trim(),
        table,
        body.trim()
    )
}

/// Everything that belongs to a table but does NOT live inside that dialect's CREATE TABLE.
///
/// MySQL needs nothing: `SHOW CREATE TABLE` already carries indexes, foreign keys, CHECKs and
/// AUTO_INCREMENT. SQLite keeps indexes as their own `sqlite_master` rows. Postgres has no
/// SHOW CREATE TABLE at all, so `get_table_definition` hand-builds one from columns + PK only —
/// index, FK/UNIQUE/CHECK, comments and the sequence behind a `serial` column are all missing,
/// and a dump without the sequence fails to restore outright ("relation x_id_seq does not exist").
///
/// Grouped by WHERE the statement has to run, which is the whole point:
///   - `sequences`  before its CREATE TABLE (the column DEFAULT references it),
///   - `indexes` / `comments`  right after CREATE TABLE,
///   - `constraints`  after EVERY table (a foreign key points at another table),
///   - `sequence_values`  after the data (setval reads MAX() of the rows just inserted).
#[tauri::command]
pub async fn get_table_ddl_extras(
    state: tauri::State<'_, crate::AppState>,
    table_name: String,
) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };
    let esc = table_name.replace('\'', "''");

    // Runs a query whose single column is a ready-to-run statement; a dialect that does not
    // support one of these (older server, missing catalog) yields an empty list instead of
    // failing the whole export.
    async fn ddl_list(conn: &DbConnection, sql: String) -> Vec<String> {
        match execute_raw_sql_generic(conn, sql).await {
            Ok(results) => all_string_values(&results),
            Err(_) => Vec::new(),
        }
    }

    let mut sequences: Vec<String> = Vec::new();
    let mut indexes: Vec<String> = Vec::new();
    let mut constraints: Vec<String> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    let mut sequence_values: Vec<String> = Vec::new();

    match &conn_type {
        DbConnection::Mysql(_) => {}
        DbConnection::Sqlite(_) => {
            // sql IS NULL for the indexes SQLite creates itself (UNIQUE / AUTOINCREMENT):
            // they come back with the table and must not be replayed.
            indexes = ddl_list(
                &conn_type,
                format!(
                    "SELECT sql || ';' FROM sqlite_master WHERE type = 'index' AND tbl_name = '{}' AND sql IS NOT NULL",
                    esc
                ),
            )
            .await;
        }
        DbConnection::Postgres(_) => {
            sequences = ddl_list(&conn_type, format!(
                "SELECT 'CREATE SEQUENCE IF NOT EXISTS ' || quote_ident(s.relname) || ';' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = 'public' AND t.relname = '{}'", esc)).await;

            // Skip every index that merely backs a constraint — PRIMARY KEY is already inside
            // CREATE TABLE and UNIQUE comes back below as ALTER TABLE ADD CONSTRAINT.
            indexes = ddl_list(&conn_type, format!(
                "SELECT pg_get_indexdef(i.indexrelid) || ';' \
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relname = '{}' \
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)", esc)).await;

            // contype: f = foreign key, u = unique, c = check. 'p' (primary key) is skipped.
            constraints = ddl_list(&conn_type, format!(
                "SELECT 'ALTER TABLE ' || quote_ident(c.relname) || ' ADD CONSTRAINT ' \
                     || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';' \
                 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relname = '{}' AND con.contype IN ('f','u','c') \
                 ORDER BY con.contype DESC, con.conname", esc)).await;

            comments = ddl_list(&conn_type, format!(
                "SELECT 'COMMENT ON TABLE ' || quote_ident(c.relname) || ' IS ' \
                     || quote_literal(obj_description(c.oid)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = 'public' AND c.relname = '{}' AND obj_description(c.oid) IS NOT NULL \
                 UNION ALL \
                 SELECT 'COMMENT ON COLUMN ' || quote_ident(c.relname) || '.' || quote_ident(a.attname) \
                     || ' IS ' || quote_literal(col_description(c.oid, a.attnum)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 WHERE n.nspname = 'public' AND c.relname = '{}' \
                   AND col_description(c.oid, a.attnum) IS NOT NULL", esc, esc)).await;

            // setval computed from the restored rows instead of the value read at export time:
            // the dump stays correct no matter how long it sits on disk before being replayed.
            sequence_values = ddl_list(&conn_type, format!(
                "SELECT 'SELECT setval(' || quote_literal(quote_ident(s.relname)) || ', COALESCE((SELECT MAX(' \
                     || quote_ident(a.attname) || ') FROM ' || quote_ident(t.relname) || '), 1), true);' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = 'public' AND t.relname = '{}'", esc)).await;
        }
    }

    Ok(json!({
        "success": true,
        "sequences": sequences,
        "indexes": indexes,
        "constraints": constraints,
        "comments": comments,
        "sequenceValues": sequence_values,
    }))
}

/// Every trigger of the current database, with a statement a dump can replay as-is.
///
/// `get_table_triggers` answers per table and is what the Structure tab uses; the export path
/// needs the whole database in one call, plus the owning table name (Postgres cannot drop a
/// trigger without `ON <table>`).
#[tauri::command]
pub async fn get_all_triggers(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => "SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME".to_string(),
        DbConnection::Postgres(_) => "SELECT tr.tgname AS name, c.relname AS tbl, '' AS timing, '' AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT tr.tgisinternal ORDER BY c.relname, tr.tgname".to_string(),
        // sql IS NULL for objects SQLite creates itself; those cannot be replayed anyway.
        DbConnection::Sqlite(_) => "SELECT name, tbl_name AS tbl, '' AS timing, '' AS event, sql AS statement FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY tbl_name, name".to_string(),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let is_mysql = matches!(conn_type, DbConnection::Mysql(_));
    let mut triggers: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        let name = row_str(row, "name").unwrap_or("");
        let table = row_str(row, "tbl").unwrap_or("");
        let statement = row_str(row, "statement").unwrap_or("");
        if name.is_empty() || statement.is_empty() {
            continue;
        }
        let ddl = if is_mysql {
            mysql_trigger_ddl(
                name,
                table,
                row_str(row, "timing").unwrap_or("BEFORE"),
                row_str(row, "event").unwrap_or("INSERT"),
                statement,
            )
        } else {
            statement.to_string()
        };
        triggers.push(json!({ "name": name, "table": table, "statement": ddl }));
    }

    Ok(json!({ "success": true, "triggers": triggers }))
}

#[tauri::command]
pub async fn save_trigger(state: tauri::State<'_, crate::AppState>, statement_sql: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    execute_raw_sql_generic(&conn_type, statement_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu Trigger thành công" }))
}

#[tauri::command]
pub async fn drop_trigger(state: tauri::State<'_, crate::AppState>, trigger_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!("DROP TRIGGER `{}`", trigger_name),
        _ => format!("DROP TRIGGER IF EXISTS \"{}\"", trigger_name),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true, "message": "Đã xóa Trigger thành công" }))
}

#[tauri::command]
pub async fn save_routine_definition(state: tauri::State<'_, crate::AppState>, routine_sql: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    execute_raw_sql_generic(&conn_type, routine_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu Procedure/Function thành công" }))
}

#[tauri::command]
pub async fn get_sequences(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Postgres(_) => "SELECT sequence_name as name, data_type, start_value, minimum_value as min_val, maximum_value as max_val, increment, cycle_option as cycle FROM information_schema.sequences WHERE sequence_schema = 'public'".to_string(),
        DbConnection::Mysql(_) => "SELECT table_name as name, 'bigint' as data_type, '1' as start_value, '1' as min_val, '9223372036854775807' as max_val, '1' as increment, 'NO' as cycle FROM information_schema.tables WHERE table_type = 'SEQUENCE' AND table_schema = DATABASE()".to_string(),
        _ => return Ok(json!({ "success": true, "sequences": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut sequences: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        sequences.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "dataType": row_str(row, "data_type").unwrap_or("bigint"),
            "startValue": row_str(row, "start_value").unwrap_or("1"),
            "minVal": row_str(row, "min_val").unwrap_or("1"),
            "maxVal": row_str(row, "max_val").unwrap_or(""),
            "incrementBy": row_str(row, "increment").unwrap_or("1"),
            "cycle": row_str(row, "cycle").map(|c| c == "YES").unwrap_or(false)
        }));
    }

    Ok(json!({ "success": true, "sequences": sequences }))
}

#[tauri::command]
pub async fn alter_sequence(state: tauri::State<'_, crate::AppState>, sequence_sql: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    execute_raw_sql_generic(&conn_type, sequence_sql).await?;
    Ok(json!({ "success": true, "message": "Đã cập nhật Sequence thành công" }))
}

#[tauri::command]
pub async fn drop_sequence(state: tauri::State<'_, crate::AppState>, sequence_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!("DROP SEQUENCE IF EXISTS `{}`", sequence_name),
        _ => format!("DROP SEQUENCE IF EXISTS \"{}\"", sequence_name),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true, "message": "Đã xóa Sequence thành công" }))
}

#[tauri::command]
pub async fn get_table_partitions(state: tauri::State<'_, crate::AppState>, table_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!(
            "SELECT PARTITION_NAME as name, PARTITION_METHOD as method, PARTITION_EXPRESSION as expression, PARTITION_DESCRIPTION as description, TABLE_ROWS as table_rows, DATA_LENGTH as data_length FROM INFORMATION_SCHEMA.PARTITIONS WHERE TABLE_NAME = '{}' AND TABLE_SCHEMA = DATABASE() AND PARTITION_NAME IS NOT NULL",
            table_name.replace('\'', "''")
        ),
        DbConnection::Postgres(_) => format!(
            "SELECT c.relname AS name, 'PARTITION' AS method, pg_get_expr(c.relpartbound, c.oid) AS expression, '' AS description, c.reltuples::bigint AS table_rows, 0 AS data_length FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class parent ON parent.oid = i.inhparent WHERE parent.relname = '{}'",
            table_name.replace('\'', "''")
        ),
        _ => return Ok(json!({ "success": true, "partitions": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut partitions: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        partitions.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "method": row_str(row, "method").unwrap_or(""),
            "expression": row_str(row, "expression").unwrap_or(""),
            "description": row_str(row, "description").unwrap_or(""),
            "tableRows": row_i64(row, "table_rows"),
            "dataLength": row_i64(row, "data_length")
        }));
    }

    Ok(json!({ "success": true, "partitions": partitions }))
}

#[tauri::command]
pub async fn get_check_constraints(state: tauri::State<'_, crate::AppState>, table_name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!(
            "SELECT tc.CONSTRAINT_NAME as name, cc.CHECK_CLAUSE as expression, 'YES' as enforced FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA WHERE tc.TABLE_NAME = '{}' AND tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'",
            table_name.replace('\'', "''")
        ),
        DbConnection::Postgres(_) => format!(
            "SELECT conname AS name, pg_get_constraintdef(c.oid) AS expression, 'YES' AS enforced FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE t.relname = '{}' AND n.nspname = 'public' AND c.contype = 'c'",
            table_name.replace('\'', "''")
        ),
        _ => return Ok(json!({ "success": true, "constraints": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut constraints: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        constraints.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "expression": row_str(row, "expression").unwrap_or(""),
            "enforced": row_str(row, "enforced").map(|s| s == "YES").unwrap_or(true)
        }));
    }

    Ok(json!({ "success": true, "constraints": constraints }))
}

#[tauri::command]
pub async fn save_view_definition(state: tauri::State<'_, crate::AppState>, view_sql: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(c) => c.clone(),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    execute_raw_sql_generic(&conn_type, view_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu View thành công" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use rusqlite::types::Value as SV;

    #[test]
    fn test_json_to_sqlite_value_null() {
        let val = json!(null);
        assert_eq!(json_to_sqlite_value(&val), SV::Null);
    }

    #[test]
    fn test_json_to_sqlite_value_bool() {
        assert_eq!(json_to_sqlite_value(&json!(true)), SV::Integer(1));
        assert_eq!(json_to_sqlite_value(&json!(false)), SV::Integer(0));
    }

    #[test]
    fn test_json_to_sqlite_value_number() {
        assert_eq!(json_to_sqlite_value(&json!(100)), SV::Integer(100));
        assert_eq!(json_to_sqlite_value(&json!(3.14159)), SV::Real(3.14159));
    }

    #[test]
    fn test_json_to_sqlite_value_string() {
        assert_eq!(json_to_sqlite_value(&json!("TableNova")), SV::Text("TableNova".into()));
    }

    #[test]
    fn test_sqlite_in_memory_query() -> Result<(), Box<dyn std::error::Error>> {
        let conn = SqliteConnection::open_in_memory()?;
        conn.execute("CREATE TABLE test_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);", [])?;
        conn.execute("INSERT INTO test_users (name) VALUES (?1), (?2);", ["Alice", "Bob"])?;

        let mut stmt = conn.prepare("SELECT id, name FROM test_users ORDER BY id ASC;")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let results: Vec<(i64, String)> = rows.collect::<Result<_, _>>()?;
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], (1, "Alice".into()));
        assert_eq!(results[1], (2, "Bob".into()));

        Ok(())
    }
}
