//! The time limit for ONE statement the user asked to run — a client-side fence.

use serde_json::{Value, json};

/// The time limit for ONE statement the user runs, read from the connection's config
/// (`statementTimeoutSecs`, 0/absent = off).
///
/// This is a **client-side** fence: when the time is up the future is dropped, sqlx closes that connection and the
/// UI is handed back immediately. It is not the server's `statement_timeout`, so the server may keep running the
/// statement until it notices the socket has closed. In exchange — and this is why it was done this way — it
/// leaves no state whatsoever in the session: setting `statement_timeout` at the pool level makes every connection
/// taken afterwards carry that limit, including work that is **long by design** such as restoring a
/// dump, generating data or `CREATE INDEX`, and every exception is another `SET` that has to be reverted
/// at the right moment. Here no exception is needed: the limit only exists inside the four commands the user
/// presses Run on, and the long-running work takes another path.
pub(crate) fn stmt_timeout(config: &Value) -> Option<std::time::Duration> {
    let secs = config
        .get("statementTimeoutSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    (secs > 0).then(|| std::time::Duration::from_secs(secs))
}

/// Change a connection's statement time limit **while it is running**.
///
/// It writes into the server's own config in the registry, and `stmt_timeout` reads that config every time a
/// command runs — so the new value takes effect from the next statement on, with no reconnect. This is the
/// reward for not setting `statement_timeout` at the session level: there is no server-side state that has to
/// be resynchronised.
///
/// The scope is the **server**, not the individual connection: databases opened on the same server share one
/// `ServerHandle`, exactly the scope the frontend stores (`connKey`).
#[tauri::command]
pub async fn set_statement_timeout(conn_id: String, secs: u64) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.server()
            .set_config_field("statementTimeoutSecs", json!(secs));
        Ok(json!({ "success": true, "secs": secs }))
    })
    .await
}

/// The timeout message. It is a Vietnamese literal, so it has a twin in `backendErrors.ts`.
pub(crate) fn timeout_msg(limit: std::time::Duration) -> String {
    format!("Câu lệnh đã chạy quá {} giây và bị dừng", limit.as_secs())
}

/// Run a future under the connection's limit. `None` = run as before, adding no layer.
pub(crate) async fn with_timeout<T, F>(
    limit: Option<std::time::Duration>,
    fut: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    match limit {
        None => fut.await,
        Some(d) => match tokio::time::timeout(d, fut).await {
            Ok(r) => r,
            Err(_) => Err(timeout_msg(d)),
        },
    }
}
