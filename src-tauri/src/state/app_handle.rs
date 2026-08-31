//! The handles parked for the layers that receive a `&DbConnection` but no `AppState`.
//!
//! **No Tauri types live here, deliberately.** This module used to park an `AppHandle` and read the
//! registry through `AppHandle::state()`. That linked Tauri's window layer into everything that
//! could reach it, which on Windows put comctl32 v6 imports into every `cargo test --lib` binary and
//! killed the whole suite at load - test binaries carry no application manifest, so the loader bound
//! comctl32 v5 and the symbols were not there. Parking the `AppState` handle itself costs one
//! pointer and keeps Tauri confined to `app/`.

use std::sync::{Mutex, OnceLock};

use super::ids::ConnId;

static STATE: OnceLock<Mutex<Option<crate::AppState>>> = OnceLock::new();

fn state_slot() -> &'static Mutex<Option<crate::AppState>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Called once from `AppState::new()`, with a clone of the very handle Tauri will `manage()`.
pub fn park_state(state: crate::AppState) {
    if let Ok(mut slot) = state_slot().lock() {
        *slot = Some(state);
    }
}

/// The parked state, or `None` before it has been built.
///
/// Callers treat `None` as "the app is not ready yet", never as a default answer - the MCP server
/// answers a client that connected mid-startup with exactly that.
pub fn parked_state() -> Option<crate::AppState> {
    let guard = match state_slot().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    guard.as_ref().cloned()
}

/// The parked state for a `#[tauri::command]`, which is why it returns an error rather than `None`.
///
/// Commands read the state through this INSTEAD of taking a `tauri::State<'_, AppState>` parameter,
/// and the reason is a stack overflow, not style. That parameter carries a lifetime, so the
/// command's future is not `'static`; Tauri can only `spawn` a `'static` future onto the async
/// runtime, so a borrowing command is instead built and run on the calling thread — the main
/// thread, whose stack Windows reserves at 1MB. `connect_db` grew past that and the release binary
/// died at launch. Reading the state from here keeps every command `'static`, so the work lands on
/// a runtime worker with a stack of its own.
///
/// The `Err` is unreachable in practice: `AppState::new()` parks the state before `manage()`, which
/// is before any command can be invoked. It is an error rather than a panic because a command that
/// somehow ran first should report that, not take the window down with it.
pub fn require_state() -> Result<crate::AppState, String> {
    parked_state().ok_or_else(|| "Ứng dụng chưa khởi tạo xong".to_string())
}

/// Is this connection refusing writes?
///
/// `false` for an ad-hoc pool (it is this process's own, never the user's) and whenever the state is
/// not parked yet — failing open here matches every other lookup in this module, and the flag is
/// only ever true because a user turned it on.
pub fn conn_is_read_only(id: &ConnId) -> bool {
    let ConnId::Session(sid) = id else {
        return false;
    };
    match parked_state() {
        Some(state) => state.connections.is_read_only(sid),
        None => false,
    }
}

/// How the backend tells the UI something happened, without holding a Tauri type.
///
/// One emitter for the whole app: `tx/` announces transaction state, `mcp/` announces requests an AI
/// client made, and neither needs to know the other exists. `app/setup.rs` installs it - see the
/// module header for why a closure and not an `AppHandle`.
type Emitter = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;

static EMIT: OnceLock<Mutex<Option<Emitter>>> = OnceLock::new();

fn emit_slot() -> &'static Mutex<Option<Emitter>> {
    EMIT.get_or_init(|| Mutex::new(None))
}

/// Called once from `app/setup.rs`.
pub fn set_emitter(emit: impl Fn(&str, serde_json::Value) + Send + Sync + 'static) {
    if let Ok(mut slot) = emit_slot().lock() {
        *slot = Some(Box::new(emit));
    }
}

/// Fire an event at the UI. A no-op before setup has run, and before any window exists - which is
/// correct: there is nobody to tell.
pub fn emit(event: &str, payload: serde_json::Value) {
    let slot = match emit_slot().lock() {
        Ok(s) => s,
        Err(e) => e.into_inner(),
    };
    if let Some(emit) = slot.as_ref() {
        emit(event, payload);
    }
}
