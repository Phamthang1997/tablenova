//! Mọi `#[tauri::command]` liên quan tới SQL.
//!
//! TẠM THỜI vẫn là một tệp lớn: đợt 3 chỉ kéo TẦNG NỀN ra khỏi `database.rs`.
//! Đợt 4 cắt tệp này thành `commands/` theo nhóm — xem docs/backend-module-split-plan.md §3.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection as SqliteConnection;
use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool, Row};
use tauri::ipc::Channel;

use crate::ssh_tunnel::SshTunnel;

use super::conn::{DbConnection, DbKind, Exec};
use super::dsn::{apply_ssh_tunnel, build_mysql_url, build_pg_url};
use super::exec::bound::run_bound_query;
use super::exec::raw::execute_raw_sql_generic;
use super::exec::stream::stream_sql_statements;
use super::iam::{apply_iam_password, is_iam, spawn_iam_refresh};
use super::ident::{fk_checks_sql, pg_schema_of, qualified, quote_ident, sql_literal, sql_str};
use super::read_only::reject_conn_read_only;
use super::rows::{
    all_string_values, cell, first_i64, result_rows, row_i64, row_str, rows_of, uniquify_columns,
};
use super::splitter::{split_sql_statements, strip_leading_comments};
use super::timeout::{stmt_timeout, timeout_msg, with_timeout};

// Timeout cho lệnh liệt kê database (nút "Tải danh sách" ở form kết nối).
// Mặc định của sqlx là 30s — quá lâu cho một thao tác dò thông tin, người dùng
// tưởng app treo. 10s đủ cho cả máy chủ ở xa mà vẫn báo lỗi sớm.
const LIST_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The schema a fresh Postgres connection lands in — i.e. the first existing entry of its
/// `search_path`. This is what the plan's §4.1 calls the default for the Sidebar picker, and it
/// costs no extra UI. Returns `None` for MySQL/SQLite, and on any failure: a probe that cannot
/// run must not stop the connection from opening, it just leaves the `public` default in place.
async fn probe_pg_schema(conn: &DbConnection) -> Option<String> {
    if !matches!(conn.kind, DbKind::Postgres(_)) {
        return None;
    }
    let res = execute_raw_sql_generic(conn, "SELECT current_schema() AS s".to_string()).await.ok()?;
    let rows = rows_of(&res);
    // `cell` yields "" for a NULL, which is what current_schema() returns when no entry of
    // search_path exists — same handling either way.
    let name = cell(rows.first()?, "s").trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Refuse writes on one connection, or allow them again.
///
/// Per connection, because the point is holding production open next to dev: one rail cell refuses,
/// the one beside it does not. Enforced in the SQL funnels (`reject_if_read_only`), so it holds for
/// statements the user types as well as for everything the UI issues.
#[tauri::command]
pub async fn set_connection_read_only(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    enabled: bool,
) -> Result<Value, String> {
    state.connections.set_read_only(&conn_id, enabled)?;
    Ok(json!({ "success": true, "readOnly": enabled }))
}

/// Every connection currently open, for the left rail (§4.2c).
///
/// Deliberately takes no `conn_id`: it is a question about the whole app, not about one connection —
/// the same exception `tx_any_pending` is.
#[tauri::command]
pub async fn list_connections(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    Ok(json!({ "connections": state.connections.list()? }))
}

#[tauri::command]
pub async fn connect_db(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, config: Value) -> Result<Value, String> {
    let db_type = config.get("dbType").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Opening the same SQLite file twice would be two `rusqlite::Connection`s on one file, i.e.
    // `SQLITE_BUSY` as soon as both write. Hand back the connection that is already open instead.
    // Postgres/MySQL are deliberately not deduplicated — see `ConnRegistry::find_sqlite`.
    if db_type == "sqlite" {
        if let Some(path) = config.get("filePath").and_then(|v| v.as_str()) {
            if let Some(existing) = state.connections.find_sqlite(path)? {
                let ctx = state.connections.acquire(&existing)?;
                return Ok(json!({
                    "success": true,
                    "schema": ctx.raw_schema(),
                    "connId": &*existing,
                }));
            }
        }
    }

    let mut ssh_tunnel: Option<SshTunnel> = None;

    // Minted before the pool is built so the handle can carry its own id from the moment it exists —
    // there is never a window where a `DbConnection` is alive without knowing which connection it is.
    let conn_id = crate::state::mint_id();

    let kind = match db_type.as_str() {
        "sqlite" => {
            let path = config.get("filePath").and_then(|v| v.as_str()).ok_or("Thiếu đường dẫn tệp SQLite")?;
            let conn = SqliteConnection::open(path).map_err(|e| e.to_string())?;
            DbKind::Sqlite(Arc::new(Mutex::new(conn)))
        }
        "postgres" => {
            let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 5432).await?;
            ssh_tunnel = tunnel;
            apply_iam_password(&config, &mut conn_config, 5432)?;
            let url = build_pg_url(&conn_config, None);
            let pool = PgPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbKind::Postgres(pool)
        }
        "mysql" => {
            let (mut conn_config, tunnel) = apply_ssh_tunnel(&config, 3306).await?;
            ssh_tunnel = tunnel;
            apply_iam_password(&config, &mut conn_config, 3306)?;
            let url = build_mysql_url(&conn_config, None);
            let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
            DbKind::Mysql(pool)
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    };
    let conn = DbConnection::session(conn_id.clone(), kind);

    // Probed before the registry is locked: this awaits, and no guard may be held across it.
    let schema = probe_pg_schema(&conn).await;

    // `connect_db` là "phiên server mới": mint cả server id lẫn conn_id, và thay trọn registry vì
    // Phase 1 giữ tối đa một kết nối. Việc dùng LẠI một `Arc<ServerHandle>` đã có là của
    // `open_database` ở Phase 3, không phải của lệnh này.
    {
        // Tên database của kết nối; SQLite thì là đường dẫn tệp.
        let db_name = if db_type == "sqlite" {
            config.get("filePath").and_then(|v| v.as_str()).unwrap_or("").to_string()
        } else {
            config.get("database").and_then(|v| v.as_str()).unwrap_or("").to_string()
        };
        let server = std::sync::Arc::new(crate::state::ServerHandle::new(
            crate::state::mint_id(),
            db_type.clone(),
            config.clone(),
            // `ServerHandle` SỞ HỮU tunnel. `SshTunnel` không `Clone` và `Drop` của nó đóng port,
            // nên đúng một bên được giữ — và đây là bên đúng: `ConnEntry` cuối cùng của server bị
            // drop thì `Arc` cuối cùng đi theo và port tự đóng, không cần refcount tay.
            ssh_tunnel.take(),
        ));
        // Nothing is dropped here any more: connecting ADDS a connection, it no longer replaces the
        // one before it. That is the whole of Phase 2 in one line — and it is also why nothing
        // resets a transaction session here. Each connection owns its own session now, so an open
        // transaction on connection A is none of connection B's business; A's session ends when A
        // is disconnected (`disconnect_db`).
        state.connections.insert(
            conn_id.clone(),
            crate::state::ConnEntry {
                // A new connection starts writable; the UI turns this on for a production label.
                read_only: false,
                server,
                db: db_name,
                conn: crate::state::LiveConn::Sql(conn),
                current_schema: schema.clone(),
            },
        )?;
    }

    // Kết nối IAM: chạy task làm mới token định kỳ (token chỉ sống 15 phút)
    if is_iam(&config) && (db_type == "postgres" || db_type == "mysql") {
        spawn_iam_refresh(app, db_type, config, conn_id.clone());
    }

    // The frontend keys its per-connection localStorage on the effective schema, so it has to
    // learn it from here rather than from its own picker state — on the first connect the user
    // has not touched the picker yet. See the plan §5.0.
    //
    // `connId` is additive and unused by the frontend for now: ids are minted here and handed out,
    // never derived from the config (multi-connection-plan §4.3). Phase 1d is what starts sending it
    // back down as a command argument.
    Ok(json!({ "success": true, "schema": schema, "connId": &*conn_id }))
}

#[tauri::command]
pub async fn disconnect_db(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<Value, String> {

    // Take the entry out first, then roll back its manual transaction while its pool is still alive:
    // dropping a pool with a transaction open leaves the server holding its locks until it notices
    // the socket died. Dropping `entry` afterwards releases the last `Arc<ServerHandle>` of that
    // server, and because `ServerHandle` owns the `SshTunnel`, its `Drop` closes the forwarded port —
    // no manual tunnel teardown.
    //
    // An unknown id is not an error: disconnecting something already gone is the state the caller
    // wanted. `reset(None)` still runs so the state machine itself is cleared.
    let entry = state.connections.remove(&conn_id)?;
    crate::tx_session::reset(entry.as_ref().and_then(|e| e.conn.sql())).await;
    drop(entry);
    Ok(json!({ "success": true }))
}

// Lấy toàn bộ catalog (bảng + cột/kiểu/PK + FK) trong ÍT truy vấn để smart-completion nạp 1 lần
// thay vì gọi get_table_schema từng bảng. Chỉ MySQL/Postgres (dùng information_schema);
// SQLite trả về rỗng -> frontend fallback lazy per-table.
#[tauri::command]
pub async fn get_full_catalog(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, db_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.dialect().to_string(), ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

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
        let col_sql = format!(
            "SELECT cl.relname::text AS t, a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS ty \
             FROM pg_attribute a \
             JOIN pg_class cl ON cl.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = cl.relnamespace \
             WHERE n.nspname = '{sch}' AND cl.relkind IN ('r','v','m','p','f') \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY cl.relname, a.attnum");
        for row in rows_of(&execute_raw_sql_generic(&conn_type, col_sql).await?) {
            let t = cell(&row, "t").to_string();
            let entry = columns_map.entry(t).or_insert_with(|| Value::Array(vec![]));
            if let Some(arr) = entry.as_array_mut() {
                arr.push(json!({ "name": cell(&row, "c"), "type": cell(&row, "ty"), "isPrimaryKey": false }));
            }
        }
        // PK: đánh dấu isPrimaryKey
        let pk_sql = format!("SELECT tc.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '{sch}'");
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
        let fk_sql = format!("SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{sch}'");
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
pub async fn get_tables(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let mut tables = Vec::new();

    match conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
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
        DbKind::Postgres(pool) => {
            // information_schema.tables has no materialized view in it (it is not in the SQL
            // standard), so a matview used to be invisible everywhere in the app — sidebar,
            // export, compare. pg_class.relkind = 'm' is the only place it shows up.
            let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '{sch}' \
                 UNION ALL \
                 SELECT c.relname, 'VIEW' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relkind = 'm'")))
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
        DbKind::Mysql(pool) => {
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

/// Below this, an exact `COUNT(*)` is cheap enough that the estimate is not worth its inaccuracy.
///
/// The threshold is compared against the *estimate*, which is the only number available before
/// deciding — so a table the planner thinks is small always gets counted for real, and a table it
/// thinks is huge is never scanned just to fill in a status line.
const APPROX_COUNT_MIN: i64 = 500_000;

/// Exact `COUNT(*)`. `None` means "could not be counted", which is **not** the same as zero — the
/// grid has to be able to say "unknown" instead of claiming an empty table.
async fn exact_row_count(conn: &DbConnection, count_sql: &str) -> Option<i64> {
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => {
            let c = conn_arc.lock().ok()?;
            c.query_row(count_sql, [], |r| r.get::<_, i64>(0)).ok()
        }
        _ => first_i64(execute_raw_sql_generic(conn, count_sql.to_string()).await.ok()?),
    }
}

/// The planner's own row estimate, when it is both available and large enough to be worth using.
///
/// Same statistics `stats/` already reads for the database overview, and the same caveats
/// apply: `reltuples` is `-1` on a Postgres table that was never analyzed and MySQL's `TABLE_ROWS`
/// is an InnoDB guess that can be off by half. Both fall out through `APPROX_COUNT_MIN` rather
/// than needing a special case — a bogus estimate reads as "small" and gets counted for real.
///
/// Deliberately restricted to `relkind = 'r'` / `TABLE_TYPE = 'BASE TABLE'`: a view has no
/// statistics of its own, and a partitioned parent's `reltuples` does not include its partitions.
/// SQLite has no such statistic at all, and its `COUNT(*)` is local file I/O, so it returns `None`.
///
/// The caller must only reach this with **no WHERE clause** — an estimate cannot answer a filter.
async fn estimate_row_count(conn: &DbConnection, schema: &Option<String>, table: &str) -> Option<i64> {
    let sql = match &conn.kind {
        DbKind::Postgres(_) => format!(
            "SELECT c.reltuples::bigint AS n FROM pg_class c \
             JOIN pg_namespace ns ON ns.oid = c.relnamespace \
             WHERE ns.nspname = '{}' AND c.relname = '{}' AND c.relkind = 'r'",
            sql_str(&pg_schema_of(schema)),
            sql_str(table)
        ),
        DbKind::Mysql(_) => format!(
            "SELECT TABLE_ROWS AS n FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND TABLE_TYPE = 'BASE TABLE'",
            sql_str(table)
        ),
        DbKind::Sqlite(_) => return None,
    };
    let n = first_i64(execute_raw_sql_generic(conn, sql).await.ok()?)?;
    (n >= APPROX_COUNT_MIN).then_some(n)
}

/// A cursor value, exactly as the database spelled it.
///
/// Only a number or a string can be a cursor. Anything else (NULL, a BLOB arriving as a byte array,
/// a composite) has no usable `>` boundary here, and returning `None` is what makes the frontend
/// fall back to `OFFSET` for that view instead of paging on a value it cannot compare.
fn scalar_to_cursor(v: &Value) -> Option<String> {
    match v {
        // `Number::to_string` keeps every digit of an i64 — the whole reason the cursor is minted
        // here and not read off the row on the frontend (see `next_cursor`).
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// One page of a table, plus how many rows there are in total.
///
/// Paging is by cursor when the frontend names a `seek_column` (a single-column primary key) and
/// hands back the `nextCursor` of the previous page, and by `OFFSET` otherwise — a filter or a sort
/// on another column is not a reason to fall back, but a table without a single-column key is.
///
/// `count_mode` is `"skip"` | `"auto"` | `"exact"`, and **anything else — including absent — means
/// `"exact"`**. That default is load-bearing, not a formality: the export paths (`dumpBuilder`,
/// `ExportTableDialog`) page until `rows.length >= totalCount`, so an *under*estimate there would
/// end the loop early and write a truncated dump with no error. Only the grid's status line, which
/// can afford a `~`, opts into the other two modes.
#[tauri::command]
pub async fn get_table_data(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    page: u32,
    limit: u32,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    filter: Option<String>,
    count_mode: Option<String>,
    seek_column: Option<String>,
    cursor: Option<String>,
) -> Result<Value, String> {
    let (conn_type, schema, limit_dur) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string), stmt_timeout(&ctx.server().config()))
    };

    let is_mysql = matches!(&conn_type.kind, DbKind::Mysql(_));
    // Ký tự trích dẫn định danh theo dialect: MySQL dùng backtick, còn lại dùng dấu nháy kép
    let q = if is_mysql { '`' } else { '"' };
    // The grid reads through this command, so it has to name the same schema the sidebar listed
    // from — otherwise a table outside `public` lists fine and then fails to open.
    let table_ref = qualified(&conn_type, &schema, &name);

    // WHERE: frontend đã dựng mệnh đề lọc đúng dialect, chỉ ghép thô vào sau WHERE
    let filter_body = filter.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let where_clause = match filter_body {
        Some(f) => format!(" WHERE {}", f),
        None => String::new(),
    };

    // loại bỏ ký tự trích dẫn có sẵn để tránh phá cú pháp, rồi tự bọc lại
    let safe_ident = |s: &str| s.replace('`', "").replace('"', "");
    let seek_col = seek_column
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| safe_ident(s));

    // ORDER BY: cột người dùng chọn, và nếu không có thì cột seek (khoá chính một cột) mà frontend
    // đưa xuống. Keyset pagination chỉ đúng khi thứ tự là xác định, nên chế độ "chưa sort" cũng
    // phải nhận `ORDER BY <pk>` — việc đó vá luôn một lỗi âm thầm có từ trước: `LIMIT/OFFSET` mà
    // không `ORDER BY` thì server được phép trả cùng một dòng ở hai trang khác nhau.
    let sort_col = sort_by
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| safe_ident(s))
        .or_else(|| seek_col.clone());
    let desc = matches!(sort_dir.as_deref(), Some(d) if d.eq_ignore_ascii_case("desc"));
    let dir = if desc { "DESC" } else { "ASC" };
    let order_clause = match &sort_col {
        Some(col) => format!(" ORDER BY {q}{col}{q} {dir}"),
        None => String::new(),
    };

    // Keyset ("seek") pagination. Con trỏ chỉ có nghĩa với đúng cột nó được lấy ra, nên nó chỉ được
    // dùng khi thứ tự đang áp dụng CHÍNH LÀ cột seek: sort theo cột khác thì frontend đã thôi gửi
    // `seek_column`, và điều kiện này là lớp chặn thứ hai.
    let seek_active = seek_col.as_ref().filter(|c| sort_col.as_deref() == Some(c.as_str()));
    let seek_clause = match (seek_active, cursor.as_ref().map(|s| s.as_str()).filter(|s| !s.is_empty())) {
        (Some(col), Some(v)) => {
            let op = if desc { "<" } else { ">" };
            let lit = sql_str(v);
            // Luôn là literal chuỗi, kể cả với khoá số: kiểu của CỘT quyết định phép so sánh, nên
            // `id > '500'` vẫn so theo số. Tự suy kiểu từ giá trị thì một khoá `varchar` chứa số
            // sẽ được so như số trong khi `ORDER BY` so như chuỗi — hai thứ tự khác nhau, và trang
            // sau lặng lẽ bỏ sót dòng.
            Some(format!("{q}{col}{q} {op} '{lit}'"))
        }
        _ => None,
    };

    // WHERE của trang = filter + con trỏ. Filter PHẢI được bọc ngoặc: `a = 1 OR b = 2` nối thẳng
    // bằng AND sẽ thành `a = 1 OR (b = 2 AND pk > …)`, tức là lọc khác hẳn ý người dùng.
    let row_where = match (filter_body, &seek_clause) {
        (Some(f), Some(seek)) => format!(" WHERE ({f}) AND {seek}"),
        (Some(f), None) => format!(" WHERE {f}"),
        (None, Some(seek)) => format!(" WHERE {seek}"),
        (None, None) => String::new(),
    };

    // Con trỏ THAY THẾ offset, không cộng dồn: đó là toàn bộ điểm của pha này — trang sâu không
    // còn phải đọc rồi bỏ đi n dòng đầu.
    let offset = if seek_clause.is_some() { 0 } else { (page.saturating_sub(1)) * limit };
    // Read ONE row more than the page needs: whether a next page exists is then a fact about the
    // rows, not a division of a row count that may be an estimate — and it costs nothing.
    let fetch_limit = limit.saturating_add(1);
    let sql = format!(
        "SELECT * FROM {table_ref}{row_where}{order_clause} LIMIT {fetch_limit} OFFSET {offset}",
        table_ref = table_ref, row_where = row_where, order_clause = order_clause, fetch_limit = fetch_limit, offset = offset
    );
    // Số đếm là của cả tập đã lọc, nên nó dùng `where_clause` (không có con trỏ) — nếu không thì
    // mỗi trang lại báo một tổng nhỏ dần.
    let count_sql = format!(
        "SELECT COUNT(*) FROM {table_ref}{where_clause}",
        table_ref = table_ref, where_clause = where_clause
    );

    let mut rows_json = Vec::new();
    let mut columns = Vec::new();

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;

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
            let result = with_timeout(limit_dur, execute_raw_sql_generic(&conn_type, sql.clone())).await?;
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

    // The extra row read above never reaches the frontend — it only answers "is there a next page".
    let has_more = rows_json.len() > limit as usize;
    rows_json.truncate(limit as usize);

    // Con trỏ cho trang sau: giá trị cột seek ở dòng CUỐI của trang này (sau khi đã cắt dòng đọc
    // thừa), dạng chuỗi chính xác. Phải lấy ở Rust chứ không để frontend đọc từ dòng JSON: một khoá
    // i64 lớn hơn 2^53 (kiểu snowflake) đi qua `JSON.parse` của JS là mất chữ số cuối, và con trỏ
    // lệch một đơn vị thì trang sau bỏ sót dòng — không lỗi, không dấu vết.
    let next_cursor = if has_more {
        seek_active
            .and_then(|col| rows_json.last()?.get(col.as_str()))
            .and_then(scalar_to_cursor)
    } else {
        None
    };

    // Counting is the expensive half of this command: it re-scans the whole table (or the whole
    // filter) while the page itself touches `limit` rows. Paging, sorting and resizing a page
    // cannot change the answer, so the grid asks for it only when the table, the filter or the
    // data itself changed — see `gridPaging.ts`.
    let mode = count_mode.as_deref().unwrap_or("exact");
    let (total_count, count_exact) = if mode == "skip" {
        (None, None)
    } else {
        // An estimate cannot answer a WHERE clause, so a filtered view is always counted for real.
        let approx = if mode == "auto" && where_clause.is_empty() {
            estimate_row_count(&conn_type, &schema, &name).await
        } else {
            None
        };
        match approx {
            Some(n) => (Some(n), Some(false)),
            // Đếm quá giờ thì trả `None`, không phải lỗi: dòng dữ liệu đã có rồi, và giao diện đã
            // biết hiển thị "không rõ tổng số" (pha 2). Chết cả trang chỉ vì con số ở thanh dưới
            // là đổi một bất tiện thành một sự cố.
            None => match limit_dur {
                None => (exact_row_count(&conn_type, &count_sql).await, Some(true)),
                Some(d) => (
                    tokio::time::timeout(d, exact_row_count(&conn_type, &count_sql))
                        .await
                        .unwrap_or(None),
                    Some(true),
                ),
            },
        }
    };

    Ok(json!({
        "success": true,
        "data": rows_json,
        "columns": columns,
        // `null`, not 0: "not counted" and "no rows" must not look the same on the frontend.
        "totalCount": total_count,
        "countExact": count_exact,
        "hasMore": has_more,
        // Đưa nguyên vào lần gọi sau để lấy trang kế tiếp. `null` = không seek được (không có trang
        // sau, hoặc khoá không phải số/chuỗi) và frontend lại dùng số trang.
        "nextCursor": next_cursor
    }))
}

#[tauri::command]
pub async fn get_table_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let sch = sql_str(&pg_schema_of(&schema));

    let mut indexes = Vec::new();
    let mut foreign_keys = Vec::new();
    let mut columns = Vec::new();

    // Danh sách cột khóa chính thật sự (dùng cho Postgres/MySQL; SQLite lấy trực tiếp từ PRAGMA)
    let pk_cols = get_primary_key_columns(&conn_type, &schema, &name).await;

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
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
        DbKind::Postgres(pool) => {
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
                 WHERE n.nspname = '{}' AND c.relname = '{}'
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum", sch, name.replace('\'', "''")
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
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE t.relkind = 'r' AND n.nspname = '{}' AND t.relname = '{}'",
                sch, name.replace('\'', "''")
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
                 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{}' AND tc.table_name = '{}'",
                sch, name.replace('\'', "''")
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
        DbKind::Mysql(pool) => {
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
fn generate_alter_sqls(table_name: &str, payload: &Value, db_type: &str, schema: &Option<String>) -> Vec<String> {
    let mut sqls = Vec::new();

    // Identifier quoting per dialect. Several statements below are shared by all three dialects
    // and used to hardcode backticks, which Postgres rejects outright — qualifying with a
    // backticked schema would have kept that broken, so they take this token instead.
    let quote = |ident: &str| -> String {
        if db_type == "postgres" {
            format!("\"{}\"", ident.replace('"', "\"\""))
        } else {
            format!("`{}`", ident.replace('`', "``"))
        }
    };
    // Postgres resolves an unqualified name through search_path, which need not contain the
    // schema the user picked, so every table reference here carries it.
    let qual = |ident: &str| -> String {
        match (db_type, schema.as_deref()) {
            ("postgres", Some(s)) if !s.is_empty() => format!("{}.{}", quote(s), quote(ident)),
            _ => quote(ident),
        }
    };
    let tbl = qual(table_name);
    
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

                let sql = format!("ALTER TABLE {} ADD COLUMN {} {}{} {}", tbl, quote(col_name), col_type, default_str, null_str);
                sqls.push(sql);
            }
        }
    }

    // 2. Xóa cột
    if let Some(arr) = dropped {
        for col_name in arr {
            if let Some(name) = col_name.as_str() {
                // SQLite không hỗ trợ DROP COLUMN trực tiếp ở một số bản cũ, tuy nhiên sqlite3 hiện tại đã hỗ trợ ALTER TABLE DROP COLUMN
                sqls.push(format!("ALTER TABLE {} DROP COLUMN {}", tbl, quote(name)));
            }
        }
    }

    // 3. Đổi tên cột
    if let Some(arr) = renamed {
        for item in arr {
            let old_name = item.get("oldName").and_then(|v| v.as_str()).unwrap_or("");
            let new_name = item.get("newName").and_then(|v| v.as_str()).unwrap_or("");
            if !old_name.is_empty() && !new_name.is_empty() {
                sqls.push(format!("ALTER TABLE {} RENAME COLUMN {} TO {}", tbl, quote(old_name), quote(new_name)));
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
                    sqls.push(format!("ALTER TABLE {} MODIFY COLUMN {} {} {}", tbl, quote(col_name), col_type, null_str));
                } else if db_type == "postgres" {
                    sqls.push(format!("ALTER TABLE {} ALTER COLUMN {} TYPE {}", tbl, quote(col_name), col_type));
                    let null_action = if is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                    sqls.push(format!("ALTER TABLE {} ALTER COLUMN {} {}", tbl, quote(col_name), null_action));
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
                    sqls.push(format!("ALTER TABLE {} DROP INDEX {}", tbl, quote(idx_name)));
                } else {
                    // Postgres: an index lives in its table's schema, so the DROP must name it.
                    sqls.push(format!("DROP INDEX {}", qual(idx_name)));
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
                
                // The new index name is never schema-qualified — Postgres puts it in its table's
                // schema and rejects a qualified name here — but the table it is ON must be.
                if db_type == "mysql" {
                    let sql = match idx_type {
                        "FULLTEXT" => format!(
                            "CREATE FULLTEXT INDEX {} ON {} ({})",
                            quote(idx_name), tbl, cols
                        ),
                        "SPATIAL" => format!(
                            "CREATE SPATIAL INDEX {} ON {} ({})",
                            quote(idx_name), tbl, cols
                        ),
                        _ => format!(
                            "CREATE {} INDEX {} ON {} ({}) USING {}",
                            unique_str, quote(idx_name), tbl, cols, method
                        ),
                    };
                    sqls.push(sql);
                } else if db_type == "postgres" {
                    sqls.push(format!(
                        "CREATE {} INDEX {} ON {} USING {} ({})",
                        unique_str, quote(idx_name), tbl, method.to_lowercase(), cols
                    ));
                } else {
                    sqls.push(format!(
                        "CREATE {} INDEX {} ON {} ({})",
                        unique_str, quote(idx_name), tbl, cols
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
                    sqls.push(format!("ALTER TABLE {} DROP FOREIGN KEY {}", tbl, quote(fk_name)));
                } else if db_type == "postgres" {
                    sqls.push(format!("ALTER TABLE {} DROP CONSTRAINT {}", tbl, quote(fk_name)));
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
                // The referenced table is qualified too: it is in the schema the user is working
                // in, which search_path need not cover.
                match db_type {
                    "mysql" => sqls.push(format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
                        tbl, quote(&fk_name), quote(col), qual(ref_table), quote(ref_col), on_update, on_delete
                    )),
                    "postgres" => sqls.push(format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
                        tbl, quote(&fk_name), quote(col), qual(ref_table), quote(ref_col), on_update, on_delete
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
pub async fn alter_table_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String, payload: Value) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    let db_type = match &conn_type.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
    };

    let sqls = generate_alter_sqls(&name, &payload, db_type, &schema);
    for sql in sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn preview_alter_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String, payload: Value) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    let db_type = match &conn_type.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
    };

    // Cùng SQL với alter_table_schema — người dùng xem trước đúng câu sẽ chạy.
    let sqls = generate_alter_sqls(&name, &payload, db_type, &schema);
    Ok(json!({ "success": true, "sql": sqls.join(";\n") }))
}

#[tauri::command]
pub async fn execute_query(state: tauri::State<'_, crate::AppState>, conn_id: String, sql: String, params: Option<Vec<Value>>) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    // Có tham số -> bind ở tầng driver (parameterized, một câu lệnh). Không có -> giữ nguyên hành vi cũ.
    let params = params.unwrap_or_default();
    let results = if params.is_empty() {
        with_timeout(limit, execute_raw_sql_generic(&conn_type, sql.clone())).await?
    } else {
        with_timeout(limit, run_bound_query(&conn_type, sql.clone(), &params)).await?
    };
    Ok(json!({ "success": true, "results": results }))
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

// Chạy nhiều câu lệnh SQL, mỗi câu trả về một bộ kết quả riêng (phục vụ nhiều result tab ở SqlEditor)
#[tauri::command]
pub async fn execute_multi_query(state: tauri::State<'_, crate::AppState>, conn_id: String, sql: String) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    let statements = split_sql_statements(&sql);
    let mut results: Vec<Value> = Vec::new();

    for stmt in statements {
        // Giới hạn tính cho TỪNG câu lệnh, không cho cả lô: "Run all" trên 50 câu lệnh ngắn không
        // phải là một câu lệnh chạy lâu, và cộng dồn thời gian của chúng lại sẽ giết đúng những lô
        // hoàn toàn bình thường.
        match with_timeout(limit, execute_raw_sql_generic(&conn_type, stmt.clone())).await {
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
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    sql: String,
    query_id: String,
    channel: Channel<Value>,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    // Đăng ký cờ hủy để cancel_query có thể dừng vòng lặp stream đang chạy
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel_flag.clone());
    }

    // Hết giờ thì bật đúng cái cờ mà `cancel_query` bật, nên vòng stream dừng bằng cùng một đường
    // — không thêm nhánh dừng thứ hai vào chỗ đang đẩy dữ liệu. `timed_out` để phân biệt "hết giờ"
    // với "người dùng bấm Stop": hai thứ đó phải hiện hai thông báo khác nhau.
    //
    // Giới hạn tính cho cả câu lệnh, kể cả phần đang đẩy dòng về — giống hệt `statement_timeout`
    // của server, vốn cũng không dừng đếm khi bắt đầu có dòng đầu tiên.
    let timed_out = Arc::new(AtomicBool::new(false));
    let timer = limit.map(|d| {
        let flag = cancel_flag.clone();
        let fired = timed_out.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            fired.store(true, Ordering::Relaxed);
            flag.store(true, Ordering::Relaxed);
        })
    });

    let params = params.unwrap_or_default();
    let outcome = stream_sql_statements(&conn_type, &sql, &params, &channel, &cancel_flag).await;
    // Xong sớm thì hẹn giờ không còn việc gì; để nó chạy tiếp là bật cờ hủy của một lượt chạy sau.
    if let Some(t) = timer {
        t.abort();
    }

    // Luôn gỡ cờ khi kết thúc (dù thành công hay lỗi)
    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }

    match outcome {
        Ok((stmt_count, cancelled)) => {
            // Hết giờ đi ra bằng khung `error`, không phải `done{cancelled}`: người dùng không bấm
            // Stop, và nói với họ là họ đã bấm thì lần sau họ sẽ đi tìm một cái nút không tồn tại.
            if let (true, Some(d)) = (timed_out.load(Ordering::Relaxed), limit) {
                let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_count, "message": timeout_msg(d) }));
                return Ok(json!({ "success": false }));
            }
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

// Lấy danh sách cột khóa chính của một bảng theo từng dialect (hỗ trợ cả khóa chính tổ hợp).
//
// `schema` must be the same one the caller writes through. This feeds `commit_changes`, whose
// UPDATE/DELETE build their WHERE from the result: reading the PK of `public.film` while writing
// to `sales.film` produces no error at all, just a wrong WHERE — i.e. the wrong rows changed.
async fn get_primary_key_columns(conn: &DbConnection, schema: &Option<String>, table: &str) -> Vec<String> {
    match &conn.kind {
        DbKind::Sqlite(conn_arc) => {
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
        DbKind::Postgres(_) => {
            let sql = format!(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = '{}' AND tc.table_schema = '{}' \
                 ORDER BY kcu.ordinal_position",
                table.replace('\'', "''"),
                sql_str(&pg_schema_of(schema))
            );
            match execute_raw_sql_generic(conn, sql).await {
                Ok(results) => all_string_values(&results),
                Err(_) => Vec::new(),
            }
        }
        DbKind::Mysql(_) => {
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
async fn detect_primary_key(conn: &DbConnection, schema: &Option<String>, table: &str) -> Option<String> {
    get_primary_key_columns(conn, schema, table).await.into_iter().next()
}

#[tauri::command]
pub async fn commit_changes(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    let table_name = payload.get("tableName").and_then(|v| v.as_str()).ok_or("Thiếu tên bảng")?;
    let changes = payload.get("changes").and_then(|v| v.as_array()).ok_or("Thiếu danh sách thay đổi")?;
    // Chế độ xem trước: chỉ dựng SQL, không thực thi
    let preview = payload.get("preview").and_then(|v| v.as_bool()).unwrap_or(false);

    // Xác định cột khóa chính: ưu tiên giá trị frontend gửi lên, nếu không có thì tự dò từ schema, cuối cùng mới fallback "id"
    // Cùng schema với các câu ghi bên dưới — xem chú thích ở get_primary_key_columns.
    let pk_col = match payload.get("primaryKey").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        Some(pk) => pk.to_string(),
        None => detect_primary_key(&conn_type, &schema, table_name).await.unwrap_or_else(|| "id".to_string()),
    };

    let is_pg = matches!(&conn_type.kind, DbKind::Postgres(_));
    // Written with backticks like every other identifier below, because the Postgres branch turns
    // the whole statement's backticks into double quotes at the end.
    let table_ref = match (is_pg, schema.as_deref()) {
        (true, Some(s)) if !s.is_empty() => format!("`{}`.`{}`", s, table_name),
        _ => format!("`{}`", table_name),
    };
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
                let sql = format!("DELETE FROM {} WHERE `{}` = '{}'", table_ref, pk_col, row_id.replace("'", "''"));
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
                        "INSERT INTO {} ({}) VALUES ({})",
                        table_ref,
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
                            "UPDATE {} SET {} WHERE `{}` = '{}'",
                            table_ref,
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

    // After the preview return, deliberately: showing someone the SQL their edits would produce is
    // not a write, and refusing it would make read-only mean "you may not look either".
    reject_conn_read_only(&conn_type)?;

    // Manual-commit mode: join the user's transaction instead of opening a nested one. They own the
    // commit point, so a failure here leaves the earlier statements pending for them to roll back —
    // which is the whole reason they turned auto-commit off.
    //
    // `use_session()`, NOT `is_open()`: the transaction does not exist until its first statement,
    // and pressing Save right after switching to manual is exactly that case. Checking `is_open()`
    // sent it down the auto-commit branch below and committed it.
    if crate::tx_session::use_session(&conn_type) {
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
    let begin = if matches!(&conn_type.kind, DbKind::Mysql(_)) { "START TRANSACTION;" } else { "BEGIN;" };
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
    state: tauri::State<'_, crate::AppState>, conn_id: String,
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
    crate::tx_session::reject_if_manual_or_open(&conn_id, "phục hồi dữ liệu")?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };
    // Restore replays a whole dump on its own connection, so none of the funnels sees it.
    reject_conn_read_only(&conn_type)?;

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


    match &conn_type.kind {
        DbKind::Mysql(pool) => {
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
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "SET CONSTRAINTS ALL DEFERRED;".to_string()).await;
                    let _ = execute_raw_sql_generic(&conn_type, "BEGIN;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("PRAGMA foreign_keys = OFF;", []);
                        let _ = conn.execute("BEGIN TRANSACTION;", []);
                    }
                }
                _ => {}
            }

            for (idx, (q, session_level)) in to_run.iter().enumerate() {
                let session_level = *session_level;

                let exec_sql = match &conn_type.kind {
                    DbKind::Postgres(_) => q.replace("`", "\""),
                    _ => q.clone(),
                };
                // Postgres: một lỗi làm cả transaction chuyển sang trạng thái aborted (25P02),
                // mọi câu sau đó đều lỗi "current transaction is aborted". Muốn chạy tiếp thì
                // phải có điểm lùi cho từng câu. Chỉ trả giá 2 round trip khi người dùng bật
                // chế độ này; MySQL và SQLite không cần vì lỗi một câu không huỷ transaction.
                let pg_savepoint = continue_on_error && matches!(&conn_type.kind, DbKind::Postgres(_));
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
                        match &conn_type.kind {
                            DbKind::Postgres(_) => {
                                let _ = execute_raw_sql_generic(&conn_type, "ROLLBACK;".to_string()).await;
                            }
                            DbKind::Sqlite(conn_arc) => {
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
            match &conn_type.kind {
                DbKind::Postgres(_) => {
                    let _ = execute_raw_sql_generic(&conn_type, "COMMIT;".to_string()).await;
                }
                DbKind::Sqlite(conn_arc) => {
                    if let Ok(conn) = conn_arc.lock() {
                        let _ = conn.execute("COMMIT;", []);
                    }
                }
                _ => {}
            }

            // Bật lại khóa ngoại
            match &conn_type.kind {
                DbKind::Sqlite(conn_arc) => {
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
            // Server-level, không phải connection-level: `last_config` + cổng tunnel thuộc
            // `ServerHandle`. `last_config` ở đó là `Value` (một server thì luôn có config) nên bọc
            // `Some` để phần dưới không phải đổi.
            let ctx = state.connections.acquire(&conn_id)?;
            (Some(ctx.server().config()), ctx.server().db_type.clone(),
             ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port))
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
                    Some(DbKind::Postgres(pool))
                }
                "mysql" => {
                    let url = build_mysql_url(&last_conf, Some(db_name.as_str()));
                    let pool = MySqlPool::connect(&url).await.map_err(|e| e.to_string())?;
                    Some(DbKind::Mysql(pool))
                }
                _ => None
            };
            if let Some(kind) = new_conn {
                // `USE <db>` đổi database ngay dưới chân tab đang restore. Phase 3 sẽ mint một
                // `conn_id` mới cho database mới (§4.3); ở đây vẫn chuyển entry hiện tại như trước —
                // nên pool mới mang ĐÚNG id của entry đó, không phải một id mới.
                let ctx = state.connections.acquire(&conn_id)?;
                let id = ctx.id().clone();
                ctx.server().set_config(last_conf);
                state.connections.replace_conn(&id, DbConnection::session(id.clone(), kind))?;
                state.connections.set_db(&id, db_name.clone())?;
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
pub async fn import_new_table(state: tauri::State<'_, crate::AppState>, conn_id: String, table_name: String, rows: Vec<Value>) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    if rows.is_empty() {
        return Err("Không có dữ liệu để tạo bảng".to_string());
    }
    let is_mysql = matches!(&conn_type.kind, DbKind::Mysql(_));
    let is_pg = matches!(&conn_type.kind, DbKind::Postgres(_));
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

    let create_sql = format!("CREATE TABLE {} ({})", qualified(&conn_type, &schema, &table_name), defs.join(", "));
    execute_raw_sql_generic(&conn_type, create_sql).await?;

    let inserted = bulk_insert(&conn_type, &schema, &table_name, &rows).await?;
    Ok(json!({ "success": true, "inserted": inserted }))
}

#[tauri::command]
pub async fn create_table(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    let table_name = payload.get("tableName").and_then(|v| v.as_str()).ok_or("Thiếu tên bảng")?;

    let db_type = match &conn_type.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
    };
    let q = if db_type == "mysql" { '`' } else { '"' };
    // Không qualify thì bảng mới rơi vào schema đầu search_path, không phải schema đang chọn.
    let table_ref = qualified(&conn_type, &schema, table_name);

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

            format!("CREATE TABLE {name} ({defs})", name = table_ref, defs = defs.join(", "))
        }
        _ => match &conn_type.kind {
            DbKind::Mysql(_) => format!("CREATE TABLE {} (id INT AUTO_INCREMENT PRIMARY KEY)", table_ref),
            _ => format!("CREATE TABLE {} (id INTEGER PRIMARY KEY)", table_ref),
        },
    };

    execute_raw_sql_generic(&conn_type, create_sql).await?;

    // Sau khi tạo bảng, tạo tiếp Index & Foreign Key (nếu có) — tái dùng bộ sinh SQL đã sửa ở generate_alter_sqls
    let extra_payload = json!({
        "addedIndexes": payload.get("indexes").cloned().unwrap_or(json!([])),
        "addedFKs": payload.get("foreignKeys").cloned().unwrap_or(json!([])),
    });
    let extra_sqls = generate_alter_sqls(table_name, &extra_payload, db_type, &schema);
    for sql in extra_sqls {
        execute_raw_sql_generic(&conn_type, sql).await?;
    }

    Ok(json!({ "success": true }))
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
    // Before the FK-disable statement, not after: refusing halfway would leave the session with
    // foreign-key checks off on a connection we just declared untouchable.
    reject_conn_read_only(conn)?;
    if crate::tx_session::use_session(conn) {
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
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    is_view: Option<bool>,
    cascade: Option<bool>,
    ignore_fk: Option<bool>,
) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let is_view = is_view.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    // Bỏ qua khóa ngoại không có nghĩa với view: view không nằm trong ràng buộc FK nào.
    let ignore_fk = ignore_fk.unwrap_or(false) && !is_view;

    // CASCADE chỉ Postgres mới thực thi thật: SQLite báo lỗi cú pháp, MySQL chấp nhận từ khóa
    // rồi bỏ qua -> người dùng tưởng đã xóa lan mà thực tế không. Từ chối còn hơn im lặng.
    if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    let keyword = if is_view { "DROP VIEW" } else { "DROP TABLE" };
    let sql = format!(
        "{} {}{}",
        keyword,
        qualified(&conn_type, &schema, &name),
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
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    restart_identity: Option<bool>,
    disable_fk: Option<bool>,
    cascade: Option<bool>,
) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let restart_identity = restart_identity.unwrap_or(false);
    let disable_fk = disable_fk.unwrap_or(false);
    let cascade = cascade.unwrap_or(false);
    let quoted = qualified(&conn_type, &schema, &name);

    // Như DROP: chỉ Postgres có TRUNCATE ... CASCADE.
    if cascade && !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Err("CASCADE chỉ được hỗ trợ trên PostgreSQL".to_string());
    }

    // MySQL luôn reset bộ đếm tự tăng bên trong TRUNCATE và không có cách tắt, nên "giữ nguyên
    // bộ đếm" phải làm thủ công: đọc giá trị trước, đặt lại sau. Đọc TRƯỚC khi truncate.
    let keep_auto_inc = match (&conn_type.kind, restart_identity) {
        (DbKind::Mysql(_), false) => mysql_next_auto_increment(&conn_type, &name).await,
        _ => None,
    };

    // Câu lệnh bắt buộc + câu lệnh "cố gắng" chạy sau (lỗi không tính là thất bại).
    let (sql, optional): (String, Option<String>) = match &conn_type.kind {
        DbKind::Mysql(_) => (
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
        DbKind::Postgres(_) => (
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
        DbKind::Sqlite(_) => (
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
pub async fn get_table_definition(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let sch = sql_str(&pg_schema_of(&schema));

    let ddl: String = match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
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
        DbKind::Mysql(pool) => {
            let show_sql = format!("SHOW CREATE TABLE `{}`", name);
            let row = sqlx::query(sqlx::AssertSqlSafe(show_sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            // Cột thứ 2 là "Create Table" (bảng) hoặc "Create View" (view)
            let s: String = row.try_get("Create Table").or_else(|_| row.try_get("Create View")).map_err(|e| e.to_string())?;
            format!("{};", s)
        }
        DbKind::Postgres(_) => {
            // A view is NOT a table here. This branch used to hand-build `CREATE TABLE` for
            // every name it was given, so exporting a Postgres database emitted a CREATE TABLE
            // for each of its views — the re-import then had a real table shadowing the view
            // and none of the view logic. relkind decides: 'v' = view, 'm' = materialized view
            // (which CREATE ... WITH DATA populates on the spot, so no REFRESH is needed as
            // long as it is written after the tables it reads — which the dump order does).
            let relkind = {
                let sql = format!(
                    "SELECT c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = '{}' AND c.relname = '{}' LIMIT 1",
                    sch, name.replace('\'', "''")
                );
                execute_raw_sql_generic(&conn_type, sql)
                    .await
                    .ok()
                    .and_then(|r| all_string_values(&r).into_iter().next())
                    .unwrap_or_default()
            };
            if relkind == "v" || relkind == "m" {
                // regclass resolves through search_path unless the name is qualified, which would
                // read a same-named view from another schema. The emitted DDL below stays
                // unqualified on purpose: the dump header sets search_path, so the file can be
                // restored into a differently-named schema.
                let sql = format!(
                    "SELECT pg_get_viewdef('\"{}\".\"{}\"'::regclass, true) AS def",
                    sch.replace('"', "\"\""),
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
            let pk_cols = get_primary_key_columns(&conn_type, &schema, &name).await;
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
                 WHERE n.nspname = '{}' AND c.relname = '{}' \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                sch, name.replace('\'', "''")
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
pub async fn rename_table(state: tauri::State<'_, crate::AppState>, conn_id: String, old_name: String, new_name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    // Chỉ vế nguồn mang schema: RENAME TO nhận tên mới KHÔNG qualify (Postgres báo lỗi cú pháp
    // nếu qualify), bảng đổi tên vẫn ở nguyên schema cũ.
    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!("RENAME TABLE `{}` TO `{}`", old_name, new_name),
        _ => format!(
            "ALTER TABLE {} RENAME TO {}",
            qualified(&conn_type, &schema, &old_name),
            quote_ident(&conn_type, &new_name)
        ),
    };
    execute_raw_sql_generic(&conn_type, sql.clone()).await?;
    
    Ok(json!({ "success": true }))
}

// Chèn hàng loạt dòng vào một bảng đã tồn tại. Gộp mỗi BATCH dòng vào một câu INSERT nhiều VALUES.
// Cột lấy từ hợp (union) các key của các dòng, giữ thứ tự xuất hiện lần đầu.
async fn bulk_insert(conn: &DbConnection, schema: &Option<String>, table: &str, rows: &[Value]) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let is_mysql = matches!(conn.kind, DbKind::Mysql(_));
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

    let quoted_table = qualified(conn, schema, table);
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
pub async fn import_table_data(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String, rows: Vec<Value>) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };
    let inserted = bulk_insert(&conn_type, &schema, &name, &rows).await?;
    Ok(json!({ "success": true, "inserted": inserted }))
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
pub async fn list_databases(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Postgres(_) => "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname".to_string(),
        DbKind::Mysql(_) => "SHOW DATABASES".to_string(),
        DbKind::Sqlite(_) => return Ok(json!({ "success": true, "databases": [] })), // SQLite: 1 file = 1 DB
    };
    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut databases = all_string_values(&results);
    databases.sort();
    Ok(json!({ "success": true, "databases": databases }))
}

/// Open another database on the SAME server as a **new connection** (§4.3).
///
/// The only way to reach another database now. It replaced `switch_database`, which *replaced* the
/// pool under a live `conn_id`: that had to refuse whenever the connection held uncommitted work,
/// and when it succeeded it left every open tab pointing at tables of a database the connection no
/// longer served. Opening *adds* a pool, so it touches nothing that already exists — there is
/// nothing to refuse, and a transaction open on the current database keeps running while the user
/// works in another one.
///
/// The `Arc<ServerHandle>` is shared, which is the point: the SSH tunnel, the credentials and the
/// IAM token are the server's, not this database's. No re-auth, and the tunnel stays up as long as
/// any connection on that server is open — the last one closing drops the last `Arc` and with it the
/// forwarded port.
///
/// Idempotent: asking for a database that is already open hands back the connection that has it,
/// rather than minting a second pool for the same place.
#[tauri::command]
pub async fn open_database(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    name: String,
) -> Result<Value, String> {
    let (server, db_type, tunnel_port, inherit_read_only) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (
            ctx.server_arc(),
            ctx.server().db_type.clone(),
            ctx.server().ssh_tunnel.as_ref().map(|t| t.local_port),
            state.connections.is_read_only(&conn_id),
        )
    };

    if db_type == "sqlite" {
        return Err("SQLite không hỗ trợ nhiều database trên một kết nối".to_string());
    }

    if let Some(existing) = state.connections.find(&server.id, &name)? {
        let ctx = state.connections.acquire(&existing)?;
        return Ok(json!({
            "success": true, "database": name,
            "schema": ctx.raw_schema(), "connId": &*existing,
        }));
    }

    // Config để dựng URL: nếu có tunnel thì trỏ qua 127.0.0.1:<local_port>
    let mut url_conf = server.config();
    if let Some(port) = tunnel_port {
        if let Some(obj) = url_conf.as_object_mut() {
            obj.insert("host".to_string(), json!("127.0.0.1"));
            obj.insert("port".to_string(), json!(port));
        }
    }

    let new_id = crate::state::mint_id();
    let kind = match db_type.as_str() {
        "postgres" => {
            let url = build_pg_url(&url_conf, Some(name.as_str()));
            DbKind::Postgres(PgPool::connect(&url).await.map_err(|e| e.to_string())?)
        }
        "mysql" => {
            let url = build_mysql_url(&url_conf, Some(name.as_str()));
            DbKind::Mysql(MySqlPool::connect(&url).await.map_err(|e| e.to_string())?)
        }
        _ => return Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    };
    let conn = DbConnection::session(new_id.clone(), kind);

    // Each database has its own schemas, so probe rather than inherit the one selected elsewhere.
    let schema = probe_pg_schema(&conn).await;
    state.connections.insert(
        new_id.clone(),
        // Inherits the read-only flag of the connection it was opened FROM: those two are the same
        // server, and someone who marked production read-only means every database on it.
        crate::state::ConnEntry {
            read_only: inherit_read_only,
            server,
            db: name.clone(),
            conn: crate::state::LiveConn::Sql(conn),
            current_schema: schema.clone(),
        },
    )?;
    Ok(json!({ "success": true, "database": name, "schema": schema, "connId": &*new_id }))
}

// `switch_database` đã bị xoá.
//
// Nó thay pool tại chỗ dưới chân một `conn_id` đang sống. Vì thế nó phải từ chối khi kết nối còn
// thay đổi chưa commit, và khi nó thành công thì mọi tab đang mở vẫn trỏ vào bảng của database cũ mà
// không ai báo. `open_database` không có cả hai vấn đề đó: nó thêm một pool trên cùng
// `Arc<ServerHandle>` (cùng tunnel, cùng thông tin đăng nhập, không xác thực lại) và mint conn_id
// mới, nên database cũ giữ nguyên tab lẫn transaction của nó. Cả ba đường gọi cũ — bộ chọn trên
// thanh tiêu đề, Sidebar, popup thống kê — và bước "đổi sang database đích" của luồng nhập đều đã
// chuyển sang nó.

/// Schemas available on the current Postgres connection, for the Sidebar picker.
///
/// Empty on MySQL (its schema *is* the database — `list_databases` already covers that) and on
/// SQLite, which is how the frontend decides whether to show the picker at all.
#[tauri::command]
pub async fn list_schemas(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, current) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string))
    };

    if !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Ok(json!({ "success": true, "schemas": [], "current": Value::Null }));
    }

    let results = execute_raw_sql_generic(
        &conn_type,
        "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' \
         AND nspname <> 'information_schema' ORDER BY nspname".to_string(),
    ).await?;
    let schemas = all_string_values(&results);
    Ok(json!({ "success": true, "schemas": schemas, "current": current }))
}

/// Selects the schema every later command works in. The Sidebar picker's backing command.
///
/// The name is verified against `pg_namespace` first: accepting one that does not exist would
/// leave every query filtering on a schema that is not there, i.e. the same empty sidebar this
/// feature exists to fix, with nothing on screen to explain it.
#[tauri::command]
pub async fn set_current_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };
    if !matches!(conn_type.kind, DbKind::Postgres(_)) {
        return Err("Chỉ PostgreSQL mới hỗ trợ chọn schema".to_string());
    }

    let schema = name.trim().to_string();
    if schema.is_empty() {
        return Err("Thiếu tên schema".to_string());
    }

    let found = execute_raw_sql_generic(
        &conn_type,
        format!("SELECT nspname FROM pg_namespace WHERE nspname = '{}' LIMIT 1", sql_str(&schema)),
    ).await?;
    if rows_of(&found).is_empty() {
        return Err(format!("Schema '{}' không tồn tại", schema));
    }

    {
        let id = state.connections.acquire(&conn_id)?.id().clone();
        state.connections.set_schema(&id, Some(schema.clone()))?;
    }
    Ok(json!({ "success": true, "schema": schema }))
}

// Tạo database mới (dùng kết nối hiện tại). encoding/collation là tùy chọn.
#[tauri::command]
pub async fn create_database(state: tauri::State<'_, crate::AppState>, conn_id: String, payload: Value) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let name = payload.get("name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).ok_or("Thiếu tên database")?;
    let encoding = payload.get("encoding").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    let collation = payload.get("collation").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => {
            let mut s = format!("CREATE DATABASE `{}`", name);
            if let Some(e) = encoding { s.push_str(&format!(" CHARACTER SET {}", e)); }
            if let Some(c) = collation { s.push_str(&format!(" COLLATE {}", c)); }
            s
        }
        DbKind::Postgres(_) => {
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
        DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ tạo database (mỗi tệp là một database)".to_string()),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Xóa database (dùng kết nối hiện tại). Không thể xóa database đang kết nối.
#[tauri::command]
pub async fn drop_database(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!("DROP DATABASE `{}`", name),
        DbKind::Postgres(_) => format!("DROP DATABASE \"{}\"", name),
        DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ xóa database".to_string()),
    };
    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Đổi tên database. Chỉ PostgreSQL hỗ trợ (và không được đổi tên DB đang kết nối tới).
#[tauri::command]
pub async fn rename_database(state: tauri::State<'_, crate::AppState>, conn_id: String, old_name: String, new_name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        // PG có lệnh đổi tên trực tiếp (không được đổi tên DB đang kết nối tới)
        DbKind::Postgres(_) => format!("ALTER DATABASE \"{}\" RENAME TO \"{}\"", old_name, new_name),
        DbKind::Mysql(_) => return Err("MySQL không hỗ trợ đổi tên database.".to_string()),
        DbKind::Sqlite(_) => return Err("SQLite không hỗ trợ đổi tên database.".to_string()),
    };
    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true }))
}

// Liệt kê các đối tượng CSDL của kết nối hiện tại: bảng, khung nhìn, hàm, thủ tục
#[tauri::command]
pub async fn get_database_objects(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

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

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
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
        DbKind::Postgres(_) => {
            // Materialized views: see the note in get_tables — information_schema has none.
            let tv = execute_raw_sql_generic(&conn_type,
                format!("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '{sch}' \
                 UNION ALL \
                 SELECT c.relname, 'VIEW' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relkind = 'm' \
                 ORDER BY 1")).await?;
            split_tables_views(&tv, "table_name", "table_type", "VIEW", &mut tables, &mut views);

            let rt = execute_raw_sql_generic(&conn_type,
                format!("SELECT p.proname AS name, p.prokind::text AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '{sch}' AND p.prokind IN ('f','p') ORDER BY p.proname"))
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
        DbKind::Mysql(_) => {
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
    if matches!(conn_type.kind, DbKind::Mysql(_)) {
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
pub async fn get_object_definition(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String, kind: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let ddl: String = match &conn_type.kind {
        DbKind::Mysql(pool) => {
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
        DbKind::Postgres(_) => {
            let sql = match kind.as_str() {
                "function" | "procedure" => format!(
                    "SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '{}' AND p.proname = '{}' LIMIT 1",
                    sch, name.replace('\'', "''")
                ),
                "view" => format!(
                    "SELECT pg_get_viewdef('\"{}\".\"{}\"'::regclass, true) AS def",
                    sch.replace('"', "\"\""),
                    name.replace('"', "\"\"")
                ),
                _ => return Err("Loại đối tượng không được hỗ trợ".to_string()),
            };
            let results = execute_raw_sql_generic(&conn_type, sql).await?;
            all_string_values(&results).into_iter().next().ok_or("Không lấy được định nghĩa đối tượng")?
        }
        DbKind::Sqlite(conn_arc) => {
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
pub async fn get_db_charsets(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
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

    match &conn_type.kind {
        DbKind::Mysql(_) => {
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
        DbKind::Postgres(_) => {
            let enc_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE encoding >= 0 ORDER BY 1".to_string()).await?;
            let mut encodings = col_values(&enc_res, "enc");
            if !encodings.iter().any(|e| e == "UTF8") { encodings.insert(0, "UTF8".to_string()); }

            let coll_res = execute_raw_sql_generic(&conn_type,
                "SELECT DISTINCT datcollate AS c FROM pg_database WHERE datcollate IS NOT NULL ORDER BY 1".to_string()).await?;
            let collations = col_values(&coll_res, "c");
            Ok(json!({ "success": true, "encodings": encodings, "collations": collations }))
        }
        DbKind::Sqlite(_) => {
            Ok(json!({ "success": true, "encodings": [], "collations": [] }))
        }
    }
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

#[tauri::command]
pub async fn get_table_triggers(state: tauri::State<'_, crate::AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT TRIGGER_NAME as name, ACTION_TIMING as timing, EVENT_MANIPULATION as event, ACTION_STATEMENT as statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE EVENT_OBJECT_TABLE = '{}' AND TRIGGER_SCHEMA = DATABASE()",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
            "SELECT tr.tgname AS name, CASE WHEN tr.tgtype & 2 = 2 THEN 'BEFORE' WHEN tr.tgtype & 64 = 64 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing, CASE WHEN tr.tgtype & 4 = 4 THEN 'INSERT' WHEN tr.tgtype & 8 = 8 THEN 'DELETE' WHEN tr.tgtype & 16 = 16 THEN 'UPDATE' ELSE 'MANIPULATION' END AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '{}' AND n.nspname = '{}' AND NOT tr.tgisinternal",
            table_name.replace('\'', "''"), sch
        ),
        DbKind::Sqlite(_) => format!(
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
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    table_name: String,
) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let esc = table_name.replace('\'', "''");
    // Only the catalog lookups take the schema. The statements these build stay unqualified so a
    // dump can be restored into a differently-named schema — the header's SET search_path decides.
    let sch = sql_str(&schema);

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

    match &conn_type.kind {
        DbKind::Mysql(_) => {}
        DbKind::Sqlite(_) => {
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
        DbKind::Postgres(_) => {
            sequences = ddl_list(&conn_type, format!(
                "SELECT 'CREATE SEQUENCE IF NOT EXISTS ' || quote_ident(s.relname) || ';' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = '{sch}' AND t.relname = '{esc}'")).await;

            // Skip every index that merely backs a constraint — PRIMARY KEY is already inside
            // CREATE TABLE and UNIQUE comes back below as ALTER TABLE ADD CONSTRAINT.
            indexes = ddl_list(&conn_type, format!(
                "SELECT pg_get_indexdef(i.indexrelid) || ';' \
                 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' \
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)")).await;

            // contype: f = foreign key, u = unique, c = check. 'p' (primary key) is skipped.
            constraints = ddl_list(&conn_type, format!(
                "SELECT 'ALTER TABLE ' || quote_ident(c.relname) || ' ADD CONSTRAINT ' \
                     || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';' \
                 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' AND con.contype IN ('f','u','c') \
                 ORDER BY con.contype DESC, con.conname")).await;

            comments = ddl_list(&conn_type, format!(
                "SELECT 'COMMENT ON TABLE ' || quote_ident(c.relname) || ' IS ' \
                     || quote_literal(obj_description(c.oid)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' AND obj_description(c.oid) IS NOT NULL \
                 UNION ALL \
                 SELECT 'COMMENT ON COLUMN ' || quote_ident(c.relname) || '.' || quote_ident(a.attname) \
                     || ' IS ' || quote_literal(col_description(c.oid, a.attnum)) || ';' \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 WHERE n.nspname = '{sch}' AND c.relname = '{esc}' \
                   AND col_description(c.oid, a.attnum) IS NOT NULL")).await;

            // setval computed from the restored rows instead of the value read at export time:
            // the dump stays correct no matter how long it sits on disk before being replayed.
            sequence_values = ddl_list(&conn_type, format!(
                "SELECT 'SELECT setval(' || quote_literal(quote_ident(s.relname)) || ', COALESCE((SELECT MAX(' \
                     || quote_ident(a.attname) || ') FROM ' || quote_ident(t.relname) || '), 1), true);' \
                 FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a' \
                 JOIN pg_class t ON t.oid = d.refobjid \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE s.relkind = 'S' AND n.nspname = '{sch}' AND t.relname = '{esc}'")).await;
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
pub async fn get_all_triggers(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => "SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS statement FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME".to_string(),
        DbKind::Postgres(_) => format!("SELECT tr.tgname AS name, c.relname AS tbl, '' AS timing, '' AS event, pg_get_triggerdef(tr.oid) AS statement FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '{sch}' AND NOT tr.tgisinternal ORDER BY c.relname, tr.tgname"),
        // sql IS NULL for objects SQLite creates itself; those cannot be replayed anyway.
        DbKind::Sqlite(_) => "SELECT name, tbl_name AS tbl, '' AS timing, '' AS event, sql AS statement FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY tbl_name, name".to_string(),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let is_mysql = matches!(conn_type.kind, DbKind::Mysql(_));
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
pub async fn save_trigger(state: tauri::State<'_, crate::AppState>, conn_id: String, statement_sql: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, statement_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu Trigger thành công" }))
}

#[tauri::command]
pub async fn drop_trigger(state: tauri::State<'_, crate::AppState>, conn_id: String, trigger_name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!("DROP TRIGGER `{}`", trigger_name),
        _ => format!("DROP TRIGGER IF EXISTS \"{}\"", trigger_name),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true, "message": "Đã xóa Trigger thành công" }))
}

#[tauri::command]
pub async fn save_routine_definition(state: tauri::State<'_, crate::AppState>, conn_id: String, routine_sql: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, routine_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu Procedure/Function thành công" }))
}

#[tauri::command]
pub async fn get_sequences(state: tauri::State<'_, crate::AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Postgres(_) => format!("SELECT sequence_name as name, data_type, start_value, minimum_value as min_val, maximum_value as max_val, increment, cycle_option as cycle FROM information_schema.sequences WHERE sequence_schema = '{sch}'"),
        DbKind::Mysql(_) => "SELECT table_name as name, 'bigint' as data_type, '1' as start_value, '1' as min_val, '9223372036854775807' as max_val, '1' as increment, 'NO' as cycle FROM information_schema.tables WHERE table_type = 'SEQUENCE' AND table_schema = DATABASE()".to_string(),
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
pub async fn alter_sequence(state: tauri::State<'_, crate::AppState>, conn_id: String, sequence_sql: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, sequence_sql).await?;
    Ok(json!({ "success": true, "message": "Đã cập nhật Sequence thành công" }))
}

#[tauri::command]
pub async fn drop_sequence(state: tauri::State<'_, crate::AppState>, conn_id: String, sequence_name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!("DROP SEQUENCE IF EXISTS `{}`", sequence_name),
        _ => format!("DROP SEQUENCE IF EXISTS \"{}\"", sequence_name),
    };

    execute_raw_sql_generic(&conn_type, sql).await?;
    Ok(json!({ "success": true, "message": "Đã xóa Sequence thành công" }))
}

#[tauri::command]
pub async fn get_table_partitions(state: tauri::State<'_, crate::AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT PARTITION_NAME as name, PARTITION_METHOD as method, PARTITION_EXPRESSION as expression, PARTITION_DESCRIPTION as description, TABLE_ROWS as table_rows, DATA_LENGTH as data_length FROM INFORMATION_SCHEMA.PARTITIONS WHERE TABLE_NAME = '{}' AND TABLE_SCHEMA = DATABASE() AND PARTITION_NAME IS NOT NULL",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
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
pub async fn get_check_constraints(state: tauri::State<'_, crate::AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT tc.CONSTRAINT_NAME as name, cc.CHECK_CLAUSE as expression, 'YES' as enforced FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA WHERE tc.TABLE_NAME = '{}' AND tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
            "SELECT conname AS name, pg_get_constraintdef(c.oid) AS expression, 'YES' AS enforced FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE t.relname = '{}' AND n.nspname = '{}' AND c.contype = 'c'",
            table_name.replace('\'', "''"), sch
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
pub async fn save_view_definition(state: tauri::State<'_, crate::AppState>, conn_id: String, view_sql: String) -> Result<Value, String> {
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, view_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu View thành công" }))
}
