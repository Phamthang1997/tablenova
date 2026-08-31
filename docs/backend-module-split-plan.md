# Kế hoạch: tách `src-tauri/src` thành các module một-nhiệm-vụ

Hiện trạng: 18 tệp, 16.833 dòng, **phẳng** (không có thư mục con nào). Sáu tệp chiếm 87% khối lượng
và mỗi tệp đang làm nhiều việc không liên quan nhau.

| Tệp | Dòng | Đang gánh bao nhiêu nhiệm vụ |
|---|---:|---|
| `database.rs` | 5.515 | dựng URL, IAM, decode cell, tách câu lệnh SQL, ba funnel thực thi, catalog, DDL bảng, DDL database, trigger/sequence/view/partition, restore dump, trạng thái kết nối, **và** `open_url` + `set_app_window_size` (không liên quan DB) |
| `data_generator.rs` | 2.556 | PRNG, parser regex, sinh text, spec, meta bảng, ghi dữ liệu, 4 command |
| `db_compare.rs` | 2.388 | phân giải 2 phía, đọc schema 3 dialect, so khác biệt, sinh SQL đồng bộ, so dữ liệu |
| `redis_db.rs` | 2.151 | TLS/URL, 43 command trải trên 8 kiểu dữ liệu, slowlog, pubsub, monitor, analyze, dump/restore |
| `tx_session.rs` | 1.130 | phân loại câu lệnh (thuần), state machine phiên, routing, 7 command |
| `db_stats.rs` | 753 | 4 command độc lập nhau |
| `state.rs` | 605 | id, `ServerHandle`, `ConnEntry`/`ConnCtx`/`RedisCtx`, registry |

`lib.rs` (239) trộn ba việc: khai báo module, `setup()` (vibrancy cửa sổ + park `AppHandle`), và danh
sách 150 dòng `generate_handler!`.

Đây thuần là việc **di chuyển code**. Không sửa hành vi, không đổi tên hàm, không đổi thông điệp lỗi.

---

## 1. Nguyên tắc chia

1. **Một tệp = một nhiệm vụ nêu được bằng một câu.** Nếu phải dùng chữ "và" thì chia tiếp.
2. **Tách tầng nền ra khỏi tầng command trước.** `#[tauri::command]` là *biên IPC*; hàm dựng SQL,
   decode cell, tách câu lệnh là *logic*. Trộn hai thứ là lý do `database.rs` phình.
3. **Hàm thuần đi riêng một tệp.** Đó là những thứ duy nhất test được không cần DB
   (`split_sql_statements`, `generate_alter_sqls`, `tx_effect`, `parse_regex`, `norm_type`,
   `topo_order`, `quote_ident`). Tách xong mới thêm được `#[cfg(test)]` cho chúng.
4. **Đường dẫn công khai giữ nguyên.** `crate::database::X` vẫn phải gọi được sau khi chia, nếu không
   thì mỗi đợt kéo theo cả `lib.rs` và 5 module khác.
5. **Tệp nhỏ không phải là chi phí.** `views.rs` 30 dòng vẫn tốt hơn 30 dòng nằm lẫn trong 5.515.

---

## 2. Kỹ thuật giữ compile xanh

**Tệp → thư mục cùng tên, `mod.rs` chỉ chứa `mod` + `pub use`.**

```rust
// database/mod.rs — không có logic
mod conn;      mod dsn;       mod iam;      mod decode;
mod rows;      mod ident;     mod splitter; mod read_only;
mod timeout;   mod exec;      mod commands;

pub use conn::*;
pub use dsn::*;
pub use commands::*;
// ...
```

Hai điểm bắt buộc:

- **Dùng `pub use x::*;` (glob), không liệt kê từng tên.** `#[tauri::command]` sinh thêm một
  `macro_rules! __cmd__<tên>` ẩn bên cạnh hàm; `generate_handler!` gọi chính macro đó. Re-export
  riêng cái hàm là chưa đủ — glob mới kéo theo macro. Đây là rủi ro kỹ thuật *duy nhất* của cả kế
  hoạch, nên **đợt 1 làm thí điểm trên một module nhỏ để xác nhận** trước khi động vào `database.rs`.
  Nếu glob không đủ, phương án dự phòng là sửa đường dẫn trong `generate_handler!` (cơ học, an toàn,
  chỉ tốn công).
- **Không dùng `use super::*;` trong tệp con.** Import tường minh, nếu không thì vẫn là một tệp lớn
  chia ra chỗ ngồi khác nhau, và cái vòng phụ thuộc không hiện ra ở đâu cả.

**Mỗi đợt là một commit riêng, chỉ chứa di chuyển.** Cách tự kiểm trước khi commit:

```bash
# danh sách hàm trước và sau phải giống hệt nhau
grep -rho '^\(pub(crate) \|pub \)\?\(async \)\?fn [a-z_0-9]*' src-tauri/src/database* | sort > after.txt
diff before.txt after.txt   # phải rỗng
```

---

## 3. Bản đồ đích

Số dòng là ước lượng từ bố cục hiện tại.

```text
src-tauri/src/
├── main.rs                          6
├── lib.rs                          ~35   chỉ khai báo module + AppState + Builder
├── app/
│   ├── mod.rs
│   ├── setup.rs                    ~60   vibrancy cửa sổ, park AppHandle (tx_session + state)
│   ├── handlers.rs                ~160   generate_handler!
│   └── shell.rs                    ~45   open_url, set_app_window_size  ← đang nằm nhầm trong database.rs
├── state/
│   ├── mod.rs
│   ├── ids.rs                      ~80   ConnScopeId, ServerId, ConnId, mint_id
│   ├── server.rs                   ~90   ServerHandle
│   ├── entry.rs                   ~160   LiveConn, RedisConn, ConnEntry, ConnCtx, RedisCtx
│   └── registry.rs                ~180   ConnRegistry
├── database/
│   ├── mod.rs                      ~60
│   ├── conn.rs                    ~110   DbKind, DbConnection, Exec
│   ├── dsn.rs                     ~150   url_encode_component, build_pg_url, build_mysql_url, apply_ssh_tunnel
│   ├── iam.rs                     ~110   is_iam, apply_iam_password, build_iam_conn, spawn_iam_refresh
│   ├── decode.rs                  ~220   decode_pg_cell!, decode_mysql_cell!, json_to_sqlite_value,
│   │                                     bind_pg_params, bind_mysql_params + mod tests hiện có
│   ├── rows.rs                     ~90   uniquify_columns, rows_of, cell, first_i64, result_rows,
│   │                                     row_str, row_i64, all_string_values, scalar_to_cursor
│   ├── ident.rs                    ~90   quote_ident, qualified, sql_str, sql_literal, pg_schema_of,
│   │                                     probe_pg_schema, fk_checks_sql
│   ├── read_only.rs                ~40   reject_conn_read_only, reject_if_read_only
│   ├── timeout.rs                  ~70   stmt_timeout, with_timeout, timeout_msg, set_statement_timeout
│   ├── splitter.rs                ~440   split_sql_statements + delimiter/trigger/comment helper
│   │                                     ← sinh đôi với src/sql/statements.ts
│   ├── exec/
│   │   ├── mod.rs                  ~20
│   │   ├── raw.rs                 ~200   execute_raw_sql_generic, sqlite_raw, pg_raw, mysql_raw
│   │   ├── bound.rs               ~120   run_bound_query, *_bound
│   │   └── stream.rs              ~260   stream_sql_statements, stream_one_statement, *_stream
│   └── commands/
│       ├── mod.rs                  ~30
│       ├── connection.rs          ~150   connect_db, disconnect_db, list_connections, set_connection_read_only
│       ├── status.rs              ~380   ConnectionStatusInfo, ping_connections, get_connection_status
│       ├── catalog.rs             ~230   get_tables, get_full_catalog, exact/estimate_row_count
│       ├── row_read.rs            ~210   get_table_data
│       ├── row_write.rs           ~330   commit_changes, get_primary_key_columns, bulk_insert,
│       │                                 import_table_data, import_new_table
│       ├── query.rs               ~200   execute_query, execute_multi_query, execute_query_stream, cancel_query
│       ├── table_schema.rs        ~300   get_table_schema
│       ├── table_alter.rs         ~270   generate_alter_sqls, alter_table_schema, preview_alter_schema
│       ├── table_ddl.rs           ~360   create/drop/truncate/rename_table, get_table_definition, run_fk_wrapped
│       ├── ddl_extras.rs          ~120   get_table_ddl_extras
│       ├── databases.rs           ~340   get_databases_list, list/open/create/drop/rename_database,
│       │                                 list_schemas, set_current_schema
│       ├── objects.rs             ~240   get_database_objects, get_object_definition, get_db_charsets
│       ├── restore.rs             ~380   restore_backup, TableMatcher, is_session_level_stmt,
│       │                                 stmt_mentions_table, use_db_name, upper_head
│       ├── stubs.rs                ~40   ai_chat, export_table, import_dbeaver, restore_backup_old
│       └── objects/
│           ├── triggers.rs        ~230
│           ├── sequences.rs        ~60
│           ├── partitions.rs       ~40
│           ├── constraints.rs      ~40
│           ├── routines.rs         ~20
│           └── views.rs            ~20
├── tx/
│   ├── mod.rs
│   ├── effect.rs                  ~220   TxEffect, tokens, tx_effect, is_write_stmt, isolation_allowed,
│   │                                     begin_statements, is_aborted_error  ← thuần, test được
│   ├── session.rs                 ~340   Meta, Session, TX_REGISTRY, status_json, emit_state, apply_effect
│   ├── route.rs                   ~330   should_route, lock_pinned, ensure_begin, run_raw/bound/stream
│   └── commands.rs                ~210   7 command tx_*
├── redis/
│   ├── mod.rs
│   ├── config.rs                  ~130   url, redis_ssl_mode, TLS certs, make_client
│   ├── conn.rs                    ~140   make_conn, take_conn, ensure_writable, RedisCaps, probe_caps
│   ├── value.rs                    ~90   redis_value_to_json, as_text, lossy_text, is_binary, pairs_to_json
│   ├── session.rs                 ~140   redis_connect/disconnect/select_db/set_read_only
│   ├── keys.rs                    ~420   scan, scan_stream, get_key, get_elements, delete_keys,
│   │                                     delete_by_pattern, ttl, rename, flush_db
│   ├── types/
│   │   └── string.rs / hash.rs / list.rs / set.rs / zset.rs / stream.rs / json.rs   ~60–160 mỗi tệp
│   ├── admin.rs                   ~110   redis_info, redis_execute_cmd
│   ├── slowlog.rs                 ~110
│   ├── live.rs                    ~180   dedicated_client, cancel helper, pubsub_start, publish, monitor_start
│   ├── analyze.rs                 ~170
│   └── transfer.rs                ~130   redis_dump_keys, redis_restore_keys
├── datagen/
│   ├── mod.rs
│   ├── rng.rs                     ~110   Rng, split_mix64, mix_seed  ← thuần
│   ├── template.rs                 ~70   expand_template, template_space  ← thuần
│   ├── regex.rs                   ~250   Rx, parse_regex, sample_regex  ← thuần
│   ├── text.rs                    ~130   lorem, slug, vi_deaccent, tên/địa chỉ, luhn  ← thuần
│   ├── spec.rs                    ~180   GenSpec/GenTableSpec/GenColumnSpec, Cell, o_* reader
│   ├── column.rs                  ~490   ColState — bộ sinh giá trị của một cột
│   ├── meta.rs                    ~360   collect_meta, topo_order, type_family, suggest_generator, parse_enum_type
│   ├── writer.rs                  ~360   prepare_table, insert_sql, run_generation, restore_session, fk pool
│   └── commands.rs                ~200   4 command
├── compare/
│   ├── mod.rs
│   ├── side.rs                    ~250   CompareSide, Resolved, resolve_side, query_rows funnel
│   ├── meta.rs                    ~140   ColMeta/IdxMeta/FkMeta/TableMeta + *_json
│   ├── read/{mysql,pg,sqlite}.rs  ~120/130/110
│   ├── diff.rs                    ~230   norm_type, norm_default, *_changes, view_def_differs
│   ├── sync_sql.rs                ~340   SqlOut, create_table_sql, create/drop_index, add/drop_fk, alter_column
│   ├── schemas.rs                 ~480   compare_schemas
│   └── data.rs                    ~560   compare_data_overview, compare_table_data, insert/update/delete_sql
├── stats/
│   ├── mod.rs
│   ├── cells.rs                    ~40   get_pg_i64_cell, get_mysql_i64_cell, is_system_db
│   ├── database.rs                ~190   get_database_stats
│   ├── all_databases.rs           ~290   get_all_databases_stats
│   ├── sizes.rs                   ~200   get_all_databases_sizes
│   └── row_count.rs                ~40   get_exact_table_row_count
├── ssh_tunnel.rs                   139   ✔ giữ nguyên
├── ssh_terminal.rs                 162   ✔ giữ nguyên
├── local_terminal.rs               152   ✔ giữ nguyên
├── aws_iam.rs                      198   ✔ giữ nguyên
├── oauth.rs                        210   ✔ giữ nguyên
├── secret_store.rs                 112   ✔ giữ nguyên
├── datasets.rs                     183   ✔ giữ nguyên (dữ liệu tĩnh của datagen)
└── export.rs                        75   ✔ giữ nguyên (xem §6)
```

Không tệp nào vượt ~500 dòng, và ~500 chỉ còn ở 3 chỗ (`datagen/column.rs`, `compare/schemas.rs`,
`compare/data.rs`) — chúng là **một** nhiệm vụ thật sự dài, không phải nhiều nhiệm vụ chồng lên nhau.

---

## 4. Thứ tự thực hiện

Xếp theo rủi ro tăng dần: mỗi đợt đứng độc lập, build được, commit được, dừng lại giữa chừng không sao.

| Đợt | Việc | Vì sao ở vị trí này |
|---|---|---|
| **0** | `lib.rs` → `app/{setup,handlers}.rs` | Không đụng logic nào. Rút `lib.rs` còn ~35 dòng |
| **1** | `db_stats.rs` → `stats/` — **thí điểm** | 753 dòng, 4 command tách bạch, chỉ 2 module phụ thuộc. Đây là chỗ xác nhận glob re-export có kéo theo `__cmd__*` macro không (§2) |
| **2** | `state.rs` → `state/` | Nền của mọi thứ khác, không có command nào bên trong |
| **3** | `database.rs` → `database/` — chỉ tầng nền | Kéo `conn/dsn/iam/decode/rows/ident/read_only/timeout/splitter/exec/*` ra. Sau đợt này `database/commands.rs` còn tạm ~3.400 dòng nhưng **chỉ còn command** |
| **4** | `database/commands.rs` → `database/commands/*` | Cắt theo bảng §3. Cơ học, đã có tầng nền để import |
| **5** | `tx_session.rs` → `tx/` | Tách `effect.rs` (thuần) khỏi state machine là phần giá trị nhất |
| **6** | `db_compare.rs` → `compare/` | |
| **7** | `data_generator.rs` → `datagen/` | |
| **8** | `redis_db.rs` → `redis/` | Nhiều command nhất nhưng phụ thuộc nông nhất — để cuối, làm khi đã quen nhịp |
| **9** | Dọn: `open_url`/`set_app_window_size` → `app/shell.rs`; xoá stub chết; cập nhật `CLAUDE.md` | Xem §6 |

Đợt 3 và 4 là phần lớn công việc. Có thể chia nhỏ đợt 4 thành từng nhóm command (một commit cho
`table_*`, một cho `databases`+`objects`, một cho `restore`) nếu muốn diff nhỏ hơn.

---

## 5. Kiểm chứng

Không có test Rust nào ngoài 5 test trong `database.rs` (`json_to_sqlite_value` + một truy vấn SQLite
in-memory), nên compiler gần như là mạng lưới an toàn duy nhất. Vì vậy:

1. **Trước mỗi đợt**: lưu danh sách hàm (`grep` ở §2). Sau đợt: `diff` phải rỗng.
2. **`cargo check`** với `CARGO_TARGET_DIR=C:\cargo-targets\TABLEGRID`, **không chạy khi `tauri dev`
   đang bật**. Nếu build script của Tauri crash (`STATUS_ACCESS_VIOLATION` — đã gặp trên máy này,
   không liên quan code app) thì kiểm bằng `.\dev-start.bat`.
3. **Chạy thử tay theo đợt**, vì `generate_handler!` sai đường dẫn không lộ ra lúc compile nếu tên
   module đúng mà hàm sai — nó lộ ra lúc runtime dưới dạng "unknown command":
   - đợt 1: mở Database Info + dashboard dung lượng
   - đợt 3–4: kết nối cả 3 dialect, mở bảng, sửa + Save, chạy SQL editor (Ctrl+Enter và Run All),
     Alter schema (preview + apply), restore một dump có `DELIMITER`/trigger
   - đợt 5: bật commit thủ công, sửa vài dòng, Commit và Rollback
   - đợt 8: mở Redis, xem từng kiểu key, Pub/Sub, Monitor, export/import prefix
4. **Sau đợt cuối**: `npm run build` một lần cho chắc.

---

## 6. Bẫy đã biết

- **Không sửa literal tiếng Việt khi di chuyển.** `src/utils/backendErrors.ts` khớp *nguyên văn* ~55
  thông điệp lỗi từ `src-tauri/src/*.rs`, và `backendErrors.test.ts` kiểm round-trip byte-identical.
  Đổi một dấu cách là hỏng bản dịch. Di chuyển thì được, viết lại thì không.
- **`splitter.rs` là sinh đôi của `src/sql/statements.ts`.** Ghi comment trỏ sang nhau ở đầu tệp mới —
  hiện `CLAUDE.md` là nơi duy nhất ghi ràng buộc đó.
- **`pub(crate)` sẽ phải nới.** Nhiều helper đang `pub(crate)` chỉ vì nằm cùng tệp với chỗ dùng. Khi
  tách, giữ **hẹp nhất còn compile được** (`pub(super)` trước, `pub(crate)` sau) thay vì `pub` hết —
  nếu không thì chia tệp xong mà biên giới vẫn không tồn tại.
- **Test hiện có đi theo hàm nó test**: `mod tests` cuối `database.rs` chuyển sang `database/decode.rs`.
- **Stub chết cần xoá, không cần chuyển** (đợt 9, kiểm lại frontend trước khi xoá):
  `export_table`, `restore_backup_old`, `import_new_table`, `import_dbeaver` — `CLAUDE.md` ghi chúng
  là no-op stub, dump thật dựng ở `utils/dumpBuilder.ts`. `ai_chat` cũng là stub nhưng UI đang gọi,
  nên giữ.
- **`export.rs`** (75 dòng, helper CSV/JSON/gzip) đã "không còn caller ở đường chính". Đợt 9 kiểm
  `grep` xem còn ai dùng; nếu không thì xoá thay vì xếp vào cấu trúc mới.
- **`CLAUDE.md` đang lệch thực tế**: nó mô tả `database.rs` "~1700 dòng" và một `DatabaseManager` duy
  nhất, trong khi thực tế là 5.515 dòng và `state::ConnRegistry` đa kết nối. Mọi đường dẫn tệp trong
  đó phải được cập nhật ở đợt 9 — kế hoạch này chưa xong nếu tài liệu vẫn chỉ sai chỗ.

---

## 7. Đã cân nhắc và KHÔNG làm

- **Không đổi tên `database` → `sql`.** Đúng hơn về nghĩa, nhưng làm hỏng mọi `crate::database::` và
  mọi tham chiếu trong `CLAUDE.md`/`docs/*` cùng lúc với việc chia tệp. Muốn đổi thì làm thành một
  commit rename riêng, sau khi đã ổn định.
- **Không gộp `#[tauri::command]` vào một `commands/` chung ở gốc.** Mẫu gợi ý trong
  `CODING_STANDARDS.md` §6.4 là gợi ý; ở đây command của Redis, datagen, compare gắn chặt với logic
  domain của chúng, tách ra chỉ tạo hai chỗ phải sửa cho một thay đổi.
- **Không thêm `error.rs` / kiểu lỗi chung.** Toàn bộ command đang trả `Result<_, String>` và
  `backendErrors.ts` khớp theo chuỗi. Đổi mô hình lỗi là một thay đổi hành vi, không phải chia tệp.
- **Không viết test mới trong cùng commit di chuyển.** Sau khi các hàm thuần đã ở tệp riêng
  (`tx/effect.rs`, `database/splitter.rs`, `datagen/{rng,regex,template,text}.rs`,
  `compare/diff.rs`), thêm `#[cfg(test)]` là việc riêng, và lúc đó mới rẻ.

---

## 8. Đã thực hiện

Đợt 0–9 đã xong trên nhánh `refactor/backend-module-split`, mỗi đợt một commit, mỗi commit
`cargo check` sạch (không error, không warning) và `cargo test --lib` 5/5.

| Trước | Sau |
|---|---|
| 18 tệp phẳng, 16.833 dòng | 11 thư mục + 2 tệp lẻ ở gốc (`main.rs`, `lib.rs`), 124 tệp `.rs` |
| `database.rs` 5.515 dòng | tệp lớn nhất còn 502 dòng (`datagen/column.rs` — một nhiệm vụ dài, không phải nhiều nhiệm vụ chồng lên nhau) |
| `lib.rs` 239 dòng | **17 dòng** — chỉ danh sách module + 2 re-export |
| 5 test Rust | **101** test Rust, phủ mọi tệp thuần |

**Cách chia và cách kiểm.** Việc cắt được sinh bằng một bản đồ chunk cấp cao nhất (`chunks.awk`)
rồi phân hoạch theo dòng, nên mỗi đợt kiểm được bằng một câu: *tập hợp dòng (bỏ dòng trắng) của
các tệp mới phải GIỐNG HỆT tệp cũ*. Không đợt nào mất hay nhân đôi một dòng.

**`cargo check` KHÔNG crash.** Giả định ở §5 (build script của Tauri có thể `STATUS_ACCESS_VIOLATION`)
không xảy ra lần nào trong cả 10 đợt; vòng lặp sửa–kiểm chạy được bình thường (~18s tăng dần).

**Ba chỗ lệch so với kế hoạch, đều có lý do:**

1. **Không đổi tên `redis_db` → `redis`** (§3 dự tính đổi). `pub mod redis;` ở gốc crate trùng tên
   với chính crate `redis`, và uniform path của Rust 2018 biến `use redis::aio::…` thành lỗi E0659
   *ambiguous* ở mọi tệp con. Tên `redis_db` được giữ.
2. **`open_url` / `set_app_window_size` chuyển ở đợt 0**, không phải đợt 9 — chúng đi cùng lúc với
   việc tạo `app/`, và việc đó xảy ra trước khi `database.rs` bị cắt.
3. **`get_primary_key_columns` / `detect_primary_key` về `commands/catalog.rs`**, không phải
   `row_write.rs`: ba nhóm lệnh đọc chúng, và chúng là đọc metadata chứ không phải ghi.

**Ba thay đổi vượt ra ngoài "di chuyển thuần", đều nhỏ và có chủ ý:**

- `redis_ctx_of()` tách khỏi `ConnRegistry::acquire_redis` sang `state/ctx.rs`. Field của `RedisCtx`
  là private có chủ đích, nên nơi duy nhất được dựng nó phải là module khai báo nó — cách này giữ
  được điều đó, thay vì nới field thành `pub(super)`.
- Khối comment mô tả `get_full_catalog` vốn nằm nhầm phía trên `rows_of`, nay về đúng chỗ.
- Visibility: helper nội bộ được nới lên `pub(super)` (hoặc `pub(crate)` khi vượt một tầng module),
  không nới lên `pub`.

**Đã làm tiếp sau đó (đợt 10–14):**

- **Đợt 10 — gom nốt tệp lẻ ở gốc:** `terminal/{local,ssh}.rs` (chung một giao thức message, nên
  frontend chỉ có một component cho cả hai), `credentials/{aws_iam,oauth,secret_store}.rs` (chung một
  *mối quan tâm*, không chung code — `mod.rs` nói thẳng điều đó), `datasets.rs` vào `datagen/`.
  `ssh_tunnel.rs` tách tiếp thành `ssh/{auth,tunnel}.rs`: nó đang làm HAI việc — xác thực (dùng
  chung với `terminal/ssh.rs`) và chuyển tiếp cổng. `TunnelHandler` đổi tên thành `SshHandler`,
  vì nó là handler của client SSH chứ không riêng gì tunnel. Gốc `src/` giờ chỉ còn `main.rs`
  và `lib.rs`.
- **Đợt 11 — xoá code chết:** `export.rs` + dependency `flate2`, và ba stub `export_table` /
  `import_dbeaver` / `restore_backup_old` (kèm wrapper `dbHelper` và mục `safeMode.ts` —
  `safeMode.test.ts` kiểm hai chiều nên bỏ sót một bên là fail build). `ai_chat` sang `app/ai.rs`.
- **Đợt 12 — test cho các tệp thuần:** 5 test -> **101**. Phủ `database/{splitter,rows,ident,decode}.rs`,
  `tx/effect.rs`, `redis_db/cmds.rs`, `datagen/{rng,template,regex,text}.rs`, `compare/{diff,values}.rs`.
  Hai chỗ đáng nói: `redis_db/cmds.rs` là **ranh giới bảo mật** của chế độ chỉ-đọc và trước đó chỉ
  được kiểm bằng mẹo standalone-rustc; `database/splitter.rs` giờ có test hai bên cùng khoá cặp
  sinh đôi với `src/sql/statements.ts`.
- **Đợt 13 — `lib.rs` còn 17 dòng:** nó đang làm ba việc, và một trong ba mâu thuẫn với chính
  `app/` — thư mục đó là "vòng đời Tauri" và `app/{setup,handlers}.rs` là hai MẢNH của Builder,
  nhưng Builder thì lại ở `lib.rs`. Nay: `app/run.rs` (Builder, cạnh hai mảnh của nó),
  `state/app.rs` (`AppState` + `AppState::new()` — nằm ở `state/` vì trường lớn nhất của nó
  chính là `ConnRegistry` ngay cạnh đó), còn `lib.rs` chỉ giữ danh sách module cộng hai
  re-export giữ nguyên `TABLEGRID::run` và `crate::AppState` (152 call site).

**Dọn nốt phần tài liệu lệch từ trước (2026-08-25).** `CLAUDE.md` còn năm chỗ mô tả `DatabaseManager`
và `RedisState` như thứ đang tồn tại — hai kiểu này bị xoá từ đợt đa kết nối, TRƯỚC đợt tách module.
Đã viết lại theo đúng cơ chế hiện tại, và mỗi chỗ đều kiểm lại bằng code chứ không suy từ tên:

| Chỗ | Trước | Nay |
|---|---|---|
| `DbConnection` | "`DatabaseManager` giữ connection đang active, chỉ một cái cho cả app" | `state::ConnRegistry` khoá theo `conn_id`; **không có "connection đang active"**; `db_type`/`last_config`/tunnel nằm trên `Arc<ServerHandle>` dùng chung theo server |
| Schema Postgres | `DatabaseManager.current_schema` | `ConnEntry.current_schema` — một `conn_id` là một `(server, database)` nên cũng là một schema. `pg_schema()` không còn; mọi call site đọc `ConnCtx::schema()`, vốn đã default sẵn |
| Transaction | "chỉ có đúng một phiên; muốn per-tab thì phải chờ refactor đa kết nối" | refactor đó đã xong: `TX_REGISTRY` là `HashMap` theo `conn_id`, một phiên cho mỗi kết nối. `TxControl` nhận `connId` và **bỏ qua event của kết nối khác** |
| Vòng đời | "`switch_database` từ chối khi transaction đang mở" | `switch_database` **đã bị xoá**; `open_database` THÊM một pool dưới `conn_id` mới nên không phải từ chối gì — transaction trên database cũ vẫn chạy |
| Redis | `RedisState.config` | `ServerHandle` của Redis giữ config **đã qua tunnel** (khác SQL), vì Redis mở socket mới thường xuyên hơn nhiều |
