//! Giải quyết MỘT phía của phép so sánh thành một kết nối dùng được, và đường đọc dữ liệu
//! chung của cả module.
//!
//! Mỗi phía được giải quyết riêng: dùng lại kết nối đang mở nếu phía đó trỏ đúng database
//! hiện tại (không phải xác thực lại — quan trọng với token AWS IAM), còn không thì mở pool
//! TẠM từ config của server. Pool tạm mang `ConnId::Adhoc` nên `should_route` không bao giờ
//! pin nó làm phiên transaction của người dùng.

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::database::{
    build_mysql_url, build_pg_url, execute_raw_sql_generic, DbConnection, DbKind,
};
use crate::ssh::SshTunnel;
use crate::AppState;

// ===================== Tham số từ frontend =====================

/// Một phía của phép so sánh. Không truyền gì -> chính database đang kết nối.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSide {
    /// Tên database (MySQL/Postgres).
    pub database: Option<String>,
    /// Schema của Postgres (mặc định `public`). MySQL/SQLite bỏ qua.
    pub schema: Option<String>,
    /// Đường dẫn tệp SQLite.
    pub file_path: Option<String>,
    /// Cấu hình kết nối đầy đủ (dạng thô như `connect_db` nhận). Bỏ trống -> dùng
    /// cấu hình của kết nối đang mở.
    pub config: Option<Value>,
}

// ===================== Kết nối cho một phía =====================

pub(super) struct Resolved {
    pub(super) conn: DbConnection,
    pub(super) dialect: String,
    /// MySQL: tên database; Postgres: tên schema; SQLite: "main".
    pub(super) schema: String,
    /// Nhãn hiển thị (tên database hoặc tệp SQLite).
    pub(super) label: String,
    /// Máy chủ, để UI phân biệt hai phía cùng tên database khác server.
    pub(super) server: String,
    /// true khi đây là kết nối tạm do module này mở -> phải đóng khi xong.
    pub(super) owned: bool,
    /// Giữ tunnel SSH sống suốt lệnh (chỉ khi phía này tự mở tunnel).
    pub(super) _tunnel: Option<SshTunnel>,
}

impl Resolved {
    pub(super) async fn close(self) {
        if !self.owned {
            return;
        }
        match self.conn.kind {
            DbKind::Postgres(pool) => pool.close().await,
            DbKind::Mysql(pool) => pool.close().await,
            // rusqlite tự đóng khi Arc cuối cùng bị drop.
            DbKind::Sqlite(_) => {}
        }
    }
}

pub(super) fn cfg_str(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn server_label(config: &Value) -> String {
    let host = cfg_str(config, "host").unwrap_or_else(|| "localhost".to_string());
    match config.get("port").and_then(|v| v.as_u64()) {
        Some(p) => format!("{}:{}", host, p),
        None => host,
    }
}

/// Tên database/tệp mà kết nối ĐANG MỞ đang trỏ tới. Dùng để biết một phía có thể
/// dùng lại kết nối sẵn có thay vì mở kết nối mới.
pub(super) async fn current_db_name(conn: &DbConnection, dialect: &str) -> Option<String> {
    let sql = match dialect {
        "postgres" => "SELECT current_database() AS db",
        "mysql" => "SELECT DATABASE() AS db",
        _ => return None,
    };
    let rows = query_rows(conn, sql.to_string()).await.ok()?;
    rows.first()
        .and_then(|r| r.get("db"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(super) async fn resolve_side(
    state: &State<'_, AppState>,
    side: &CompareSide,
    conn_id: &str,
) -> Result<Resolved, String> {
    let (active, active_type, last_config, tunnel_port) = {
        // `.ok()`, không phải `?`: mỗi phía có thể tự mang config riêng, nên "chưa kết nối" không
        // phải lỗi ở đây — `base` phía dưới mới quyết định (`side.config.or(last_config)`).
        match state.connections.acquire(&conn_id).ok() {
            Some(ctx) => (
                Some(ctx.conn().clone()),
                ctx.server().db_type.clone(),
                Some(ctx.server().config()),
                ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port),
            ),
            None => (None, String::new(), None, None),
        }
    };

    let own_config = side.config.is_some();
    let base = side
        .config
        .clone()
        .or(last_config)
        .ok_or_else(|| "Chưa có cấu hình kết nối".to_string())?;

    // Config do frontend gửi thì dialect nằm trong đó; ngược lại lấy theo kết nối đang mở.
    let dialect = if own_config {
        cfg_str(&base, "dbType")
    } else if !active_type.is_empty() {
        Some(active_type.clone())
    } else {
        cfg_str(&base, "dbType")
    }
    .ok_or_else(|| "Hệ quản trị CSDL không được hỗ trợ".to_string())?;

    if dialect == "sqlite" {
        let path = side
            .file_path
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| cfg_str(&base, "filePath"))
            .ok_or_else(|| "Thiếu đường dẫn tệp SQLite".to_string())?;

        // Cùng tệp với kết nối đang mở -> dùng lại (tránh mở khoá tệp lần hai).
        let active_path = cfg_str(&base, "filePath");
        if !own_config && active_path.as_deref() == Some(path.as_str()) {
            if let Some(conn) = active.clone() {
                return Ok(Resolved {
                    conn,
                    dialect,
                    schema: "main".to_string(),
                    label: path.clone(),
                    server: path,
                    owned: false,
                    _tunnel: None,
                });
            }
        }

        // Mở CHỈ ĐỌC: so sánh không được tạo ra tệp rỗng khi người dùng gõ sai đường dẫn.
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("Không mở được tệp SQLite '{}': {}", path, e))?;

        return Ok(Resolved {
            // `adhoc`: pool này do module tự mở nên không bao giờ được trở thành phiên transaction
            // của người dùng — xem `ConnId::Adhoc` và §0 của kế hoạch.
            conn: DbConnection::adhoc(DbKind::Sqlite(std::sync::Arc::new(std::sync::Mutex::new(conn)))),
            dialect,
            schema: "main".to_string(),
            label: path.clone(),
            server: path,
            owned: true,
            _tunnel: None,
        });
    }

    if dialect != "postgres" && dialect != "mysql" {
        return Err("Hệ quản trị CSDL không được hỗ trợ".to_string());
    }

    let wanted_db = side
        .database
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| cfg_str(&base, "database"));

    // Dùng lại kết nối đang mở khi phía này trỏ đúng database hiện tại: không phải
    // xác thực lại (quan trọng với AWS IAM, token chỉ sống 15 phút).
    if !own_config {
        if let Some(conn) = active.clone() {
            let current = current_db_name(&conn, &dialect).await;
            let same = match (&wanted_db, &current) {
                (Some(w), Some(c)) => w == c,
                (None, _) => true,
                _ => false,
            };
            if same {
                let schema = match dialect.as_str() {
                    "postgres" => side.schema.clone().unwrap_or_else(|| "public".to_string()),
                    _ => current.clone().or(wanted_db.clone()).unwrap_or_default(),
                };
                return Ok(Resolved {
                    conn,
                    dialect,
                    schema,
                    label: current.or(wanted_db).unwrap_or_default(),
                    server: server_label(&base),
                    owned: false,
                    _tunnel: None,
                });
            }
        }
    }

    // Kết nối tạm. Config lấy từ kết nối đang mở thì host/port phải trỏ vào tunnel
    // đang chạy; config do frontend gửi kèm SSH thì tự mở tunnel riêng.
    let default_port: u16 = if dialect == "postgres" { 5432 } else { 3306 };
    let mut conn_config = base.clone();
    let mut tunnel: Option<SshTunnel> = None;

    if own_config {
        let (tunneled, t) = crate::database::apply_ssh_tunnel(&conn_config, default_port).await?;
        conn_config = tunneled;
        tunnel = t;
    } else if let (Some(obj), Some(port)) = (conn_config.as_object_mut(), tunnel_port) {
        obj.insert("host".to_string(), json!("127.0.0.1"));
        obj.insert("port".to_string(), json!(port));
    }
    crate::database::apply_iam_password(&base, &mut conn_config, default_port)?;

    let db_override = wanted_db.as_deref();
    // `adhoc` — xem ghi chú ở nhánh SQLite phía trên.
    let conn = DbConnection::adhoc(if dialect == "postgres" {
        let url = build_pg_url(&conn_config, db_override);
        DbKind::Postgres(
            sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
                .max_connections(2)
                .connect(&url)
                .await
                .map_err(|e| e.to_string())?,
        )
    } else {
        let url = build_mysql_url(&conn_config, db_override);
        DbKind::Mysql(
            sqlx::pool::PoolOptions::<sqlx::MySql>::new()
                .max_connections(2)
                .connect(&url)
                .await
                .map_err(|e| e.to_string())?,
        )
    });

    let label = wanted_db
        .clone()
        .or_else(|| cfg_str(&base, "database"))
        .unwrap_or_default();
    let schema = match dialect.as_str() {
        "postgres" => side.schema.clone().unwrap_or_else(|| "public".to_string()),
        _ => label.clone(),
    };

    Ok(Resolved {
        conn,
        dialect,
        schema,
        label,
        server: server_label(&base),
        owned: true,
        _tunnel: tunnel,
    })
}

pub(super) fn side_json(r: &Resolved, tables: usize) -> Value {
    json!({
        "label": r.label,
        "server": r.server,
        "dialect": r.dialect,
        "schema": r.schema,
        "tableCount": tables,
    })
}

// ===================== Đọc kết quả JSON =====================

/// The single funnel for every statement this module runs — all 18 call sites go through here.
///
/// A side resolved to an ad-hoc pool must never become the user's pinned transaction session. That
/// no longer depends on calling a particular executor: the pool carries `ConnId::Adhoc` and
/// `should_route` refuses it.
pub(super) async fn query_rows(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    let res = execute_raw_sql_generic(conn, sql).await?;
    Ok(res
        .first()
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Như `query_rows` nhưng lỗi -> danh sách rỗng. Dùng cho phần metadata không bắt buộc
/// (index/FK/view) để thiếu quyền trên một bảng hệ thống không làm hỏng cả phép so sánh.
pub(super) async fn query_rows_soft(conn: &DbConnection, sql: String) -> Vec<Value> {
    query_rows(conn, sql).await.unwrap_or_default()
}

pub(super) fn f_str(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

pub(super) fn f_opt_str(row: &Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Value::Null) | None => None,
        _ => Some(f_str(row, key)),
    }
}

pub(super) fn f_bool(row: &Value, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => {
            let u = s.trim().to_ascii_uppercase();
            u == "YES" || u == "TRUE" || u == "T" || u == "1"
        }
        _ => false,
    }
}
