//! `AppState` — every live handle the app owns, i.e. the thing Tauri `manage()`s.
//!
//! It lives in `state/` rather than in `app/`: its biggest field IS the `ConnRegistry` right next
//! to it, and splitting two nested things across two directories would be worse than keeping them together.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::registry::ConnRegistry;
use crate::terminal;

pub struct AppState {
    // Every open connection — SQL AND REDIS — keyed by `conn_id`
    // (docs/multi-connection-plan.md §4.3, docs/redis-ui-unification-plan.md §2.3). This is the ONE
    // source of truth: `DatabaseManager` (a single `Option<DbConnection>` for the whole app) and
    // `RedisState` (a single Redis connection for the whole app) have both been deleted.
    pub connections: ConnRegistry,
    // Cancel flags for in-flight streaming queries (query_id -> flag). execute_query_stream registers one,
    // cancel_query raises it to stop the row-pushing loop.
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // The open SSH Terminal sessions (session_id -> session).
    pub ssh_terminals: terminal::ssh::SshTerminalMap,
    // The open Local Terminal (local shell) sessions.
    pub local_terminals: terminal::local::LocalTerminalMap,
    // The built-in MCP server (docs/mcp-server-plan.md). One per app, and it holds only its own
    // listener - the connections it will serve live in `connections` above, like everything else.
    pub mcp: crate::mcp::McpServer,
}

impl AppState {
    /// State at startup: no connection, and no terminal session.
    pub fn new() -> Self {
        AppState {
            connections: ConnRegistry::new(),
            cancel_flags: Mutex::new(HashMap::new()),
            ssh_terminals: Mutex::new(HashMap::new()),
            local_terminals: Mutex::new(HashMap::new()),
            mcp: crate::mcp::McpServer::default(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
