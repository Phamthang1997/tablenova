# Project Rules & Guidelines for TableNova

## Quy tắc CSS & Styling
- **Không được phép sử dụng Inline CSS** (`style={{ ... }}`).
- Tất cả giao diện UI phải sử dụng **CSS Classes** định nghĩa trong `src/index.css` (hoặc tệp `.css` tương ứng).
- **Ngoại lệ duy nhất**: Chỉ dùng inline style khi giá trị thuộc tính là dữ liệu động tính toán runtime (như tọa độ chuột, thanh phần trăm progress, màu động từ user picker).

## Quy tắc Cấu trúc Module & Tính năng Rust (`src-tauri`)
- **Tổ chức theo đúng thư mục domain**:
  - Tính năng thuộc domain có sẵn (`database`, `redis_db`, `compare`, `credentials`, `datagen`, `ssh`, `terminal`, `stats`, `tx`, `state`, `app`) phải đặt vào thư mục tương ứng trong `src-tauri/src/<domain>/`.
  - Tính năng/Domain mới: Tạo thư mục mới `src-tauri/src/<feature_name>/` kèm `mod.rs` và khai báo `pub mod <feature_name>;` trong `src-tauri/src/lib.rs`.
- **Cấm viết logic trực tiếp trong `src-tauri/src/lib.rs` hoặc `main.rs`**: `lib.rs` chỉ dùng để khai báo module và re-export cần thiết (`AppState`, `run`).
- **Đăng ký `#[tauri::command]`**: Mọi command mới bắt buộc phải được thêm vào danh sách `tauri::generate_handler![...]` trong `src-tauri/src/app/handlers.rs`.
- **Quản lý State**: Trạng thái dùng chung phải được gắn vào `AppState` trong `src-tauri/src/state/`.

