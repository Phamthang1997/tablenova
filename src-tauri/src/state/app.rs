//! `AppState` — mọi handle còn sống mà app sở hữu, tức thứ Tauri `manage()`.
//!
//! Nằm trong `state/` chứ không trong `app/`: trường lớn nhất của nó CHÍNH LÀ `ConnRegistry`
//! ngay cạnh đây, và tách hai thứ lồng nhau ra hai thư mục thì tệ hơn là để chung.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::registry::ConnRegistry;
use crate::terminal;

pub struct AppState {
    // Mọi kết nối đang mở — SQL LẪN REDIS — khoá theo `conn_id`
    // (docs/multi-connection-plan.md §4.3, docs/redis-ui-unification-plan.md §2.3). Đây là nguồn
    // sự thật DUY NHẤT: `DatabaseManager` (một `Option<DbConnection>` cho cả app) và `RedisState`
    // (một connection Redis cho cả app) đều đã bị xoá.
    pub connections: ConnRegistry,
    // Cờ hủy cho các truy vấn đang stream (query_id -> cờ). execute_query_stream đăng ký,
    // cancel_query bật cờ để dừng vòng lặp đẩy dữ liệu.
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // Các phiên SSH Terminal đang mở (session_id -> phiên).
    pub ssh_terminals: terminal::ssh::SshTerminalMap,
    // Các phiên Local Terminal (shell cục bộ) đang mở.
    pub local_terminals: terminal::local::LocalTerminalMap,
}

impl AppState {
    /// Trạng thái lúc khởi động: chưa có kết nối, chưa có phiên terminal nào.
    pub fn new() -> Self {
        AppState {
            connections: ConnRegistry::new(),
            cancel_flags: Mutex::new(HashMap::new()),
            ssh_terminals: Mutex::new(HashMap::new()),
            local_terminals: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
