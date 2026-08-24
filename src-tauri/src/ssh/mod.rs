//! Nói chuyện SSH. Hai nhiệm vụ tách rời nhau, và `auth` là phần dùng chung:
//!
//! - `auth.rs`   — kết nối + xác thực (password hoặc private key)
//! - `tunnel.rs` — chuyển tiếp cổng cho SQL và Redis
//!
//! `terminal/ssh.rs` (PTY/shell) cũng dùng `auth` nhưng KHÔNG nằm ở đây: nó thuộc về
//! `terminal/` cùng bản local, vì hai bảng terminal chia nhau một giao thức message và đó
//! mới là ràng buộc dễ vỡ. SSH chỉ là đường truyền của nó.

pub mod auth;
pub mod tunnel;

pub use auth::*;
pub use tunnel::*;
