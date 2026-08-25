//! `AppState` — every live handle the app owns, i.e. the thing Tauri `manage()`s.
//!
//! It lives in `state/` rather than in `app/`: its biggest field IS the `ConnRegistry` right next
//! to it, and splitting two nested things across two directories would be worse than keeping them together.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::registry::ConnRegistry;
use crate::terminal;

/// Everything `AppState` owns. Reached through `AppState`'s `Deref`, so `state.connections` reads
/// the same at all 150-odd call sites as it did when this WAS `AppState`.
pub struct AppStateInner {
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

/// A cheap handle to the one `AppStateInner`, not the state itself.
///
/// Tauri `manage()`s one clone and `state::parked()` holds another, which is what lets the MCP
/// server reach the registry **without touching a single Tauri type**. That mattered concretely: an
/// earlier version went through `AppHandle`, and pulling Tauri's window layer into the crate made
/// every `cargo test --lib` binary import comctl32 v6 symbols (`TaskDialogIndirect`,
/// `SetWindowSubclass`). Test binaries carry no application manifest, so Windows resolved comctl32
/// v5 and the whole suite died at load with STATUS_ENTRYPOINT_NOT_FOUND - 101 unrelated tests taken
/// out by a feature that had not shipped yet.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

impl std::ops::Deref for AppState {
    type Target = AppStateInner;

    fn deref(&self) -> &AppStateInner {
        &self.inner
    }
}

impl AppState {
    /// State at startup: no connection, and no terminal session.
    pub fn new() -> Self {
        let state = AppState {
            inner: Arc::new(AppStateInner {
                connections: ConnRegistry::new(),
                cancel_flags: Mutex::new(HashMap::new()),
                ssh_terminals: Mutex::new(HashMap::new()),
                local_terminals: Mutex::new(HashMap::new()),
                mcp: crate::mcp::McpServer::default(),
            }),
        };
        // Parked here rather than at the `manage()` call site so that nothing in the Tauri
        // bootstrap has to know this second holder exists - and so `run.rs` keeps referring to no
        // state machinery at all. See `state/app_handle.rs` for why the MCP server needs it.
        super::app_handle::park_state(state.clone());
        state
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
