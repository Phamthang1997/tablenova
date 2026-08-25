//! The MCP surface: the six tools an AI client can call, and nothing else.
//!
//! This file holds the DECLARATIONS - names, parameter schemas, descriptions - because
//! `#[tool_router]` wants them in one impl block. The bodies live in `catalog.rs` (introspection)
//! and `data.rs` (rows).
//!
//! Every tool is a read. There is no write tool in this build, and adding one is not a matter of
//! writing another method: defence layer 5 (interactive approval) does not exist yet, and a write
//! that reaches the database without it commits on a pooled connection the user cannot roll back.
//! See `docs/mcp-server-plan.md` §3.5.
//!
//! Parameter structs derive `JsonSchema`, so the schema an AI reads is generated from the very
//! struct the body destructures - the two cannot drift.

mod catalog;

mod data;

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnArgs {
    /// From tablenova_list_connections.
    pub connection_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableArgs {
    /// From tablenova_list_connections.
    pub connection_id: String,
    /// Unqualified table or view name, as tablenova_list_tables reports it.
    pub table_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PreviewArgs {
    /// From tablenova_list_connections.
    pub connection_id: String,
    /// Unqualified table or view name, as tablenova_list_tables reports it.
    pub table_name: String,
    /// Rows to return. Default 100, capped at 1000.
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryArgs {
    /// From tablenova_list_connections.
    pub connection_id: String,
    /// Exactly ONE read statement: SELECT, EXPLAIN, SHOW, DESCRIBE or DESC.
    pub sql: String,
    /// Rows to return. Default 100, capped at 1000.
    pub limit: Option<usize>,
}

#[derive(Clone)]
pub struct TableNovaMcp {
    // Unread until a tool needs per-call state: with a static router the generated dispatch in
    // `#[tool_handler]` never looks at the field. It is not optional - both macros expect a field
    // of this exact name and type.
    #[allow(dead_code)]
    tool_router: ToolRouter<TableNovaMcp>,
}

#[tool_router]
impl TableNovaMcp {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(
        description = "List the database connections the TableNova user has shared with AI clients. \
                       Always call this first: every other tool needs a connection_id from here, and \
                       connections the user did not share are invisible."
    )]
    async fn tablenova_list_connections(&self) -> Result<CallToolResult, McpError> {
        catalog::list_connections().await
    }

    #[tool(description = "List the databases (or schemas) reachable on one connection.")]
    async fn tablenova_list_databases(
        &self,
        Parameters(a): Parameters<ConnArgs>,
    ) -> Result<CallToolResult, McpError> {
        catalog::list_databases(&a.connection_id).await
    }

    #[tool(
        description = "List the tables and views of the database a connection is open on, with row \
                       count estimates."
    )]
    async fn tablenova_list_tables(
        &self,
        Parameters(a): Parameters<ConnArgs>,
    ) -> Result<CallToolResult, McpError> {
        catalog::list_tables(&a.connection_id).await
    }

    #[tool(
        description = "Describe one table: columns, types, nullability, primary key, foreign keys \
                       and indexes. Prefer this over SELECT * when you only need the shape."
    )]
    async fn tablenova_describe_table(
        &self,
        Parameters(a): Parameters<TableArgs>,
    ) -> Result<CallToolResult, McpError> {
        catalog::describe_table(&a.connection_id, &a.table_name).await
    }

    #[tool(
        description = "Read the first rows of a table, to see what the data actually looks like. \
                       Cheaper and safer than writing a SELECT for the same thing."
    )]
    async fn tablenova_preview_table(
        &self,
        Parameters(a): Parameters<PreviewArgs>,
    ) -> Result<CallToolResult, McpError> {
        data::preview_table(&a.connection_id, &a.table_name, a.limit).await
    }

    #[tool(
        description = "Run ONE read-only SQL statement (SELECT, EXPLAIN, SHOW, DESCRIBE) and return \
                       the rows. Writes and DDL are refused - ask the user to run those in TableNova \
                       themselves. Check `truncated` in the result before drawing conclusions from a \
                       row count."
    )]
    async fn tablenova_query(
        &self,
        Parameters(a): Parameters<QueryArgs>,
    ) -> Result<CallToolResult, McpError> {
        data::query(&a.connection_id, &a.sql, a.limit).await
    }
}

impl Default for TableNovaMcp {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_handler]
impl ServerHandler for TableNovaMcp {
    fn get_info(&self) -> ServerInfo {
        // No `with_protocol_version(...)`: the default is whatever revision this build of `rmcp`
        // implements. Pinning one here would freeze the app at a revision the SDK has moved past,
        // which is the exact failure the SDK was adopted to avoid.
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            // NOT `Implementation::from_build_env()`: that macro reads the CARGO_PKG_* of the crate
            // it expands in, which is `rmcp` - so the server introduced itself to every client as
            // "rmcp 3.1.4" instead of TableNova. Spelled out here, it reads this crate's own.
            .with_server_info(tablenova_identity())
            .with_instructions(
                "TableNova exposes the databases its user already has open, read-only. Start with \
                 tablenova_list_connections. Writes are refused by design; ask the user to make \
                 changes in TableNova itself."
                    .to_string(),
            )
    }
}

// ---------------------------------------------------------------------------
// Shared by the tool bodies
// ---------------------------------------------------------------------------

/// The parked `AppHandle`, or an error saying the app is not ready.
///
/// A tool that runs before setup finished is a client that connected during startup - rare, and
/// answerable, which is better than a panic in an axum task nobody is watching.
pub(super) fn app_state() -> Result<crate::AppState, McpError> {
    crate::state::parked_state()
        .ok_or_else(|| McpError::internal_error("TableNova is still starting up".to_string(), None))
}

/// Wraps an error string from shared TableNova code.
///
/// Known wart, recorded rather than papered over: these messages come from code the UI also uses, so
/// they arrive in Vietnamese. Translating them here would mean a second copy of
/// `src/utils/backendErrors.ts` in Rust, which is a worse trade than an AI client occasionally
/// reading a Vietnamese driver error. Messages this module writes itself are English.
pub(super) fn passthrough(err: String) -> McpError {
    McpError::internal_error(err, None)
}

/// A tool result carrying JSON.
///
/// Pretty-printed text rather than a structured payload: every MCP client renders text content, and
/// the shape is already self-describing. Worth revisiting once structured output is universal.
pub(super) fn json_result(value: &Value) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// How the server introduces itself.
///
/// NOT `Implementation::from_build_env()`, which every rmcp example uses: that macro reads the
/// CARGO_PKG_* of the crate it expands in - `rmcp` - so the server announced itself to every client
/// as "rmcp 3.1.4". A client listing its MCP servers would show the SDK's name instead of this app's.
fn tablenova_identity() -> Implementation {
    let mut me = Implementation::from_build_env();
    me.name = "tablenova".to_string();
    me.version = env!("CARGO_PKG_VERSION").to_string();
    me
}
