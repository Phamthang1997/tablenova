//! Hai backend của bảng Terminal (`TerminalPanel.tsx`): shell cục bộ và shell qua SSH.
//!
//! Chúng nằm chung một thư mục vì dùng CHUNG một giao thức message đẩy về frontend, nên
//! frontend chỉ có một component cho cả hai — đổi giao thức ở một bên mà quên bên kia thì
//! component đó vỡ:
//!
//! ```text
//! { type: "data",   bytes: [...] }   output (mảng byte, xterm tự giải mã UTF-8)
//! { type: "exit",   code }           shell thoát (chỉ SSH)
//! { type: "closed" }                 phiên đã đóng
//! ```

pub mod local;
pub mod ssh;
