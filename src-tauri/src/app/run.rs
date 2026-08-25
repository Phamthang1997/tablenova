//! Tauri bootstrap: builds the `Builder`, attaches plugins, `manage`s state and wires the handler.
//!
//! `setup.rs` and `handlers.rs` are two pieces of this very Builder, so it has to sit next to them
//! rather than in `lib.rs` — `lib.rs` only does what nothing else can: declare the modules.

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            super::setup::init(app);
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(super::handlers::handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
