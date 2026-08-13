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
- Data Generator không có bảng nào để chọn (đường đọc metadata riêng, xem mục 2).
- Người dùng **vẫn gõ `SELECT * FROM sales.film` chạy được** — nên cảm giác là "app hỏng một
  nửa" chứ không phải "không kết nối được".

Chỉ **MySQL và SQLite không dính**: với MySQL, schema chính là database và đi theo `USE`; SQLite
thì luôn là `main` (hoặc tên đã `ATTACH`).

---

## 2. Nguyên nhân

**23** chỗ hardcode `nspname = 'public'` / `table_schema = 'public'` trong `src-tauri/src/database.rs`,
trải trên **12 lệnh**, cộng **4 chỗ nữa** trong `src-tauri/src/data_generator.rs`:

| Tệp | Lệnh / hàm | Dòng (đã soát lại 2026-08-13) |
|---|---|---|
| `database.rs` | `get_full_catalog` | 548, 559, 571 |
| `database.rs` | `get_tables` | 622, 625 |
| `database.rs` | `get_table_schema` | 893 |
| `database.rs` | `get_primary_key_columns` (helper) | 2188 |
| `database.rs` | `get_table_definition` | 3130, 3169 |
| `database.rs` | `get_database_objects` | 3913, 3916, 3921 |
| `database.rs` | `get_object_definition` | 4017 |
| `database.rs` | `get_table_triggers` | 4430 |
| `database.rs` | `get_table_ddl_extras` | 4534, 4542, 4551, 4558, 4564, 4576 |
| `database.rs` | `get_all_triggers` | 4607 |
| `database.rs` | `get_sequences` | 4697 (`sequence_schema = 'public'`) |
| `database.rs` | `get_check_constraints` | 4806 |
| `data_generator.rs` | `collect_meta` | 1485, 1513, 1527, 1566 |

`get_sequences` giờ nằm thẳng trong bảng (bản trước để ở chú thích rời), và `collect_meta` —
đường đọc metadata của Data Generator — là chỗ bản trước bỏ sót hẳn: nó tự dò bảng/PK/cột/FK
chứ không đi qua `get_full_catalog`, nên sửa 11 lệnh kia xong thì Data Generator **vẫn** chỉ
nhìn thấy `public`.

---

## 3. Đã có sẵn một hình mẫu đúng

`src-tauri/src/db_compare.rs` **đã** tham số hoá schema: mỗi phía mang `schema: Option<String>`,
mặc định `public` (xem `resolve_side`, dòng ~208), và `DbCompareDialog` có ô nhập schema cho
Postgres. Tức là chức năng "So sánh 2 database" là chỗ **duy nhất** trong app dùng được schema
khác — phần còn lại nên copy đúng khuôn đó thay vì nghĩ ra khuôn mới.

Hai thứ cụ thể để copy, không phải chỉ copy tinh thần:

- `db_compare.rs:432` — `qualified(dialect, schema, table)`: trả về `"sales"."film"`, và trả về
  đúng tên bảng khi dialect là SQLite hoặc schema rỗng. Đây là hàm mà mục 4.2 cần, đã viết sẵn.
- `db_compare.rs:208` / `:266` — cách mặc định `public` chỉ cho Postgres (`match dialect`), MySQL
  lấy tên database, SQLite là `"main"`. Giữ nguyên khuôn này thì phần MySQL/SQLite không đổi hành vi.

Lưu ý về commit `68b912e` ("support Postgres non-public schemas"): commit đó **chỉ** làm phần
`db_compare` + thêm chính doc này. Tiêu đề commit rộng hơn thực tế — phần còn lại của app chưa
có gì, đúng như mục 7.

---

## 4. Quyết định phải chốt TRƯỚC khi code

Đây mới là phần khó; 22 dòng kia là phần dễ.

### 4.1. "Schema đang chọn" đến từ đâu? — ✅ ĐÃ CHỐT: **phương án B**

| Phương án | Được | Mất |
|---|---|---|
| **A. Trường trong `DbConnectionConfig`** | Đơn giản nhất, lưu theo profile kết nối, khớp cách `db_compare` đang làm | Đổi schema phải sửa kết nối; không duyệt nhanh nhiều schema được |
| **B. Ô chọn schema trên Sidebar** (như ô chọn database) ✅ | Đúng kỳ vọng của người dùng DBeaver/pgAdmin; duyệt qua lại nhanh | Phải thêm state + invalidate catalog mỗi lần đổi; ảnh hưởng khoá localStorage (xem 4.3) |
| **C. Đọc `search_path` của server** | Không thêm UI nào | "Vô hình": người dùng không hiểu vì sao thấy bảng này mà không thấy bảng kia; `search_path` có thể có nhiều schema |

**Chốt B** (2026-08-13): ô chọn schema trên Sidebar, chỉ hiện với Postgres, mặc định là schema
đầu tiên trong `search_path` (thường là `public`). Không đi đường A làm bước đệm — A không tiết
kiệm được gì ở phần khó (mục 4.2 phải làm y hệt trong cả hai phương án), mà lại phải viết rồi bỏ
phần đọc schema từ config.

Kéo theo, vì chọn B:

- **Đổi schema phải làm đúng những gì đổi database đang làm**: `invalidateCatalog()`, Sidebar
  nạp lại danh sách, các tab đang mở đổi scope (mục 4.3).
- **Đổi database phải nạp lại danh sách schema và reset ô chọn** — schema `sales` không chắc tồn
  tại ở database mới. Bỏ bước này thì ô chọn trỏ vào một schema không có thật và mọi thứ lại trống
  trơn, đúng triệu chứng mục 1 mà lần này còn khó đoán hơn.
- Ô chọn đặt cạnh ô chọn database hiện có; `DbRail.tsx` (thêm ở `68b912e`) hiện chưa biết gì về
  schema.

### 4.2. SQL sinh ra phải qualify tên

Không chỉ các câu introspection. Mọi chỗ dựng SQL bằng `format!` phải thành `"sales"."film"`.
Đây là phần dễ sót nhất (mục 6), nên liệt kê hẳn ra thay vì để "vân vân":

| Tệp | Hàm | Dòng | Câu sinh ra |
|---|---|---|---|
| `database.rs` | `get_table_data` | 699, 703 | `SELECT *` / `COUNT(*)` của Data Grid |
| `database.rs` | `generate_alter_sqls` | 1117–1254 | mọi `ALTER TABLE` (dùng cho cả `alter_table_schema` lẫn `preview_alter_schema`) |
| `database.rs` | `commit_changes` | 2270, 2288, 2311 | `DELETE` / `INSERT` / `UPDATE` khi bấm Lưu ở lưới |
| `database.rs` | `create_table` | 2765 | `CREATE TABLE` |
| `database.rs` | `import_new_table` | 2852, 2855 | `CREATE TABLE` lúc nhập |
| `database.rs` | `drop_table` | 2988 | `DROP TABLE` |
| `database.rs` | `truncate_table` | 3050–3075 | `TRUNCATE` / `DELETE` / `ALTER … AUTO_INCREMENT` |
| `database.rs` | `get_table_definition` | 3114 | `SHOW CREATE TABLE` (MySQL) + phần `CREATE TABLE` tự dựng |
| `database.rs` | `rename_table` | 3213 | `RENAME TABLE` / `ALTER TABLE … RENAME TO` |
| `database.rs` | `bulk_insert` | 3271 | `INSERT` của `import_table_data` |
| `database.rs` | `get_object_definition` | 4003 | `SHOW CREATE TABLE` |
| `data_generator.rs` | `fetch_fk_pool` | 1974–1976 | `SELECT <fk> FROM <parent>` |
| `data_generator.rs` | `estimate_fk_pool` | 2033–2034 | `MAX(<key>) FROM <parent>` |
| `data_generator.rs` | `insert_sql` | 2145 | `INSERT` hàng loạt |
| `data_generator.rs` | `run_generation` | 2397 | `DELETE FROM <table>` của "xoá dữ liệu cũ" |

Chỗ thắt cổ chai để sửa: **hai** hàm `quote_ident` (`database.rs:2876`, `data_generator.rs:382`).
Thêm một `qualified()` cạnh mỗi hàm — copy `db_compare.rs:432` — rồi đổi các điểm trên sang gọi
`qualified()`. Không gộp hai hàm làm một trong đợt này: chúng khác chữ ký (một nhận
`&DbConnection`, một nhận `&str` dialect), gộp lại là một thay đổi riêng.

Hai chỗ đáng chú ý vì nằm ngoài trực giác "sửa các câu introspection là xong":

- `get_table_data` là **đường đọc** nhưng không có `'public'` nào để grep — nó nhận tên bảng từ
  frontend và ghép thẳng. Sửa hết mục 2 mà quên nó thì Sidebar liệt kê được bảng ở `sales` nhưng
  bấm vào là lỗi "relation does not exist".
- `get_primary_key_columns` (mục 2) nuôi `commit_changes`. Nếu nó vẫn đọc `public` trong khi
  `commit_changes` đã ghi vào `sales`, kết quả không phải lỗi mà là **dò sai khoá chính** — mệnh
  đề `WHERE` sai, tức sửa/xoá nhầm hàng. Hai chỗ này phải đổi trong cùng một lần.

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

### 5.0. Schema đi xuống backend bằng đường nào? — ✅ ĐÃ CHỐT: **trạng thái trong `DatabaseManager`**

Chốt B ở 4.1 mới trả lời "người dùng chọn schema ở đâu", chưa trả lời "backend biết schema bằng
cách nào". Hai đường đã cân:

- **Tham số cho từng lệnh** (`schema: Option<String>`): sửa chữ ký của 12 lệnh ở mục 2 **cộng**
  các lệnh ở mục 4.2 (`get_table_data`, `commit_changes`, `drop_table`, `truncate_table`,
  `rename_table`, `create_table`, `import_table_data`, …) — khoảng 25 lệnh, mỗi lệnh kéo theo một
  điểm sửa trong `dbHelper` và mọi nơi gọi nó ở frontend.
- **Lưu trong `DatabaseManager`** ✅, cạnh `db_type` và `last_config`, đổi bằng một lệnh
  `set_current_schema` giống cách `switch_database` đổi database.

**Chốt đường thứ hai** (2026-08-13). Ba lý do, theo thứ tự sức nặng:

1. **Nó là cách database đang được xử lý.** `DatabaseManager` giữ đúng một `DbConnection`, một
   `db_type`, một `last_config`; database đang mở đổi bằng `switch_database` chứ không phải bằng
   tham số của từng lệnh. Schema đứng đúng tầng đó — cùng lý do `tx_session.rs` tra cứu phiên bằng
   `static` cấp module thay vì nhét vào chữ ký mọi hàm chạy SQL.
2. **Các đường bên trong `data_generator.rs` không phải lệnh nên tham số không tới được.**
   `collect_meta`, `fetch_fk_pool`, `estimate_fk_pool`, `insert_sql`, `run_generation` là hàm nội
   bộ; đi đường tham số thì vẫn phải luồn `schema` qua từng chữ ký một. Còn `active_conn()`
   (`data_generator.rs:1891`) **đã** lấy `dialect` ra từ manager rồi — thêm schema vào đúng chỗ đó
   là một dòng, và cả 5 hàm kia có ngay.
3. **Mọi lệnh trong `database.rs` đã có sẵn khối lấy trạng thái đó.** Khuôn chung là
   `{ khoá manager; clone conn ra; clone db_type ra; thả khoá }` (ví dụ `database.rs:510–518`) —
   lấy thêm schema là một dòng trong khối đã có, không đổi chữ ký lệnh nào, không đụng `dbHelper`
   và không đụng nơi gọi ở frontend.

Điều đường này **không** mua được: nó không giảm rủi ro sót ở mục 4.2. Chỗ nào quên gọi
`qualified()` thì vẫn âm thầm ghi vào `public`, dù schema lấy từ đâu. Bảng ở 4.2 vẫn là danh sách
kiểm bắt buộc.

Hình dạng cụ thể:

- `DatabaseManager` thêm `current_schema: Option<String>` (`None` = MySQL/SQLite, hoặc chưa kết nối).
- `connect_db` đặt giá trị đầu bằng `SELECT current_schema()` khi là Postgres — đây chính là "schema
  đầu tiên trong `search_path`" mà 4.1 mô tả, lấy được mà không cần thêm UI nào.
- `switch_database` **phải đọc lại** `current_schema()` sau khi đổi pool, và `disconnect_db` xoá về
  `None` — cùng lý do đã nói ở 4.1 (schema cũ không chắc tồn tại ở database mới).
- `set_current_schema(name)` là lệnh ô chọn gọi.
- Helper `pg_schema(&manager) -> String` mặc định `"public"`, để không rải `unwrap_or("public")`.
- **`connect_db`, `switch_database` và `set_current_schema` đều trả về schema đang hiệu lực.**
  Frontend cần con số này cho `scopeKey` (4.3): với đường này, schema dùng làm khoá localStorage đến
  **từ phản hồi của backend**, không phải từ state của ô chọn — nếu không, lần kết nối đầu (khi
  người dùng chưa chạm vào ô chọn) sẽ ghi khoá theo một giá trị mà backend chưa chắc đồng ý.

### 5.1. Các bước

1. **Backend**: `pg_schema()` helper (mặc định `public`, giữ nguyên hành vi cũ khi chưa đặt) +
   `qualified()` cạnh mỗi `quote_ident` (4.2), rồi thay 23 chỗ ở `database.rs` và 4 chỗ ở
   `data_generator.rs` (mục 2).
2. **Lệnh mới `list_schemas`**: `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
   AND nspname <> 'information_schema' ORDER BY 1`. Trả rỗng cho MySQL/SQLite (frontend ẩn ô chọn).
3. **Trạng thái schema**: `current_schema` trong `DatabaseManager` + lệnh `set_current_schema`,
   `connect_db`/`switch_database`/`disconnect_db` đặt lại nó, cả ba trả về schema hiệu lực (5.0).
   `active_conn()` của `data_generator.rs` trả thêm schema.
4. **`dbHelper`**: `getSchemas()` + `setSchema()`.
5. **Qualify tên** ở mọi chỗ sinh SQL — bảng ở 4.2 là danh sách kiểm.
6. **UI**: ô chọn schema trên Sidebar (chỉ hiện với Postgres) + `invalidateCatalog()` khi đổi;
   đổi database thì nạp lại danh sách schema và reset ô chọn (4.1).
7. **`connKey.ts`**: thêm schema vào `scopeKey`, kèm đường đọc khoá cũ.
8. **`dumpBuilder`**: `CREATE SCHEMA` + `SET search_path` trong header khi schema ≠ `public`.
9. **Test**: `connKey` (khoá cũ vẫn đọc được), `dumpBuilder` (header có schema), và một ca
   introspection chạy tay trên database có schema `sales`.

Thứ tự gợi ý: 1–5 (backend + qualify) đi trọn một lượt rồi mới sang 6–8. Làm ngược lại thì ô chọn
có mặt trước khi các đường ghi biết nghe theo nó — tức là người dùng đổi sang `sales` và app ghi
vào `public`, đúng cái rủi ro nặng nhất ở mục 6.

---

## 6. Ước lượng & rủi ro

- Backend + `list_schemas` + ô chọn: ~1 buổi.
- Qualify tên ở các đường ghi (4.2) là phần dễ sót nhất — sót chỗ nào thì lệnh đó âm thầm chạy
  vào `public`, tức là **ghi nhầm schema**, không phải chỉ hiển thị sai. Có hai mức: sót ở đường
  đọc thì lỗi hiện ra ngay ("relation does not exist"); sót ở `get_primary_key_columns` thì không
  lỗi gì cả mà `WHERE` sai (4.2).
- `scopeKey` đổi mà quên đường đọc khoá cũ thì người dùng mất hết tab đang mở.
- Data Generator có đường đọc metadata riêng (`collect_meta`) — dễ tưởng đã xong khi
  `get_full_catalog` chạy đúng.

---

## 7. Trạng thái

**Hết chặn — đã chốt cả hai quyết định** (2026-08-13):

- **4.1 = phương án B**: ô chọn schema trên Sidebar, mặc định lấy từ `current_schema()`.
- **5.0 = trạng thái trong `DatabaseManager`** + lệnh `set_current_schema`, không thêm tham số
  cho lệnh nào.

**Đã làm xong 5.1 mục 1–5** (backend + qualify tên):

- `DatabaseManager.current_schema`, helper `pg_schema()` / `pg_schema_of()` / `sql_str()` /
  `qualified()`; `probe_pg_schema()` đọc `current_schema()` lúc kết nối.
- `connect_db` / `switch_database` / `disconnect_db` đặt lại và **trả về** schema hiệu lực.
- Lệnh mới `list_schemas`, `set_current_schema` (có kiểm tra schema tồn tại), đã đăng ký ở
  `lib.rs`, đã có `listSchemas()` / `setSchema()` trong `dbHelper` và message mới đã vào
  `backendErrors.ts` + 3 tệp locale.
- 23 chỗ `'public'` ở `database.rs` và 4 chỗ ở `data_generator.rs` đã tham số hoá; `active_conn()`
  của Data Generator trả thêm schema nên 5 hàm nội bộ có sẵn.
- Qualify tên ở toàn bộ call-site mục 4.2.

**Đã làm xong mục 6–7**:

- Ô chọn schema trên Sidebar (`.sidebar-schema-bar`), chỉ hiện khi `list_schemas` trả về khác
  rỗng — tức chỉ Postgres, không cần kiểm tra `dbType` ở chỗ hiển thị.
- `App.tsx` giữ `connection.schema`, luôn lấy từ phản hồi backend (`connect_db`,
  `switch_database`, `set_current_schema`), không tự đoán.
- Đổi schema chạy đúng luồng của đổi database: `invalidateCatalog()` + `dbReloadKey` + nạp lại
  tab theo khoá mới. `Sidebar` thêm `schema` vào deps của effect nạp bảng.
- `scopeKey(config, db, schema)` + `tabsStorageKey(..., schema)`; hậu tố `:schema` **chỉ** thêm
  khi khác `public`, nên khoá của người dùng cũ giữ nguyên cách viết. Đường đọc lùi nằm ở
  `scopeKeyCandidates` / `tabsStorageKeyCandidates` (mới → khoá không có schema → khoá tiền
  `connKey`), chỉ khoá đầu được ghi. Có test cho cả hai.

**Đã làm xong mục 8**: `dumpHeader()` nhận thêm `schema` và ghi `CREATE SCHEMA IF NOT EXISTS` +
`SET search_path TO` khi schema khác `public` — bỏ qua với `public` để tệp xuất từ database
thường không khác gì bản trước đây. Hai nơi gọi `buildDump` đều truyền schema: popup Xuất
(`App.tsx`, lấy từ `connection.schema`) và nút Backup của Connection Manager (lấy từ phản hồi
`connect`). Đặt ở header thay vì qualify từng câu DDL là cố ý — người dùng đổi schema đích chỉ
bằng sửa **một dòng**, còn tên đã qualify thì phải sửa cả tệp.

**Toàn bộ mục 1–8 đã xong**, và đã kiểm chứng: `cargo check` sạch (không warning, không lỗi),
`tsc -b` 0 lỗi, `npm test` 529 test qua, `oxlint` sạch.

Còn hai việc đứng ngoài phần code:

- **Chưa chạy tay trên một database Postgres thật có schema `sales`** — đây là mục 9 của 5.1 mà
  máy này không có sẵn dữ liệu để làm. Đường đọc (sidebar, catalog, xuất) sai thì lộ ra ngay,
  nhưng đường ghi thì không: cần kiểm ít nhất **sửa một dòng ở lưới rồi Lưu** (khớp cặp
  `get_primary_key_columns` ↔ `commit_changes`), **thêm/xoá cột ở trình sửa cấu trúc**, và
  **sinh dữ liệu cho một bảng có khoá ngoại**.
- `pg_get_indexdef()` trả về câu `CREATE INDEX … ON <schema>.<bảng>` có sẵn schema (output của
  chính Postgres), nên riêng index trong dump vẫn mang tên schema nguồn. `SET search_path` ở
  header không đổi được điều đó. Hệ quả: nhập một dump có index vào schema tên khác thì index
  vẫn trỏ schema cũ. Muốn xử lý thì phải viết lại chuỗi trả về, nên tách thành việc riêng.

### Ý ở 4.4 đã cân nhắc và KHÔNG làm

"Cho phép đổi schema đích lúc nhập" (giống ô "database đích" của popup Nhập). Không làm vì header
đã đủ: schema đích nằm trên đúng một dòng `SET search_path TO "x";` ở đầu tệp, sửa tay là xong.
Thêm một ô nữa nghĩa là phải viết lại dòng đó trong tệp người dùng đưa vào — tức là sửa nội dung
dump trước khi chạy, đúng loại việc mà mọi thứ khác trong luồng nhập đang tránh.

Hai việc phát sinh khi làm, ghi lại để khỏi tìm lại:

- `generate_alter_sqls` trước đây sinh backtick cho **cả ba** dialect ở các nhánh dùng chung
  (thêm cột, xoá cột, đổi tên cột) — Postgres từ chối backtick, nên các thao tác đó ở trình sửa
  cấu trúc vốn đã hỏng trên Postgres từ trước. Đã sửa bằng token trích dẫn theo dialect, vì
  không sửa thì không qualify đúng được.
- `get_table_schema` lấy index/FK chỉ theo **tên bảng**, không lọc schema. Hai schema có bảng
  trùng tên thì trộn kết quả. Đã thêm điều kiện schema.
- DDL **sinh ra** (CREATE TABLE/VIEW, COMMENT, constraint) cố ý **không** qualify, để tệp dump
  còn nhập lại được vào schema tên khác — đúng hướng mục 4.4. Ngoại lệ nằm ngoài tầm với:
  `pg_get_indexdef()` là output của chính Postgres và luôn kèm schema; xử lý ở mục 8.
