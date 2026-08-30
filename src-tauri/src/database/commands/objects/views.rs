//! Views: saving a definition.

use serde_json::{json, Value};

use crate::database::execute_raw_sql_generic;

#[tauri::command]
pub async fn save_view_definition(conn_id: String, view_sql: String) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    execute_raw_sql_generic(&conn_type, view_sql).await?;
    Ok(json!({ "success": true, "message": "Đã lưu View thành công" }))
}
