//! Stored procedures / functions: saving a definition.

use serde_json::{json, Value};

use crate::database::execute_raw_sql_generic;

#[tauri::command]
pub async fn save_routine_definition(conn_id: String, routine_sql: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, routine_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu Procedure/Function thành công" }))
}).await
}
