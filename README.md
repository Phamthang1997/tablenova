# 🚀 TABLENOVA

> **Trình quản lý & soạn thảo cơ sở dữ liệu hiện đại, siêu tốc và tinh tế dành cho PostgreSQL, MySQL, và SQLite.**

TABLENOVA là ứng dụng desktop native được xây dựng trên nền tảng **Tauri v2 + Rust** ở backend và **React 19 + TypeScript + Vite + Monaco Editor** ở frontend. Ứng dụng mang lại trải nghiệm làm việc mượt mà, trực quan và mạnh mẽ tương tự TablePlus và DataGrip.

---

## ✨ Tính năng nổi bật

### 🗄️ 1. Hỗ trợ đa cơ sở dữ liệu (Multi-Database Support)
- **PostgreSQL**: Hỗ trợ đầy đủ kiểu dữ liệu nâng cao (UUID, JSONB, Numeric, Chrono Timestamp).
- **MySQL / MariaDB**: Xử lý trực tiếp MySQL 8+ native drivers.
- **SQLite**: Tối ưu tốc độ truy vấn SQLite cục bộ.
- **Kết nối an toàn**: Hỗ trợ SSL/TLS, SSH Tunnel (Russh) và Connection Pooling.

### 📝 2. Trình soạn thảo SQL thông minh (Monaco SQL Editor)
- **Autocomplete tự động**: Gợi ý tên bảng, tên cột (Schema-aware), từ khóa SQL và hàm tích hợp thời gian thực.
- **Tham số truy vấn (Query Parameters)**: Hỗ trợ cú pháp `:param_name`, `$1`, `?` với hộp thoại nhập tham số tự động.
- **Định dạng SQL**: Tùy chọn 1-click **Làm đẹp (Beautify SQL)** hoặc **Nén 1 dòng (Minify SQL)**.
- **Chia khung linh hoạt (Split Panes)**: Chế độ Xem đơn, Chia dọc (Left/Right) hoặc Chia ngang (Top/Bottom) với thanh kéo resizer tùy chỉnh độ cao.

### 📊 3. Trực quan hóa EXPLAIN Plan (EXPLAIN Visualization)
- **Sơ đồ luồng (Plan Diagram View)**: Hiển thị kế hoạch thực thi dạng sơ đồ khối cây (Flowchart) với phân màu mức độ chi phí (*Green / Orange / Red severity*).
- **Cấu trúc cây (Tree View)**: Xem chi tiết loại Operation, Bảng, Index, Cost, Rows theo dạng thụt lùi thu gọn/mở rộng.
- **Dữ liệu thô (Raw View)**: Xem text EXPLAIN nguyên bản kèm nút sao chép 1-click.
- **Đa dạng chế độ**: Hỗ trợ `EXPLAIN (Ước tính)`, `EXPLAIN ANALYZE (Thực tế thực thi)`, và `EXPLAIN FORMAT=JSON`.

### 📋 4. Bảng Lịch sử & Câu lệnh đã lưu (Query History & Saved Queries)
- **Drawer góc phải màn hình**: Thanh bên thông minh phân nhóm theo ngày (*Hôm nay, Hôm qua,...*).
- **Sao chép 1-click**: Bấm sao chép SQL trực tiếp vào clipboard hoặc bấm nạp vào trình soạn thảo.
- **Lưu Bookmark**: Lưu trữ các câu lệnh thường dùng để tái sử dụng nhanh chóng.

### 📊 5. Bảng dữ liệu & Xuất dữ liệu (Data Grid & Export)
- Phân trang siêu tốc (10, 20, 50, 100 dòng / trang).
- Xuất dữ liệu linh hoạt sang **CSV**, **JSON**, hoặc bộ nhớ tạm Clipboard.

### 🎯 6. Thiết kế UI/UX hiện đại (Modern Aesthetics)
- Giao diện Tối (Dark) / Sáng (Light) cao cấp.
- Dynamic Smart Dropdown: Menu thả xuống tự động tính toán khoảng trống màn hình để bung lên trên hoặc mở xuống dưới.

---

## 🛠️ Công nghệ sử dụng (Tech Stack)

### Backend (Rust / Tauri)
- **Tauri v2**: Framework xây dựng ứng dụng desktop mượt nhẹ.
- **sqlx** & **rusqlite**: Kết nối async trực tiếp tới PostgreSQL, MySQL & SQLite.
- **russh**: Tích hợp SSH Tunnel bảo mật.
- **tokio**: Runtime xử lý bất đồng bộ đa luồng.

### Frontend (React / TypeScript)
- **React 19** & **TypeScript 6**: Giao diện người dùng hướng thành phần.
- **Vite 8**: Bundler frontend tốc độ cao.
- **Monaco Editor**: Trình soạn thảo mã lệnh chuẩn VS Code.
- **Lucide React**: Bộ icon hiện đại.

---

## 🚀 Hướng dẫn cài đặt & Chạy ứng dụng

### Yêu cầu hệ thống
- **Node.js** >= 18.x
- **Rust** >= 1.75
- **npm** hoặc **yarn** / **pnpm**

### Các bước khởi chạy môi trường Dev

1. **Clone repository**:
   ```bash
   git clone https://github.com/your-username/table.git
   cd table
   ```

2. **Cài đặt các gói phụ thuộc (Frontend)**:
   ```bash
   npm install
   ```

3. **Chạy ứng dụng chế độ Development (Tauri Dev)**:
   ```bash
   npm run dev
   # Hoặc chạy file batch khởi động nhanh trên Windows:
   .\dev-start.bat
   ```

4. **Build bản phát hành (Production Package)**:
   ```bash
   npm run build
   ```

---

## 📁 Cấu trúc thư mục dự án

```text
table/
├── src/                          # Mã nguồn Frontend (React + TS)
│   ├── components/               # Các UI components chính
│   │   ├── SqlEditor.tsx         # Trình soạn thảo SQL & Toolbar
│   │   ├── ExplainViewer.tsx     # Bộ đọc & chuyển tab EXPLAIN
│   │   ├── ExplainDiagramView.tsx# Sơ đồ khối EXPLAIN Diagram
│   │   ├── ExplainTreeView.tsx   # Cấu hình cây EXPLAIN Tree
│   │   └── ExplainRawView.tsx    # Văn bản thô EXPLAIN Raw
│   ├── utils/
│   │   ├── explainHelper.ts      # Parser phân tích kế hoạch EXPLAIN
│   │   └── queryParamHelper.ts   # Xử lý tham số truy vấn SQL
│   ├── App.tsx                   # Component ứng dụng chính
│   └── index.css                 # Hệ thống CSS Design System
├── src-tauri/                    # Mã nguồn Backend (Rust + Tauri)
│   ├── src/
│   │   ├── main.rs               # Điểm khởi chạy Tauri Desktop
│   │   ├── database.rs           # Xử lý kết nối SQL & Streaming
│   │   └── ssh.rs                # Kết nối SSH Tunnel
│   ├── Cargo.toml                # Khai báo thư viện Rust
│   └── tauri.conf.json           # Cấu hình ứng dụng Tauri
├── package.json
└── README.md
```

---

## 📄 Giấy phép & Tác giả (License & Publisher)

- **Người phát hành (Publisher / Author)**: **MeoMeo**
  - 📧 **Gmail**: [pthang888@gmail.com](mailto:pthang888@gmail.com)
  - 💼 **LinkedIn**: [thangpx](https://www.linkedin.com/in/thangpx/)
- **Bản quyền (Copyright)**: © 2026 MeoMeo · TABLENOVA
- **Giấy phép (License)**: Dự án được phát triển dưới giấy phép [MIT License](LICENSE).
