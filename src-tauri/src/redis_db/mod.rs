// Hỗ trợ Redis như một loại DB thứ 4 — TÁCH BIỆT khỏi enum DbConnection (SQL) để không phá vỡ
// hàng loạt match sẵn có, nhưng nằm CHUNG registry `conn_id` với SQL
// (`docs/redis-ui-unification-plan.md` §2.3): một danh sách kết nối đang mở cho `DbRail`, một vòng
// đời, một cờ read-only. `RedisState` — một connection và một db_index cho cả app — đã bị xoá.
//
// Một `conn_id` = một `(server, db index)` (§2.1). Đổi db index là MỞ MỘT KẾT NỐI KHÁC, không phải
// đổi state dùng chung; đó là thứ giữ cho hai tab key mở trên hai db không đọc nhầm của nhau.
// Dùng redis::aio::MultiplexedConnection (Clone rẻ) theo pattern: lock -> clone -> drop lock -> await.

pub mod cmds;
pub mod keys;
pub mod types;

mod admin;
mod analyze;
mod caps;
mod config;
mod conn;
mod live;
mod session;
mod slowlog;
mod transfer;
mod value;

pub use admin::*;
pub use analyze::*;
pub use caps::RedisCaps;
pub use keys::*;
pub use live::*;
pub use session::*;
pub use slowlog::*;
pub use transfer::*;
pub use types::*;
