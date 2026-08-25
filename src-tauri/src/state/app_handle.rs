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
