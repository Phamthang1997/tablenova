pub mod app;
pub mod aws_iam;
pub mod data_generator;
pub mod database;
pub mod datasets;
pub mod db_compare;
pub mod db_stats;
pub mod export;
pub mod local_terminal;
pub mod oauth;
pub mod redis_cmds;
pub mod redis_db;
pub mod secret_store;
pub mod ssh_terminal;
pub mod ssh_tunnel;
pub mod state;
pub mod tx_session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

pub struct AppState {
    // Mọi kết nối đang mở — SQL LẪN REDIS — khoá theo `conn_id`
    // (docs/multi-connection-plan.md §4.3, docs/redis-ui-unification-plan.md §2.3). Đây là nguồn
    // sự thật DUY NHẤT: `DatabaseManager` (một `Option<DbConnection>` cho cả app) và `RedisState`
    // (một connection Redis cho cả app) đều đã bị xoá.
    pub connections: state::ConnRegistry,
    // Cờ hủy cho các truy vấn đang stream (query_id -> cờ). execute_query_stream đăng ký,
    // cancel_query bật cờ để dừng vòng lặp đẩy dữ liệu.
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // Các phiên SSH Terminal đang mở (session_id -> phiên).
    pub ssh_terminals: ssh_terminal::SshTerminalMap,
    // Các phiên Local Terminal (shell cục bộ) đang mở.
    pub local_terminals: local_terminal::LocalTerminalMap,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            app::setup::init(app);
            Ok(())
        })
        .manage(AppState {
            connections: state::ConnRegistry::new(),
            cancel_flags: Mutex::new(HashMap::new()),
            ssh_terminals: Mutex::new(HashMap::new()),
            local_terminals: Mutex::new(HashMap::new()),
        })
        .invoke_handler(app::handlers::handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
