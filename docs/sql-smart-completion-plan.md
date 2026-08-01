# Kế hoạch: Smart SQL Completion tiệm cận dbForge (hướng B)

Mục tiêu: gợi ý code chính xác theo ngữ cảnh trong Monaco cho **MySQL + PostgreSQL**, đúng cả trong
**subquery/CTE/derived table**, có **alias resolution**, **gợi ý JOIN ON theo FK**, **kiểu dữ liệu**, snippet.
Khác bản MVP heuristic ở chỗ dùng **parser SQL thật (ANTLR4)** thay vì regex.

---

## 1. Kiến trúc tổng thể (toàn bộ chạy frontend)

```
Monaco editor
   │ (text + caret)
   ▼
[1] Lexer/Parser ANTLR4 (MySQL | PG)   ← chọn theo dbType
   │ token stream + parse tree (chịu lỗi, input dở dang)
   ▼
[2] antlr4-c3 CandidatesCollector       ← "tại caret được phép gì": rule + token
   │ candidate rules (table/column/alias/function) + keyword tokens
   ▼
[3] Scope Resolver (visitor trên tree)  ← alias→bảng theo từng scope, CTE, derived table
   │ danh sách bảng/alias/cột nhìn thấy tại caret
   ▼
[4] Catalog (cache metadata)            ← cột+kiểu, PK/FK, view, function
   │
   ▼
[5] Suggestion Builder + Ranking        ← CompletionItem[] (kind, detail, snippet, sortText)
   ▼
Monaco CompletionItemProvider (async, triggerChars: . ( space)
```

Backend (Rust) chỉ đóng vai **cung cấp catalog** (introspection), không tham gia lúc gõ.

---

## 2. Parser (ANTLR4) — phần lõi

- **Tái dùng grammar `grammars-v4`**: `sql/mysql` và `sql/postgresql` (lexer + parser có sẵn). Không tự viết grammar.
- **Runtime TS**: `antlr4ng` (bản TypeScript hiện hành, kế thừa `antlr4ts` đã ngừng). `antlr4-c3` (v3+) tương thích antlr4ng.
- **Sinh parser**: ANTLR tool là **Java** → cần JVM lúc *generate*. Chiến lược: generate **một lần**, **commit file .ts sinh ra** vào repo (`src/sql/generated/`), để build thường ngày & máy khác **không cần Java**. Chỉ regenerate khi nâng grammar.
- **Chịu lỗi / input dở dang**: parse **riêng câu lệnh chứa caret** (tách theo `;` bằng mask sẵn có), bật error-recovery mặc định của ANTLR; c3 vẫn tính được candidate dù câu chưa hợp lệ.
- Chọn parser theo `connection.dbType` (mysql/postgres); SQLite tạm dùng MySQL-lite hoặc bản heuristic cũ.

## 3. antlr4-c3 — máy tính "được phép gì tại caret"

- Cấu hình `preferredRules` = chỉ số các rule ngữ nghĩa: `tableName`, `columnName`, `functionCall/routineName`, `alias`... (khác nhau giữa 2 grammar → có map riêng mỗi dialect).
- `ignoredTokens` = dấu câu/khoảng trắng.
- Tại caret: `core.collectCandidates(tokenIndex)` → `{ rules, tokens }`.
  - `tokens` → gợi ý **từ khoá** (map token type → text).
  - `rules` chứa `tableName`/`columnName`... → chuyển sang [3][4] để lấy tên thật.
- Cần hàm ánh xạ vị trí ký tự Monaco → **token index** trong stream (dựa token start/stop).

## 4. Scope Resolver (tầng ngữ nghĩa)

Visitor nhẹ trên parse tree, dựng **scope stack**:
- Mỗi `SELECT` (kể cả subquery) là 1 scope: thu `FROM`/`JOIN` → danh sách `{alias, schema, table}`; `CTE` → tên + (nếu có) danh sách cột; `derived table` → alias + cột chiếu ra.
- Tại caret: tính **tập bảng/alias nhìn thấy** (scope hiện tại + cha nếu correlated).
- Phân giải:
  - `alias.` → bảng → cột (từ catalog) + kiểu.
  - cột trần → gộp cột mọi bảng trong scope; đánh dấu **nhập nhằng** nếu trùng.
- Xử lý `USING(...)`, `NATURAL JOIN`, `schema.table`.

## 5. Catalog metadata (cache)

**Backend**: thêm command gộp `get_full_catalog(database)` trả:
- tables/views: `{name, kind, columns:[{name,type,nullable,pk}], }`
- foreign keys: `[{table, column, refTable, refColumn}]`
- functions/procedures: `[{name, args}]` (để gợi ý + param hint)
- (index tuỳ chọn)

Đã có sẵn một phần: `getTableSchema`, `getDatabaseObjects`. Gộp/bổ sung để lấy **1 lần/độ trễ thấp** (quan trọng với DB ở xa).

**Frontend `catalog.ts`**:
- Cache theo `connection + database`.
- Nạp **nền** (như `refreshSqlMeta` hiện tại): danh sách bảng+cột+kiểu eager; FK/function có thể lazy theo bảng.
- **Invalidate** khi: `table-renamed`, `database-restored`, sau `commitChanges`/`alter_table_schema` (DDL) → dispatch event, catalog refetch.

## 6. Đồ thị FK cho gợi ý JOIN ON

- Từ danh sách FK dựng adjacency `table → [(col, refTable, refCol)]`.
- Khi caret ở `ON` giữa bảng mới JOIN (A) và các bảng đã có trong scope (B...): đề xuất `A.fk = B.pk` (và chiều ngược lại).
- Fallback heuristic khi không có FK: khớp **cùng tên cột** hoặc `refTable_id ↔ id`.

## 7. Suggestion Builder + Ranking

- `CompletionItem`: `kind` (Field/Class/Function/Keyword), `detail` = kiểu dữ liệu / bảng nguồn, `documentation`, `insertText` + `insertTextRules` (snippet).
- **Snippet**:
  - Chọn bảng sau FROM/JOIN → tự thêm alias gợi ý (`customer c`).
  - JOIN → bung khung `JOIN ${table} ${alias} ON ${cond}`.
  - Lệnh "bung `SELECT *`" thành danh sách cột.
  - Function → `fn(${1:arg})` + signature help (`SignatureHelpProvider`).
- **Ranking** qua `sortText`: khớp prefix > cột trong scope > bảng > từ khoá; cộng điểm **dùng gần đây** (lưu localStorage).
- Fuzzy match (Monaco tự lọc theo prefix; có thể thêm fuzzy riêng).

## 8. Tích hợp Monaco

- Đăng ký `registerCompletionItemProvider('sql', ...)` mới (thay provider hiện tại trong `SqlEditor.tsx`), `triggerCharacters: ['.', '(', ' ']`.
- `provideCompletionItems` async; `resolveCompletionItem` cho documentation lazy.
- Thêm `registerSignatureHelpProvider` cho tham số hàm.
- Dispose provider cũ (đã có cơ chế `sqlCompletionDisposable`).

## 9. Hiệu năng

- **Chỉ parse câu lệnh chứa caret**, không parse cả file.
- Cache parse theo hash text câu lệnh; chỉ parse lại khi đổi.
- Cân nhắc chạy **parse + c3 trong Web Worker** (Monaco đã dùng worker; provider async gọi worker) để không giật khi gõ trên script lớn.
- Metadata luôn từ cache → **0 round-trip lúc gõ**.

## 10. Dialect

- 2 grammar riêng; chọn theo dbType. Bộ **từ khoá + hàm dựng sẵn** theo dialect. Quoting: backtick (MySQL) vs `"..."` (PG). Khác biệt version để sau.

## 11. Kiểm thử

- Fixtures kiểu sakila: đặt caret ở nhiều vị trí (sau `SELECT`, sau `c.`, trong `ON`, trong subquery) → assert tập candidate.
- Unit test cho Scope Resolver (alias, CTE, derived, ambiguity).
- Ma trận thủ công MySQL/PG.

---

## Lộ trình chia nhỏ (trong hướng B)

| Giai đoạn | Nội dung | Kết quả |
|---|---|---|
| **B1** | Hạ tầng: thêm antlr4ng + antlr4-c3, sinh & commit parser **MySQL**, ánh xạ caret→token, c3 candidate → gợi ý **từ khoá + bảng** grammar-based | Parity với provider hiện tại nhưng nền tảng đúng |
| **B2** | `get_full_catalog` + catalog.ts (kiểu, FK, function) + **Scope Resolver** | Gõ `alias.` → cột đúng bảng + kiểu; cột trong scope; đúng cả subquery/CTE |
| **B3** | **JOIN ON theo FK** + snippet (auto-alias, khung JOIN, bung SELECT *) + signature help | Gần bằng ảnh dbForge |
| **B4** | Grammar **PostgreSQL** + đánh bóng dialect | Hỗ trợ PG tương đương |
| **B5** | Web Worker + parse cache + ranking (dùng gần đây) + fuzzy | Mượt trên script lớn, xếp hạng thông minh |

## Rủi ro & đánh đổi
- **Bundle size**: parser MySQL/PG sinh ra khá lớn → tách chunk, lazy-load theo dialect.
- **Build phức tạp**: bước codegen ANTLR cần Java → giải quyết bằng **commit file sinh sẵn**.
- **Bảo trì grammar**: cập nhật theo phiên bản DB — chấp nhận trễ pha.
- **Hiệu năng**: script lớn → Web Worker + parse-per-statement.
- **Công sức**: B1–B5 cỡ **nhiều tuần → tháng**; nên làm tuần tự, dùng thật sau mỗi giai đoạn.

## Cấu trúc file dự kiến
```
src/sql/
  generated/            # parser ANTLR sinh ra (commit), mysql/ + postgres/
  catalog.ts            # nạp/cache metadata + invalidate
  fkGraph.ts            # đồ thị FK -> gợi ý JOIN
  scopeResolver.ts      # visitor scope/alias/CTE
  candidates.ts         # cầu nối antlr4-c3
  completionProvider.ts # dựng CompletionItem + ranking + đăng ký Monaco
src-tauri/src/database.rs  # thêm get_full_catalog
```
