//! Gốc crate. Ở đây CHỈ có thứ duy nhất nó làm được: danh sách module, cộng hai re-export giữ
//! nguyên đường dẫn cũ (`tablenova::run` cho `main.rs`, `crate::AppState` cho 152 call site).

pub mod app;
pub mod compare;
pub mod credentials;
pub mod database;
pub mod datagen;
pub mod redis_db;
pub mod ssh;
pub mod state;
pub mod stats;
pub mod terminal;
pub mod tx;

pub use app::run::run;
pub use state::AppState;
