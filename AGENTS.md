# Project Rules & Guidelines for TableNova

## Quy tắc CSS & Styling
- **Không được phép sử dụng Inline CSS** (`style={{ ... }}`).
- Tất cả giao diện UI phải sử dụng **CSS Classes** định nghĩa trong `src/index.css` (hoặc tệp `.css` tương ứng).
- **Ngoại lệ duy nhất**: Chỉ dùng inline style khi giá trị thuộc tính là dữ liệu động tính toán runtime (như tọa độ chuột, thanh phần trăm progress, màu động từ user picker).

## Quy tắc Thiết kế Giao diện & Nút bấm (UI & Buttons)
- **Luôn làm nút giống thiết kế hiện tại của TableNova**: Mỗi lựa chọn hoặc hành động phải là một nút độc lập với viền riêng (`1px solid var(--win-border)`), `border-radius: 6px`, màu nền trong suốt, hiệu ứng hover/active đổi viền và màu theo `var(--win-accent)`.
- **Cấm gom nút vào khung viên thuốc dính liền (iOS-style segmented container)**: Không bọc các nút lựa chọn vào một khung viền chung dạng capsule.

## Quy tắc Cấu trúc Module & Tính năng Rust (`src-tauri`)
- **Tổ chức theo đúng thư mục domain**:
  - Tính năng thuộc domain có sẵn (`database`, `redis_db`, `compare`, `credentials`, `datagen`, `ssh`, `terminal`, `stats`, `tx`, `state`, `app`) phải đặt vào thư mục tương ứng trong `src-tauri/src/<domain>/`.
  - Tính năng/Domain mới: Tạo thư mục mới `src-tauri/src/<feature_name>/` kèm `mod.rs` và khai báo `pub mod <feature_name>;` trong `src-tauri/src/lib.rs`.
- **Cấm viết logic trực tiếp trong `src-tauri/src/lib.rs` hoặc `main.rs`**: `lib.rs` chỉ dùng để khai báo module và re-export cần thiết (`AppState`, `run`).
- **Đăng ký `#[tauri::command]`**: Mọi command mới bắt buộc phải được thêm vào danh sách `tauri::generate_handler![...]` trong `src-tauri/src/app/handlers.rs`.
- **Quản lý State**: Trạng thái dùng chung phải được gắn vào `AppState` trong `src-tauri/src/state/`.

## Quy tắc Git Commit, PR & Chú thích Mã nguồn (English Only)
- **Git Commit Messages**: Toàn bộ commit message bắt buộc phải viết bằng **tiếng Anh (English)** theo định dạng Conventional Commits (ví dụ: `feat(scope): ...`, `fix(scope): ...`, `refactor(scope): ...`, `docs(scope): ...`).
- **Pull Requests**: Tiêu đề (PR Title) và nội dung mô tả (PR Description) bắt buộc phải viết bằng **tiếng Anh (English)**. Không thêm footer/trailer `Co-Authored-By`.
- **Code Comments**: Toàn bộ ghi chú, giải thích, docstring trong mã nguồn TypeScript & Rust bắt buộc phải viết bằng **tiếng Anh (English)**.

## Quy tắc Kiểm tra & Refactor Mã nguồn (Refactoring & Verification Protocol)
- **Bắt buộc chạy `npx tsc --noEmit` và `oxlint` sau mỗi lần refactor**: Tuyệt đối không chỉ phụ thuộc vào `vitest` / `npm test` vì test suite không kiểm tra type toàn diện cho các file JSX lớn như `App.tsx`.
- **Grep toàn bộ codebase trước khi xóa/thay thế state hoặc props**: Khi chuyển đổi công cụ (ví dụ từ modal sang tab) hoặc xóa state setter, bắt buộc phải `grep_search` để rà soát và cập nhật đồng bộ tất cả các nơi gọi (bao gồm `TitleBar`, `Sidebar`, Shortcuts, Context Menus).
- **Phân biệt rạch ròi các tính năng có tên tương tự**: Tuyệt đối không xóa nhầm logic/memo giữa các module độc lập nhưng có tên tương tự nhau (ví dụ: công cụ *Import Database* dạng dump SQL vs tính năng *Global Import Table* từ CSV/JSON/SQL).


