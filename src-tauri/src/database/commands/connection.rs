//! Mở / đóng / liệt kê kết nối, và cờ chỉ-đọc của một kết nối.

use std::sync::{Arc, Mutex};

use rusqlite::Connection as SqliteConnection;
use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool};

use crate::database::{
    apply_iam_password, apply_ssh_tunnel, build_mysql_url, build_pg_url, cell,
    execute_raw_sql_generic, is_iam, rows_of, spawn_iam_refresh, DbConnection, DbKind,
};
use crate::ssh_tunnel::SshTunnel;

/// The schema a fresh Postgres connection lands in — i.e. the first existing entry of its
/// `search_path`. This is what the plan's §4.1 calls the default for the Sidebar picker, and it
/// costs no extra UI. Returns `None` for MySQL/SQLite, and on any failure: a probe that cannot
/// run must not stop the connection from opening, it just leaves the `public` default in place.
pub(super) async fn probe_pg_schema(conn: &DbConnection) -> Option<String> {
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
    crate::tx::reset(entry.as_ref().and_then(|e| e.conn.sql())).await;
    drop(entry);
    Ok(json!({ "success": true }))
}
