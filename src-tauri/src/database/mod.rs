//! Tất cả những gì nói chuyện với một database SQL.
//!
//! `mod.rs` không chứa logic: nó chỉ khai báo module con và re-export. Dùng `pub use x::*;`
//! (glob) chứ KHÔNG liệt kê từng tên — `#[tauri::command]` sinh kèm một `macro_rules! __cmd__<tên>`
//! ẩn mà `generate_handler!` gọi tới, và chỉ glob mới kéo theo nó.

pub mod exec;

mod commands;
mod conn;
mod decode;
mod dsn;
mod iam;
mod ident;
mod read_only;
mod rows;
mod splitter;
mod timeout;

pub use commands::*;
pub use conn::*;
pub(crate) use dsn::*;
pub(crate) use exec::bound::*;
pub(crate) use exec::raw::*;
pub(crate) use exec::stream::*;
pub(crate) use iam::*;
pub(crate) use ident::*;
pub(crate) use read_only::*;
pub(crate) use rows::*;
pub(crate) use splitter::*;
pub(crate) use timeout::*;
