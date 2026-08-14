// So sánh CẤU TRÚC và DỮ LIỆU giữa HAI database.
//
// Phase 1 của đa kết nối vẫn chỉ mở MỘT kết nối, nên mỗi "phía" (source/target) được giải quyết
// riêng trong `resolve_side()`: dùng lại kết nối đang mở nếu phía đó trỏ đúng database
// hiện tại, còn không thì mở kết nối TẠM từ `last_config` với database/tệp thay thế —
// cùng cách `get_all_databases_stats` làm khi "quét sâu". Kết nối tạm được đóng ngay
// khi lệnh kết thúc (`Resolved::close`).
//
// Toàn bộ metadata đọc qua `execute_raw_sql_generic` (đã trả về JSON `{columns, data}`)
// nên module này không lặp lại phần giải mã ô dữ liệu của từng driver. Việc pool tạm của
// module không bao giờ bị pin làm phiên transaction của người dùng giờ do CHÍNH KIỂU bảo đảm:
// mỗi pool tạm mang `ConnId::Adhoc` và `should_route` từ chối nó — không còn phụ thuộc vào
// việc nhớ gọi đúng một funnel riêng.
//
// SQL sinh ra (`syncSql`) luôn theo hướng source -> target và theo dialect của TARGET.
// Mọi câu lệnh phá dữ liệu (DROP ...) chỉ được sinh ở dạng thực thi khi
// `includeDrops = true`; mặc định chúng bị comment lại để một script chạy vô tình
// không xoá gì.
//
// NGÔN NGỮ: thông báo lỗi và `warnings` viết tiếng Việt như phần còn lại của backend
// (frontend dịch qua `src/utils/backendErrors.ts`), nhưng phần comment TRONG script SQL
// viết tiếng Anh — script là tệp đem đi chỗ khác (migration, DBeaver, psql/mysql CLI),
// không phải chữ trên giao diện, nên không đi qua bảng dịch.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use tauri::State;

use crate::database::{build_mysql_url, build_pg_url, execute_raw_sql_generic, DbConnection, DbKind};
use crate::ssh_tunnel::SshTunnel;
use crate::AppState;

// Số dòng tối đa đọc về từ MỖI phía khi so dữ liệu. Vượt ngưỡng -> kết quả đánh dấu
// `truncated` và chỉ so phần đầu theo thứ tự khóa.
const DEFAULT_DATA_LIMIT: usize = 20_000;
// Số dòng KHÁC BIỆT tối đa trả về cho UI (số đếm trong `summary` vẫn là số thật).
const DEFAULT_MAX_DIFF_ROWS: usize = 500;

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

struct Resolved {
    conn: DbConnection,
    dialect: String,
    /// MySQL: tên database; Postgres: tên schema; SQLite: "main".
    schema: String,
    /// Nhãn hiển thị (tên database hoặc tệp SQLite).
    label: String,
    /// Máy chủ, để UI phân biệt hai phía cùng tên database khác server.
    server: String,
    /// true khi đây là kết nối tạm do module này mở -> phải đóng khi xong.
    owned: bool,
    /// Giữ tunnel SSH sống suốt lệnh (chỉ khi phía này tự mở tunnel).
    _tunnel: Option<SshTunnel>,
}

impl Resolved {
    async fn close(self) {
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

fn cfg_str(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn server_label(config: &Value) -> String {
    let host = cfg_str(config, "host").unwrap_or_else(|| "localhost".to_string());
    match config.get("port").and_then(|v| v.as_u64()) {
        Some(p) => format!("{}:{}", host, p),
        None => host,
    }
}

/// Tên database/tệp mà kết nối ĐANG MỞ đang trỏ tới. Dùng để biết một phía có thể
/// dùng lại kết nối sẵn có thay vì mở kết nối mới.
async fn current_db_name(conn: &DbConnection, dialect: &str) -> Option<String> {
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

async fn resolve_side(
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

fn side_json(r: &Resolved, tables: usize) -> Value {
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
async fn query_rows(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
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
async fn query_rows_soft(conn: &DbConnection, sql: String) -> Vec<Value> {
    query_rows(conn, sql).await.unwrap_or_default()
}

fn f_str(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn f_opt_str(row: &Value, key: &str) -> Option<String> {
    match row.get(key) {
        Some(Value::Null) | None => None,
        _ => Some(f_str(row, key)),
    }
}

fn f_bool(row: &Value, key: &str) -> bool {
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

// ===================== Metadata =====================

#[derive(Clone, Default)]
struct ColMeta {
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    auto_increment: bool,
    comment: Option<String>,
    position: usize,
}

#[derive(Clone, Default)]
struct IdxMeta {
    name: String,
    columns: Vec<String>,
    unique: bool,
}

#[derive(Clone, Default)]
struct FkMeta {
    name: String,
    columns: Vec<String>,
    ref_table: String,
    ref_columns: Vec<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

#[derive(Clone, Default)]
struct TableMeta {
    name: String,
    is_view: bool,
    columns: Vec<ColMeta>,
    indexes: Vec<IdxMeta>,
    fks: Vec<FkMeta>,
    pk: Vec<String>,
    view_def: Option<String>,
    /// Câu CREATE gốc — chỉ SQLite có (sqlite_master.sql). Dùng lại nguyên văn khi cả hai
    /// phía đều là SQLite, vì SQLite không ALTER được và câu gốc là bản mô tả chính xác nhất.
    create_sql: Option<String>,
}

impl TableMeta {
    fn column(&self, name: &str) -> Option<&ColMeta> {
        self.columns.iter().find(|c| c.name == name)
    }
}

type SchemaMeta = BTreeMap<String, TableMeta>;

fn col_json(c: &ColMeta) -> Value {
    json!({
        "name": c.name,
        "type": c.data_type,
        "nullable": c.nullable,
        "default": c.default,
        "autoIncrement": c.auto_increment,
        "comment": c.comment,
        "position": c.position,
    })
}

fn idx_json(i: &IdxMeta) -> Value {
    json!({ "name": i.name, "columns": i.columns, "unique": i.unique })
}

fn fk_json(f: &FkMeta) -> Value {
    json!({
        "name": f.name,
        "columns": f.columns,
        "refTable": f.ref_table,
        "refColumns": f.ref_columns,
        "onDelete": f.on_delete,
        "onUpdate": f.on_update,
    })
}

// ---- Trích dẫn định danh / literal ----

fn q_ident(dialect: &str, name: &str) -> String {
    if dialect == "mysql" {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn q_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Tên bảng đầy đủ. SQLite không có schema nên chỉ trả về tên bảng.
fn qualified(dialect: &str, schema: &str, table: &str) -> String {
    if dialect == "sqlite" || schema.is_empty() {
        q_ident(dialect, table)
    } else {
        format!("{}.{}", q_ident(dialect, schema), q_ident(dialect, table))
    }
}

// ---- MySQL ----

async fn read_mysql(conn: &DbConnection, schema: &str) -> Result<SchemaMeta, String> {
    let s = schema.replace('\'', "''");
    let mut out: SchemaMeta = BTreeMap::new();

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{s}'"
    );
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_str(&row, "table_type").to_ascii_uppercase().contains("VIEW");
        out.insert(
            name.clone(),
            TableMeta { name, is_view, ..Default::default() },
        );
    }

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS data_type, \
                IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, \
                COLUMN_COMMENT AS column_comment, ORDINAL_POSITION AS ordinal_position \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '{s}' \
         ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    for row in query_rows(conn, sql).await? {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            let position = t.columns.len() + 1;
            t.columns.push(ColMeta {
                name: f_str(&row, "column_name"),
                data_type: f_str(&row, "data_type"),
                nullable: f_bool(&row, "is_nullable"),
                default: f_opt_str(&row, "column_default"),
                auto_increment: f_str(&row, "extra").to_ascii_lowercase().contains("auto_increment"),
                comment: f_opt_str(&row, "column_comment").filter(|c| !c.is_empty()),
                position,
            });
        }
    }

    // STATISTICS chứa cả PRIMARY: tách ra thành `pk`, phần còn lại là index thường.
    let sql = format!(
        "SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, COLUMN_NAME AS column_name, \
                NON_UNIQUE AS non_unique \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '{s}' \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        let idx_name = f_str(&row, "index_name");
        let col = f_str(&row, "column_name");
        if let Some(t) = out.get_mut(&table) {
            if idx_name == "PRIMARY" {
                t.pk.push(col);
                continue;
            }
            let unique = !f_bool(&row, "non_unique");
            match t.indexes.iter_mut().find(|i| i.name == idx_name) {
                Some(i) => i.columns.push(col),
                None => t.indexes.push(IdxMeta { name: idx_name, columns: vec![col], unique }),
            }
        }
    }

    let sql = format!(
        "SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name, \
                k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS ref_table, \
                k.REFERENCED_COLUMN_NAME AS ref_column, r.DELETE_RULE AS delete_rule, \
                r.UPDATE_RULE AS update_rule \
         FROM information_schema.KEY_COLUMN_USAGE k \
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
          AND r.TABLE_NAME = k.TABLE_NAME \
         WHERE k.TABLE_SCHEMA = '{s}' AND k.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        let name = f_str(&row, "constraint_name");
        if let Some(t) = out.get_mut(&table) {
            let col = f_str(&row, "column_name");
            let ref_col = f_str(&row, "ref_column");
            match t.fks.iter_mut().find(|f| f.name == name) {
                Some(f) => {
                    f.columns.push(col);
                    f.ref_columns.push(ref_col);
                }
                None => t.fks.push(FkMeta {
                    name,
                    columns: vec![col],
                    ref_table: f_str(&row, "ref_table"),
                    ref_columns: vec![ref_col],
                    on_delete: f_opt_str(&row, "delete_rule"),
                    on_update: f_opt_str(&row, "update_rule"),
                }),
            }
        }
    }

    let sql = format!(
        "SELECT TABLE_NAME AS table_name, VIEW_DEFINITION AS view_definition \
         FROM information_schema.VIEWS WHERE TABLE_SCHEMA = '{s}'"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.view_def = f_opt_str(&row, "view_definition");
        }
    }

    Ok(out)
}

// ---- Postgres ----

async fn read_pg(conn: &DbConnection, schema: &str) -> Result<SchemaMeta, String> {
    let s = schema.replace('\'', "''");
    let mut out: SchemaMeta = BTreeMap::new();

    // relkind là kiểu "char" — sqlx không giải mã được thành String, nên map ngay trong SQL.
    let sql = format!(
        "SELECT c.relname AS table_name, \
                CASE WHEN c.relkind IN ('v','m') THEN 1 ELSE 0 END AS is_view \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' AND c.relkind IN ('r','p','v','m')"
    );
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_bool(&row, "is_view");
        out.insert(name.clone(), TableMeta { name, is_view, ..Default::default() });
    }

    let sql = format!(
        "SELECT c.relname AS table_name, a.attname AS column_name, \
                format_type(a.atttypid, a.atttypmod) AS data_type, \
                (NOT a.attnotnull) AS is_nullable, \
                pg_get_expr(d.adbin, d.adrelid) AS column_default, \
                (a.attidentity <> '')::bool AS is_identity, \
                col_description(c.oid, a.attnum) AS column_comment \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         WHERE n.nspname = '{s}' AND c.relkind IN ('r','p','v','m') \
         ORDER BY c.relname, a.attnum"
    );
    for row in query_rows(conn, sql).await? {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            let default = f_opt_str(&row, "column_default");
            let position = t.columns.len() + 1;
            t.columns.push(ColMeta {
                name: f_str(&row, "column_name"),
                data_type: f_str(&row, "data_type"),
                nullable: f_bool(&row, "is_nullable"),
                auto_increment: f_bool(&row, "is_identity")
                    || default.as_deref().map(|d| d.contains("nextval(")).unwrap_or(false),
                default,
                comment: f_opt_str(&row, "column_comment"),
                position,
            });
        }
    }

    let sql = format!(
        "SELECT c.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, \
                ix.indisprimary AS is_primary, pg_get_indexdef(ix.indexrelid) AS index_def \
         FROM pg_index ix \
         JOIN pg_class c ON c.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' \
         ORDER BY c.relname, i.relname"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            let cols = index_def_columns(&f_str(&row, "index_def"));
            if f_bool(&row, "is_primary") {
                t.pk = cols;
                continue;
            }
            t.indexes.push(IdxMeta {
                name: f_str(&row, "index_name"),
                columns: cols,
                unique: f_bool(&row, "is_unique"),
            });
        }
    }

    let sql = format!(
        "SELECT con.conname AS constraint_name, c.relname AS table_name, rc.relname AS ref_table, \
                (SELECT string_agg(a.attname, ',' ORDER BY x.ord) \
                   FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord) \
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS columns, \
                (SELECT string_agg(a.attname, ',' ORDER BY x.ord) \
                   FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord) \
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS ref_columns, \
                CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' \
                     WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule, \
                CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' \
                     WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_class rc ON rc.oid = con.confrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.contype = 'f' AND n.nspname = '{s}' \
         ORDER BY c.relname, con.conname"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.fks.push(FkMeta {
                name: f_str(&row, "constraint_name"),
                columns: split_csv(&f_str(&row, "columns")),
                ref_table: f_str(&row, "ref_table"),
                ref_columns: split_csv(&f_str(&row, "ref_columns")),
                on_delete: f_opt_str(&row, "delete_rule"),
                on_update: f_opt_str(&row, "update_rule"),
            });
        }
    }

    let sql = format!(
        "SELECT c.relname AS table_name, pg_get_viewdef(c.oid, true) AS view_definition \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{s}' AND c.relkind IN ('v','m')"
    );
    for row in query_rows_soft(conn, sql).await {
        let table = f_str(&row, "table_name");
        if let Some(t) = out.get_mut(&table) {
            t.view_def = f_opt_str(&row, "view_definition");
        }
    }

    Ok(out)
}

/// Lấy danh sách cột từ `pg_get_indexdef` — phần trong cặp ngoặc CUỐI cùng.
/// `CREATE UNIQUE INDEX x ON t USING btree (a, lower(b))` -> ["a", "lower(b)"].
fn index_def_columns(def: &str) -> Vec<String> {
    let open = match def.rfind('(') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let close = match def.rfind(')') {
        Some(i) if i > open => i,
        _ => return Vec::new(),
    };
    split_csv(&def[open + 1..close])
}

fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().trim_matches('"').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

// ---- SQLite ----

async fn read_sqlite(conn: &DbConnection) -> Result<SchemaMeta, String> {
    let mut out: SchemaMeta = BTreeMap::new();

    let sql = "SELECT name AS table_name, type AS table_type, sql AS create_sql \
               FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
               ORDER BY name"
        .to_string();
    for row in query_rows(conn, sql).await? {
        let name = f_str(&row, "table_name");
        if name.is_empty() {
            continue;
        }
        let is_view = f_str(&row, "table_type") == "view";
        let create_sql = f_opt_str(&row, "create_sql");
        out.insert(
            name.clone(),
            TableMeta {
                name,
                is_view,
                view_def: if is_view { create_sql.clone() } else { None },
                create_sql,
                ..Default::default()
            },
        );
    }

    let names: Vec<String> = out.keys().cloned().collect();
    for name in names {
        let quoted = q_ident("sqlite", &name);

        // (cột, thứ tự trong PK) — PRAGMA trả `pk` = 0 nếu không thuộc PK, 1..n nếu thuộc.
        let mut pk: Vec<(i64, String)> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA table_info({quoted})")).await {
            let col = ColMeta {
                name: f_str(&row, "name"),
                data_type: f_str(&row, "type"),
                nullable: !f_bool(&row, "notnull"),
                default: f_opt_str(&row, "dflt_value"),
                auto_increment: false,
                comment: None,
                position: 0,
            };
            let pk_ord = row.get("pk").and_then(|v| v.as_i64()).unwrap_or(0);
            if pk_ord > 0 {
                pk.push((pk_ord, col.name.clone()));
            }
            if let Some(t) = out.get_mut(&name) {
                let position = t.columns.len() + 1;
                t.columns.push(ColMeta { position, ..col });
            }
        }
        pk.sort_by_key(|(ord, _)| *ord);

        let mut indexes: Vec<IdxMeta> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA index_list({quoted})")).await {
            let idx_name = f_str(&row, "name");
            // origin = 'pk' -> index ngầm của PRIMARY KEY, đã có trong `pk`.
            if idx_name.is_empty() || f_str(&row, "origin") == "pk" {
                continue;
            }
            let unique = f_bool(&row, "unique");
            let info_sql = format!("PRAGMA index_info({})", q_ident("sqlite", &idx_name));
            let cols: Vec<String> = query_rows_soft(conn, info_sql)
                .await
                .iter()
                .map(|r| f_str(r, "name"))
                .filter(|c| !c.is_empty())
                .collect();
            indexes.push(IdxMeta { name: idx_name, columns: cols, unique });
        }

        let mut fks: Vec<FkMeta> = Vec::new();
        for row in query_rows_soft(conn, format!("PRAGMA foreign_key_list({quoted})")).await {
            let id = row.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            // SQLite không đặt tên FK -> tên tổng hợp, đủ ổn định để so hai bên.
            let fk_name = format!("fk_{}_{}", name, id);
            let from = f_str(&row, "from");
            let to = f_str(&row, "to");
            match fks.iter_mut().find(|f| f.name == fk_name) {
                Some(f) => {
                    f.columns.push(from);
                    f.ref_columns.push(to);
                }
                None => fks.push(FkMeta {
                    name: fk_name,
                    columns: vec![from],
                    ref_table: f_str(&row, "table"),
                    ref_columns: vec![to],
                    on_delete: f_opt_str(&row, "on_delete"),
                    on_update: f_opt_str(&row, "on_update"),
                }),
            }
        }

        if let Some(t) = out.get_mut(&name) {
            t.pk = pk.into_iter().map(|(_, c)| c).collect();
            t.indexes = indexes;
            t.fks = fks;
        }
    }

    Ok(out)
}

async fn read_schema(r: &Resolved) -> Result<SchemaMeta, String> {
    match r.dialect.as_str() {
        "mysql" => read_mysql(&r.conn, &r.schema).await,
        "postgres" => read_pg(&r.conn, &r.schema).await,
        "sqlite" => read_sqlite(&r.conn).await,
        _ => Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    }
}

// ===================== So sánh cấu trúc =====================

/// Chuẩn hóa kiểu dữ liệu trước khi so, để hai bên chỉ khác cách viết thì không bị
/// báo là khác nhau: bỏ display-width của kiểu số nguyên (MySQL 8 không còn `int(11)`),
/// gộp các tên đồng nghĩa giữa các dialect.
fn norm_type(raw: &str) -> String {
    let mut t = raw.trim().to_ascii_lowercase();
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");

    for base in ["tinyint", "smallint", "mediumint", "bigint", "int", "integer"] {
        if let Some(rest) = t.strip_prefix(base) {
            if rest.starts_with('(') {
                if let Some(close) = rest.find(')') {
                    t = format!("{}{}", base, &rest[close + 1..]);
                }
            }
            break;
        }
    }

    let (head, tail) = match t.find('(') {
        Some(i) => (t[..i].trim().to_string(), t[i..].to_string()),
        None => (t.clone(), String::new()),
    };
    let head = match head.as_str() {
        "integer" | "int4" | "serial" | "serial4" => "int",
        "int8" | "bigserial" | "serial8" => "bigint",
        "int2" | "smallserial" => "smallint",
        "character varying" | "varchar2" => "varchar",
        "character" | "bpchar" => "char",
        "bool" => "boolean",
        "double precision" | "float8" => "double",
        "float4" | "real" => "float",
        "timestamp without time zone" => "timestamp",
        "timestamp with time zone" | "timestamptz" => "timestamptz",
        "time without time zone" => "time",
        "decimal" | "numeric" => "decimal",
        "text" | "longtext" | "mediumtext" | "tinytext" | "clob" => "text",
        "blob" | "bytea" | "longblob" | "mediumblob" | "tinyblob" => "blob",
        other => other,
    };
    format!("{}{}", head, tail)
}

/// Giá trị mặc định hai bên có coi là giống nhau. Bỏ dấu nháy/cast của Postgres
/// (`'x'::character varying` <-> `x` của MySQL) và không phân biệt hoa/thường của
/// các hằng như CURRENT_TIMESTAMP.
fn norm_default(raw: Option<&str>) -> String {
    let mut d = match raw {
        None => return String::new(),
        Some(s) => s.trim().to_string(),
    };
    if let Some(i) = d.find("::") {
        d = d[..i].trim().to_string();
    }
    let d = d.trim_matches('\'').trim().to_ascii_lowercase();
    match d.as_str() {
        "now()" | "current_timestamp()" => "current_timestamp".to_string(),
        _ => d,
    }
}

fn column_changes(a: &ColMeta, b: &ColMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if norm_type(&a.data_type) != norm_type(&b.data_type) {
        ch.push("type");
    }
    if a.nullable != b.nullable {
        ch.push("nullable");
    }
    if norm_default(a.default.as_deref()) != norm_default(b.default.as_deref()) {
        ch.push("default");
    }
    if a.auto_increment != b.auto_increment {
        ch.push("autoIncrement");
    }
    if a.comment.clone().unwrap_or_default() != b.comment.clone().unwrap_or_default() {
        ch.push("comment");
    }
    if a.position != b.position {
        ch.push("position");
    }
    ch
}

fn index_changes(a: &IdxMeta, b: &IdxMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.unique != b.unique {
        ch.push("unique");
    }
    ch
}

fn fk_changes(a: &FkMeta, b: &FkMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.ref_table != b.ref_table {
        ch.push("refTable");
    }
    if a.ref_columns != b.ref_columns {
        ch.push("refColumns");
    }
    if a.on_delete.clone().unwrap_or_default().to_ascii_uppercase()
        != b.on_delete.clone().unwrap_or_default().to_ascii_uppercase()
    {
        ch.push("onDelete");
    }
    if a.on_update.clone().unwrap_or_default().to_ascii_uppercase()
        != b.on_update.clone().unwrap_or_default().to_ascii_uppercase()
    {
        ch.push("onUpdate");
    }
    ch
}

/// So sánh định nghĩa view sau khi bỏ khoảng trắng, ngoặc đơn, quotes, typecast, schema qualification —
/// hai server format khác nhau là chuyện thường, chỉ nội dung SQL thực sự khác mới đáng báo.
fn view_def_differs(
    a: Option<&String>,
    b: Option<&String>,
    src_db: &str,
    tgt_db: &str,
    name: &str,
) -> bool {
    fn squash(s: Option<&String>, db_name: &str) -> String {
        let mut str_val = match s {
            Some(v) => v.as_str().trim(),
            None => return String::new(),
        };
        if str_val.is_empty() {
            return String::new();
        }

        let lower = str_val.to_ascii_lowercase();
        // Cắt bỏ phần tiền tố "CREATE [OR REPLACE] [ALGORITHM=...] [DEFINER=...] VIEW view_name AS "
        if let Some(v_idx) = lower.find("view ") {
            let after_view = &lower[v_idx + 5..];
            if let Some(as_idx) = after_view.find(" as ") {
                let cut_offset = v_idx + 5 + as_idx + 4;
                if cut_offset < str_val.len() {
                    str_val = &str_val[cut_offset..];
                }
            }
        } else if let Some(as_idx) = lower.find(" as ") {
            if lower.starts_with("create") || lower.starts_with("replace") {
                str_val = &str_val[as_idx + 4..];
            }
        }

        let mut cleaned = str_val
            .replace('"', "")
            .replace('`', "")
            .replace("public.", "")
            .replace("PUBLIC.", "")
            .replace("dbo.", "")
            .replace("DBO.", "")
            .replace("::text", "")
            .replace("::character varying", "")
            .replace("::varchar", "")
            .replace("::integer", "")
            .replace("::int4", "")
            .replace("::int", "")
            .replace("::bigint", "")
            .replace("::int8", "")
            .replace("::boolean", "")
            .replace("::bool", "");

        if !db_name.is_empty() {
            let pfx1 = format!("{}.", db_name.trim());
            let pfx2 = pfx1.to_ascii_lowercase();
            cleaned = cleaned.replace(&pfx1, "").replace(&pfx2, "");
        }

        cleaned = cleaned.replace('(', " ").replace(')', " ");

        cleaned
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(';')
            .to_ascii_lowercase()
    }
    let sa = squash(a, src_db);
    let sb = squash(b, tgt_db);
    if sa.is_empty() || sb.is_empty() {
        return false;
    }
    let differs = sa != sb;
    if differs {
        eprintln!("[VIEW DIFF] {}\n  SA: {}\n  SB: {}", name, sa, sb);
    }
    differs
}

// ===================== Sinh SQL đồng bộ =====================

struct SqlOut {
    lines: Vec<String>,
    include_drops: bool,
}

impl SqlOut {
    fn new(include_drops: bool) -> Self {
        SqlOut { lines: Vec::new(), include_drops }
    }
    fn note(&mut self, text: impl AsRef<str>) {
        self.lines.push(format!("-- {}", text.as_ref()));
    }
    fn blank(&mut self) {
        self.lines.push(String::new());
    }
    fn push(&mut self, stmt: impl Into<String>) {
        self.lines.push(stmt.into());
    }
    /// Câu lệnh xoá: chỉ chạy thật khi người dùng bật `includeDrops`.
    fn destructive(&mut self, stmt: impl Into<String>) {
        let stmt = stmt.into();
        if self.include_drops {
            self.lines.push(stmt);
        } else {
            self.lines.push(format!("-- {}", stmt));
        }
    }
    /// Cặp DROP + CREATE (index/FK đã đổi). Không bật `includeDrops` thì comment CẢ HAI,
    /// vì chạy riêng CREATE sẽ lỗi trùng tên.
    fn paired(&mut self, drop_stmt: impl Into<String>, create_stmt: impl Into<String>) {
        self.destructive(drop_stmt);
        self.destructive(create_stmt);
    }
}

/// Kết xuất giá trị mặc định của cột nguồn sang SQL của dialect đích.
/// MySQL trả về default dạng GIÁ TRỊ THÔ (`abc`), Postgres/SQLite trả về BIỂU THỨC
/// (`'abc'::text`), nên phải phân biệt theo dialect nguồn.
fn render_default(src_dialect: &str, tgt_dialect: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    let upper = trimmed.to_ascii_uppercase();
    let is_expr = upper.starts_with("CURRENT_")
        || upper.starts_with("NOW(")
        || upper == "NULL"
        || upper.starts_with("NEXTVAL(")
        || upper.starts_with("UUID(")
        || upper.starts_with("GEN_RANDOM_UUID(")
        || trimmed.parse::<f64>().is_ok();

    if src_dialect == "mysql" {
        if is_expr {
            return trimmed.to_string();
        }
        return q_lit(trimmed);
    }
    // Nguồn Postgres/SQLite: đã là biểu thức SQL. Bỏ cast `::type` khi đích không phải PG.
    if tgt_dialect != "postgres" {
        if let Some(i) = trimmed.find("::") {
            return trimmed[..i].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Mệnh đề định nghĩa một cột, theo dialect ĐÍCH.
fn column_clause(c: &ColMeta, src_dialect: &str, tgt: &str, single_int_pk: bool) -> String {
    let mut out = format!("{} {}", q_ident(tgt, &c.name), c.data_type);

    if c.auto_increment {
        match tgt {
            "mysql" => out.push_str(" AUTO_INCREMENT"),
            "postgres" => out.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
            "sqlite" if single_int_pk => {
                // SQLite chỉ tự tăng với INTEGER PRIMARY KEY AUTOINCREMENT.
                return format!("{} INTEGER PRIMARY KEY AUTOINCREMENT", q_ident(tgt, &c.name));
            }
            _ => {}
        }
    }
    if !c.nullable {
        out.push_str(" NOT NULL");
    }
    if let Some(d) = c.default.as_deref().filter(|d| !d.trim().is_empty()) {
        // Default sinh từ sequence đã được diễn tả bằng AUTO_INCREMENT/IDENTITY ở trên.
        if !(c.auto_increment && d.to_ascii_uppercase().contains("NEXTVAL(")) {
            out.push_str(&format!(" DEFAULT {}", render_default(src_dialect, tgt, d)));
        }
    }
    if tgt == "mysql" {
        if let Some(cm) = c.comment.as_deref().filter(|c| !c.is_empty()) {
            out.push_str(&format!(" COMMENT {}", q_lit(cm)));
        }
    }
    out
}

fn create_table_sql(t: &TableMeta, src_dialect: &str, tgt: &str, schema: &str) -> Vec<String> {
    let mut stmts = Vec::new();
    let full = qualified(tgt, schema, &t.name);

    if t.is_view {
        let def = t.view_def.clone().unwrap_or_default();
        if def.trim().is_empty() {
            stmts.push(format!("-- Could not read the definition of view {}", t.name));
            return stmts;
        }
        // SQLite lưu cả câu CREATE VIEW trong sqlite_master; các dialect khác chỉ lưu thân SELECT.
        let body = def.trim().trim_end_matches(';').to_string();
        if body.to_ascii_uppercase().starts_with("CREATE ") {
            stmts.push(format!("{};", body));
        } else if tgt == "sqlite" {
            stmts.push(format!("CREATE VIEW {} AS {};", full, body));
        } else {
            stmts.push(format!("CREATE OR REPLACE VIEW {} AS {};", full, body));
        }
        return stmts;
    }

    // SQLite -> SQLite: câu CREATE gốc là bản mô tả đầy đủ nhất (kể cả AUTOINCREMENT,
    // CHECK, FK inline) và không cần dịch kiểu dữ liệu.
    if src_dialect == "sqlite" && tgt == "sqlite" {
        if let Some(orig) = t.create_sql.as_deref().filter(|s| !s.trim().is_empty()) {
            stmts.push(format!("{};", orig.trim().trim_end_matches(';')));
            for idx in &t.indexes {
                stmts.push(create_index_sql(idx, &t.name, tgt, schema));
            }
            return stmts;
        }
    }

    let single_int_pk = t.pk.len() == 1
        && t.column(&t.pk[0])
            .map(|c| c.auto_increment || norm_type(&c.data_type).starts_with("int"))
            .unwrap_or(false);

    let mut parts: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            format!(
                "  {}",
                column_clause(c, src_dialect, tgt, single_int_pk && t.pk.first() == Some(&c.name))
            )
        })
        .collect();

    let inline_pk = !(tgt == "sqlite" && single_int_pk && t.pk.first().map(|p| t.column(p).map(|c| c.auto_increment).unwrap_or(false)).unwrap_or(false));
    if !t.pk.is_empty() && inline_pk {
        let cols: Vec<String> = t.pk.iter().map(|c| q_ident(tgt, c)).collect();
        parts.push(format!("  PRIMARY KEY ({})", cols.join(", ")));
    }

    // SQLite không có ALTER TABLE ADD CONSTRAINT -> FK phải nằm trong câu CREATE.
    if tgt == "sqlite" {
        for fk in &t.fks {
            let cols: Vec<String> = fk.columns.iter().map(|c| q_ident(tgt, c)).collect();
            let refs: Vec<String> = fk.ref_columns.iter().map(|c| q_ident(tgt, c)).collect();
            let mut clause = format!(
                "  FOREIGN KEY ({}) REFERENCES {} ({})",
                cols.join(", "),
                q_ident(tgt, &fk.ref_table),
                refs.join(", ")
            );
            if let Some(rule) = fk.on_delete.as_deref().filter(|r| !r.is_empty() && !r.eq_ignore_ascii_case("NO ACTION")) {
                clause.push_str(&format!(" ON DELETE {}", rule.to_ascii_uppercase()));
            }
            if let Some(rule) = fk.on_update.as_deref().filter(|r| !r.is_empty() && !r.eq_ignore_ascii_case("NO ACTION")) {
                clause.push_str(&format!(" ON UPDATE {}", rule.to_ascii_uppercase()));
            }
            parts.push(clause);
        }
    }

    stmts.push(format!("CREATE TABLE {} (\n{}\n);", full, parts.join(",\n")));

    for idx in &t.indexes {
        stmts.push(create_index_sql(idx, &t.name, tgt, schema));
    }
    if tgt != "sqlite" {
        for fk in &t.fks {
            stmts.push(add_fk_sql(fk, &t.name, tgt, schema));
        }
    }
    stmts
}

fn create_index_sql(idx: &IdxMeta, table: &str, tgt: &str, schema: &str) -> String {
    let cols: Vec<String> = idx
        .columns
        .iter()
        // Postgres cho phép index trên biểu thức (`lower(a)`) — giữ nguyên, đừng trích dẫn.
        .map(|c| if c.contains('(') { c.clone() } else { q_ident(tgt, c) })
        .collect();
    let unique = if idx.unique { "UNIQUE " } else { "" };
    format!(
        "CREATE {}INDEX {} ON {} ({});",
        unique,
        q_ident(tgt, &idx.name),
        qualified(tgt, schema, table),
        cols.join(", ")
    )
}

fn drop_index_sql(idx: &IdxMeta, table: &str, tgt: &str, schema: &str) -> String {
    if tgt == "mysql" {
        format!(
            "DROP INDEX {} ON {};",
            q_ident(tgt, &idx.name),
            qualified(tgt, schema, table)
        )
    } else if tgt == "postgres" {
        format!("DROP INDEX {};", qualified(tgt, schema, &idx.name))
    } else {
        format!("DROP INDEX {};", q_ident(tgt, &idx.name))
    }
}

fn add_fk_sql(fk: &FkMeta, table: &str, tgt: &str, schema: &str) -> String {
    let cols: Vec<String> = fk.columns.iter().map(|c| q_ident(tgt, c)).collect();
    let refs: Vec<String> = fk.ref_columns.iter().map(|c| q_ident(tgt, c)).collect();
    let mut sql = format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        qualified(tgt, schema, table),
        q_ident(tgt, &fk.name),
        cols.join(", "),
        qualified(tgt, schema, &fk.ref_table),
        refs.join(", ")
    );
    if let Some(rule) = fk.on_delete.as_deref().filter(|r| !r.is_empty() && !r.eq_ignore_ascii_case("NO ACTION")) {
        sql.push_str(&format!(" ON DELETE {}", rule.to_ascii_uppercase()));
    }
    if let Some(rule) = fk.on_update.as_deref().filter(|r| !r.is_empty() && !r.eq_ignore_ascii_case("NO ACTION")) {
        sql.push_str(&format!(" ON UPDATE {}", rule.to_ascii_uppercase()));
    }
    sql.push(';');
    sql
}

/// SQLite không thêm/bớt được khóa ngoại của bảng đã tồn tại (không có
/// `ALTER TABLE ... ADD/DROP CONSTRAINT`) -> trả về ghi chú thay vì SQL không chạy được.
fn fk_stmt_or_note(tgt: &str, table: &str, fk_name: &str, stmt: String) -> String {
    if tgt == "sqlite" {
        format!(
            "-- SQLite cannot add or drop a foreign key on an existing table: {}.{} - recreate the table.",
            table, fk_name
        )
    } else {
        stmt
    }
}

fn drop_fk_sql(fk: &FkMeta, table: &str, tgt: &str, schema: &str) -> String {
    let full = qualified(tgt, schema, table);
    if tgt == "mysql" {
        format!("ALTER TABLE {} DROP FOREIGN KEY {};", full, q_ident(tgt, &fk.name))
    } else {
        format!("ALTER TABLE {} DROP CONSTRAINT {};", full, q_ident(tgt, &fk.name))
    }
}

/// Các câu lệnh sửa MỘT cột cho khớp nguồn. SQLite không sửa được cột -> chỉ ghi chú.
fn alter_column_stmts(
    table: &str,
    src: &ColMeta,
    tgt_col: &ColMeta,
    changes: &[&str],
    src_dialect: &str,
    tgt: &str,
    schema: &str,
) -> Vec<String> {
    let full = qualified(tgt, schema, table);
    let mut out = Vec::new();

    match tgt {
        "mysql" => {
            out.push(format!(
                "ALTER TABLE {} MODIFY COLUMN {};",
                full,
                column_clause(src, src_dialect, tgt, false)
            ));
        }
        "postgres" => {
            let col = q_ident(tgt, &src.name);
            if changes.contains(&"type") {
                out.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} TYPE {};",
                    full, col, src.data_type
                ));
            }
            if changes.contains(&"nullable") {
                out.push(format!(
                    "ALTER TABLE {} ALTER COLUMN {} {} NOT NULL;",
                    full,
                    col,
                    if src.nullable { "DROP" } else { "SET" }
                ));
            }
            if changes.contains(&"default") {
                match src.default.as_deref().filter(|d| !d.trim().is_empty()) {
                    Some(d) => out.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {};",
                        full,
                        col,
                        render_default(src_dialect, tgt, d)
                    )),
                    None => out.push(format!(
                        "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT;",
                        full, col
                    )),
                }
            }
            if changes.contains(&"comment") {
                let cm = src.comment.as_deref().unwrap_or("");
                out.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {};",
                    full,
                    col,
                    if cm.is_empty() { "NULL".to_string() } else { q_lit(cm) }
                ));
            }
        }
        _ => {
            out.push(format!(
                "-- SQLite cannot alter a column: {}.{} ({} -> {}). Recreate the table and copy the data.",
                table, src.name, tgt_col.data_type, src.data_type
            ));
        }
    }
    out
}

// ===================== Lệnh: so sánh cấu trúc =====================

#[tauri::command]
pub async fn compare_schemas(
    state: State<'_, AppState>, conn_id: String,
    source: CompareSide,
    target: CompareSide,
    include_drops: Option<bool>,
) -> Result<Value, String> {
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = compare_schemas_inner(&src, &tgt, include_drops.unwrap_or(false)).await;
    src.close().await;
    tgt.close().await;
    out
}

async fn compare_schemas_inner(
    src: &Resolved,
    tgt: &Resolved,
    include_drops: bool,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let mut warnings: Vec<String> = Vec::new();
    if src.dialect != tgt.dialect {
        warnings.push(format!(
            "Hai phía khác hệ quản trị ({} / {}): kiểu dữ liệu và giá trị mặc định trong SQL đồng bộ có thể phải sửa tay.",
            src.dialect, tgt.dialect
        ));
    }
    if src.label == tgt.label && src.server == tgt.server && src.schema == tgt.schema {
        warnings.push("Hai phía đang trỏ cùng một database.".to_string());
    }

    let mut sql = SqlOut::new(include_drops);
    sql.note(format!(
        "Schema sync: {} ({}) -> {} ({})",
        src.label, src.dialect, tgt.label, tgt.dialect
    ));
    if !include_drops {
        sql.note("Destructive statements are commented out (enable \"generate drop statements\" to run them).");
    }
    if src.dialect != tgt.dialect {
        sql.note("The two sides use different engines: check data types and default values before running.");
    }

    let all_names: BTreeSet<&String> = src_meta.keys().chain(tgt_meta.keys()).collect();
    let mut tables_json: Vec<Value> = Vec::new();
    let (mut only_src, mut only_tgt, mut different, mut identical) = (0, 0, 0, 0);
    let (mut c_only_src, mut c_only_tgt, mut c_diff) = (0, 0, 0);
    let (mut idx_diffs, mut fk_diffs) = (0, 0);

    for name in all_names {
        let s = src_meta.get(name);
        let t = tgt_meta.get(name);

        match (s, t) {
            (Some(s), None) => {
                only_src += 1;
                c_only_src += s.columns.len();
                sql.blank();
                sql.note(format!("Table only in source: {}", name));
                for stmt in create_table_sql(s, &src.dialect, &tgt.dialect, &tgt.schema) {
                    sql.push(stmt);
                }
                tables_json.push(json!({
                    "name": name,
                    "kind": if s.is_view { "view" } else { "table" },
                    "status": "onlySource",
                    "changes": ["exists"],
                    "diffCount": s.columns.len().max(1),
                    "columns": s.columns.iter().map(|c| json!({
                        "name": c.name, "status": "onlySource", "changes": [], "source": col_json(c), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "indexes": s.indexes.iter().map(|i| json!({
                        "name": i.name, "status": "onlySource", "changes": [], "source": idx_json(i), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "foreignKeys": s.fks.iter().map(|f| json!({
                        "name": f.name, "status": "onlySource", "changes": [], "source": fk_json(f), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "primaryKey": { "source": s.pk, "target": Value::Null, "differs": !s.pk.is_empty() },
                    "viewDefinitionDiffers": false,
                }));
            }
            (None, Some(t)) => {
                only_tgt += 1;
                c_only_tgt += t.columns.len();
                sql.blank();
                sql.note(format!("Table only in target: {}", name));
                let full = qualified(&tgt.dialect, &tgt.schema, name);
                sql.destructive(if t.is_view {
                    format!("DROP VIEW {};", full)
                } else {
                    format!("DROP TABLE {};", full)
                });
                tables_json.push(json!({
                    "name": name,
                    "kind": if t.is_view { "view" } else { "table" },
                    "status": "onlyTarget",
                    "changes": ["exists"],
                    "diffCount": t.columns.len().max(1),
                    "columns": t.columns.iter().map(|c| json!({
                        "name": c.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": col_json(c)
                    })).collect::<Vec<_>>(),
                    "indexes": t.indexes.iter().map(|i| json!({
                        "name": i.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": idx_json(i)
                    })).collect::<Vec<_>>(),
                    "foreignKeys": t.fks.iter().map(|f| json!({
                        "name": f.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": fk_json(f)
                    })).collect::<Vec<_>>(),
                    "primaryKey": { "source": Value::Null, "target": t.pk, "differs": !t.pk.is_empty() },
                    "viewDefinitionDiffers": false,
                }));
            }
            (Some(s), Some(t)) => {
                if s.is_view || t.is_view {
                    let is_kind_mismatch = s.is_view != t.is_view;
                    let view_differs = !is_kind_mismatch && view_def_differs(s.view_def.as_ref(), t.view_def.as_ref(), &src.schema, &tgt.schema, name);
                    let status = if is_kind_mismatch || view_differs { "different" } else { "identical" };

                    let mut changes: Vec<String> = Vec::new();
                    if is_kind_mismatch {
                        changes.push("kind".to_string());
                    }
                    if view_differs {
                        changes.push("viewDefinition".to_string());
                    }

                    if status == "identical" {
                        identical += 1;
                    } else {
                        different += 1;
                        sql.blank();
                        sql.note(format!("View differs: {}", name));
                        if is_kind_mismatch {
                            sql.note(format!(
                                "{} is a {} in source but a {} in target - handle manually.",
                                name,
                                if s.is_view { "view" } else { "table" },
                                if t.is_view { "view" } else { "table" }
                            ));
                        } else if view_differs {
                            let def = s.view_def.clone().unwrap_or_default();
                            let body = def.trim().trim_end_matches(';').to_string();
                            if body.is_empty() {
                                sql.note(format!("Could not read the definition of view {}", name));
                            } else if tgt.dialect == "sqlite" {
                                sql.paired(
                                    format!("DROP VIEW {};", qualified(&tgt.dialect, &tgt.schema, name)),
                                    if body.to_ascii_uppercase().starts_with("CREATE ") {
                                        format!("{};", body)
                                    } else {
                                        format!(
                                            "CREATE VIEW {} AS {};",
                                            qualified(&tgt.dialect, &tgt.schema, name),
                                            body
                                        )
                                    },
                                );
                            } else {
                                sql.push(format!(
                                    "CREATE OR REPLACE VIEW {} AS {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    body
                                ));
                            }
                        }
                    }

                    tables_json.push(json!({
                        "name": name,
                        "kind": if s.is_view { "view" } else { "table" },
                        "status": status,
                        "changes": changes,
                        "diffCount": if status == "identical" { 0 } else { 1 },
                        "columns": Vec::<Value>::new(),
                        "indexes": Vec::<Value>::new(),
                        "foreignKeys": Vec::<Value>::new(),
                        "primaryKey": { "source": s.pk, "target": t.pk, "differs": false },
                        "viewDefinitionDiffers": view_differs,
                    }));
                } else {
                    let mut table_sql: Vec<String> = Vec::new();
                    let mut destructive_sql: Vec<String> = Vec::new();
                    let mut paired_sql: Vec<(String, String)> = Vec::new();
                    let mut changes: Vec<&str> = Vec::new();
                    let mut diff_count = 0usize;

                    // ---- Cột ----
                    let mut cols_json: Vec<Value> = Vec::new();
                    let col_names: Vec<String> = s
                        .columns
                        .iter()
                        .map(|c| c.name.clone())
                        .chain(t.columns.iter().filter(|c| s.column(&c.name).is_none()).map(|c| c.name.clone()))
                        .collect();
                    for cn in &col_names {
                        match (s.column(cn), t.column(cn)) {
                            (Some(sc), None) => {
                                c_only_src += 1;
                                diff_count += 1;
                                cols_json.push(json!({
                                    "name": cn, "status": "onlySource", "changes": [],
                                    "source": col_json(sc), "target": Value::Null
                                }));
                                table_sql.push(format!(
                                    "ALTER TABLE {} ADD COLUMN {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    column_clause(sc, &src.dialect, &tgt.dialect, false)
                                ));
                            }
                            (None, Some(tc)) => {
                                c_only_tgt += 1;
                                diff_count += 1;
                                cols_json.push(json!({
                                    "name": cn, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": col_json(tc)
                                }));
                                destructive_sql.push(format!(
                                    "ALTER TABLE {} DROP COLUMN {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    q_ident(&tgt.dialect, cn)
                                ));
                            }
                            (Some(sc), Some(tc)) => {
                                let ch = column_changes(sc, tc);
                                if ch.is_empty() {
                                    cols_json.push(json!({
                                        "name": cn, "status": "identical", "changes": [],
                                        "source": col_json(sc), "target": col_json(tc)
                                    }));
                                } else {
                                    c_diff += 1;
                                    diff_count += 1;
                                    cols_json.push(json!({
                                        "name": cn, "status": "different", "changes": ch.clone(),
                                        "source": col_json(sc), "target": col_json(tc)
                                    }));
                                    if ch.iter().any(|c| *c != "position") {
                                        table_sql.extend(alter_column_stmts(
                                            name, sc, tc, &ch, &src.dialect, &tgt.dialect, &tgt.schema,
                                        ));
                                    }
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if cols_json.iter().any(|c| c.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("columns");
                    }

                    // ---- Index ----
                    let mut idx_json_list: Vec<Value> = Vec::new();
                    let idx_names: Vec<String> = s
                        .indexes
                        .iter()
                        .map(|i| i.name.clone())
                        .chain(
                            t.indexes
                                .iter()
                                .filter(|i| !s.indexes.iter().any(|x| x.name == i.name))
                                .map(|i| i.name.clone()),
                        )
                        .collect();
                    for iname in &idx_names {
                        let si = s.indexes.iter().find(|i| &i.name == iname);
                        let ti = t.indexes.iter().find(|i| &i.name == iname);
                        match (si, ti) {
                            (Some(si), None) => {
                                idx_diffs += 1;
                                diff_count += 1;
                                idx_json_list.push(json!({
                                    "name": iname, "status": "onlySource", "changes": [],
                                    "source": idx_json(si), "target": Value::Null
                                }));
                                table_sql.push(create_index_sql(si, name, &tgt.dialect, &tgt.schema));
                            }
                            (None, Some(ti)) => {
                                idx_diffs += 1;
                                diff_count += 1;
                                idx_json_list.push(json!({
                                    "name": iname, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": idx_json(ti)
                                }));
                                destructive_sql.push(drop_index_sql(ti, name, &tgt.dialect, &tgt.schema));
                            }
                            (Some(si), Some(ti)) => {
                                let ch = index_changes(si, ti);
                                if ch.is_empty() {
                                    idx_json_list.push(json!({
                                        "name": iname, "status": "identical", "changes": [],
                                        "source": idx_json(si), "target": idx_json(ti)
                                    }));
                                } else {
                                    idx_diffs += 1;
                                    diff_count += 1;
                                    idx_json_list.push(json!({
                                        "name": iname, "status": "different", "changes": ch,
                                        "source": idx_json(si), "target": idx_json(ti)
                                    }));
                                    paired_sql.push((
                                        drop_index_sql(ti, name, &tgt.dialect, &tgt.schema),
                                        create_index_sql(si, name, &tgt.dialect, &tgt.schema),
                                    ));
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if idx_json_list.iter().any(|i| i.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("indexes");
                    }

                    // ---- Khóa ngoại ----
                    let mut fk_json_list: Vec<Value> = Vec::new();
                    let fk_names: Vec<String> = s
                        .fks
                        .iter()
                        .map(|f| f.name.clone())
                        .chain(
                            t.fks
                                .iter()
                                .filter(|f| !s.fks.iter().any(|x| x.name == f.name))
                                .map(|f| f.name.clone()),
                        )
                        .collect();
                    for fname in &fk_names {
                        let sf = s.fks.iter().find(|f| &f.name == fname);
                        let tf = t.fks.iter().find(|f| &f.name == fname);
                        match (sf, tf) {
                            (Some(sf), None) => {
                                fk_diffs += 1;
                                diff_count += 1;
                                fk_json_list.push(json!({
                                    "name": fname, "status": "onlySource", "changes": [],
                                    "source": fk_json(sf), "target": Value::Null
                                }));
                                table_sql.push(fk_stmt_or_note(
                                    &tgt.dialect,
                                    name,
                                    fname,
                                    add_fk_sql(sf, name, &tgt.dialect, &tgt.schema),
                                ));
                            }
                            (None, Some(tf)) => {
                                fk_diffs += 1;
                                diff_count += 1;
                                fk_json_list.push(json!({
                                    "name": fname, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": fk_json(tf)
                                }));
                                if tgt.dialect == "sqlite" {
                                    table_sql.push(fk_stmt_or_note(&tgt.dialect, name, fname, String::new()));
                                } else {
                                    destructive_sql.push(drop_fk_sql(tf, name, &tgt.dialect, &tgt.schema));
                                }
                            }
                            (Some(sf), Some(tf)) => {
                                let ch = fk_changes(sf, tf);
                                if ch.is_empty() {
                                    fk_json_list.push(json!({
                                        "name": fname, "status": "identical", "changes": [],
                                        "source": fk_json(sf), "target": fk_json(tf)
                                    }));
                                } else {
                                    fk_diffs += 1;
                                    diff_count += 1;
                                    fk_json_list.push(json!({
                                        "name": fname, "status": "different", "changes": ch,
                                        "source": fk_json(sf), "target": fk_json(tf)
                                    }));
                                    if tgt.dialect == "sqlite" {
                                        table_sql.push(fk_stmt_or_note(&tgt.dialect, name, fname, String::new()));
                                    } else {
                                        paired_sql.push((
                                            drop_fk_sql(tf, name, &tgt.dialect, &tgt.schema),
                                            add_fk_sql(sf, name, &tgt.dialect, &tgt.schema),
                                        ));
                                    }
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if fk_json_list.iter().any(|f| f.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("foreignKeys");
                    }

                    // ---- Khóa chính ----
                    let pk_differs = s.pk != t.pk;
                    if pk_differs {
                        diff_count += 1;
                        changes.push("primaryKey");
                    }

                    let status = if diff_count == 0 { "identical" } else { "different" };

                    if status == "identical" {
                        identical += 1;
                    } else {
                        different += 1;

                        sql.blank();
                        sql.note(format!("Table differs: {}", name));
                        if pk_differs {
                            sql.note(format!(
                                "Primary key differs ({}: [{}] / [{}]) - no statement generated, changing a PK needs a data review.",
                                name,
                                s.pk.join(", "),
                                t.pk.join(", ")
                            ));
                        }
                        for stmt in table_sql {
                            sql.push(stmt);
                        }
                        for stmt in destructive_sql {
                            sql.destructive(stmt);
                        }
                        for (d, c) in paired_sql {
                            sql.paired(d, c);
                        }
                    }

                    tables_json.push(json!({
                        "name": name,
                        "kind": "table",
                        "status": status,
                        "changes": if status == "identical" { Vec::<String>::new() } else { changes.iter().map(|s| s.to_string()).collect() },
                        "diffCount": if status == "identical" { 0 } else { diff_count },
                        "columns": if status == "identical" { Vec::new() } else { cols_json },
                        "indexes": if status == "identical" { Vec::new() } else { idx_json_list },
                        "foreignKeys": if status == "identical" { Vec::new() } else { fk_json_list },
                        "primaryKey": { "source": s.pk, "target": t.pk, "differs": pk_differs },
                        "viewDefinitionDiffers": false,
                    }));
                }
            }
            (None, None) => {}
        }
    }

    let identical_all = only_src == 0 && only_tgt == 0 && different == 0;
    if identical_all {
        sql.blank();
        sql.note("Both sides have the same structure.");
    }

    Ok(json!({
        "success": true,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "identical": identical_all,
        "summary": {
            "tablesOnlySource": only_src,
            "tablesOnlyTarget": only_tgt,
            "tablesDifferent": different,
            "tablesIdentical": identical,
            "columnsOnlySource": c_only_src,
            "columnsOnlyTarget": c_only_tgt,
            "columnsDifferent": c_diff,
            "indexDiffs": idx_diffs,
            "foreignKeyDiffs": fk_diffs,
        },
        "tables": tables_json,
        "syncSql": sql.lines,
        "includeDrops": include_drops,
        "warnings": warnings,
    }))
}

// ===================== Lệnh: tổng quan dữ liệu (đếm dòng) =====================

#[tauri::command]
pub async fn compare_data_overview(
    state: State<'_, AppState>, conn_id: String,
    source: CompareSide,
    target: CompareSide,
    tables: Option<Vec<String>>,
) -> Result<Value, String> {
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = data_overview_inner(&src, &tgt, tables).await;
    src.close().await;
    tgt.close().await;
    out
}

async fn count_rows(r: &Resolved, table: &str) -> Result<i64, String> {
    let sql = format!(
        "SELECT COUNT(*) AS n FROM {}",
        qualified(&r.dialect, &r.schema, table)
    );
    let rows = query_rows(&r.conn, sql).await?;
    let v = rows.first().and_then(|row| row.get("n")).cloned().unwrap_or(Value::Null);
    Ok(match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    })
}

async fn data_overview_inner(
    src: &Resolved,
    tgt: &Resolved,
    only: Option<Vec<String>>,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let filter: Option<BTreeSet<String>> = only.map(|v| v.into_iter().collect());
    let names: BTreeSet<&String> = src_meta.keys().chain(tgt_meta.keys()).collect();

    let mut out: Vec<Value> = Vec::new();
    let mut diff_tables = 0usize;

    for name in names {
        if let Some(f) = &filter {
            if !f.contains(name) {
                continue;
            }
        }
        let s = src_meta.get(name);
        let t = tgt_meta.get(name);
        // View không so dữ liệu (không có khóa, và đọc lại phụ thuộc bảng gốc).
        if s.map(|m| m.is_view).unwrap_or(false) || t.map(|m| m.is_view).unwrap_or(false) {
            continue;
        }

        let (mut s_rows, mut t_rows): (Option<i64>, Option<i64>) = (None, None);
        let mut error: Option<String> = None;
        if s.is_some() {
            match count_rows(src, name).await {
                Ok(n) => s_rows = Some(n),
                Err(e) => error = Some(e),
            }
        }
        if t.is_some() {
            match count_rows(tgt, name).await {
                Ok(n) => t_rows = Some(n),
                Err(e) => error = error.or(Some(e)),
            }
        }

        let status = match (s, t) {
            (Some(_), None) => "onlySource",
            (None, Some(_)) => "onlyTarget",
            _ => {
                if s_rows == t_rows {
                    "sameCount"
                } else {
                    "differentCount"
                }
            }
        };
        if status != "sameCount" {
            diff_tables += 1;
        }

        // Khóa gợi ý cho so dữ liệu: PK phải có ở CẢ HAI bên mới dùng được.
        let pk: Vec<String> = match (s, t) {
            (Some(s), Some(t)) if !s.pk.is_empty() && s.pk == t.pk => s.pk.clone(),
            (Some(s), None) => s.pk.clone(),
            (None, Some(t)) => t.pk.clone(),
            _ => Vec::new(),
        };
        let comparable = s.is_some() && t.is_some() && !pk.is_empty();

        out.push(json!({
            "name": name,
            "status": status,
            "sourceRows": s_rows,
            "targetRows": t_rows,
            "primaryKey": pk,
            "comparable": comparable,
            "error": error,
        }));
    }

    Ok(json!({
        "success": true,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "tables": out,
        "tablesWithDifference": diff_tables,
    }))
}

// ===================== Lệnh: so dữ liệu một bảng =====================

/// Chuỗi khóa của một dòng. Dùng để ghép dòng hai bên, nên phải chuẩn hóa giống
/// `values_equal` (số 1 và chuỗi "1" từ hai driver khác nhau là CÙNG một khóa).
fn key_of(row: &Value, keys: &[String]) -> String {
    keys.iter()
        .map(|k| norm_scalar(row.get(k).unwrap_or(&Value::Null)))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// Dạng chuẩn của một ô để so sánh/ghép khóa.
fn norm_scalar(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}null".to_string(),
        Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        Value::Number(n) => norm_number(&n.to_string()),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Bỏ số 0 vô nghĩa ở cuối phần thập phân: `1.50` và `1.5` là một giá trị.
fn norm_number(s: &str) -> String {
    let t = s.trim();
    if !t.contains('.') {
        return t.to_string();
    }
    let t = t.trim_end_matches('0');
    let t = t.trim_end_matches('.');
    // "-0.0" và "0" là cùng một giá trị, đừng báo khác nhau.
    if t.is_empty() || t == "-" || t == "-0" {
        "0".to_string()
    } else {
        t.to_string()
    }
}

fn looks_numeric(s: &str) -> bool {
    !s.trim().is_empty() && s.trim().parse::<f64>().is_ok()
}

/// Hai ô có coi là bằng nhau.
///
/// Chỉ nới lỏng ĐÚNG trường hợp cần thiết: một bên là số, bên kia là chuỗi số —
/// DECIMAL/NUMERIC được sqlx trả về dạng chuỗi nên MySQL và Postgres cho ra hai kiểu
/// JSON khác nhau cho cùng một giá trị. Hai chuỗi thì so chính xác, để không bỏ sót
/// khác biệt thật.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (Value::Number(_), Value::String(s)) | (Value::String(s), Value::Number(_)) => {
            let num = if matches!(a, Value::Number(_)) { a } else { b };
            looks_numeric(s) && norm_number(s) == norm_scalar(num)
        }
        (Value::Bool(x), Value::Number(n)) | (Value::Number(n), Value::Bool(x)) => {
            n.as_f64().map(|f| (f != 0.0) == *x).unwrap_or(false)
        }
        _ => a == b,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn compare_table_data(
    state: State<'_, AppState>, conn_id: String,
    source: CompareSide,
    target: CompareSide,
    table: String,
    key_columns: Option<Vec<String>>,
    limit: Option<usize>,
    max_diff_rows: Option<usize>,
    include_drops: Option<bool>,
) -> Result<Value, String> {
    if table.trim().is_empty() {
        return Err("Thiếu tên bảng".to_string());
    }
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = compare_table_data_inner(
        &src,
        &tgt,
        &table,
        key_columns,
        limit.unwrap_or(DEFAULT_DATA_LIMIT).max(1),
        max_diff_rows.unwrap_or(DEFAULT_MAX_DIFF_ROWS).max(1),
        include_drops.unwrap_or(false),
    )
    .await;
    src.close().await;
    tgt.close().await;
    out
}

async fn fetch_rows(
    r: &Resolved,
    table: &str,
    columns: &[String],
    keys: &[String],
    limit: usize,
) -> Result<Vec<Value>, String> {
    let cols: Vec<String> = columns.iter().map(|c| q_ident(&r.dialect, c)).collect();
    let order: Vec<String> = keys.iter().map(|c| q_ident(&r.dialect, c)).collect();
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {} LIMIT {}",
        cols.join(", "),
        qualified(&r.dialect, &r.schema, table),
        order.join(", "),
        limit + 1
    );
    query_rows(&r.conn, sql).await
}

async fn compare_table_data_inner(
    src: &Resolved,
    tgt: &Resolved,
    table: &str,
    key_columns: Option<Vec<String>>,
    limit: usize,
    max_diff_rows: usize,
    include_drops: bool,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let s_tbl = src_meta
        .get(table)
        .ok_or_else(|| format!("Bảng '{}' không có ở nguồn", table))?;
    let t_tbl = tgt_meta
        .get(table)
        .ok_or_else(|| format!("Bảng '{}' không có ở đích", table))?;

    // Chỉ so những cột có ở CẢ HAI bên; phần lệch cấu trúc báo riêng để UI nhắc người dùng.
    let common: Vec<String> = s_tbl
        .columns
        .iter()
        .filter(|c| t_tbl.column(&c.name).is_some())
        .map(|c| c.name.clone())
        .collect();
    if common.is_empty() {
        return Err(format!("Bảng '{}' không có cột nào chung giữa hai bên", table));
    }
    let only_src_cols: Vec<String> = s_tbl
        .columns
        .iter()
        .filter(|c| t_tbl.column(&c.name).is_none())
        .map(|c| c.name.clone())
        .collect();
    let only_tgt_cols: Vec<String> = t_tbl
        .columns
        .iter()
        .filter(|c| s_tbl.column(&c.name).is_none())
        .map(|c| c.name.clone())
        .collect();

    // Khóa: người dùng chọn, hoặc PK của nguồn. Không có khóa thì không ghép được dòng.
    let keys: Vec<String> = match key_columns.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => s_tbl.pk.clone(),
    };
    if keys.is_empty() {
        return Err(format!(
            "Bảng '{}' không có khóa chính — hãy chọn cột khóa để so dữ liệu",
            table
        ));
    }
    for k in &keys {
        if !common.contains(k) {
            return Err(format!("Cột khóa '{}' không có ở cả hai bên", k));
        }
    }

    let s_rows = fetch_rows(src, table, &common, &keys, limit).await?;
    let t_rows = fetch_rows(tgt, table, &common, &keys, limit).await?;
    let truncated = s_rows.len() > limit || t_rows.len() > limit;
    let s_rows = &s_rows[..s_rows.len().min(limit)];
    let t_rows = &t_rows[..t_rows.len().min(limit)];

    let mut t_index: HashMap<String, &Value> = HashMap::with_capacity(t_rows.len());
    let mut dup_target = 0usize;
    for row in t_rows.iter() {
        if t_index.insert(key_of(row, &keys), row).is_some() {
            dup_target += 1;
        }
    }

    let mut rows_json: Vec<Value> = Vec::new();
    let (mut n_only_src, mut n_only_tgt, mut n_diff, mut n_same) = (0usize, 0usize, 0usize, 0usize);
    let mut matched: BTreeSet<String> = BTreeSet::new();

    let mut sql = SqlOut::new(include_drops);
    sql.note(format!(
        "Data sync for table {}: {} -> {}",
        table, src.label, tgt.label
    ));
    sql.note(format!("Key columns: {}", keys.join(", ")));
    if !include_drops {
        sql.note("DELETE statements are commented out (enable \"generate drop statements\" to run them).");
    }
    sql.blank();

    for s_row in s_rows.iter() {
        let k = key_of(s_row, &keys);
        matched.insert(k.clone());
        match t_index.get(&k) {
            None => {
                n_only_src += 1;
                if rows_json.len() < max_diff_rows {
                    rows_json.push(json!({
                        "status": "onlySource",
                        "key": key_values(s_row, &keys),
                        "source": s_row,
                        "target": Value::Null,
                        "changedColumns": [],
                    }));
                }
                sql.push(insert_sql(tgt, table, s_row, &common));
            }
            Some(t_row) => {
                let changed: Vec<String> = common
                    .iter()
                    .filter(|c| {
                        !values_equal(
                            s_row.get(c.as_str()).unwrap_or(&Value::Null),
                            t_row.get(c.as_str()).unwrap_or(&Value::Null),
                        )
                    })
                    .cloned()
                    .collect();
                if changed.is_empty() {
                    n_same += 1;
                } else {
                    n_diff += 1;
                    if rows_json.len() < max_diff_rows {
                        rows_json.push(json!({
                            "status": "different",
                            "key": key_values(s_row, &keys),
                            "source": s_row,
                            "target": *t_row,
                            "changedColumns": changed,
                        }));
                    }
                    sql.push(update_sql(tgt, table, s_row, &changed, &keys));
                }
            }
        }
    }

    for t_row in t_rows.iter() {
        let k = key_of(t_row, &keys);
        if matched.contains(&k) {
            continue;
        }
        n_only_tgt += 1;
        if rows_json.len() < max_diff_rows {
            rows_json.push(json!({
                "status": "onlyTarget",
                "key": key_values(t_row, &keys),
                "source": Value::Null,
                "target": t_row,
                "changedColumns": [],
            }));
        }
        sql.destructive(delete_sql(tgt, table, t_row, &keys));
    }

    let identical = n_only_src == 0 && n_only_tgt == 0 && n_diff == 0;
    if identical {
        sql.note("Both sides hold the same data (within the compared range).");
    }

    let mut warnings: Vec<String> = Vec::new();
    if truncated {
        warnings.push(format!(
            "Chỉ so {} dòng đầu (theo thứ tự khóa) của mỗi bên.",
            limit
        ));
    }
    if dup_target > 0 {
        warnings.push(format!(
            "Đích có {} dòng trùng khóa — chỉ dòng cuối được đem so.",
            dup_target
        ));
    }
    if !only_src_cols.is_empty() || !only_tgt_cols.is_empty() {
        warnings.push("Hai bên lệch cột: chỉ so những cột có ở cả hai bên.".to_string());
    }

    Ok(json!({
        "success": true,
        "table": table,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "keyColumns": keys,
        "columns": common,
        "columnsOnlySource": only_src_cols,
        "columnsOnlyTarget": only_tgt_cols,
        "identical": identical,
        "summary": {
            "onlySource": n_only_src,
            "onlyTarget": n_only_tgt,
            "different": n_diff,
            "identical": n_same,
            "sourceRows": s_rows.len(),
            "targetRows": t_rows.len(),
        },
        "rows": rows_json,
        "rowsTruncated": n_only_src + n_only_tgt + n_diff > rows_json.len(),
        "truncated": truncated,
        "syncSql": sql.lines,
        "includeDrops": include_drops,
        "warnings": warnings,
    }))
}

fn key_values(row: &Value, keys: &[String]) -> Value {
    Value::Array(
        keys.iter()
            .map(|k| row.get(k).cloned().unwrap_or(Value::Null))
            .collect(),
    )
}

/// Literal SQL của một ô. Không tham số hóa được vì đây là script để người dùng đọc
/// và chạy ở nơi khác — escaping theo đúng cách `database.rs` vẫn làm.
fn sql_value(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => q_lit(s),
        // BLOB được trả về dạng mảng byte -> hex literal (X'..' dùng được ở cả 3 dialect).
        Value::Array(a) => {
            let bytes: Option<Vec<u8>> = a
                .iter()
                .map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect();
            match bytes {
                Some(b) => format!(
                    "X'{}'",
                    b.iter().map(|x| format!("{:02X}", x)).collect::<String>()
                ),
                None => q_lit(&v.to_string()),
            }
        }
        other => q_lit(&other.to_string()),
    }
}

fn insert_sql(tgt: &Resolved, table: &str, row: &Value, columns: &[String]) -> String {
    let cols: Vec<String> = columns.iter().map(|c| q_ident(&tgt.dialect, c)).collect();
    let vals: Vec<String> = columns
        .iter()
        .map(|c| sql_value(row.get(c.as_str()).unwrap_or(&Value::Null)))
        .collect();
    format!(
        "INSERT INTO {} ({}) VALUES ({});",
        qualified(&tgt.dialect, &tgt.schema, table),
        cols.join(", "),
        vals.join(", ")
    )
}

fn where_key(tgt: &Resolved, row: &Value, keys: &[String]) -> String {
    keys.iter()
        .map(|k| {
            let v = row.get(k.as_str()).unwrap_or(&Value::Null);
            if v.is_null() {
                format!("{} IS NULL", q_ident(&tgt.dialect, k))
            } else {
                format!("{} = {}", q_ident(&tgt.dialect, k), sql_value(v))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn update_sql(tgt: &Resolved, table: &str, row: &Value, changed: &[String], keys: &[String]) -> String {
    let sets: Vec<String> = changed
        .iter()
        .map(|c| {
            format!(
                "{} = {}",
                q_ident(&tgt.dialect, c),
                sql_value(row.get(c.as_str()).unwrap_or(&Value::Null))
            )
        })
        .collect();
    format!(
        "UPDATE {} SET {} WHERE {};",
        qualified(&tgt.dialect, &tgt.schema, table),
        sets.join(", "),
        where_key(tgt, row, keys)
    )
}

fn delete_sql(tgt: &Resolved, table: &str, row: &Value, keys: &[String]) -> String {
    format!(
        "DELETE FROM {} WHERE {};",
        qualified(&tgt.dialect, &tgt.schema, table),
        where_key(tgt, row, keys)
    )
}
