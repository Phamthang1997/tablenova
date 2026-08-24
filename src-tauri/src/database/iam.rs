//! AWS IAM authentication: sinh token thay mật khẩu, và làm mới nó trước khi hết hạn.

use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool};
use tauri::Manager;

use super::conn::{DbConnection, DbKind};
use super::dsn::{build_mysql_url, build_pg_url};

// Chu kỳ làm mới token IAM (token sống 15 phút -> dựng lại pool trước khi hết hạn).
const IAM_REFRESH_SECS: u64 = 780;

pub(crate) fn is_iam(config: &Value) -> bool {
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
//
// Trả `DbKind`, không phải `DbConnection`: pool mới thay chỗ của một kết nối ĐANG có, nên id phải là
// id của kết nối đó. Caller (task refresh) là nơi biết id, và bọc ở đó.
pub(crate) async fn build_iam_conn(db_type: &str, orig_config: &Value) -> Result<DbKind, String> {
    let default_port = if db_type == "postgres" { 5432 } else { 3306 };
    let mut conn_config = orig_config.clone();
    apply_iam_password(orig_config, &mut conn_config, default_port)?;
    match db_type {
        "postgres" => Ok(DbKind::Postgres(
            PgPool::connect(&build_pg_url(&conn_config, None)).await.map_err(|e| e.to_string())?,
        )),
        "mysql" => Ok(DbKind::Mysql(
            MySqlPool::connect(&build_mysql_url(&conn_config, None)).await.map_err(|e| e.to_string())?,
        )),
        _ => Err("IAM chỉ hỗ trợ postgres/mysql".to_string()),
    }
}

// Task nền: cứ ~13 phút sinh token mới và thay pool, chừng nào conn_id này còn trong registry.
pub(crate) fn spawn_iam_refresh(
    app: tauri::AppHandle,
    db_type: String,
    config: Value,
    conn_id: crate::state::SessionId,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(IAM_REFRESH_SECS)).await;
            let state = app.state::<crate::AppState>();
            // Stop when this task's connection is gone from the registry.
            //
            // This replaced a generation counter, and the replacement is not cosmetic. A counter was
            // right only while `connect_db` closed the previous connection: once Phase 2 lets N
            // connections coexist, a **global** counter makes the second connect kill the first
            // connection's refresh task — that connection then dies ~15 minutes later with an auth
            // error and nothing pointing at the cause (§4.6) — and a **per-server** counter does the
            // same to sibling connections when one of them reconnects. Existence of the id is right
            // in both worlds: the id is in the registry exactly while that connection is alive and
            // its token still needs refreshing.
            if state.connections.acquire(&conn_id).is_err() {
                break;
            }
            // Replacing the pool would drop the connection an open manual transaction is pinned to,
            // silently losing everything the user has not committed. The token is still valid for
            // ~2 more minutes; wait for the next cycle instead.
            if crate::tx_session::is_open(&conn_id) {
                continue;
            }
            match build_iam_conn(&db_type, &config).await {
                Ok(kind) => {
                    let new_conn = DbConnection::session(conn_id.clone(), kind);
                    // No second guard before the swap, and none is needed: the swap names `conn_id`.
                    // A disconnect removes that entry and a reconnect mints a *different* id, so a
                    // stale task can only ever write to an entry that is already gone, where
                    // `replace_conn` no-ops.
                    if state.connections.replace_conn(&conn_id, new_conn).is_err() {
                        break; // registry poisoned -> nothing left to refresh
                    }
                }
                Err(_) => { /* lỗi tạm thời -> thử lại chu kỳ sau */ }
            }
        }
    });
}
