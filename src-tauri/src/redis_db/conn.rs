//! Lấy connection ra khỏi registry, và mở connection RIÊNG cho Pub/Sub và Monitor.

use redis::aio::MultiplexedConnection;
use serde_json::Value;

use crate::redis_db::config::make_client;

pub(crate) async fn make_conn(config: &Value, db_index: i64) -> Result<MultiplexedConnection, String> {
    let client = make_client(config, db_index)?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Không thể kết nối Redis: {}", e))
}

// Lấy một handle connection đã clone (drop lock trước khi await).
pub(crate) fn take_conn(state: &crate::AppState, conn_id: &str) -> Result<MultiplexedConnection, String> {
    Ok(state.connections.acquire_redis(conn_id)?.conn())
}

// Refuses every write when read-only mode is on. Called by each mutating command rather
// than by one wrapper, because there is no single funnel: the element editors talk to their
// own Redis command directly (see the block comment above `redis_hash_set`).
pub(crate) fn ensure_writable(state: &crate::AppState, conn_id: &str) -> Result<(), String> {
    if state.connections.is_read_only(conn_id) {
        return Err("Chế độ chỉ đọc: không thể ghi vào Redis".to_string());
    }
    Ok(())
}

// ---- Pub/Sub and Profiler ----
// Both need their OWN connection: `SUBSCRIBE` and `MONITOR` switch a connection into push
// mode, and the app's `MultiplexedConnection` is shared by every other Redis feature — using
// it here would break all of them (which is why `redis_execute_cmd` refuses these commands).
// Each session is stopped through the existing `cancel_query(query_id)` path.

/// Opens a second connection to the same server/database as the active one.
pub(crate) async fn dedicated_client(state: &crate::AppState, conn_id: &str) -> Result<redis::Client, String> {
    let ctx = state.connections.acquire_redis(conn_id)?;
    // Config + db index của CHÍNH kết nối này, không phải của một state toàn cục: Pub/Sub và
    // Profiler mở socket riêng, và socket đó phải nằm trên đúng db mà tab của nó đang xem.
    make_client(&ctx.config(), ctx.db_index())
        .map_err(|e| format!("Không mở được kết nối riêng cho Redis: {}", e))
}
