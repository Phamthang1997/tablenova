# Kế hoạch: hỗ trợ schema khác `public` (Postgres)

Tách ra từ đợt sửa export/import (Phase 0-7). Đây là mục **duy nhất** của plan đó chưa làm, và
cố ý không gộp vào: nó không sửa bug nào của luồng export/import mà lại chạm vào catalog, tab,
localStorage và mọi chỗ sinh SQL — gộp vào thì phần đã xong khó review và khó rollback.

---

## 1. Triệu chứng

Kết nối tới một database Postgres mà bảng nằm trong schema `sales` (hoặc `tenant_x`, `staging`…):

- **Sidebar trống trơn** — không báo lỗi, chỉ là không có gì.
- Popup Xuất không có đối tượng nào để chọn.
- Structure / Data Grid không mở được bảng nào.
- Completion trong SQL editor không biết bảng nào (catalog rỗng).
- Người dùng **vẫn gõ `SELECT * FROM sales.film` chạy được** — nên cảm giác là "app hỏng một
  nửa" chứ không phải "không kết nối được".

Chỉ **MySQL và SQLite không dính**: với MySQL, schema chính là database và đi theo `USE`; SQLite
thì luôn là `main` (hoặc tên đã `ATTACH`).

---

## 2. Nguyên nhân

22 chỗ hardcode `nspname = 'public'` / `table_schema = 'public'` trong `src-tauri/src/database.rs`,
trải trên 11 lệnh:

| Lệnh | Dòng (thời điểm viết doc) |
|---|---|
| `get_full_catalog` | 500, 511, 523 |
| `get_tables` | 574, 577 |
| `get_table_schema` | 845 |
| `get_primary_key_columns` (helper) | 2117 |
| `get_table_definition` | 3011, 3050 |
| `get_database_objects` | 3794, 3797, 3802 |
| `get_object_definition` | 3898 |
| `get_table_triggers` | 4311 |
| `get_table_ddl_extras` | 4415, 4423, 4432, 4439, 4445, 4457 |
| `get_all_triggers` | 4488 |
| `get_check_constraints` | 4687 |

`get_sequences` dùng `information_schema.sequences WHERE sequence_schema = 'public'` (cùng loại).

---

## 3. Đã có sẵn một hình mẫu đúng

`src-tauri/src/db_compare.rs` **đã** tham số hoá schema: mỗi phía mang `schema: Option<String>`,
mặc định `public` (xem `resolve_side`, dòng ~208), và `DbCompareDialog` có ô nhập schema cho
Postgres. Tức là chức năng "So sánh 2 database" là chỗ **duy nhất** trong app dùng được schema
khác — phần còn lại nên copy đúng khuôn đó thay vì nghĩ ra khuôn mới.

---

## 4. Quyết định phải chốt TRƯỚC khi code

Đây mới là phần khó; 22 dòng kia là phần dễ.

### 4.1. "Schema đang chọn" đến từ đâu? (bắt buộc chốt)

| Phương án | Được | Mất |
|---|---|---|
| **A. Trường trong `DbConnectionConfig`** | Đơn giản nhất, lưu theo profile kết nối, khớp cách `db_compare` đang làm | Đổi schema phải sửa kết nối; không duyệt nhanh nhiều schema được |
| **B. Ô chọn schema trên Sidebar** (như ô chọn database) | Đúng kỳ vọng của người dùng DBeaver/pgAdmin; duyệt qua lại nhanh | Phải thêm state + invalidate catalog mỗi lần đổi; ảnh hưởng khoá localStorage (xem 4.3) |
| **C. Đọc `search_path` của server** | Không thêm UI nào | "Vô hình": người dùng không hiểu vì sao thấy bảng này mà không thấy bảng kia; `search_path` có thể có nhiều schema |

**Đề xuất: B, mặc định là schema đầu tiên trong `search_path` (thường là `public`).** A là bước
đệm rẻ nếu muốn ra sớm.

### 4.2. SQL sinh ra phải qualify tên

Không chỉ các câu introspection. Mọi chỗ dựng SQL bằng `format!` phải thành `"sales"."film"`:
`generate_alter_sqls`, `alter_table_schema`, `preview_alter_schema`, `commit_changes`,
`drop_table` / `truncate_table` / `rename_table`, `data_generator.rs`.

### 4.3. Khoá localStorage phải thêm một tầng

`utils/connKey.ts`: `scopeKey(config, db)` hiện là **server + database**. Hai schema trong cùng
một database sẽ dùng chung tab, draft SQL và lịch sử — đúng loại bug mà `connKey.ts` sinh ra để
chống. Cần `scopeKey(config, db, schema)`, kèm đường đọc khoá cũ một lần để không ai mất tab
(giống `legacyTabsStorageKey`).

### 4.4. Dump phải mang schema theo

Tệp xuất từ `sales` mà nhập lại sẽ chui vào `public`. Cần `CREATE SCHEMA IF NOT EXISTS "sales";`
+ `SET search_path TO "sales";` trong header của `utils/dumpBuilder.ts` (chỗ `dumpHeader`), và
cân nhắc cho phép người dùng đổi schema đích lúc nhập (popup Nhập đã có ô "database đích").

---

## 5. Việc cần làm

1. **Backend**: thêm tham số `schema: Option<String>` cho 11 lệnh ở mục 2 (mặc định `public`,
   giữ nguyên hành vi cũ khi không truyền). Một helper `pg_schema(opt)` để không rải
   `unwrap_or("public")` khắp nơi.
2. **Lệnh mới `list_schemas`**: `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
   AND nspname <> 'information_schema' ORDER BY 1`.
3. **`dbHelper`**: truyền schema xuống 11 lệnh; thêm `getSchemas()`.
4. **UI**: ô chọn schema trên Sidebar (chỉ hiện với Postgres) + `invalidateCatalog()` khi đổi.
5. **Qualify tên** ở mọi chỗ sinh SQL (4.2).
6. **`connKey.ts`**: thêm schema vào `scopeKey`, kèm đường đọc khoá cũ.
7. **`dumpBuilder`**: `CREATE SCHEMA` + `SET search_path` trong header khi schema ≠ `public`.
8. **Test**: `connKey` (khoá cũ vẫn đọc được), `dumpBuilder` (header có schema), và một ca
   introspection chạy tay trên database có schema `sales`.

---

## 6. Ước lượng & rủi ro

- Backend + `list_schemas` + ô chọn: ~1 buổi.
- Qualify tên ở các đường ghi (4.2) là phần dễ sót nhất — sót chỗ nào thì lệnh đó âm thầm chạy
  vào `public`, tức là **ghi nhầm schema**, không phải chỉ hiển thị sai.
- `scopeKey` đổi mà quên đường đọc khoá cũ thì người dùng mất hết tab đang mở.

---

## 7. Trạng thái

Chưa bắt đầu. Chặn ở quyết định **4.1**.
