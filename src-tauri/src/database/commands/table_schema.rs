//! `get_table_schema` — the columns / indexes / foreign keys of ONE table, for the structure editor.
//!
//! The body lives in `database/introspect.rs`, which the MCP server shares. See that file for why
//! it may not sit next to a `#[tauri::command]`.

use serde_json::Value;

use crate::database::introspect::get_table_schema_inner;

#[tauri::command]
pub async fn get_table_schema(state: tauri::State<'_, crate::AppState>, conn_id: String, name: String) -> Result<Value, String> {
    get_table_schema_inner(&state, conn_id, name).await
}
