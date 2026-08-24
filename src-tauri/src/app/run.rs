//! Bootstrap của Tauri: dựng `Builder`, gắn plugin, `manage` state và nối handler.
//!
//! `setup.rs` và `handlers.rs` là hai mảnh của chính Builder này, nên nó phải nằm cạnh chúng
//! chứ không ở `lib.rs` — `lib.rs` chỉ còn làm việc mà duy nhất nó làm được: khai báo module.

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
