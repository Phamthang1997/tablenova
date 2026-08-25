//! Crate root. It holds ONLY what nothing else can: the module list, plus two re-exports that keep
//! the old paths working (`tablenova::run` for `main.rs`, `crate::AppState` for 152 call sites).

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
