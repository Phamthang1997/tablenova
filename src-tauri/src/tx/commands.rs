//! The seven `#[tauri::command]`s of manual commit mode (`TxControl.tsx` on the title bar).

use serde_json::{Value, json};

use crate::database::DbConnection;

use super::effect::{dialect_of, isolation_allowed, sanitize_savepoint};
use super::route::{lock_pinned, raw_on_pinned, run_raw};
use super::session::{
    any_pending, emit_state, has_pending, is_open, release_if_closed, session_for, status_json,
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn current_conn(state: &crate::AppState, conn_id: &str) -> Result<DbConnection, String> {
    Ok(state.connections.acquire(conn_id)?.conn().clone())
}

#[tauri::command]
pub async fn tx_status(conn_id: String) -> Result<Value, String> {
    Box::pin(async move { Ok(status_json(&conn_id)) }).await
}

/// Is **any** connection holding uncommitted changes?
///
/// For the window-close guard, which is the one question that is not per-connection: closing the
/// window discards every session, so asking only about the connection the UI happens to be showing
/// would silently throw away another tab's transaction.
#[tauri::command]
pub async fn tx_any_pending() -> Result<Value, String> {
    Box::pin(async move { Ok(json!({ "anyPending": any_pending() })) }).await
}

/// Turn auto-commit on or off. Turning it ON while a transaction is open is rejected rather than
/// resolved for the user — committing and rolling back are both destructive in one direction, and
/// guessing which one was meant is not ours to do.
#[tauri::command]
pub async fn tx_set_autocommit(conn_id: String, enabled: bool) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        if enabled && has_pending(&conn_id) {
            return Err(
                "Transaction đang mở — hãy commit hoặc rollback trước khi bật lại auto-commit"
                    .to_string(),
            );
        }
        // An open-but-empty transaction has nothing to lose, so close it quietly.
        if enabled && is_open(&conn_id) {
            let conn = current_conn(&state, &conn_id).ok();
            if let Some(c) = &conn {
                let mut guard = lock_pinned(c).await?;
                if let Some(pinned) = guard.as_mut() {
                    let _ = raw_on_pinned(pinned, c, "ROLLBACK").await;
                }
                *guard = None;
            }
            let session = session_for(&conn_id);
            let mut m = session.meta.lock().map_err(|e| e.to_string())?;
            m.close();
        }
        {
            let session = session_for(&conn_id);
            let mut m = session.meta.lock().map_err(|e| e.to_string())?;
            m.autocommit = enabled;
        }
        if enabled {
            release_if_closed(&conn_id).await;
        }
        emit_state(&conn_id);
        Ok(status_json(&conn_id))
    })
    .await
}

#[tauri::command]
pub async fn tx_set_isolation(
    conn_id: String,
    level: Option<String>,
    read_only: Option<bool>,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn = current_conn(&state, &conn_id)?;
        let dialect = dialect_of(&conn);
        if let Some(l) = &level
            && !isolation_allowed(dialect, l)
        {
            return Err("Mức cô lập không hợp lệ cho hệ quản trị này".to_string());
        }
        {
            let session = session_for(&conn_id);
            let mut m = session.meta.lock().map_err(|e| e.to_string())?;
            m.isolation = level.map(|l| l.to_uppercase());
            if let Some(ro) = read_only {
                m.read_only = ro;
            }
        }
        emit_state(&conn_id);
        Ok(status_json(&conn_id))
    })
    .await
}

async fn end_tx(state: crate::AppState, conn_id: &str, sql: &str) -> Result<Value, String> {
    if !is_open(conn_id) {
        return Err("Không có transaction nào đang mở".to_string());
    }
    // `conn_id` is already a `&str` here, unlike the commands that own a `String`.
    let conn = current_conn(&state, conn_id)?;
    let mut guard = lock_pinned(&conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    let out = raw_on_pinned(pinned, &conn, sql).await;
    drop(guard);

    // The transaction is over either way: a failed COMMIT on Postgres (serialization failure,
    // deferred constraint) has already rolled the whole thing back, and leaving the UI showing an
    // open transaction would invite a second COMMIT against nothing.
    {
        let session = session_for(conn_id);
        let mut m = session.meta.lock().map_err(|e| e.to_string())?;
        m.close();
    }
    release_if_closed(conn_id).await;
    emit_state(conn_id);
    out.map(|_| status_json(conn_id))
}

#[tauri::command]
pub async fn tx_commit(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        end_tx(state, &conn_id, "COMMIT").await
    })
    .await
}

#[tauri::command]
pub async fn tx_rollback(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        end_tx(state, &conn_id, "ROLLBACK").await
    })
    .await
}

#[tauri::command]
pub async fn tx_savepoint(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let clean = sanitize_savepoint(&name)?;
        let conn = current_conn(&state, &conn_id)?;
        run_raw(&conn, format!("SAVEPOINT {}", clean)).await?;
        Ok(status_json(&conn_id))
    })
    .await
}

#[tauri::command]
pub async fn tx_rollback_to(conn_id: String, name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let clean = sanitize_savepoint(&name)?;
        let conn = current_conn(&state, &conn_id)?;
        run_raw(&conn, format!("ROLLBACK TO SAVEPOINT {}", clean)).await?;
        Ok(status_json(&conn_id))
    })
    .await
}
