// So sánh CẤU TRÚC và DỮ LIỆU giữa HAI database.
//
// Phase 1 của đa kết nối vẫn chỉ mở MỘT kết nối, nên mỗi "phía" (source/target) được giải quyết
// riêng trong `resolve_side()`: dùng lại kết nối đang mở nếu phía đó trỏ đúng database
// hiện tại, còn không thì mở kết nối TẠM từ `last_config` với database/tệp thay thế —
// cùng cách `get_all_databases_stats` làm khi "quét sâu". Kết nối tạm được đóng ngay
// khi lệnh kết thúc (`Resolved::close`).
//
// Toàn bộ metadata đọc qua `execute_raw_sql_generic` (đã trả về JSON `{columns, data}`)
// nên module này không lặp lại phần giải mã ô dữ liệu của từng driver. Việc pool tạm của
// module không bao giờ bị pin làm phiên transaction của người dùng giờ do CHÍNH KIỂU bảo đảm:
// mỗi pool tạm mang `ConnId::Adhoc` và `should_route` từ chối nó — không còn phụ thuộc vào
// việc nhớ gọi đúng một funnel riêng.
//
// SQL sinh ra (`syncSql`) luôn theo hướng source -> target và theo dialect của TARGET.
// Mọi câu lệnh phá dữ liệu (DROP ...) chỉ được sinh ở dạng thực thi khi
// `includeDrops = true`; mặc định chúng bị comment lại để một script chạy vô tình
// không xoá gì.
//
// NGÔN NGỮ: thông báo lỗi và `warnings` viết tiếng Việt như phần còn lại của backend
// (frontend dịch qua `src/utils/backendErrors.ts`), nhưng phần comment TRONG script SQL
// viết tiếng Anh — script là tệp đem đi chỗ khác (migration, DBeaver, psql/mysql CLI),
// không phải chữ trên giao diện, nên không đi qua bảng dịch.

pub mod read;

mod data_overview;
mod data_rows;
mod diff;
mod ident;
mod meta;
mod schemas;
mod script;
mod side;
mod sync_sql;
mod values;

pub use data_overview::*;
pub use data_rows::*;
pub use schemas::*;
