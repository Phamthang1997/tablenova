# Kế hoạch: SSH Terminal xem log server (bản chỉnh cho đúng repo TableNova)

Tích hợp một SSH Terminal tương tác trong TableNova dùng `xterm.js` (frontend React) và
`russh` (backend Rust) để người dùng kết nối trực tiếp vào máy chủ DB, chạy lệnh xem log
(`tail -f`, `journalctl`, ...) mà không rời ứng dụng.

> Bản này sửa 4 sai sót của plan gốc: (1) đăng ký command sai file, (2) thiếu khai báo module,
> (3) resize dùng sai API russh, (4) không tái dùng logic SSH đã có. Xem mục "Khác biệt so với plan gốc" ở cuối.

---

## Component 1: Backend (Rust)

### [MODIFY] `src-tauri/src/ssh_tunnel.rs` — tách logic kết nối + xác thực để tái dùng
File này **đã có sẵn** toàn bộ phần khó: `TunnelHandler` (chấp nhận host key), parse config SSH,
và xác thực cả `password` lẫn `key` (`decode_secret_key`/`load_secret_key`, `PrivateKeyWithHashAlg`,
`authenticate_publickey`/`authenticate_password`). Không viết lại.

- Trích phần "connect + authenticate" (bước 1–2 trong `SshTunnel::open`) thành một hàm dùng chung, ví dụ:
  ```rust
  // Kết nối SSH và xác thực, trả về Handle đã sẵn sàng mở kênh.
  pub async fn connect_and_auth(config: &Value) -> Result<client::Handle<TunnelHandler>, String>
  ```
  `SshTunnel::open` gọi lại hàm này; `ssh_terminal.rs` cũng gọi nó → một đường xác thực duy nhất.
- Đổi `TunnelHandler` sang `pub` (hoặc export) để module terminal dùng lại kiểu Handler.
- Giữ nguyên các key config đang đọc: `sshHost`, `sshPort` (mặc định 22), `sshUser` (mặc định `root`),
  `sshAuthType` (`password`/`key`), `sshPassword`, `sshKeyContent`, `sshKeyPath`, `sshPassphrase`.

### [NEW] `src-tauri/src/ssh_terminal.rs`
- Theo dõi phiên terminal đang mở: `HashMap<String, TerminalSession>` với `session_id` →
  handle của **channel** (để ghi input, resize, đóng) + `JoinHandle` của vòng lặp đọc output.
  State này đặt trong `AppState` (xem lib.rs bên dưới), **không** để biến global rời rạc.
- Dùng `russh` 0.62.2. API cần kiểm đúng version (đã ghim `russh = "0.62.2"` trong Cargo.toml):
  - `channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])` — **chỉ khi khởi tạo**.
  - `channel.request_shell(true).await`.
  - Đọc output: vòng lặp `while let Some(msg) = channel.wait().await` khớp `ChannelMsg::Data { data }`
    (và `ExtendedData` cho stderr) → đẩy về frontend.
- Tauri Commands:
  - `open_ssh_terminal(state, profile_config: Value, session_id: String, cols: u32, rows: u32, channel: Channel<Value>)`
    → `connect_and_auth(&profile_config)`, mở channel, `request_pty`, `request_shell`, spawn tokio task
    đọc output và đẩy qua **`Channel`** về frontend. Lưu session vào state.
  - `send_ssh_input(state, session_id: String, data: String)` → ghi bytes vào channel:
    `channel.data(data.as_bytes()).await`.
  - `resize_ssh_terminal(state, session_id: String, cols: u32, rows: u32)` →
    **`channel.window_change(cols, rows, 0, 0).await`** (KHÔNG gọi lại `request_pty`).
  - `close_ssh_terminal(state, session_id: String)` → `channel.eof()`/`close()`, abort task đọc, xóa khỏi map.

> **Cơ chế đẩy output**: dùng `tauri::ipc::Channel<Value>` — đúng pattern vừa dùng cho streaming SQL
> (`execute_query_stream`), thay cho việc emit event `"ssh-data"` toàn cục + tự quản listen/unlisten.
> Input đi ngược qua command `send_ssh_input` (Channel chỉ một chiều backend→frontend).

### [MODIFY] `src-tauri/src/lib.rs` — **KHÔNG phải main.rs**
`main.rs` chỉ là 6 dòng gọi `tablenova::run()`. Mọi đăng ký nằm ở `lib.rs`.
- Thêm `pub mod ssh_terminal;` (cạnh `pub mod ssh_tunnel;`).
- Thêm state phiên vào `AppState` (đã có tiền lệ: `cancel_flags: Mutex<HashMap<..>>`):
  ```rust
  pub ssh_terminals: Mutex<HashMap<String, ssh_terminal::TerminalSession>>,
  ```
  và khởi tạo `ssh_terminals: Mutex::new(HashMap::new())` trong `.manage(AppState { ... })`.
- Đăng ký 4 command mới trong `tauri::generate_handler![ ... ]`:
  `ssh_terminal::open_ssh_terminal`, `send_ssh_input`, `resize_ssh_terminal`, `close_ssh_terminal`.

### [MODIFY] `src-tauri/Cargo.toml`
- `russh = "0.62.2"` đã có. Không thêm dep mới (tokio `full`, serde_json đã đủ).

---

## Component 2: Frontend (React)

### [MODIFY] `package.json`
- Dùng **package scope mới** (bản `xterm`/`xterm-addon-fit` cũ đã deprecated):
  `@xterm/xterm` và `@xterm/addon-fit`.

### [NEW] `src/components/SshTerminal.tsx`
- Overlay/modal chứa canvas xterm.js.
- Mở phiên: tạo `Channel`, gán `channel.onmessage` để ghi output vào `term.write(...)`,
  rồi `invoke('open_ssh_terminal', { profileConfig, sessionId, cols, rows, channel })`.
- `term.onData(d => dbHelper.sendSshInput(sessionId, d))` — gửi keystroke.
- `@xterm/addon-fit`: `fitAddon.fit()` khi resize, gọi `resize_ssh_terminal(sessionId, cols, rows)`.
- Khi đóng modal/unmount: `close_ssh_terminal(sessionId)`.

### [MODIFY] `src/utils/dbHelper.ts` — điểm gọi invoke duy nhất
- Thêm: `openSshTerminal`, `sendSshInput`, `resizeSshTerminal`, `closeSshTerminal`
  (tái dùng kiểu `Channel` như `executeQueryStream` vừa thêm).

### [MODIFY] `src/components/ConnectionManager.tsx`
- Thêm menu chuột phải / nút trên profile đã lưu: **"Mở SSH Terminal"**
  (chỉ bật khi profile có `sshEnabled`), mở `SshTerminal` với config SSH của profile.

---

## Verification Plan

### Tự động
- `npm run build-frontend` — cài package + type-check.
- `cargo check` (đặt `CARGO_TARGET_DIR` như dev-start.bat, và **tắt app dev** trước để tránh khóa file khi link).

### Thủ công
1. Connection Manager → chọn profile có SSH → chuột phải → Mở SSH Terminal.
2. Xác nhận đăng nhập được, hiện prompt server.
3. Chạy `tail -f /var/log/syslog` → xác nhận log chảy real-time.
4. Resize cửa sổ → xác nhận `window_change` chỉnh đúng độ rộng ngắt dòng (chạy `tput cols` để kiểm).
5. Đóng modal → xác nhận phiên SSH ngắt sạch (task đọc bị abort, session xóa khỏi map).
6. Kiểm khi `tail -f` đang chạy mà resize — không được crash/treo.

---

## Khác biệt so với plan gốc (cái đã sai)
| Sai ở plan gốc | Sửa lại |
|---|---|
| `[MODIFY] main.rs` để đăng ký command + state | Phải là **lib.rs** (`invoke_handler!` + `AppState`). |
| Không khai báo module cho `ssh_terminal.rs` | Thêm `pub mod ssh_terminal;` trong lib.rs. |
| `resize` gọi lại `request_pty(...)` | Dùng **`channel.window_change(cols, rows, 0, 0)`**. |
| Viết lại connect+auth từ đầu | **Tái dùng** `ssh_tunnel.rs` (`connect_and_auth`, `TunnelHandler`, parse config). |
| Emit event `"ssh-data"` toàn cục | Dùng **`tauri::ipc::Channel`** (đồng bộ với streaming SQL). |
| `xterm` / `xterm-addon-fit` (deprecated) | `@xterm/xterm` / `@xterm/addon-fit`. |
| "global mutex state" rời | State trong **`AppState`** theo pattern `cancel_flags`. |
| Tên "TableNova" ✓ | Đã đúng (project đã đổi tên). |
