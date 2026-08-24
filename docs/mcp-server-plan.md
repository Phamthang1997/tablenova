# Tài liệu Thiết kế & Kế hoạch Triển khai: TableNova Internal MCP Server (Model Context Protocol)

Tài liệu này đặc tả kiến trúc kỹ thuật, giao thức, cơ chế bảo mật và lộ trình triển khai tính năng **Tích hợp MCP Server nội bộ (Built-in Model Context Protocol Server)** cho TableNova.

---

## 📌 1. Tổng quan & Mục tiêu

### 1.1. Khái niệm Model Context Protocol (MCP)
**Model Context Protocol (MCP)** là một tiêu chuẩn mở do Anthropic khởi xướng, cho phép các mô hình ngôn ngữ lớn (LLM) và các trợ lý AI (như **Claude Desktop, Cursor, Raycast, Antigravity, Windsurf**) giao tiếp hai chiều an toàn với các nguồn dữ liệu và công cụ cục bộ (Local Tools & Data Sources).

### 1.2. Mục tiêu của TableNova MCP Server
- **Biến TableNova thành Data Hub cho AI**: Cho phép các AI Client bên ngoài truy vấn danh mục cơ sở dữ liệu (Database Schema, Tables, Columns, Indexes), xem dữ liệu mẫu và thực thi truy vấn SQL trực tiếp qua các phiên kết nối đang mở trong TableNova.
- **Không cần cấu hình lại kết nối ở AI Client**: Thay vì phải chia sẻ connection string, password hay private key SSH với từng AI IDE, AI IDE chỉ cần gọi MCP Server cục bộ của TableNova.
- **Bảo mật tuyệt đối (Human-in-the-Loop & Safe Mode)**: Mọi thao tác ghi/sửa dữ liệu (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`) đều phải qua cơ chế phê duyệt hoặc bị chặn nếu kết nối ở chế độ Read-Only.
- **Nâng tầm trải nghiệm cạnh tranh**: Đưa TableNova trở thành Database Client mã nguồn mở đầu tiên hỗ trợ MCP đa nền tảng (Windows, macOS, Linux).

---

## 🏗️ 2. Kiến trúc Kỹ thuật (System Architecture)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL AI CLIENTS                            │
│  (Cursor IDE, Claude Desktop, Raycast, Antigravity, VS Code Copilot)    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ JSON-RPC 2.0 (HTTP / SSE / Stdio)
                                     │ Token: Bearer <local_auth_token>
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TABLENOVA DESKTOP APP                            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    Rust Backend (Tauri Core)                      │  │
│  │                                                                   │  │
│  │   ┌──────────────────────┐        ┌───────────────────────────┐   │  │
│  │   │  Local MCP Server    │ ◄────► │   Security & Safe Gate    │   │  │
│  │   │ (127.0.0.1:45124)    │        │  (Read-Only & Confirm UI) │   │  │
│  │   └──────────┬───────────┘        └───────────────────────────┘   │  │
│  │              │                                                    │  │
│  │              ▼                                                    │  │
│  │   ┌───────────────────────────────────────────────────────────┐   │  │
│  │   │  Connection Manager & Pool (PostgreSQL, MySQL, SQLite...) │   │  │
│  │   └──────────────────────────┬────────────────────────────────┘   │  │
│  └──────────────────────────────┼────────────────────────────────────┘  │
│                                 │ Query / Schema Fetch                  │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │             Target Databases (Remote / Local / SSH)               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Phương thức Giao tiếp (Transport Protocol)
MCP hỗ trợ 2 cơ chế truyền tải chính:
1. **Server-Sent Events (SSE) qua HTTP**:
   - Chạy một HTTP/JSON-RPC Server nhẹ bên trong Rust backend (sử dụng `axum` / `tokio`).
   - Lắng nghe duy nhất trên giao tiếp Loopback cục bộ: `http://127.0.0.1:45124/sse`.
   - Phù hợp nhất cho các client chạy độc lập như Cursor, Raycast, web hooks.
2. **Standard I/O (Stdio) qua CLI Bridge (Tùy chọn)**:
   - Một executable nhỏ gọn `tablenova-mcp-cli` (hoặc cờ `--mcp` từ chính binary TableNova) kết nối với instance TableNova đang chạy qua IPC / Local Named Pipe.
   - Phù hợp cho **Claude Desktop** (vốn mặc định dùng stdio).

---

## 🛠️ 3. Danh sách MCP Tools & Resources Cung cấp

TableNova MCP Server sẽ đăng ký các công cụ chuẩn sau:

### 3.1. Danh mục Tools (Callable Functions)

| Tên Tool (MCP Name) | Mô tả chức năng | Quyền hạn & Bảo mật |
| :--- | :--- | :---: |
| `tablenova_list_connections` | Lấy danh sách các kết nối Database đang mở và trạng thái sẵn sàng. | `Read-Only` |
| `tablenova_list_databases` | Liệt kê các database / schema thuộc một connection. | `Read-Only` |
| `tablenova_list_tables` | Lấy toàn bộ danh sách bảng, view trong database được chỉ định. | `Read-Only` |
| `tablenova_describe_table` | Xem chi tiết cấu trúc bảng (Cột, Data Type, Nullable, Primary Key, Foreign Key, Indexes). | `Read-Only` |
| `tablenova_preview_table` | Lấy dữ liệu mẫu (ví dụ: 10 - 50 dòng đầu tiên) từ bảng để AI hiểu phân bố dữ liệu. | `Read-Only` |
| `tablenova_execute_query` | Thực thi một câu lệnh SQL tuỳ ý (`SELECT`, `EXPLAIN`,...). | `Safe Mode Filter` |
| `tablenova_execute_mutation` | Thực thi các câu lệnh thay đổi (`INSERT`, `UPDATE`, `DELETE`, `DDL`). | `Cần Human Confirm` |

### 3.2. Đặc tả Chi tiết Tham số của Tool

#### 1. `tablenova_list_tables`
- **Inputs**:
  ```json
  {
    "connection_id": "conn_prod_pg_01",
    "schema": "public" // Tùy chọn, mặc định theo schema hiện tại
  }
  ```
- **Returns**: Danh sách tên bảng, loại (`table` / `view`), tổng số cột, ước lượng số dòng.

#### 2. `tablenova_describe_table`
- **Inputs**:
  ```json
  {
    "connection_id": "conn_prod_pg_01",
    "table_name": "users",
    "schema": "public"
  }
  ```
- **Returns**: Toàn bộ DDL rút gọn, metadata cột, quan hệ Foreign Key nối tới các bảng khác.

#### 3. `tablenova_execute_query`
- **Inputs**:
  ```json
  {
    "connection_id": "conn_prod_pg_01",
    "sql": "SELECT id, email, created_at FROM users WHERE is_active = true LIMIT 20;",
    "database": "ecommerce_db"
  }
  ```
- **Returns**:
  ```json
  {
    "columns": ["id", "email", "created_at"],
    "rows": [
      [1, "alex@example.com", "2026-01-15T08:30:00Z"],
      [2, "maria@example.com", "2026-02-01T10:15:00Z"]
    ],
    "execution_time_ms": 12,
    "row_count": 2
  }
  ```

---

## 🔒 4. Cơ chế An toàn & Bảo mật (Security & Human-in-the-Loop)

An ninh cơ sở dữ liệu là ưu tiên số 1 khi cho phép AI tương tác. TableNova thiết lập 4 lớp phòng thủ:

```
[ AI Request ]
      │
      ▼
┌────────────────────────────────────────┐
│  1. Loopback-only Binding (127.0.0.1)  │ ➔ Chặn 100% truy cập từ mạng ngoài
└──────────────────┬─────────────────────┘
                   ▼
┌────────────────────────────────────────┐
│  2. Local Auth Token Validation        │ ➔ Chỉ Client có API Key mới được gọi
└──────────────────┬─────────────────────┘
                   ▼
┌────────────────────────────────────────┐
│  3. Connection Safe Mode Filter        │ ➔ Nếu connection ở "Read-Only", chặn
└──────────────────┬─────────────────────┘   mọi INSERT/UPDATE/DELETE/DROP ngay lập tức
                   ▼
┌────────────────────────────────────────┐
│  4. Human-In-The-Loop Approval         │ ➔ Hiện popup xác nhận trên TableNova UI
│     (Cho các câu lệnh Mutation)        │   khi AI muốn ghi/xóa dữ liệu
└────────────────────────────────────────┘
```

1. **Loopback Only (`127.0.0.1`)**:
   - Server tuyệt đối **không** lắng nghe trên `0.0.0.0` hay public IP.
2. **Local Token Authentication**:
   - Khi khởi động MCP Server, TableNova tự sinh một chuỗi bí mật `bearer_token` (có thể regenerate trong Settings). Mọi request từ AI Client bắt buộc phải có header: `Authorization: Bearer <token>`.
3. **Phân loại Truy vấn & Safe Mode**:
   - Mặc định: Chỉ cho phép các câu lệnh **Idempotent / Read-Only** (`SELECT`, `EXPLAIN`, `SHOW`, `DESCRIBE`).
   - Nếu câu lệnh chứa từ khóa phá hủy (`DROP DATABASE`, `TRUNCATE`, `ALTER TABLE`, `UPDATE/DELETE` không có `WHERE`), TableNova sẽ tự động từ chối với mã lỗi `PERMISSION_DENIED`.
4. **Hộp thoại Duyệt tương tác (Interactive Approval Toast/Modal)**:
   - Khi AI yêu cầu thực thi `execute_mutation`, TableNova sẽ bắn Toast thông báo trên giao diện desktop:
     > ⚠️ **AI Agent (Cursor) đang yêu cầu chạy lệnh:**
     > `UPDATE users SET status = 'verified' WHERE id = 42;`
     > `[ Từ chối ]` `[ Cho phép 1 lần ]`

---

## 🖥️ 5. Thiết kế Giao diện Người dùng (UI/UX) trên TableNova

### 5.1. Màn hình Cài đặt MCP (`McpServerSettingsModal.tsx`)
- **Toggle Bật/Tắt MCP Server**:
  - Trạng thái: `🟢 Đang chạy trên 127.0.0.1:45124` | `🔴 Đã dừng`.
- **Cấu hình Cổng (Port)**:
  - Mặc định: `45124` (tự động chuyển port tiếp theo nếu bị chiếm dụng).
- **Mã xác thực (Auth Token)**:
  - Hiển thị dạng ẩn `••••••••••••`, có nút **Copy Token** và nút **Regenerate Token**.
- **Cấu hình Quyền hạn (Permissions Scope)**:
  - `[x]` Cho phép đọc danh sách Table & Schema.
  - `[x]` Cho phép thực thi câu lệnh `SELECT`.
  - `[ ]` Cho phép câu lệnh `INSERT/UPDATE/DELETE` (yêu cầu Human Confirm).
  - Giới hạn dòng tối đa trả về cho AI (mặc định: `100 rows`).
- **Danh sách Kết nối được phép chia sẻ cho AI**:
  - Người dùng có thể tích chọn từng Connection cụ thể (ví dụ: chỉ share `Local Dev SQLite`, không share `Production Postgres`).
- **Audit Logs / Live Requests**:
  - Bảng log thời gian thực: Thời gian, AI Client, Công cụ gọi, Câu lệnh SQL, Thời gian thực thi, Trạng thái (Thành công / Từ chối).

### 5.2. Hướng dẫn Tích hợp 1-Click (1-Click Config Copy)
Giao diện cung cấp sẵn snippet cấu hình để người dùng copy trực tiếp vào AI Editor của mình:

#### Cấu hình cho **Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "tablenova": {
      "url": "http://127.0.0.1:45124/sse",
      "headers": {
        "Authorization": "Bearer YOUR_TABLENOVA_TOKEN"
      }
    }
  }
}
```

#### Cấu hình cho **Claude Desktop** (`claude_desktop_config.json`):

**Lựa chọn 1: Chạy Native qua Binary TableNova (Khuyên dùng - 100% Native Rust, giống Serena/Postgres MCP)**:
```json
{
  "mcpServers": {
    "tablenova": {
      "command": "C:\\Program Files\\TableNova\\tablenova.exe",
      "args": ["--mcp"]
    }
  }
}
```
*(Trên macOS: `/Applications/TableNova.app/Contents/MacOS/tablenova` với args `["--mcp"]`)*

**Lựa chọn 2: Chạy qua NPX / Node Bridge**:
```json
{
  "mcpServers": {
    "tablenova": {
      "command": "npx",
      "args": [
        "-y",
        "@tablenova/mcp",
        "--port",
        "45124",
        "--token",
        "YOUR_TABLENOVA_TOKEN"
      ]
    }
  }
}
```

---

## 📅 6. Lộ trình Triển khai Kỹ thuật (Implementation Plan)

### Giai đoạn 1: Core Backend & HTTP/SSE Server (Tuần 1)
- [ ] Thêm crate `axum`, `tokio`, `tower-http` vào `src-tauri/Cargo.toml`.
- [ ] Tạo module backend `src-tauri/src/mcp/`:
  - `server.rs`: Khởi tạo axum server, SSE endpoint, Token validation middleware.
  - `protocol.rs`: JSON-RPC 2.0 parser và MCP Schema definitions.
  - `tools.rs`: Triển khai các handler cho `list_connections`, `list_tables`, `describe_table`, `execute_query`.
- [ ] Tích hợp trạng thái Server vào `AppState` của Tauri (Bật/Tắt/Đổi Port).

### Giai đoạn 2: UI Quản lý & Bảo mật (Tuần 2)
- [ ] Thiết kế `McpServerSettingsModal.tsx` và `McpStatusPill.tsx` trên thanh trạng thái (Footer hoặc TitleBar).
- [ ] Xây dựng cơ chế duyệt `Human-in-the-Loop` (`McpApprovalDialog.tsx`).
- [ ] Viết bộ lọc bảo vệ Safe Mode trong Rust để kiểm tra cú pháp AST của câu lệnh SQL trước khi thực thi.

### Giai đoạn 3: Audit Log & Packaging (Tuần 3)
- [ ] Xây dựng màn hình hiển thị Audit Log các truy vấn do AI gọi.
- [ ] Tạo package helper CLI (nếu cần cho Claude Desktop stdio bridge).
- [ ] Viết tài liệu hướng dẫn và video demo kết nối với Cursor / Claude Desktop.

---

## 🎯 7. Kết luận & Tác động

Khi hoàn thành tính năng **TableNova Internal MCP Server**:
1. **TableNova sẽ trở thành database client đầu tiên trên Windows/Linux sở hữu sức mạnh kết nối trực tiếp với AI IDE hàng đầu thế giới.**
2. Người dùng chỉ cần gõ trong Cursor: *"Hãy kiểm tra bảng orders trong db của tôi xem có đơn hàng nào bị lỗi hôm nay không"*, Cursor sẽ tự động gọi TableNova để lấy dữ liệu chính xác 100% trong thời gian thực.
3. Tạo ra lợi thế cạnh tranh vượt trội hoàn toàn trước các đối thủ như TablePro (chỉ có trên Mac), DBeaver hay TablePlus.
