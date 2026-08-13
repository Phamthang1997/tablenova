# Project Rules & Guidelines for TableNova

## Quy tắc CSS & Styling
- **Không được phép sử dụng Inline CSS** (`style={{ ... }}`).
- Tất cả giao diện UI phải sử dụng **CSS Classes** định nghĩa trong `src/index.css` (hoặc tệp `.css` tương ứng).
- **Ngoại lệ duy nhất**: Chỉ dùng inline style khi giá trị thuộc tính là dữ liệu động tính toán runtime (như tọa độ chuột, thanh phần trăm progress, màu động từ user picker).
