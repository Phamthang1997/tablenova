//! The MCP surface: what an AI client can actually call.
//!
//! **Deliberately empty of database tools right now.** Defence layers 3 and 4 (per-connection
//! exposure, and the read-only statement filter) are not built yet, so there is nothing here that
//! could reach a database even if a client authenticated. The transport is real and testable; the
//! surface opens in Bước 2 of `docs/mcp-server-plan.md`, once the things guarding it exist.
//!
//! When tools do land, they go in sibling files (`catalog.rs`, `data.rs`) and are declared with
//! `#[tool]`, whose generated JSON Schema comes from the Rust parameter struct - so the schema an AI
//! reads and the struct the code destructures cannot drift apart.

use rmcp::{
    ServerHandler,
    handler::server::router::tool::ToolRouter,
    model::{Implementation, ServerCapabilities, ServerInfo},
    tool_handler, tool_router,
};

#[derive(Clone)]
pub struct TableNovaMcp {
    // Unread until the first `#[tool]` lands (Bước 2): with an empty router the generated
    // `#[tool_handler]` dispatch never needs to look at it. The field itself is not optional -
    // `#[tool_router]` and `#[tool_handler]` both expect it by this exact name.
    #[allow(dead_code)]
    tool_router: ToolRouter<TableNovaMcp>,
}

#[tool_router]
impl TableNovaMcp {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
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
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "TableNova exposes the databases the user already has open. \
                 No tools are available yet: this build ships the transport only."
                    .to_string(),
            )
    }
}
