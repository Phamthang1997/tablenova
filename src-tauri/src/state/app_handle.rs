//! `AppHandle` được park lại cho những tầng nhận `&DbConnection` mà không nhận `AppState`.

use std::sync::{Mutex, OnceLock};

use super::ids::ConnId;

/// `AppHandle` parked so the three SQL funnels can reach the registry.
///
/// They receive a `&DbConnection` and no `AppState` — the same shape that made `tx/` keep its
/// state in a module-level static. The difference here is deliberate: this parks a *handle* and
/// reads the registry through it, so the read-only flag has exactly one home (`ConnEntry`). A second
/// copy kept in sync would be the duplicate-cache mistake this codebase has paid for twice already.
static APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();

fn app_slot() -> &'static Mutex<Option<tauri::AppHandle>> {
    APP.get_or_init(|| Mutex::new(None))
}

/// Called once from `lib.rs` setup.
pub fn set_app_handle(app: tauri::AppHandle) {
    if let Ok(mut slot) = app_slot().lock() {
        *slot = Some(app);
    }
}

/// Is this connection refusing writes?
///
/// `false` for an ad-hoc pool (it is this process's own, never the user's) and whenever the handle
/// is not parked yet — failing open here matches every other lookup in this module, and the flag is
/// only ever true because a user turned it on.
pub fn conn_is_read_only(id: &ConnId) -> bool {
    let ConnId::Session(sid) = id else {
        return false;
    };
    let guard = match app_slot().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let Some(app) = guard.as_ref() else {
        return false;
    };
    use tauri::Manager;
    app.state::<crate::AppState>().connections.is_read_only(sid)
}
