//! The four introspection tools: what connections exist, and what is inside one.
//!
//! These reuse the very bodies the TableNova UI calls, through the `*_inner` entry points that take
//! an `&AppState` instead of a `tauri::State`. That is the point - schema introspection is a pile of
//! dialect-specific SQL, and a second copy written for AI clients would answer a different question
//! from the sidebar within a release or two.
//!
//! Reusing them is only safe because `policy::resolve` has already refused a connection in manual
//! commit mode: these bodies go through the ROUTED funnel, which would otherwise open the user's
//! transaction for them. See `policy::reject_if_manual`.

use crate::mcp::audit::Refusal;
use rmcp::model::CallToolResult;


use super::{app_state, json_result, passthrough};
use crate::mcp::policy;

/// Every connection the user shared, and nothing else - the filtering happens in the registry so no
/// tool can forget it.
pub async fn list_connections() -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    let connections = state.connections.list_mcp_exposed().map_err(passthrough)?;
    json_result(&serde_json::json!({ "connections": connections }))
}

pub async fn list_databases(connection_id: &str) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    policy::resolve(&state, connection_id)?;
    let out = crate::database::introspect::list_databases_inner(&state, connection_id.to_string())
        .await
        .map_err(passthrough)?;
    json_result(&out)
}

pub async fn list_tables(connection_id: &str) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    policy::resolve(&state, connection_id)?;
    let out = crate::database::introspect::get_tables_inner(&state, connection_id.to_string())
        .await
        .map_err(passthrough)?;
    json_result(&out)
}

pub async fn describe_table(
    connection_id: &str,
    table_name: &str,
) -> Result<CallToolResult, Refusal> {
    let state = app_state()?;
    policy::resolve(&state, connection_id)?;
    let out = crate::database::introspect::get_table_schema_inner(
        &state,
        connection_id.to_string(),
        table_name.to_string(),
    )
    .await
    .map_err(passthrough)?;
    json_result(&out)
}
