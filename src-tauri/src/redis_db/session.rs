//! Vòng đời một kết nối Redis: connect / disconnect / đổi db index / cờ chỉ-đọc.
//!
//! Một `conn_id` = một `(server, db index)`. Đổi db index là MỞ KẾT NỐI KHÁC, không phải đổi
//! state dùng chung — đó là thứ giữ cho hai tab key trên hai db không đọc nhầm của nhau.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::redis_db::caps::probe_caps;
use crate::redis_db::conn::make_conn;

// ---- Commands ----

/// The name a Redis `(server, db index)` is filed under in the registry — the `db` field the rail
/// draws, and what `find` matches on so opening the same index twice is idempotent.
pub(crate) fn redis_db_name(index: i64) -> String {
    format!("db{}", index)
}

#[tauri::command]
pub async fn redis_connect(state: tauri::State<'_, crate::AppState>, config: Value) -> Result<Value, String> {
    let db_index = config.get("dbIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    // Mở SSH tunnel trước: conn_config trỏ về 127.0.0.1:<cổng chuyển tiếp>, và chính conn_config
    // đó được lưu lại để mọi lần reconnect sau (đổi db index, Pub/Sub, Profiler) dùng lại đúng
    // cổng này thay vì mở tunnel mới.
    let (conn_config, tunnel) = crate::database::apply_ssh_tunnel(&config, 6379).await?;
    let mut conn = make_conn(&conn_config, db_index).await?;

    // PING để chắc chắn kết nối/authenticate OK.
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| format!("PING lỗi: {}", e))?;

    let caps = probe_caps(&mut conn).await;
    let read_only = config.get("readOnly").and_then(|v| v.as_bool()).unwrap_or(false);

    let conn_id = crate::state::mint_id();
    // `ServerHandle` giữ config đã TUNNEL, khác với SQL (giữ config gốc rồi mở tunnel lại mỗi lần
    // dựng pool). Redis reconnect nhiều hơn — đổi db index, Pub/Sub, Profiler đều mở socket mới —
    // và tunnel đã sống sẵn ngay trên handle này, nên dựng lại là mở thừa một cổng chuyển tiếp.
    let server = Arc::new(crate::state::ServerHandle::new(
        crate::state::mint_id(),
        "redis".to_string(),
        conn_config,
        tunnel,
    ));
    state.connections.insert(
        conn_id.clone(),
        crate::state::ConnEntry {
            read_only,
            server,
            db: redis_db_name(db_index),
            conn: crate::state::LiveConn::Redis(crate::state::RedisConn {
                conn,
                db_index,
                caps: caps.clone(),
            }),
            // Redis không có schema. `None` chứ không phải `Some("")`: `pg_schema_of` mặc định
            // `public`, và một chuỗi rỗng ở đây sẽ đi vào scopeKey của frontend.
            current_schema: None,
        },
    )?;

    Ok(json!({
        "success": true,
        "connId": &*conn_id,
        "dbIndex": db_index,
        "caps": caps.to_json(),
        "readOnly": read_only,
    }))
}

/// Mirrors the app's read-only toggle into the backend. The toggle can be flipped after
/// connecting, so the value cannot be read from the connect config alone.
///
/// Writes the registry's own flag — there is no second Redis-only flag any more, so the rail, the
/// SQL guard and the Redis guard can no longer disagree about one connection.
#[tauri::command]
pub async fn redis_set_read_only(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    flag: bool,
) -> Result<Value, String> {
    state.connections.set_read_only(&conn_id, flag)?;
    Ok(json!({ "success": true, "readOnly": flag }))
}

#[tauri::command]
pub async fn redis_disconnect(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<Value, String> {
    // Dropping the entry releases its `Arc<ServerHandle>`; the SSH tunnel closes with the LAST
    // entry of that server, not with this one — which is the point of putting it there. Ngắt `db3`
    // trong khi `db0` của cùng server còn mở thì cổng chuyển tiếp phải sống tiếp.
    let entry = state.connections.remove(&conn_id)?;
    drop(entry);
    Ok(json!({ "success": true }))
}

/// Đổi database index (0-15).
///
/// Không còn đổi state dùng chung: nó **mở một kết nối khác** trên cùng server và trả về `conn_id`
/// của kết nối đó (§2.1). Frontend chuyển workspace sang id mới, đúng như khi mở database thứ hai
/// của một server Postgres. Idempotent — bấm `db3` hai lần trả về cùng một `conn_id`.
#[tauri::command]
pub async fn redis_select_db(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    index: i64,
) -> Result<Value, String> {
    select_db_inner(&state, &conn_id, index).await
}

// Shared by the command above and by the `SELECT n` interception in `redis_execute_cmd`, so
// the console cannot switch database behind the UI's back.
pub(crate) async fn select_db_inner(
    state: &crate::AppState,
    conn_id: &str,
    index: i64,
) -> Result<Value, String> {
    let (server, read_only) = {
        let ctx = state.connections.acquire_redis(conn_id)?;
        (ctx.server_arc(), ctx.read_only())
    };
    let db = redis_db_name(index);

    // Đã mở sẵn thì dùng lại, không mint pool thứ hai cho cùng một chỗ.
    if let Some(existing) = state.connections.find(&server.id, &db)? {
        return Ok(json!({ "success": true, "connId": &*existing, "dbIndex": index }));
    }

    let config = server.config();
    let mut conn = make_conn(&config, index).await?;
    let _: String = redis::cmd("PING").query_async(&mut conn).await.map_err(|e| e.to_string())?;
    let caps = probe_caps(&mut conn).await;

    let new_id = crate::state::mint_id();
    state.connections.insert(
        new_id.clone(),
        crate::state::ConnEntry {
            // Kế thừa cờ read-only của kết nối mở ra nó: cùng một server, và ai đã đánh dấu
            // production chỉ đọc thì có ý nói mọi db index của nó. Cùng lý lẽ với `open_database`.
            read_only,
            // CÙNG `Arc<ServerHandle>`: một `ServerHandle` khác sẽ mở tunnel riêng và đóng nó ngay
            // khi kết nối đầu tiên biến mất.
            server,
            db,
            conn: crate::state::LiveConn::Redis(crate::state::RedisConn { conn, db_index: index, caps }),
            current_schema: None,
        },
    )?;
    Ok(json!({ "success": true, "connId": &*new_id, "dbIndex": index }))
}
