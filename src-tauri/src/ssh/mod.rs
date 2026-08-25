//! Speaking SSH. Two separate jobs, with `auth` as the shared part:
//!
//! - `auth.rs`   — connect + authenticate (password or private key)
//! - `tunnel.rs` — port forwarding for SQL and Redis
//!
//! `terminal/ssh.rs` (PTY/shell) uses `auth` too but is NOT here: it belongs to
//! `terminal/` next to the local one, because the two terminal panels share one message protocol
//! and that is the fragile constraint. SSH is only its transport.

pub mod auth;
pub mod tunnel;

pub use auth::*;
pub use tunnel::*;
