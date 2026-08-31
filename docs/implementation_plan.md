# Plan: Hỗ trợ Redis Database trong TABLEGRID (Redis Key-Value GUI Client)

Tích hợp **Redis** làm loại cơ sở dữ liệu thứ 4 trong TABLEGRID (bên cạnh SQLite, PostgreSQL, và MySQL). Cung cấp giao diện trực quan để duyệt namespace/keys, chỉnh sửa dữ liệu đa dạng kiểu (String, Hash, List, Set, Sorted Set, Stream), quản lý TTL, chạy câu lệnh Redis CLI tương tác, và theo dõi thông số server (`INFO`).

---

## User Review Required

> [!IMPORTANT]
> **Điểm khác biệt về UX giữa Relational DB (SQL) và Redis (Key-Value):**
> 1. Khi kết nối đến Redis, Sidebar của TABLEGRID sẽ chuyển sang chế độ **Redis Key Browser** thay vì danh sách Bảng SQL.
> 2. Các tab chính cho Redis sẽ bao gồm: **Redis Key Editor** (xem/chỉnh sửa key), **Redis CLI Console** (chạy lệnh `GET`, `SET`, `HGETALL`, `INFO`,...), và **Redis Server Dashboard** (thống kê RAM, Clients, Keyspace).
> 3. Để đảm bảo an toàn cho máy chủ Redis sản xuất có hàng triệu keys, hệ thống sẽ **luôn dùng `SCAN` dạng phân trang (non-blocking)**, tuyệt đối không dùng `KEYS *`.

---

## Open Questions

> [!NOTE]
> - **Redis Sentinel / Redis Cluster**: Trong phiên bản đầu tiên (V1), chúng ta tập trung hỗ trợ đầy đủ **Redis Standalone** (kèm TLS/SSL, Password/ACL và SSH Tunneling). Nếu bạn cần hỗ trợ thêm Redis Sentinel/Cluster ngay trong V1, vui lòng phản hồi cho chúng tôi.

---

## Proposed Changes

### Backend (Rust `src-tauri`)

#### [MODIFY] [Cargo.toml](file:///c:/workspace/table/src-tauri/Cargo.toml)
- Thêm dependency `redis`:
  ```toml
  redis = { version = "1.4.1", features = ["tokio-comp", "tls-rustls"] }
  ```

#### [MODIFY] [database.rs](file:///c:/workspace/table/src-tauri/src/database.rs)
- Mở rộng enum `DbConnection` để lưu kết nối Redis:
  ```rust
  pub enum DbConnection {
      Sqlite(Arc<Mutex<SqliteConnection>>),
      Postgres(PgPool),
      Mysql(MySqlPool),
      Redis(Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>),
  }
  ```
- Cập nhật command `connect_db`:
  - Xử lý `dbType == "redis"`. Dựng URL kết nối `redis://[user:password@]host:port/dbIndex` hoặc `rediss://` nếu bật SSL.
  - Hỗ trợ kết nối thông qua SSH Tunnel (sử dụng port forwarding đã có của `ssh_tunnel.rs`).
- Thêm các Tauri Commands mới chuyên dụng cho Redis:
  - `redis_scan_keys(pattern: String, cursor: u64, count: usize, type_filter: Option<String>)`: Quét keys bằng `SCAN` kèm `TYPE` và `TTL`.
  - `redis_get_key(key: String)`: Trả về kiểu dữ liệu (string, hash, list, set, zset, stream), TTL, memory usage, và toàn bộ giá trị tương ứng.
  - `redis_set_key(payload: Value)`: Tạo hoặc cập nhật key & value tùy thuộc kiểu dữ liệu.
  - `redis_delete_keys(keys: Vec<String>)`: Xóa key bằng `DEL` hoặc `UNLINK`.
  - `redis_set_ttl(key: String, ttl: i64)`: Thiết lập TTL (`EXPIRE` hoặc `PERSIST`).
  - `redis_rename_key(old_key: String, new_key: String)`: Đổi tên key (`RENAME`).
  - `redis_flush_db()`: Xóa sạch keys trong DB hiện tại (`FLUSHDB`).
  - `redis_info()`: Gọi `INFO` và parse kết quả dạng JSON cho Dashboard.
  - `redis_execute_cmd(command: String)`: Parse và thực thi câu lệnh Redis CLI dạng chuỗi thô.

#### [MODIFY] [lib.rs](file:///c:/workspace/table/src-tauri/src/lib.rs)
- Đăng ký các command Redis mới vào danh sách `tauri::generate_handler![...]`.

---

### Frontend (React + TypeScript `src`)

#### [MODIFY] [dbHelper.ts](file:///c:/workspace/table/src/utils/dbHelper.ts)
- Cập nhật type `DbConnectionConfig`: thêm `'redis'` vào `type` và trường `dbIndex?: number`.
- Định nghĩa kiểu TypeScript mới: `RedisKeyItem`, `RedisValueDetail`, `RedisInfoResult`.
- Bổ sung các phương thức gọi `invoke()` cho các lệnh Redis backend.

#### [MODIFY] [ConnectionManager.tsx](file:///c:/workspace/table/src/components/ConnectionManager.tsx)
- Bổ sung tab/card chọn loại DB **Redis** (Icon đại diện Redis, Port mặc định 6379, ô chọn Database Index 0–15, Username ACL, Password, SSL/TLS, SSH Tunnel).

#### [MODIFY] [Sidebar.tsx](file:///c:/workspace/table/src/components/Sidebar.tsx)
- Thêm giao diện duyệt **Redis Key Browser** khi đang kết nối Redis:
  - Dropdown chuyển đổi Database Index (`db0` đến `db15`).
  - Thanh tìm kiếm theo pattern (`MATCH *`) và bộ lọc theo kiểu dữ liệu (`String`, `Hash`, `List`, `Set`, `ZSet`, `Stream`).
  - Hiển thị danh sách Key theo **dạng cây thư mục Namespace** (phân tách bởi dấu `:` ví dụ `user:1001:profile`).
  - Các thao tác nhanh: "Thêm Key mới", "Làm mới danh sách", "Xóa DB (Flush DB)".

#### [NEW] [RedisKeyViewer.tsx](file:///c:/workspace/table/src/components/RedisKeyViewer.tsx)
- Component xem và chỉnh sửa thông tin của Key đang chọn:
  - **Header**: Tên Key (cho phép đổi tên), Badge kiểu dữ liệu, TTL badge/trình sửa TTL (hẹn giờ hết hạn / vô hạn), dung lượng bộ nhớ.
  - **Trình chỉnh sửa theo Kiểu Dữ Liệu**:
    - **String**: Ô nhập liệu văn bản / Định dạng JSON code editor với nút "Format JSON".
    - **Hash**: Bảng Field – Value (Thêm/Sửa/Xóa field).
    - **List**: Bảng Index – Value (Thêm phần tử Push/Pop/Sửa value).
    - **Set**: Bảng Member duy nhất (Thêm/Xóa member).
    - **ZSet (Sorted Set)**: Bảng Score – Member (Thêm/Sửa Score, Sắp xếp).
    - **Stream**: Bảng danh sách Entry ID và Fields/Values (`XRANGE`).

#### [NEW] [RedisConsole.tsx](file:///c:/workspace/table/src/components/RedisConsole.tsx)
- Cửa sổ dòng lệnh Redis CLI tương tác, cho phép người dùng nhập trực tiếp câu lệnh (`GET key`, `HGETALL myhash`, `INFO`, `CONFIG GET *`,...) và nhận kết quả được định dạng dạng bảng hoặc JSON.

#### [NEW] [RedisDashboardModal.tsx](file:///c:/workspace/table/src/components/RedisDashboardModal.tsx)
- Modal / Tab xem tổng quan thông số máy chủ Redis từ lệnh `INFO` (Dung lượng RAM đang dùng, Số lượng Client kết nối, Tổng số keys theo từng DB, Redis Version, Hit Rate cache).

#### [MODIFY] [App.tsx](file:///c:/workspace/table/src/App.tsx) & [TabManager.tsx](file:///c:/workspace/table/src/components/TabManager.tsx)
- Tích hợp loại Tab mới: `redis_key` (Mở tab chỉnh sửa key) và `redis_console` (Mở Redis CLI Console).

---

## Verification Plan

### Automated Tests / Checks
- **Rust Backend**:
  ```bash
  cd src-tauri
  cargo check
  ```
  Xác nhận mã nguồn Rust biên dịch thành công với crate `redis` và không gặp lỗi kiểu dữ liệu.
- **React Frontend**:
  ```bash
  npm run build-frontend
  ```
  Xác nhận TypeScript type check và Vite bundle thành công.

### Manual Verification
1. **Kết nối**: Tạo kết nối đến máy chủ Redis cục bộ (`127.0.0.1:6379`) hoặc từ xa, kiểm tra authentication (Password/ACL), SSL và chuyển đổi qua lại giữa các database index (`db0` - `db15`).
2. **Duyệt Key**: Tìm kiếm theo pattern `user:*`, lọc theo loại Hash/String, kiểm tra tính năng hiển thị dạng thư mục theo dấu `:`.
3. **Thao tác dữ liệu (CRUD)**:
   - Thêm key mới loại `String`, `Hash`, `List`, `Set`, `ZSet`.
   - Sửa value, đổi tên key, thiết lập TTL (ví dụ 60 giây) và kiểm tra key tự động hết hạn.
   - Xóa key đơn lẻ và xóa danh sách key được chọn.
4. **Redis Console & Dashboard**:
   - Mở Redis Console, gõ các lệnh `PING`, `INFO memory`, `SET test "val"`, `GET test` và kiểm tra phản hồi.
   - Mở Server Dashboard và xác nhận thông số RAM, Keyspace hiển thị đúng.
