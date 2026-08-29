//! AWS IAM authentication: generating a token in place of the password, and refreshing it before it expires.

use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool};
use tauri::Manager;

use super::conn::{DbConnection, DbKind};
use super::dsn::{build_mysql_url, build_pg_url};

// The IAM token refresh cycle (a token lives 15 minutes -> rebuild the pool before it expires).
const IAM_REFRESH_SECS: u64 = 780;

pub(crate) fn is_iam(config: &Value) -> bool {
    config.get("authMethod").and_then(|v| v.as_str()) == Some("aws_iam")
}

// When AWS IAM is used: generate a token, set it as conn_config's password and force SSL (IAM requires SSL).
// The token is signed from the ORIGINAL config (the real host/region), so call this before using the tunneled conn_config.
pub(crate) fn apply_iam_password(orig_config: &Value, conn_config: &mut Value, default_port: u16) -> Result<(), String> {
    if !is_iam(orig_config) {
        return Ok(());
    }
    let token = crate::credentials::aws_iam::generate_rds_token(orig_config, default_port)?;
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

// Rebuild the IAM pool with a fresh token (no SSH tunnel — IAM refresh assumes a direct RDS connection).
//
// It returns a `DbKind`, not a `DbConnection`: the new pool takes the place of an EXISTING connection, so the id must be
// that connection's id. The caller (the refresh task) is what knows the id, and wraps it there.
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

// Background task: every ~13 minutes generate a fresh token and swap the pool, for as long as this conn_id is in the registry.
pub(crate) fn spawn_iam_refresh(
    app: tauri::AppHandle,
    db_type: String,
    config: Value,
    conn_id: crate::state::ConnScopeId,
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
            if crate::tx::is_open(&conn_id) {
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
                Err(_) => { /* transient error -> retry on the next cycle */ }
            }
        }
    });
}
