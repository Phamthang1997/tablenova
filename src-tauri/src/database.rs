use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use rusqlite::Connection as SqliteConnection;
use sqlx::{PgPool, MySqlPool, Row, Column, Executor, Statement, SqlSafeStr};
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
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col: &str = $col;
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
        else { Value::Null }
    }};
}

// Giải mã một ô dữ liệu MySQL (bao gồm cả kiểu số không dấu, DECIMAL, ngày giờ, JSON).
macro_rules! decode_mysql_cell {
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col: &str = $col;
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
        else { Value::Null }
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
fn build_pg_url(config: &Value, db_override: Option<&str>) -> String {
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
fn build_mysql_url(config: &Value, db_override: Option<&str>) -> String {
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
async fn apply_ssh_tunnel(config: &Value, default_port: u16) -> Result<(Value, Option<SshTunnel>), String> {
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
fn apply_iam_password(orig_config: &Value, conn_config: &mut Value, default_port: u16) -> Result<(), String> {
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
        let col_sql = "SELECT table_name AS t, column_name AS c, data_type AS ty FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position".to_string();
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
            let rows = sqlx::query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public'")
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
            let sql = format!(
                "SELECT column_name, data_type, is_nullable, column_default 
                 FROM information_schema.columns 
                 WHERE table_name = '{}' AND table_schema = 'public'
                 ORDER BY ordinal_position", name
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(pool).await.map_err(|e| e.to_string())?;
            for r in rows {
                let col_name: String = r.get("column_name");
                let col_type: String = r.get("data_type");
                let is_nullable: String = r.get("is_nullable");
                let column_default: Option<String> = r.try_get("column_default").ok();
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": column_default.as_ref().map(|d| d.contains("nextval")).unwrap_or(false)
                }));
            }

            // Lấy danh sách Indexes của Postgres
            let idx_sql = format!(
                "SELECT i.relname AS index_name, ix.indisunique AS is_unique, am.amname AS index_method, pg_get_indexdef(ix.indexrelid) AS index_def
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
                    let method: String = r.get(2);
                    let index_def: String = r.get(3);
                    
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
                        "unique": unique,
                        "type": if unique { "UNIQUE" } else { "INDEX" },
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
            let sql = format!(
                "SELECT column_name, data_type, is_nullable, column_default, extra 
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
                let is_pk = pk_cols.iter().any(|c| c == &col_name);

                columns.push(json!({
                    "name": col_name,
                    "type": col_type,
                    "nullable": is_nullable == "YES",
                    "isPrimaryKey": is_pk,
                    "defaultValue": column_default,
                    "autoIncrement": extra.contains("auto_increment")
                }));
            }

            // Lấy danh sách Indexes của MySQL
            let idx_sql = format!("SHOW INDEX FROM `{}`", name);
            if let Ok(idx_rows) = sqlx::query(sqlx::AssertSqlSafe(idx_sql)).fetch_all(pool).await {
                use std::collections::HashMap;
                let mut idx_map: HashMap<String, (Vec<String>, bool, String)> = HashMap::new();
                for r in idx_rows {
                    let key_name: String = r.try_get("Key_name").or_else(|_| r.try_get("KEY_NAME")).unwrap_or_default();
                    if key_name == "PRIMARY" { continue; }
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
                    indexes.push(json!({
                        "name": idx_name,
                        "columns": cols.join(", "),
                        "unique": unique,
                        "type": if unique { "UNIQUE" } else { "INDEX" },
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

// Tách một chuỗi SQL nhiều câu lệnh thành từng câu (nhận biết chuỗi trích dẫn và comment để không cắt nhầm dấu ;)
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let (mut sq, mut dq, mut bt) = (false, false, false);
    let (mut line_c, mut block_c) = (false, false);
    let mut esc = false;
    let mut it = sql.chars().peekable();

    while let Some(c) = it.next() {
        cur.push(c);
        if line_c {
            if c == '\n' { line_c = false; }
            continue;
        }
        if block_c {
            if c == '*' && it.peek() == Some(&'/') {
                if let Some(n) = it.next() { cur.push(n); }
                block_c = false;
            }
            continue;
        }
        if esc { esc = false; continue; }
        if (sq || dq) && c == '\\' { esc = true; continue; }

        if !sq && !dq && !bt {
            if c == '-' && it.peek() == Some(&'-') { line_c = true; continue; }
            if c == '#' { line_c = true; continue; }
            if c == '/' && it.peek() == Some(&'*') {
                if let Some(n) = it.next() { cur.push(n); }
                block_c = true;
                continue;
            }
        }

        match c {
            '\'' if !dq && !bt => sq = !sq,
            '"' if !sq && !bt => dq = !dq,
            '`' if !sq && !dq => bt = !bt,
            ';' if !sq && !dq && !bt => {
                cur.pop(); // bỏ dấu ';'
                let s = cur.trim().to_string();
                if !s.is_empty() { out.push(s); }
                cur.clear();
            }
            _ => {}
        }
    }
    let s = cur.trim().to_string();
    if !s.is_empty() { out.push(s); }
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
    match conn {
        DbConnection::Sqlite(conn_arc) => {
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
        DbConnection::Postgres(pool) => {
            let trimmed = sql.trim().to_uppercase();
            if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
                let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
                sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
                let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
                return Ok(());
            }
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
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
                    let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
                }
                let mut map = serde_json::Map::new();
                for col_name in &columns {
                    let val: Value = decode_pg_cell!(&r, col_name.as_str());
                    map.insert(col_name.clone(), val);
                }
                batch.push(Value::Object(map));
                if batch.len() >= STREAM_BATCH {
                    let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
                }
            }
            if !batch.is_empty() {
                let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
            }
            if columns.is_empty() {
                if let Ok(stmt) = pool.prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
                    for col in stmt.columns() {
                        columns.push(col.name().to_string());
                    }
                }
                let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
            }
            Ok(())
        }
        DbConnection::Mysql(pool) => {
            let trimmed = sql.trim().to_uppercase();
            if trimmed.starts_with("USE ") || trimmed.starts_with("CREATE DATABASE") {
                let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
                sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
                let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": Vec::<String>::new() }));
                return Ok(());
            }
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            // Dò xem câu lệnh có trả về cột không. Nếu không -> execute + báo affected.
            let returns_rows = match (&mut *conn).prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
                Ok(st) => !st.columns().is_empty(),
                Err(_) => true,
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
                    let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns.clone() }));
                }
                let mut map = serde_json::Map::new();
                for col_name in &columns {
                    let val: Value = decode_mysql_cell!(&r, col_name.as_str());
                    map.insert(col_name.clone(), val);
                }
                batch.push(Value::Object(map));
                if batch.len() >= STREAM_BATCH {
                    let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": std::mem::take(&mut batch) }));
                }
            }
            if !batch.is_empty() {
                let _ = channel.send(json!({ "type": "rows", "stmtIndex": stmt_index, "rows": batch }));
            }
            if columns.is_empty() {
                if let Ok(stmt) = pool.prepare(sqlx::AssertSqlSafe(sql.to_string()).into_sql_str()).await {
                    for col in stmt.columns() {
                        columns.push(col.name().to_string());
                    }
                }
                let _ = channel.send(json!({ "type": "columns", "stmtIndex": stmt_index, "query": sql, "columns": columns }));
            }
            Ok(())
        }
    }
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

    for sql in sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

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
pub async fn export_multi_tables(state: tauri::State<'_, crate::AppState>, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    let tables = payload.get("tables").and_then(|v| v.as_array()).ok_or("Thiếu danh sách bảng")?;
    let filename = payload.get("filename").and_then(|v| v.as_str()).unwrap_or("backup.sql");
    let sql_options = payload.get("sqlOptions");
    
    let drop_table = sql_options.and_then(|o| o.get("dropTable")).and_then(|v| v.as_bool()).unwrap_or(true);
    let include_structure = sql_options.and_then(|o| o.get("includeStructure")).and_then(|v| v.as_bool()).unwrap_or(true);
    let include_content = sql_options.and_then(|o| o.get("includeContent")).and_then(|v| v.as_bool()).unwrap_or(true);
    let compress_gzip = payload.get("compressGzip").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut sql_out = String::new();
    sql_out.push_str("-- Database Backup generated by TableNova\n");
    sql_out.push_str(&format!("-- Date: {}\n\n", chrono::Local::now().to_rfc3339()));

    for table_val in tables {
        let table_name = table_val.as_str().unwrap_or("");
        if table_name.is_empty() { continue; }

        if drop_table {
            sql_out.push_str(&format!("DROP TABLE IF EXISTS `{}`;\n", table_name));
        }

        // Lấy cấu trúc bảng
        if include_structure {
            sql_out.push_str(&format!("-- Structure for table `{}`\n", table_name));
            match &conn_type {
                DbConnection::Sqlite(conn_arc) => {
                    let conn = conn_arc.lock().map_err(|e| e.to_string())?;
                    let mut stmt = conn.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").map_err(|e| e.to_string())?;
                    let mut rows = stmt.query([table_name]).map_err(|e| e.to_string())?;
                    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                        let create_sql: String = row.get(0).map_err(|e| e.to_string())?;
                        sql_out.push_str(&format!("{};\n\n", create_sql));
                    }
                }
                DbConnection::Mysql(pool) => {
                    let show_sql = format!("SHOW CREATE TABLE `{}`", table_name);
                    if let Ok(row) = sqlx::query(sqlx::AssertSqlSafe(show_sql)).fetch_one(pool).await {
                        let create_sql: String = row.get("Create Table");
                        sql_out.push_str(&format!("{};\n\n", create_sql));
                    }
                }
                DbConnection::Postgres(pool) => {
                    // Đơn giản hóa đối với Postgres bằng cách dựng câu lệnh thô cơ bản
                    sql_out.push_str(&format!("CREATE TABLE \"{}\" (\n", table_name));
                    let info_sql = format!(
                        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '{}'",
                        table_name
                    );
                    if let Ok(rows) = sqlx::query(sqlx::AssertSqlSafe(info_sql)).fetch_all(pool).await {
                        let mut cols_defs = Vec::new();
                        for r in rows {
                            let name: String = r.get("column_name");
                            let col_type: String = r.get("data_type");
                            let nullable: String = r.get("is_nullable");
                            let null_str = if nullable == "YES" { "" } else { " NOT NULL" };
                            cols_defs.push(format!("  \"{}\" {}{}", name, col_type, null_str));
                        }
                        sql_out.push_str(&cols_defs.join(",\n"));
                    }
                    sql_out.push_str("\n);\n\n");
                }
            }
        }

        // Lấy nội dung bảng
        if include_content {
            sql_out.push_str(&format!("-- Data for table `{}`\n", table_name));
            let select_sql = format!("SELECT * FROM `{}`", table_name);
            let query_sql = match &conn_type {
                DbConnection::Postgres(_) => select_sql.replace("`", "\""),
                _ => select_sql,
            };

            let res = execute_raw_sql_generic(&conn_type, query_sql).await?;
            if let Some(first_res) = res.get(0) {
                if let Some(rows) = first_res.get("data").and_then(|v| v.as_array()) {
                    for row in rows {
                        if let Some(obj) = row.as_object() {
                            let mut cols = Vec::new();
                            let mut vals = Vec::new();
                            for (k, v) in obj {
                                cols.push(format!("`{}`", k));
                                if v.is_null() {
                                    vals.push("NULL".to_string());
                                } else if v.is_string() {
                                    vals.push(format!("'{}'", v.as_str().unwrap().replace("'", "''")));
                                } else {
                                    vals.push(v.to_string());
                                }
                            }
                            sql_out.push_str(&format!(
                                "INSERT INTO `{}` ({}) VALUES ({});\n",
                                table_name,
                                cols.join(", "),
                                vals.join(", ")
                            ));
                        }
                    }
                }
            }
            sql_out.push_str("\n");
        }
    }

    // Ghi file
    if compress_gzip {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        
        let path = std::path::Path::new(filename);
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder.write_all(sql_out.as_bytes()).map_err(|e| e.to_string())?;
        encoder.finish().map_err(|e| e.to_string())?;
    } else {
        std::fs::write(filename, sql_out).map_err(|e| e.to_string())?;
    }

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn parse_backup_tables(file_path: String) -> Result<Value, String> {
    use std::io::Read;
    let mut sql_content = String::new();

    if file_path.ends_with(".gz") {
        use flate2::read::GzDecoder;
        let file = std::fs::File::open(&file_path).map_err(|e| e.to_string())?;
        let mut decoder = GzDecoder::new(file);
        decoder.read_to_string(&mut sql_content).map_err(|e| e.to_string())?;
    } else {
        sql_content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    }

    // Đọc danh sách bảng từ câu lệnh CREATE TABLE hoặc INSERT INTO
    let mut tables = Vec::new();
    let re = regex::Regex::new(r##"(?i)(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE\s+IF\s+EXISTS)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?"##).unwrap();
    for cap in re.captures_iter(&sql_content) {
        let table_name = cap[1].to_string();
        if !tables.contains(&table_name) {
            tables.push(table_name);
        }
    }

    Ok(json!({ "success": true, "tables": tables }))
}

#[tauri::command]
pub async fn restore_backup(state: tauri::State<'_, crate::AppState>, sql_content: String, tables: Vec<String>) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    // Phân tích cú pháp thô sơ và thực thi các câu lệnh cho các bảng được chọn
    let mut statements_count = 0;
    
    // Tách các câu lệnh theo dấu chấm phẩy ;
    let mut current_query = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;

    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut chars_iter = sql_content.chars().peekable();
    let mut last_use_db: Option<String> = None;

    match &conn_type {
        DbConnection::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            
            // 1. Tắt khóa ngoại
            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 0;").execute(&mut *conn).await;

            // 2. Bắt đầu Transaction
            let _ = sqlx::query("START TRANSACTION;").execute(&mut *conn).await;

            let mut escaped = false;
            // 3. Chạy các lệnh
            while let Some(char_val) = chars_iter.next() {
                if in_block_comment {
                    if char_val == '*' && chars_iter.peek() == Some(&'/') {
                        chars_iter.next();
                        in_block_comment = false;
                    }
                    continue;
                }
                if in_line_comment {
                    if char_val == '\n' || char_val == '\r' {
                        in_line_comment = false;
                    }
                    continue;
                }

                if escaped {
                    current_query.push(char_val);
                    escaped = false;
                    continue;
                }

                if char_val == '\\' && (in_single_quote || in_double_quote) {
                    current_query.push(char_val);
                    escaped = true;
                    continue;
                }

                if char_val == '/' && chars_iter.peek() == Some(&'*') && !in_single_quote && !in_double_quote && !in_backtick {
                    chars_iter.next();
                    in_block_comment = true;
                    continue;
                }
                if ((char_val == '-' && chars_iter.peek() == Some(&'-')) || char_val == '#') && !in_single_quote && !in_double_quote && !in_backtick {
                    if char_val == '-' {
                        chars_iter.next();
                    }
                    in_line_comment = true;
                    continue;
                }
                if char_val == '\'' && !in_double_quote && !in_backtick && !in_line_comment && !in_block_comment {
                    in_single_quote = !in_single_quote;
                } else if char_val == '"' && !in_single_quote && !in_backtick && !in_line_comment && !in_block_comment {
                    in_double_quote = !in_double_quote;
                } else if char_val == '`' && !in_single_quote && !in_double_quote && !in_line_comment && !in_block_comment {
                    in_backtick = !in_backtick;
                }

                if char_val == ';' && !in_single_quote && !in_double_quote && !in_backtick {
                    let q = current_query.trim().to_string();
                    if !q.is_empty() {
                        let mut should_exec = false;
                        let q_upper = q.to_uppercase();
                        if q_upper.starts_with("CREATE DATABASE") || q_upper.starts_with("USE ") {
                            should_exec = true;
                            if q_upper.starts_with("USE ") {
                                let parts: Vec<&str> = q.split_whitespace().collect();
                                if parts.len() >= 2 {
                                    let db_name = parts[1].trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'').to_string();
                                    if !db_name.is_empty() {
                                        last_use_db = Some(db_name);
                                    }
                                }
                            }
                        } else {
                            let q_lower = q.to_lowercase();
                            for t in &tables {
                                let t_lower = t.to_lowercase();
                                let pattern = format!(r"\b{}\b", t_lower);
                                if let Ok(re) = regex::Regex::new(&pattern) {
                                    if re.is_match(&q_lower) {
                                        should_exec = true;
                                        break;
                                    }
                                } else if q_lower.contains(&t_lower) {
                                    should_exec = true;
                                    break;
                                }
                            }
                        }

                        if should_exec {
                            let run_res = sqlx::query(sqlx::AssertSqlSafe(q.clone())).execute(&mut *conn).await;
                            if let Err(e) = run_res {
                                let is_ignorable = q_upper.starts_with("USE ") || q_upper.starts_with("CREATE DATABASE");
                                if !is_ignorable {
                                    // Gặp lỗi thì Rollback và bật lại khóa ngoại trước khi trả về lỗi
                                    let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                                    let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                                    return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", q, e));
                                }
                            }
                            statements_count += 1;
                        }
                    }
                    current_query.clear();
                } else {
                    current_query.push(char_val);
                }
            }

            // Chạy lệnh cuối
            let q = current_query.trim().to_string();
            if !q.is_empty() {
                let q_upper = q.to_uppercase();
                let mut should_exec = false;
                if q_upper.starts_with("CREATE DATABASE") || q_upper.starts_with("USE ") {
                    should_exec = true;
                    if q_upper.starts_with("USE ") {
                        let parts: Vec<&str> = q.split_whitespace().collect();
                        if parts.len() >= 2 {
                            let db_name = parts[1].trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'').to_string();
                            if !db_name.is_empty() {
                                last_use_db = Some(db_name);
                            }
                        }
                    }
                } else {
                    let q_lower = q.to_lowercase();
                    for t in &tables {
                        let t_lower = t.to_lowercase();
                        let pattern = format!(r"\b{}\b", t_lower);
                        if let Ok(re) = regex::Regex::new(&pattern) {
                            if re.is_match(&q_lower) {
                                should_exec = true;
                                break;
                            }
                        } else if q_lower.contains(&t_lower) {
                            should_exec = true;
                            break;
                        }
                    }
                }

                if should_exec {
                    let run_res = sqlx::query(sqlx::AssertSqlSafe(q.clone())).execute(&mut *conn).await;
                    if let Err(e) = run_res {
                        let is_ignorable = q_upper.starts_with("USE ") || q_upper.starts_with("CREATE DATABASE");
                        if !is_ignorable {
                            // Gặp lỗi thì Rollback và bật lại khóa ngoại trước khi trả về lỗi
                            let _ = sqlx::query("ROLLBACK;").execute(&mut *conn).await;
                            let _ = sqlx::query("SET FOREIGN_KEY_CHECKS = 1;").execute(&mut *conn).await;
                            return Err(format!("Lỗi khi chạy lệnh SQL cuối: {}. Chi tiết: {}", q, e));
                        }
                    }
                    statements_count += 1;
                }
            }

            // Commit transaction
            let _ = sqlx::query("COMMIT;").execute(&mut *conn).await;

            // 3. Bật lại khóa ngoại
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

            let mut escaped = false;
            while let Some(char_val) = chars_iter.next() {
                if in_block_comment {
                    if char_val == '*' && chars_iter.peek() == Some(&'/') {
                        chars_iter.next();
                        in_block_comment = false;
                    }
                    continue;
                }
                if in_line_comment {
                    if char_val == '\n' || char_val == '\r' {
                        in_line_comment = false;
                    }
                    continue;
                }

                if escaped {
                    current_query.push(char_val);
                    escaped = false;
                    continue;
                }

                if char_val == '\\' && (in_single_quote || in_double_quote) {
                    current_query.push(char_val);
                    escaped = true;
                    continue;
                }

                if char_val == '/' && chars_iter.peek() == Some(&'*') && !in_single_quote && !in_double_quote && !in_backtick {
                    chars_iter.next();
                    in_block_comment = true;
                    continue;
                }
                if ((char_val == '-' && chars_iter.peek() == Some(&'-')) || char_val == '#') && !in_single_quote && !in_double_quote && !in_backtick {
                    if char_val == '-' {
                        chars_iter.next();
                    }
                    in_line_comment = true;
                    continue;
                }
                if char_val == '\'' && !in_double_quote && !in_backtick && !in_line_comment && !in_block_comment {
                    in_single_quote = !in_single_quote;
                } else if char_val == '"' && !in_single_quote && !in_backtick && !in_line_comment && !in_block_comment {
                    in_double_quote = !in_double_quote;
                } else if char_val == '`' && !in_single_quote && !in_double_quote && !in_line_comment && !in_block_comment {
                    in_backtick = !in_backtick;
                }

                if char_val == ';' && !in_single_quote && !in_double_quote && !in_backtick {
                    let q = current_query.trim().to_string();
                    if !q.is_empty() {
                        let mut should_exec = false;
                        let q_upper = q.to_uppercase();
                        if q_upper.starts_with("CREATE DATABASE") || q_upper.starts_with("USE ") {
                            should_exec = true;
                            if q_upper.starts_with("USE ") {
                                let parts: Vec<&str> = q.split_whitespace().collect();
                                if parts.len() >= 2 {
                                    let db_name = parts[1].trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'').to_string();
                                    if !db_name.is_empty() {
                                        last_use_db = Some(db_name);
                                    }
                                }
                            }
                        } else {
                            let q_lower = q.to_lowercase();
                            for t in &tables {
                                let t_lower = t.to_lowercase();
                                let pattern = format!(r"\b{}\b", t_lower);
                                if let Ok(re) = regex::Regex::new(&pattern) {
                                    if re.is_match(&q_lower) {
                                        should_exec = true;
                                        break;
                                    }
                                } else if q_lower.contains(&t_lower) {
                                    should_exec = true;
                                    break;
                                }
                            }
                        }

                        if should_exec {
                            let exec_sql = match &conn_type {
                                DbConnection::Postgres(_) => q.replace("`", "\""),
                                _ => q.clone(),
                            };
                            let run_res = execute_raw_sql_generic(&conn_type, exec_sql.clone()).await;
                            if let Err(e) = run_res {
                                let is_ignorable = q_upper.starts_with("USE ") || q_upper.starts_with("CREATE DATABASE");
                                if !is_ignorable {
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
                                    return Err(format!("Lỗi khi chạy lệnh SQL: {}. Chi tiết: {}", q, e));
                                }
                            }
                            statements_count += 1;
                        }
                    }
                    current_query.clear();
                } else {
                    current_query.push(char_val);
                }
            }

            // Chạy lệnh cuối
            let q = current_query.trim().to_string();
            if !q.is_empty() {
                let q_upper = q.to_uppercase();
                let mut should_exec = false;
                if q_upper.starts_with("CREATE DATABASE") || q_upper.starts_with("USE ") {
                    should_exec = true;
                    if q_upper.starts_with("USE ") {
                        let parts: Vec<&str> = q.split_whitespace().collect();
                        if parts.len() >= 2 {
                            let db_name = parts[1].trim_matches(|c| c == ';' || c == '`' || c == '"' || c == '\'').to_string();
                            if !db_name.is_empty() {
                                last_use_db = Some(db_name);
                            }
                        }
                    }
                } else {
                    let q_lower = q.to_lowercase();
                    for t in &tables {
                        let t_lower = t.to_lowercase();
                        let pattern = format!(r"\b{}\b", t_lower);
                        if let Ok(re) = regex::Regex::new(&pattern) {
                            if re.is_match(&q_lower) {
                                should_exec = true;
                                break;
                            }
                        } else if q_lower.contains(&t_lower) {
                            should_exec = true;
                            break;
                        }
                    }
                }

                if should_exec {
                    let exec_sql = match &conn_type {
                        DbConnection::Postgres(_) => q.replace("`", "\""),
                        _ => q.clone(),
                    };
                    let run_res = execute_raw_sql_generic(&conn_type, exec_sql).await;
                    if let Err(e) = run_res {
                        let is_ignorable = q_upper.starts_with("USE ") || q_upper.starts_with("CREATE DATABASE");
                        if !is_ignorable {
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
                            return Err(format!("Lỗi khi chạy lệnh SQL cuối: {}. Chi tiết: {}", q, e));
                        }
                    }
                    statements_count += 1;
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

    Ok(json!({ 
        "success": true, 
        "statementsCount": statements_count,
        "activeDatabase": last_use_db
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

#[tauri::command]
pub async fn drop_table(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
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
        DbConnection::Mysql(_) => format!("DROP TABLE `{}`", name),
        _ => format!("DROP TABLE \"{}\"", name),
    };
    execute_raw_sql_generic(&conn_type, sql.clone()).await?;

    Ok(json!({ "success": true }))
}

// Xóa sạch dữ liệu nhưng giữ cấu trúc bảng
#[tauri::command]
pub async fn truncate_table(state: tauri::State<'_, crate::AppState>, name: String) -> Result<Value, String> {
    let conn_type = {
        let manager = state.db_manager.lock().map_err(|e| e.to_string())?;
        match manager.connection.as_ref() {
            Some(DbConnection::Sqlite(conn_arc)) => DbConnection::Sqlite(conn_arc.clone()),
            Some(DbConnection::Postgres(pool)) => DbConnection::Postgres(pool.clone()),
            Some(DbConnection::Mysql(pool)) => DbConnection::Mysql(pool.clone()),
            None => return Err("Chưa kết nối CSDL".to_string()),
        }
    };

    // SQLite không có TRUNCATE -> dùng DELETE FROM
    let sql = match &conn_type {
        DbConnection::Mysql(_) => format!("TRUNCATE TABLE `{}`", name),
        DbConnection::Postgres(_) => format!("TRUNCATE TABLE \"{}\"", name),
        DbConnection::Sqlite(_) => format!("DELETE FROM \"{}\"", name),
    };
    execute_raw_sql_generic(&conn_type, sql).await?;

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
            // Postgres không có SHOW CREATE TABLE -> dựng lại từ metadata (cột + NOT NULL + DEFAULT + PRIMARY KEY)
            let pk_cols = get_primary_key_columns(&conn_type, &name).await;
            let sql = format!(
                "SELECT column_name, data_type, is_nullable, column_default \
                 FROM information_schema.columns \
                 WHERE table_name = '{}' AND table_schema = 'public' \
                 ORDER BY ordinal_position",
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
async fn execute_raw_sql_generic(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    match conn {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let col_count = stmt.column_count();
            let mut columns = Vec::new();
            for i in 0..col_count {
                columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
            }
            
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
            results.push(json!({
                "columns": columns,
                "data": rows_json
            }));
        }
        DbConnection::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            if sql.to_uppercase().trim().starts_with("USE ") || sql.to_uppercase().trim().starts_with("CREATE DATABASE") {
                sqlx::query(sqlx::AssertSqlSafe(sql.clone())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
            } else {
                let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
                let mut rows_json = Vec::new();
                let mut columns = Vec::new();
                if !rows.is_empty() {
                    for col in rows[0].columns() {
                        columns.push(col.name().to_string());
                    }
                    for r in rows {
                        let mut map = serde_json::Map::new();
                        for col_name in &columns {
                            let val: Value = decode_pg_cell!(&r, col_name.as_str());
                            map.insert(col_name.clone(), val);
                        }
                        rows_json.push(Value::Object(map));
                    }
                } else {
                    if let Ok(stmt) = pool.prepare(sqlx::AssertSqlSafe(sql.clone()).into_sql_str()).await {
                        for col in stmt.columns() {
                            columns.push(col.name().to_string());
                        }
                    }
                }
                results.push(json!({
                    "columns": columns,
                    "data": rows_json
                }));
            }
        }
        DbConnection::Mysql(pool) => {
            // Lấy 1 connection duy nhất từ pool để chạy câu lệnh, đảm bảo SET FOREIGN_KEY_CHECKS hoạt động xuyên suốt phiên
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            if sql.to_uppercase().trim().starts_with("USE ") || sql.to_uppercase().trim().starts_with("CREATE DATABASE") {
                sqlx::query(sqlx::AssertSqlSafe(sql.clone())).execute(&mut *conn).await.map_err(|e| e.to_string())?;
            } else {
                let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
                let mut rows_json = Vec::new();
                let mut columns = Vec::new();
                if !rows.is_empty() {
                    for col in rows[0].columns() {
                        columns.push(col.name().to_string());
                    }
                    for r in rows {
                        let mut map = serde_json::Map::new();
                        for col_name in &columns {
                            let val: Value = decode_mysql_cell!(&r, col_name.as_str());
                            map.insert(col_name.clone(), val);
                        }
                        rows_json.push(Value::Object(map));
                    }
                } else {
                    if let Ok(stmt) = pool.prepare(sqlx::AssertSqlSafe(sql.clone()).into_sql_str()).await {
                        for col in stmt.columns() {
                            columns.push(col.name().to_string());
                        }
                    }
                }
                results.push(json!({
                    "columns": columns,
                    "data": rows_json
                }));
            }
        }
    }
    Ok(results)
}

// Như execute_raw_sql_generic nhưng bind tham số ở tầng driver (parameterized query).
// Chỉ dùng cho MỘT câu lệnh (vd EXPLAIN <query có :param>) — không tách nhiều câu lệnh.
// SQL truyền vào phải đã dùng placeholder native (`?` cho SQLite/MySQL, `$1..$n` cho Postgres).
async fn run_bound_query(conn: &DbConnection, sql: String, params: &[Value]) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    match conn {
        DbConnection::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let col_count = stmt.column_count();
            let mut columns = Vec::new();
            for i in 0..col_count {
                columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
            }
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
            results.push(json!({ "columns": columns, "data": rows_json }));
        }
        DbConnection::Postgres(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            let query = bind_pg_params(sqlx::query(sqlx::AssertSqlSafe(sql.clone())), params);
            let rows = query.fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
            let mut rows_json = Vec::new();
            let mut columns = Vec::new();
            if !rows.is_empty() {
                for col in rows[0].columns() {
                    columns.push(col.name().to_string());
                }
                for r in rows {
                    let mut map = serde_json::Map::new();
                    for col_name in &columns {
                        let val: Value = decode_pg_cell!(&r, col_name.as_str());
                        map.insert(col_name.clone(), val);
                    }
                    rows_json.push(Value::Object(map));
                }
            }
            results.push(json!({ "columns": columns, "data": rows_json }));
        }
        DbConnection::Mysql(pool) => {
            let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
            let query = bind_mysql_params(sqlx::query(sqlx::AssertSqlSafe(sql.clone())), params);
            let rows = query.fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
            let mut rows_json = Vec::new();
            let mut columns = Vec::new();
            if !rows.is_empty() {
                for col in rows[0].columns() {
                    columns.push(col.name().to_string());
                }
                for r in rows {
                    let mut map = serde_json::Map::new();
                    for col_name in &columns {
                        let val: Value = decode_mysql_cell!(&r, col_name.as_str());
                        map.insert(col_name.clone(), val);
                    }
                    rows_json.push(Value::Object(map));
                }
            }
            results.push(json!({ "columns": columns, "data": rows_json }));
        }
    }
    Ok(results)
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
            let tv = execute_raw_sql_generic(&conn_type, "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name".to_string()).await?;
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

    Ok(json!({
        "success": true,
        "tables": tables,
        "views": views,
        "functions": functions,
        "procedures": procedures
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
                _ => format!("SHOW CREATE TABLE `{}`", name),
            };
            let row = sqlx::query(sqlx::AssertSqlSafe(stmt)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let s: String = row.try_get("Create Function")
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
        std::process::Command::new("cmd")
            .args(["/C", "start", &url])
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
