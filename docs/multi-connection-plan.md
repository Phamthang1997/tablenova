# Kế hoạch: hỗ trợ đa kết nối (multi-connection)

Chuyển TableNova từ **một kết nối tại một thời điểm** sang **nhiều kết nối song song**, mỗi tab gắn
với kết nối của nó.

Bản này viết lại bản đầu tiên. Bản đầu gộp ba nhóm việc khác nhau vào một tài liệu và chốt sai một
quyết định trung tâm; phần "đã cân nhắc và KHÔNG làm" ở cuối ghi lại những gì bị bỏ và vì sao, để
khỏi đề xuất lại.

Phạm vi đã chốt:

| Hạng mục | Chốt |
|---|---|
| `conn_id` xuống backend | **Tham số tường minh của mọi lệnh.** Backend **không** giữ "kết nối đang active" (§4.1) |
| Truy vấn liên-kết-nối (federation) | **Bỏ khỏi phạm vi** (phụ lục) |
| Redis | **Ngoài phạm vi** — 43 lệnh, `RedisState` riêng, không chia sẻ code (phụ lục) |
| Thư mục kết nối, Ctrl+K, ping, dashboard, copy giữa 2 kết nối | Tách thành thay đổi độc lập, không chờ đợt này (§5) |

---

## 0. Một lỗi đang tồn tại — ✅ ĐÃ SỬA

Tìm ra khi soát cho kế hoạch này. Không liên quan đa kết nối, nên đã sửa trước và độc lập.

`should_route()` (`tx_session.rs:476`) trả `true` khi `!m.autocommit || m.open` — **trước khi** xét
connection nào. Nhưng `db_compare.rs` đọc metadata qua `execute_raw_sql_generic`, và connection nó
truyền có thể là **pool ad-hoc** do `resolve_side()` mở cho phía không phải database hiện tại.

Hệ quả: bật commit thủ công → mở "So sánh 2 database" trỏ một database khác → `lock_pinned`
(`tx_session.rs:493`) pin **pool tạm của compare** làm phiên và `ensure_begin` chạy `BEGIN` trên đó.
Từ đó **mọi câu lệnh của người dùng chạy vào database compare**, rồi `Resolved::close()` đóng pool
trong khi phiên vẫn trỏ vào nó.

**Đã sửa** bằng cách tách `execute_raw_sql_generic` thành hai: phần kiểm tra route giữ nguyên tên, và
`execute_raw_sql_unrouted` là phần thân. `db_compare::query_rows` — **funnel duy nhất** của cả module,
cả 18 call site đi qua nó — gọi bản unrouted. Không nhân bản code, một chỗ sửa.

Hai điều đã kiểm khi sửa:

- **`db_stats` không dính.** Deep scan của nó (`pg_count_tables_rows_remote`, `db_stats.rs:256`) dùng
  sqlx trực tiếp chứ không qua funnel, nên pool ad-hoc của nó chưa bao giờ route được. Vẫn là chỗ
  phơi nhiễm nếu sau này ai bọc nó lại qua funnel.
- **`data_generator` không dính.** Nó dùng kết nối *active*, không phải ad-hoc, và đã có
  `reject_if_manual_or_open` chặn từ đầu (`data_generator.rs:2260`).

Đánh đổi, ghi lại để khỏi tìm lại: Postgres/MySQL giờ đọc trạng thái **đã commit** qua một pooled
connection riêng. Đó là ngữ nghĩa đúng cho việc so sánh hai database, và MVCC snapshot read không bị
chặn bởi row lock của transaction đang mở. SQLite không đổi gì: `DbConnection::Sqlite` là một handle
dùng chung nên vẫn thấy transaction, route hay không.

Khi làm Phase 1a, `ConnId::Adhoc` (§4.4a) sẽ thay bản sửa này bằng cấu trúc — lúc đó `should_route`
tự trả `false` cho pool ad-hoc và không cần một funnel riêng nữa.

---

## 1. Triệu chứng

Mở kết nối thứ hai là **mất** kết nối thứ nhất. Không có thông báo, không có lựa chọn — kết nối cũ
bị đóng và thay bằng cái mới.

Gốc ở hai chỗ, và cả hai đều ghi rõ giả định trong comment:

- `DatabaseManager.connection` (`database.rs:190`) là **một `Option`**, không phải map. Comment của
  `current_schema` (`:194-199`) nói thẳng: *"there is one connection, so there is one current schema."*
- `connection` (`App.tsx:172`) là **một object nullable** `{ dbName, dbType, schema }`, không phải
  danh sách.

Ba biểu hiện, dùng luôn làm cách verify:

- **`DbRail.tsx` đã tồn tại, đã wire, và chết theo thiết kế.** `connectionCount={connection ? 1 : 0}`
  (`App.tsx:1356`) với guard `< 2` (`DbRail.tsx:70`). Comment trong file ghi là chờ multi-connection.
  Nó cũng chuyển *database*, không chuyển *kết nối*.
- **Kết nối xong là thay cả màn hình.** `App.tsx:1324` là either/or cứng
  `!connection ? <ConnectionManager/> : <workspace/>`; `onConnect` là một cú handoff rồi unmount toàn
  bộ manager. Không có affordance "thêm kết nối".
- **SQL và Redis không cùng tồn tại.** `App.tsx:1332` đổi **toàn bộ** workspace sang `<RedisBrowser>`.

---

## 2. Nguyên nhân — nơi giả định "một kết nối" nằm

Bảng này là **danh sách kiểm**, dùng như bảng 23 chỗ `'public'` của
`docs/postgres-schema-support-plan.md` §2.

| Tệp | Điểm | Ghi chú |
|---|---|---|
| `database.rs` | **50** chỗ `db_manager.lock()` | Cùng một khối inline: lock → `match manager.connection.as_ref()` clone theo variant → `None => Err("Chưa kết nối CSDL")` → clone `pg_schema(&manager)` → thả khoá trước `.await` |
| `tx_session.rs` | `static G: OnceLock<Global>` (`:359`) | §4.2 — rủi ro nặng nhất |
| `data_generator.rs` | `active_conn()` (`:1920`) + `CANCEL_KEY` cố định (`:47`) | `active_conn` là khoá duy nhất của tệp, nuôi 5 hàm nội bộ |
| `db_stats.rs` | 3 chỗ | |
| `db_compare.rs` | `resolve_side()` | Đã tham số hoá — §3 |
| `App.tsx` | `connection` một object; `tabs` một list phẳng; `activeTabId` / `dirtyTabId` / `queryCount` / `dbReloadKey` / `mountedQueryTabs` global | |
| `TabManager.tsx` | `TabInfo` (`:7`) **không có** `connKey` / `db` / `schema` | Ràng buộc tab↔database hiện là **ngoại tại**, qua khoá localStorage — §4.5 |
| `sql/catalog.ts` | singleton cấp module; `schemaCache` key bằng **tên bảng trơn** (`:11`) | Đụng nhau giữa kết nối là *cấu trúc*, không phải xác suất |
| `sql/dbIndexRegistry.ts`, `sql/usageStats.ts`, `utils/schemaSnapshot.ts` | cùng bệnh singleton | |
| 4 `window` CustomEvent | `database-restored`, `table-renamed`, `open-table-tab`, `sql-history-changed` — **không cái nào mang conn id** trong `detail` | Cộng 2 guard `window.__*Listener` khiến handler thành process-global |
| `TxControl.tsx` | `listen(TX_EVENT)` không lọc (`:57`) | Event của kết nối thứ hai ghi đè hiển thị của kết nối thứ nhất |

Quy mô:

| Tầng | Số lượng |
|---|---|
| `#[tauri::command]` toàn bộ / đã đăng ký ở `lib.rs` | 125 / 124 |
| — chạm kết nối SQL (phải thêm `conn_id`) | **~62** (`database.rs` 46, `tx_session.rs` 6, `data_generator.rs` 4, `db_compare.rs` 3, `db_stats.rs` 3) |
| — Redis (ngoài phạm vi) | 43 |
| `dbHelper` method / call site frontend | 121 / **210** (52 tệp) |
| Chỗ **dựng** `DbConnection` | chỉ **12** (9 session + 3 ad-hoc ở `db_compare`) |

Con số cuối là lý do refactor này khả thi: 234 chỗ *nhắc* `DbConnection::` nghe như bất khả, nhưng
164 trong đó nằm **bên trong 50 khối acquire sẽ bị xoá**.

### `cancel_flags` KHÔNG nằm trong bảng trên

Khoá của nó là `q_${crypto.randomUUID()}` (`SqlEditor.tsx:1033`) — đã unique toàn cục, `cancel_query`
không cần biết kết nối nào. **Chỉ `CANCEL_KEY` của Data Generator là đụng thật:** hai lần sinh dữ
liệu đồng thời thì `flags.insert` thứ hai (`data_generator.rs:2315`) thay cờ của lần đầu — một lần
chạy thành không hủy được — và `flags.remove` của lần xong trước (`:2336`) bỏ rơi cờ của lần kia.

---

## 3. Đã có sẵn hình mẫu đúng — và ba việc đã xong

### 3.1 Hình mẫu: `db_compare.rs` đã là per-connection context

`struct Resolved { conn, dialect, schema, label, server, owned, _tunnel }` (`db_compare.rs:56-83`) +
`Resolved::close(self)` (chỉ đóng pool khi `owned`). `resolve_side()` (`:116-280`) **dùng lại** kết
nối đang mở khi phía đó trỏ đúng database hiện tại — không phải xác thực lại, quan trọng với token
AWS IAM sống 15 phút — còn không thì mở pool ad-hoc từ `last_config` với database bị override. **Mọi
hàm downstream nhận `&Resolved`**, không hàm nào với tay lấy biến global.

Tức là module "So sánh 2 database" **đã** chạy đa kết nối trong production. Phần còn lại nên phổ quát
hoá đúng khuôn đó thay vì nghĩ khuôn mới.

### 3.2 Hình mẫu khác đã có

- **Mở pool phụ**: `switch_database` (`database.rs:3863`) đã dựng pool mới từ `last_config` với
  `database` override — thân hàm ở `:3891-3903` **chính là** `open_database()` tương lai.
  `db_stats.rs:256-265` + `:401-416` mở pool transient `max_connections(1)` cho từng database trong
  deep scan. `open_list_pool_pg/mysql` (`database.rs:3752`).
- **Registry trong `AppState`**: đã có 3 map `Mutex<HashMap<String, _>>` (`cancel_flags`,
  `ssh_terminals`, `local_terminals` — `lib.rs:20-33`).
- **Khoá localStorage per-connection**: `connKey()` / `scopeKey(config, db, schema)` /
  `tabsStorageKeyCandidates()` (`utils/connKey.ts`) đã có, kèm đường đọc lùi. `scopeKey` khớp **1:1**
  với identity chốt ở §4.3.
- **Shadowing `invoke` để lấy hết call site bằng một chỗ sửa**: `dbHelper.ts:24` là hàm `invoke` cục
  bộ shadow hàm import, và comment của nó nói thẳng lý do — *"Shadowing the imported name keeps all
  existing `await invoke(...)` call sites unchanged"*. Đó là cách `backendErrors.ts` phủ được cả 63
  call site. §5 Phase 1 dùng lại đúng trick này.

### 3.3 Ba việc bản trước đề xuất xây mà **đã xong**

- **Thư mục kết nối — XONG.** `SavedProfile` đã có `group?: string` **và** `color?: string`
  (`ConnectionManager.tsx:108`); đã có `groupedProfiles`, autocomplete tên nhóm, và export theo nhóm
  (`exportScope: 'all' | 'group' | 'single'`). Thiếu **duy nhất** ngữ nghĩa Đỏ=Prod / Vàng=Staging /
  Xanh=Dev trên `color` đã có.
- **Query history đã đa kết nối — XONG.** `utils/queryHistory.ts` đã gắn `conn` + `db` mỗi entry, có
  `matchesScope()` 3 mức (`db` / `conn` / `all`), `tf_history_scope`, và cap 500 **theo từng `conn`**.
- **Autocomplete** — `sql/catalog.ts` đã có. Việc thật là *key nó theo `(connId, db, schema)`*, không
  phải làm autocomplete.

Cộng hai cái gần xong: **ping** (`get_connection_status`, `database.rs:4424`, đã ping kết nối) và
**copy dữ liệu giữa 2 kết nối** (`utils/dumpBuilder.ts` + `buildSql()` batch 500 dòng / 200k ký tự đã
sinh DDL + INSERT cho cả 3 dialect, đã có test).

---

## 4. Quyết định phải chốt TRƯỚC khi code

### 4.1 `conn_id` là tham số tường minh của mọi lệnh — ✅ ĐÃ CHỐT

Bản trước đề xuất `connections: HashMap<String, _>` **cộng** `active_conn_id: Option<String>`. Bỏ
`active_conn_id`.

Giữ con trỏ "active" ở backend buộc frontend gọi `set_active_connection()` trước mỗi thao tác. Với
210 call site async, hai tab refresh đồng thời sẽ chèn nhau và một trong hai đọc/ghi **sai kết nối,
không lỗi nào phát ra**. "Active" thuần là khái niệm UI, không có mặt ở backend.

Quyết định này **đảo** §5.0 của `docs/postgres-schema-support-plan.md` ("trạng thái trong
`DatabaseManager`, không thêm tham số cho lệnh nào"). Đảo là đúng, vì lý lẽ của §5.0 là *"có một kết
nối nên có một schema"* — **chính tiền đề đó đang bị bỏ**. Schema thì mỗi kết nối một cái; kết nối
thì mỗi **tab** một cái.

`conn_id` khai là `String`, **không bao giờ `Option<String>`**, để Tauri từ chối ngay ở biên khi
frontend quên truyền thay vì âm thầm mặc định về một kết nối nào đó. Đây là chỗ duy nhất trong kế
hoạch mà một lỗi runtime ồn ào là thiết kế đúng.

### 4.2 `tx_session.rs` — rủi ro nặng nhất

Bản trước chỉ ghi `static SESSIONS: Mutex<HashMap<String, TxSessionState>>` theo `conn_id`. **Không
có khoá để tra:** `should_route`, ba funnel (`execute_raw_sql_generic` `database.rs:3434`,
`run_bound_query` `:3643`, `stream_one_statement` `:1991`), ba entry point session (`run_raw`
`tx_session.rs:638`, `run_bound` `:662`, `run_stream` `:696`) và `Exec::acquire` (`database.rs:3599`)
đều nhận `&DbConnection` và dùng nó **chỉ để lấy dialect**.

**Hệ quả nếu để global khi đã có N kết nối — nặng hơn "chặn nhau".** `should_route` đọc `meta` global,
và `Global.pinned` là **một** `tokio::sync::Mutex` cố ý giữ suốt một câu lệnh (comment nguyên văn,
`tx_session.rs:354`: *"Held across the whole statement on purpose: one session means one statement at
a time."*). Bật manual mode một lần là **mọi** câu lệnh của **mọi** kết nối route vào **một**
connection đã pin — SQL của kết nối B chạy trên connection của kết nối A, **sai database**. Chuyện
"query dài ở A chặn B" chỉ là hệ quả phụ.

Triệu chứng nhẹ hơn cùng gốc: `use_session()` / `reject_if_manual_or_open()` (`:440`, `:448`) cũng
global, nên bật manual mode ở A là **từ chối** Data Generator và restore ở B vô cớ.

**Ràng buộc thứ tự cứng:** phần này phải nằm **cùng phase** với việc registry nhận nhiều entry, không
phải phase sau. Xem §5 Phase 2.

Hình dạng:

```rust
struct Session {
    // std::sync on purpose: small, synchronous, never held across an .await.
    meta: Mutex<Meta>,
    pinned: tokio::sync::Mutex<Option<Pinned>>,
}
static TX_REGISTRY: OnceLock<Mutex<HashMap<ConnScopeId, Arc<Session>>>>;
static APP: OnceLock<Mutex<Option<AppHandle>>>;   // stays a single handle
```

**`Arc<Session>` là load-bearing, không phải trang trí.** `lock_pinned` phải: khoá registry (std) →
get-or-insert → **clone `Arc` → thả khoá registry** → `session.pinned.lock().await`. Giữ khoá registry
qua `.await` vừa vi phạm `docs/CODING_STANDARDS.md` §6.3, vừa **dựng lại đúng cái serialization vừa
bỏ**, chỉ dịch lên một tầng. `HashMap<_, Session>` với `&Session` mượn ra không diễn đạt được cú thả
khoá đó.

Ba điều nữa, mỗi điều là một lỗi im lặng nếu bỏ:

- **`should_route` không được tạo entry.** Nó chạy **mỗi câu lệnh**, kể cả restore 50k câu — ghi trên
  hot path là sai. `tx_set_autocommit` tạo entry; "không có entry" = `autocommit = true`, vốn đã đúng
  cho một kết nối mới. Tra bằng `map.get(&*id)` (`Arc<str>: Borrow<str>`) để không cấp phát `String`
  mỗi câu.
- **`reset()` (`:787`) phải `TX_REGISTRY.remove(&id)`.** Không thì map rò một entry mỗi vòng
  connect/disconnect, **và** một id được dùng lại sẽ thừa hưởng `Meta` cũ với `autocommit = false` —
  câu lệnh kế tiếp của người dùng âm thầm mở một transaction họ không yêu cầu.
- **`any_pending()` — hàm mới, KHÔNG mang id.** Guard `onCloseRequested` phải hỏi "có kết nối **nào**
  đang dirty không". Nếu guard hỏi theo id thì đóng cửa sổ sẽ **âm thầm bỏ transaction của tab khác**.

`emit_state()` (`:398`): giữ tên event `"tx-state-changed"`, thêm **đúng một** field `"connId"` vào
`status_json()` (`:378`); `TxControl` lọc `payload.connId !== activeConnId`. Không bọc thành
`{ connId, status }` — bọc là phá mọi field access trong `TxControl.tsx` và kiểu `TxStatus` cùng lúc,
mà không được gì. `tx_status` (`:811`) nhận thêm `conn_id`; nó vẫn không cần `AppState` vì map là
global cấp module.

**Và `TxControl` không còn đúng chỗ.** Comment của nó nói thẳng: *"transaction thuộc về kết nối, không
thuộc về tab — `DatabaseManager` giữ đúng một connection cho cả app, nên nói rằng hai tab có hai
transaction là nói dối. Vì vậy nút nằm ở thanh tiêu đề chứ không ở toolbar từng tab."* Tiền đề đó mất
thì phải chốt lại chỗ đặt.

#### 4.2a Guard phải khoá theo "có gì để mất", không theo "có transaction mở"

Phát hiện khi thử tay Phase 1, và Phase 2 phải giữ đúng tính chất này khi `tx_session` thành per-connection.

Trong manual mode, `should_route` gửi **mọi** câu lệnh qua phiên, và `run_raw` gọi `ensure_begin` cho
câu đầu tiên **bất kể câu gì** — nên một `SELECT` của lần refresh lưới cũng mở transaction. Hệ quả:
`is_open()` gần như luôn true khi manual mode bật, và `switch_database` (chỗ duy nhất gọi
`reject_if_open`) trở thành **không bao giờ chạy được**: ngay sau Discard, lần đọc kế tiếp mở lại
transaction với 0 câu chờ và lời từ chối quay lại — một lời từ chối người dùng không có cách nào xoá.

Chốt: guard khoá theo `has_pending()` (`open && statements > 0`, mà `statements` chỉ đếm câu **ghi**).
Transaction mở mà không có gì chờ nghĩa là nó chỉ đọc, nên caller **tự rollback** rồi đi tiếp thay vì
hỏi người dùng — và phải rollback **trong lúc pool cũ còn sống**, vì sau khi swap thì connection đã pin
thuộc một pool không ai giữ và server ôm khoá tới khi socket chết. Giữ nguyên văn message cũ nên
`backendErrors.ts` không đổi.

Cùng gốc, một lỗi UI: sau Discard, không ai bảo lưới nạp lại nên màn hình vẫn hiện giá trị vừa bị
rollback — người dùng đọc ra thành "Discard không rollback" dù backend đã rollback xong. `TxControl`
dispatch `database-restored` sau Commit / Discard / `ROLLBACK TO`; **không** dispatch khi đổi mode /
isolation / savepoint vì chúng không đổi dòng nào.

#### 4.2b Chỗ đặt `TxControl` — ✅ ĐÃ CHỐT: chia ba tầng

**Loại hẳn "toolbar từng tab".** Nó khẳng định một quyền sở hữu **sai**: hai tab trên cùng một kết nối
sẽ hiện cùng một transaction hai lần, không có cách nào để người dùng biết đó là **một**. Lý lẽ trong
comment gốc vẫn đúng, chỉ "thanh tiêu đề" là phần cần sửa.

Chốt chia ba tầng, mỗi phần về đúng chỗ nó thuộc về:

| Tầng | Trách nhiệm |
|---|---|
| **Rail bên trái** (`DbRail`) | **Trạng thái per-connection.** Mỗi item một badge pending (dot + số). Đây là phần *chỉ* rail làm được |
| **Thanh tiêu đề** | **Control của kết nối đang chọn.** Giữ nguyên capsule hiện có, scope theo kết nối đang chọn, cộng một dấu hiệu tổng khi kết nối **khác** đang dirty |
| **Dialog** | Per-connection, thêm tên kết nối vào header. Mở được từ cả hai chỗ trên |

Lý do rail là chỗ đúng cho phần trạng thái: nó là chỗ **duy nhất** trong UI mà mỗi item *chính là* một
kết nối, 1:1 với `conn_id` (§4.3). Và nó là phương án duy nhất cho thấy **N phiên cùng lúc** — với một
nút trên thanh tiêu đề thì N−1 phiên còn lại vô hình, tức có thể đang có ba transaction chưa commit mà
chỉ thấy một. Badge ở rail giải trực tiếp rủi ro #2 ở §6: người dùng **thấy** kết nối nào dirty trước
khi đóng cửa sổ, thay vì gặp một dialog bất ngờ. `any_pending()` (ở trên) chính là hàm nuôi dấu hiệu
tổng trên thanh tiêu đề.

Lý do thanh tiêu đề **vẫn phải giữ** một phần, chứ không dồn hết vào rail — ba rào, và không rào nào nhỏ:

1. **Rail ẩn khi < 2 kết nối** (`DbRail.tsx:44` + guard `< 2`; comment trong file: *"With a single
   connection the title bar popover is enough"*). Dồn hết vào rail thì với **một** kết nối — trường hợp
   phổ biến nhất — không còn UI transaction nào. Đó là regression.
2. **Rail ẩn cùng sidebar** (`App.tsx:1353` là `{showSidebar && <DbRail …>}`, và comment ghi việc gắn
   với sidebar là *cố ý*). Nên `Ctrl+P` sẽ ẩn luôn trạng thái transaction — có dữ liệu chưa commit mà
   không còn dấu hiệu nào. Rào này nguy hiểm hơn rào trên.
3. **Rail quá hẹp cho controls.** Badge thì vừa; Commit / Rollback / ô isolation / Monaco xem SQL chưa
   commit thì không. Nên rail chỉ làm *chỉ báo + cửa vào*. Cộng: item rail đã có primary action là
   "chuyển kết nối", nên badge cần hit area riêng (~14px ở góc icon), không dùng chung được.

Chi phí: badge ở rail + scope thanh tiêu đề + dấu hiệu tổng + header dialog. **Không component mới,
không dialog mới.**

#### 4.2c Rail hiện gì — ✅ ĐÃ CHỐT: chỉ các kết nối **đang mở**

Hôm nay `DbRail` gọi `dbHelper.listDatabases()` và liệt kê **mọi** database trên server. Đổi thành:
rail liệt kê **đúng tập `conn_id` đang sống**, tức chỉ những kết nối người dùng đã chủ động mở.

Ba thứ có được từ quyết định này:

- **Hết vấn đề danh sách phẳng.** Nếu rail liệt kê mọi database thì với §4.3 nó sẽ **trộn** "database
  của server A" với "database của server B" mà không phân biệt được, trong khi cây Sidebar lại có
  server ở cấp trên. Chỉ hiện kết nối đã mở thì tập hiển thị *chính là* tập `conn_id`, không còn chỗ
  cho sự trộn đó.
- **Badge có chỗ đặt đúng nghĩa.** Một phiên transaction chỉ tồn tại trên một kết nối **đã mở**; một
  database chưa mở không có phiên nào để hiện.
- **Bỏ được một truy vấn.** `list_databases` chạy một query thật trên kết nối đang hoạt động
  (`DbRail.tsx:42-43` đã ghi chú đúng điều đó). Rail chuyển sang đọc registry kết nối, không cần query.
  `list_databases` vẫn cần, nhưng cho **cây Sidebar** — nơi người dùng chọn database để mở.

Giữ nguyên guard `< 2`: một kết nối thì không có gì để chuyển, và tầng thanh tiêu đề đã phủ trường hợp
đó (rào 1 ở trên).

### 4.3 Identity = `(server, database)`; mở database thứ hai **sinh `conn_id` mới**

Ba đường đã cân:

- **(i) `conn_id` = server, `database` là state đổi bằng `switch_database`.** Loại: hai tab ở hai
  database của cùng server sẽ tranh một `current_db` — đúng cái race đã loại ở §4.1, dịch xuống một
  tầng.
- **(ii) Lệnh nhận cả `(conn_id, db)`.** Loại: khoá tx-session, khoá schema và khoá pool thành *tuple*
  ở ~62 chữ ký; mỗi lệnh phải xử lý "database chưa mở → mint pool"; và SQLite phải nhận một `db` vô
  nghĩa.
- **(iii) `conn_id` định danh `(server, database)`; mở database thứ hai sinh `conn_id` mới.** ✅ **CHỐT.**

(iii) thắng vì pool, `current_schema`, phiên transaction và catalog autocomplete có **đúng cùng một
lifetime** — `(server, database)`. Một khoá opaque phục vụ cả bốn; không tuple ở đâu; SQLite không cần
ngoại lệ (1 tệp = 1 `conn_id`). Và nó khớp 1:1 với `scopeKey(config, db, schema)` đã có, nên phần
localStorage không phải nghĩ lại. `switch_database` hạ thành `open_database(conn_id, db) -> conn_id`
cộng một cú re-point ở frontend.

**Bản trước sai hình ở đây.** Nó đề xuất `db_pools: HashMap<String, PgPool>` **phẳng bên trong một
entry** — tức là **một `current_schema` cho N pool**, âm thầm phá lại đúng tiền đề mà
`postgres-schema-support-plan.md` §5.0 dựa vào. Phải là hai tầng, với khoá phẳng hướng ra lệnh:

```rust
// Per-server resources: one tunnel, one IAM refresh task, one credential set.
struct ServerHandle {
    db_type: String,
    last_config: Value,
    ssh_tunnel: Option<SshTunnel>,
    generation: AtomicU64,
}

// What a conn_id points at. One per (server, database).
struct ConnEntry {
    server: Arc<ServerHandle>,
    db: String,
    kind: DbKind,
    current_schema: Option<String>,
}
```

`Arc<ServerHandle>` cho vòng đời tunnel **miễn phí**: `ConnEntry` cuối cùng trên một server bị drop →
port tunnel đóng. Không refcount tay, không phải trả lời câu "ai sở hữu tunnel" (`CLAUDE.md`: drop
handle là đóng port).

`conn_id` **opaque, backend sinh, trả về cho frontend**, kèm `find_conn(server_id, db)` cho
idempotence. **Không** dẫn xuất từ config: config mang secret, và một lỗi normalize sẽ thành
cross-talk âm thầm giữa hai profile khác credential trỏ cùng host. Frontend map `scopeKey` đã lưu →
id sống, lúc kết nối.

### 4.4 Cơ chế: để **compiler** bắt chỗ sót, không phải grep

Điểm quyết định 50+ chỗ sửa có an toàn hay không. Nguyên tắc: **xoá đường cũ, đừng để nó nằm song
song với đường mới.**

**(a) Đặt id vào *trong* `DbConnection`, không thêm tham số.**

```rust
pub type ConnScopeId = Arc<str>;

pub enum ConnId {
    Session(ConnScopeId),
    /// A short-lived pool (db_compare, deep scan). Never routable to a tx session — see §0.
    Adhoc,
}

pub struct DbConnection { pub id: ConnId, pub kind: DbKind }

// The old enum, renamed.
pub enum DbKind {
    Sqlite(Arc<Mutex<SqliteConnection>>),
    Postgres(PgPool),
    Mysql(MySqlPool),
}
```

Ba funnel, `Exec::acquire`, và cả 35 chữ ký `conn: &DbConnection` **giữ nguyên từng byte**; 66 call
site `execute_raw_sql_generic(&conn_type, sql)` giữ nguyên. Lý do chọn cách này thay vì thêm một tham
số `&ConnCtx`:

1. **Desync thành không biểu diễn được.** `(&DbConnection, &str)` hay `ConnRef { conn, id }` đều *cho
   phép* truyền handle của A với id của B — đúng lớp lỗi mà refactor này tồn tại để diệt. Một field
   thì không lệch được.
2. **Chi phí bằng không**, không phải "một `String` mỗi câu lệnh". Nơi clone thật sự xảy ra (helper
   acquire, `spawn_blocking` của `sqlite_stream` `:2029`, task IAM) là một atomic increment trên
   `Arc<str>`.
3. Chỉ **12** chỗ dựng `DbConnection` (`database.rs:380,383,440,448,456,2759,2764,3895,3900` +
   `db_compare.rs:176,244,253`). Phần dư ~70 chỗ là sửa một token (`match &conn` →
   `match &conn.kind`), compiler chỉ hết.
4. `ConnId::Adhoc` sửa lỗi §0 bằng **cấu trúc**, không bằng sentinel chuỗi.

Schema **không** vào kiểu funnel — funnel không dùng nó. Nó nằm ở giá trị trả về của helper acquire.

**(b) Xoá `AppState::db_manager` (`lib.rs:21`) hẳn.** Cả 56 chỗ khoá thành `E0609: no field
'db_manager'`. Đó là toàn bộ câu trả lời cho "tìm hết chỗ sót mà không cần grep". Xoá và thêm trong
**một** commit — một commit trung gian để cả hai cùng tồn tại là mất luôn bảo đảm.

**(c) `state.rs` mới, `inner` private.**

```rust
pub struct ConnRegistry { inner: Mutex<HashMap<ConnScopeId, ConnEntry>> }   // `inner` PRIVATE

impl ConnRegistry {
    /// The only way to obtain a DbConnection carrying ConnId::Session.
    pub fn acquire(&self, id: &str) -> Result<ConnCtx, String> { /* ... */ }
}

pub struct ConnCtx { conn: DbConnection, dialect: &'static str, schema: String }   // fields private
```

Với `inner` private trong `state.rs`, không chỗ nào ở `database.rs` tự cuộn lại lock+match+clone được.
"Đã chuyển hết chỗ chưa" thành "có biên dịch không". `ConnCtx` **không** derive `Clone` — nó được
luồn, không nhân bản.

**(d) `ConnCtx::schema()` trả `String` đã defaulted.** Nếu `acquire` trả `Option<String>` thì chỗ nào
quên `pg_schema_of` sẽ âm thầm query `public` **và compiler vẫn vui**. Trả giá trị đã default xoá luôn
`pg_schema()` (`database.rs:204`) và làm "quên default" thành không biểu diễn được. Giữ `Option` thô
sau một `raw_schema()` riêng, cho field `"current"` của `list_schemas` (`:3944`).

Cái compiler vẫn không bắt được: một lệnh nhận `conn_id` nhưng bên trong dùng id khác. Thay bằng một
`#[test]` `include_str!("database.rs")` khẳng định `"state.connections"` xuất hiện **0 lần** ngoài
`state.rs` — repo đã nhận loại test twin y như vậy (`src/utils/__tests__/backendErrors.test.ts`).

Một phần thưởng nhỏ, ghi lại vì nó cho thấy hướng này *đúng chiều*: `dialect_of()`
(`tx_session.rs:246`) tồn tại **chỉ vì** funnel nhận `DbConnection` trần rồi phải suy lại dialect.
`ConnCtx` mang `dialect` sẵn nên các lời gọi đó biến mất.

### 4.5 Mô hình lưu tab phải **đảo chiều**

Hiện tại: **một khoá → cả danh sách tab** (`App.tsx:728`), và `restoreTabs()` gọi `setTabs()` **thay
trọn** danh sách (`:779`) — đổi database là swap cả workspace. Đa kết nối thì tab của nhiều kết nối
**cùng tồn tại**, nên mô hình phải đảo thành *mỗi tab tự mang scope của nó*.

Back-compat: lần chạy đầu đọc mọi khoá candidate của các kết nối được khôi phục
(`tabsStorageKeyCandidates()` đã có sẵn đường đó). Quên đường này là người dùng **mất hết tab đang mở**.

Kéo theo:

- `TabInfo` thêm `connKey` / `db` / `schema`.
- Id tab hiện **không unique giữa kết nối** (`table_<name>`, `query_<timestamp>`) — đó là lý do
  `App.tsx:1479` phải chắp `tabScope` vào React key.
- `queryCount` (đếm "SQL Query N") và invariant "tối đa một tab dirty" (`dirtyTabId`) phải xét lại
  theo kết nối.

### 4.6 Vòng đời pool và tài nguyên per-server

- `max_connections` cho pool phụ (tiền lệ: `db_compare` dùng 2, `db_stats` dùng 1) và điều kiện đóng
  pool idle. Mở pool mỗi lần expand một database là bộ khuếch đại số kết nối lên server dùng chung.
- **`conn_generation: AtomicU64` (`lib.rs:30`) phải chuyển vào `ServerHandle`.** Để global thì mở kết
  nối thứ hai bump nó và `spawn_iam_refresh` (`database.rs:396`, `:408`) **thoát khỏi vòng lặp của kết
  nối thứ nhất** → kết nối đó âm thầm chết sau ~15 phút với lỗi auth. Đây là lỗi im lặng giá trị nhất
  trong cả kế hoạch, **và không test được dưới 15 phút** — phải là invariant khi review, verify một
  lần trong build nháp với chu kỳ refresh rút ngắn.
- **SQLite**: hai entry trên cùng một tệp = hai `rusqlite::Connection` = `SQLITE_BUSY` khi ghi đồng
  thời. Dedupe theo đường dẫn đã normalize lúc mở — đúng lựa chọn `db_compare.rs:152-166` đã làm.
- `connect_db` gọi `tx_session::reset(prev)` (`database.rs:426-429`) với giả định "prev là *cái* kết
  nối". Chuyển sang đường close, không thì Phase 2 rò một phiên mỗi lần connect.

---

## 5. Việc cần làm

### Phase 0 — dọn nền

Merge phần đang uncommitted (tính năng schema Postgres, ~2278 dòng thêm) trước. Không mở một refactor
xuyên ngang trên working tree đang dở.

### Phase 1 — plumbing, vẫn đúng một kết nối

**Invariant kết thúc phase: app hoạt động y như trước với 1 kết nối.** Đó là cách verify cả phase.

Cưỡng chế bằng: registry giữ ≤ 1 entry; `connect_db` vẫn đóng cái trước; và frontend tiêm `connId` tại
**một** choke point `dbHelper.ts:24` — nên **0 trong 210 call site đổi ở phase này** (§3.2: trick
shadowing đã dùng cho `backendErrors.ts`).

Đây là shim di trú, **không phải thiết kế**: một "current id" cấp module đọc ở wrapper chính là cái
race đã loại ở §4.1. Nó chỉ được phép tồn tại khi N == 1, và điều kiện ra khỏi Phase 2 là `dbHelper`
không còn đọc id ngầm ở đâu.

- **1a.** `state.rs` mới (`ConnRegistry`, `ConnCtx`, `Arc<ServerHandle>`), chưa wire — ✅ **đã làm**.
- **1b.** **Xoá `AppState::db_manager`**; sửa 56 `E0609` bằng `ConnRegistry::acquire`. Bên trong 1b,
  thứ tự cũng bắt buộc: **các chỗ GHI trước các chỗ ĐỌC.** `connect_db`/`disconnect_db` phải nạp
  registry xong thì reader mới có gì để `acquire()`; làm ngược lại thì reader đọc một registry rỗng.
  - **1b-1** ✅ `AppState.connections` + `connect_db` mint `conn_id` (UUID) và ghi vào registry,
    `disconnect_db` xoá. Chưa lệnh nào đọc, nên hành vi không đổi.
  - **1b-2** ✅ `tx_session::current_conn` + `data_generator::active_conn` (chữ ký giữ nguyên nên
    không caller nào đổi). Shim là `ConnRegistry::sole()`, **từ chối khi có >1 entry** thay vì chọn
    bừa — nhờ đó không thể ship Phase 2 khi còn caller của nó.
  - **1b-3** ✅ 39 chỗ đọc trong `database.rs`, đúng hai hình dạng, đổi bằng pass cơ học. Xoá được
    `pg_schema()` (0 caller còn lại) — `ConnCtx::schema()` đã defaulted nên "quên default" thành
    không biểu diễn được.
  - **1b-4** ✅ `SshTunnel` chuyển sang `ServerHandle` (port đóng khi `Arc` cuối cùng drop), 2 chỗ
    đọc server-level, `db_compare`/`db_stats`/`get_connection_status`, 8 chỗ ghi lifecycle, rồi
    **xoá `db_manager` + `DatabaseManager`**.

**Kết quả 1b:** 56 → 0 chỗ khoá `db_manager`; 48 chỗ đi qua registry; `database.rs` ngắn đi ~50 dòng.
Còn đúng hai `#[allow(dead_code)]` có phạm vi hàm, kèm lý do: `acquire()` (1d dùng) và `ConnCtx::db()`
(rail của Phase 3 dùng).

Ba điều phát sinh khi làm, ghi lại để khỏi tìm lại:

- **`ServerHandle::last_config` phải là `Mutex<Value>`**, vì `USE` trong restore và `switch_database`
  đều ghi lại `database` trong đó, mà `ServerHandle` nằm sau `Arc`. Phase 3 bỏ được `Mutex` này: khi
  database đến từ `ConnEntry::db` thì `last_config` thành server-level thật và thôi thay đổi.
  *(Sai — xem §8. `switch_database` đã bị xoá nhưng restore-`USE` thì không xoá được, nên `Mutex` ở
  lại.)*
- **Task refresh IAM không còn cần `generation` để bảo vệ phép swap.** Nó swap theo `conn_id`, mà
  disconnect thì xoá entry đó còn reconnect thì mint id *khác* — nên một task cũ chỉ có thể ghi vào
  một entry đã biến mất, và `replace_conn` no-op. `generation` giờ chỉ còn để dừng vòng lặp. Đây là
  một phần của §4.6 tự giải quyết sớm.
- **`get_connection_status` và `db_compare::resolve_side` phải dùng `sole().ok()`, không phải `?`.**
  Cả hai *dung thứ* trạng thái chưa kết nối: cái đầu rơi xuống nhánh Redis, cái sau để `base` quyết
  định từ config của từng phía. Dùng `?` là biến "chưa kết nối SQL" thành lỗi và chặn cả hai đường đó.
- **1c.** ✅ Bọc `DbConnection` + đổi tên `DbKind` + `ConnId::Adhoc` (§4.4a), làm §0 thành cấu trúc.
  Tách hai nửa qua một **type alias trung gian** (`pub type DbConnection = DbKind`): nửa đầu là rename
  149 chỗ mà grep tự chứng minh, nửa sau là thay đổi ngữ nghĩa phá 46 `match` + 14 `matches!` + 6 chỗ
  dựng. Nhờ tách, một lỗi biên dịch chỉ có thể đến từ một nửa.
- **1d.** ✅ 45 lệnh + 4 helper nhận `conn_id`; `dbHelper.ts:24` tiêm `connId` cho **mọi** lệnh nên
  **0/210 call site frontend phải sửa**; `sole()` đã xoá.

Bốn thứ chỉ lộ ra khi làm, ghi lại để khỏi tìm lại:

- **Pass cơ học phải kiểm ngược, không kiểm xuôi.** Cách bắt được chỗ sót không phải "đếm số chỗ đã
  đổi" mà là: *mọi* `match` có arm `DbKind::` phải có `.kind` ở target. Kiểm xuôi báo 46/46 đẹp; kiểm
  ngược lộ ra **2 tuple-match** (`match (conn, schema)`, `match (&conn_type, restart_identity)`) mà
  regex không khớp, và **1 chỗ không được đổi** (`let conn = match conn { Some(c) => … }` trong
  `get_connection_status` — match trên `Option<DbConnection>`, không phải trên connection).
- **`build_iam_conn` phải trả `DbKind`, không phải `DbConnection`.** Pool mới thay chỗ một kết nối
  *đang có*, nên id phải là id của kết nối đó — mà hàm dựng pool không biết id. Caller bọc. Cùng lý do
  đó, restore-`USE` và `switch_database` bọc bằng id của entry hiện tại, **không** mint id mới.
- **`connect_db` không nhận `conn_id`** (nó tự mint), nên chỗ đọc "kết nối cũ" để rollback lấy từ giá
  trị trả về của `clear()`. Việc đó sửa luôn một chi tiết cũ: connect **thất bại** không còn rollback
  transaction của kết nối mà nó chưa hề thay thế.
- **`disconnect_db` coi id lạ là hợp lệ**, không phải lỗi: ngắt một thứ đã biến mất chính là trạng
  thái người gọi muốn. `reset(None)` vẫn chạy để xoá state machine.

**Thứ tự 1b trước 1c là bắt buộc, đã đo.** Có **319** chỗ nhắc `DbConnection::` trong `src-tauri/src`,
trong đó **170** là các cặp `Some(DbConnection::X(y)) => DbConnection::X(y.clone())` **nằm trong 56
khối acquire mà 1b xoá sạch**. Làm wrapper trước thì phải sửa 170 chỗ chỉ để bước sau ném đi; làm sau
thì chỉ còn ~149 chỗ dư. (Bản đầu của tài liệu này xếp ngược, đã sửa.)

### Phase 2 — N kết nối, mỗi kết nối một database — ✅ CODE XONG

Bảy việc backend + frontend tối thiểu đã làm; `cargo check` sạch, `tsc -b` 0 lỗi, 534 test pass,
oxlint sạch. **Chưa thử tay** — xem §8.

Bốn thứ chỉ lộ ra khi làm, ghi lại để khỏi tìm lại:

- **`Session.pinned` phải là `Arc<tokio::Mutex<…>>` + `lock_owned()`.** Khi phiên còn là `&'static
  Global` thì guard mượn từ static nên không có vấn đề vòng đời; chuyển sang `Arc<Session>` thì
  `MutexGuard<'_, _>` không thể sống lâu hơn `Arc` mà `lock_pinned` vừa tra, trong khi caller giữ
  guard suốt cả câu lệnh. `lock_owned()` trả guard tự mang keep-alive. Đây cũng là thứ cho phép
  **thả khoá map trước khi await** — giữ nó qua `.await` là dựng lại đúng cái serialization vừa bỏ.
- **`use_session` nhận `&DbConnection`, còn `reject_if_manual_or_open` nhận `&str`.** Không thống
  nhất được: guard của restore và sinh dữ liệu chạy *trước khi* có handle, chỉ biết id. Nên vị từ
  được viết thẳng ở đó thay vì gọi lại `use_session` — giữ được tính chất "handle mang identity của
  chính nó" ở chỗ có handle, mà không ép chỗ không có phải bịa ra một cái.
- **Reconnect mint `conn_id` MỚI.** `handleReconnect` không cập nhật state thì React giữ id cũ:
  lệnh vẫn chạy (shim `dbHelper` đã đổi) nên không lộ ra ngay, biểu hiện là **thanh transaction chết
  im** vì `TxControl` lọc bỏ mọi event do id không khớp.
- **Chuyển kết nối phải qua `guardDirty`.** Nó swap danh sách tab y như đổi database, nên sửa dở ở
  lưới mất trắng nếu không hỏi — và người dùng sẽ chuyển kết nối thường xuyên hơn nhiều so với đổi
  database, từ lúc có rail.

#### `open_database` kéo lên từ Phase 3, và nó xoá luôn một lớp lỗi

Phát sinh khi thử tay: bộ chọn database trên thanh tiêu đề gọi `switch_database`, mà lệnh đó *thay*
pool nên bị `reject_if_pending` chặn khi database hiện tại còn thay đổi chưa commit — người dùng
không có cách nào xoá lời từ chối đó nếu không bỏ chính phần việc đang làm.

Chốt: bộ chọn database **mở thêm một kết nối**, không đổi kết nối đang có. Đó chính là
`open_database(conn_id, db) -> conn_id mới` của §4.3, vốn xếp ở Phase 3. Kéo lên vì nó không chỉ là
tính năng mà là **cách lớp lỗi kia biến mất**: mở là *thêm* pool nên không đụng gì đang có, không có
gì để từ chối, và transaction đang mở ở database cũ cứ chạy tiếp.

Ba tính chất đến từ việc chia sẻ `Arc<ServerHandle>`, không phải viết thêm: dùng chung tunnel, dùng
chung credential (**không xác thực lại** — quan trọng với token IAM sống 15 phút), và tunnel chỉ đóng
khi kết nối *cuối cùng* trên server đó đóng. `find(server, db)` làm lệnh idempotent: chọn lại database
đã mở thì trả về kết nối đang giữ nó.

**`switch_database` được giữ lại ở bước này**, không xoá: còn ba đường thật sự muốn thay pool tại
chỗ — bước "đổi sang database đích" của luồng nhập/phục hồi, popup thống kê, và một chỗ ở Sidebar.

> **Quyết định này đã bị đảo về sau.** Cả ba đường đó cũng chuyển sang `open_database` và
> `switch_database` bị xoá hẳn — lý do đầy đủ ở §8. Tóm tắt: cái đúng cho bộ chọn database đúng cho
> cả ba, vì lớp lỗi ở trên không phải của riêng bộ chọn mà là của *hình dạng* "thay pool dưới chân một
> `conn_id` đang sống". Giữ lại ba chỗ nghĩa là giữ lại lớp lỗi ở ba chỗ.

#### Rail: chỉ hiện, chuyển, đóng

Chốt sau khi thử tay: rail **không** có nút thêm. Thêm kết nối tới server khác đi qua thanh tiêu đề
(*Kết nối mới*); thêm database trên cùng server đi qua bộ chọn database. Rail mang menu chuột phải
với *Đóng kết nối* / *Đóng các kết nối khác*.

Một lỗi tự tạo đáng ghi: bản đầu tôi đặt nút `+` **trong** rail mà rail lại tự ẩn khi `< 2` kết nối —
nút mở kết nối thứ hai chỉ hiện ra khi đã có kết nối thứ hai. Bê nguyên ngưỡng của rail cũ (liệt kê
*database*, ẩn khi chỉ có một) sang rail mới mà không soát lại điều kiện còn đúng không.

Một chỗ **cố ý bỏ ngỏ**: Redis không vào rail. Nó không đi qua `connect_db` nên không có `conn_id`.
Kết nối Redis khi đang có kết nối SQL vẫn swap workspace sang `RedisBrowser` còn rail giữ nguyên các
kết nối SQL với không cái nào active. Hơi lạ nhưng không hỏng, và Redis vốn ngoài phạm vi.

#### Kế hoạch gốc của Phase 2 (giữ lại để đối chiếu)

**Invariant kết thúc phase** — thứ làm Phase 1 an toàn là có một câu kiểm được, phase này cần cái
tương đương: *hai kết nối mở đồng thời, mỗi kết nối một phiên transaction riêng; chuyển qua lại giữ
nguyên trạng thái từng cái; ghi vào đúng kết nối của tab đang mở.* Ca chặn: hai kết nối cùng có bảng
trùng tên → manual mode ở A, sửa một dòng → sang B, sửa một dòng → `TxControl` báo đúng phiên của B →
commit ở B → quay lại A, phần chưa commit của A **vẫn còn**.

Backend, 7 việc:

1. **`tx_session` thành map** — ràng buộc cứng, phải cùng phase với việc registry nhận nhiều entry
   (§4.2). Phần load-bearing là `Arc<Session>`. Phase 1 đã đưa `conn_id` tới **mọi** chỗ gọi
   `is_open` / `use_session` / `has_pending` / `reject_if_pending` / `reject_if_manual_or_open` /
   `should_route`, và `should_route` đã có sẵn `conn.id` từ 1c — nên phần này chủ yếu là cơ học.
2. **Xoá `conn_generation`** — *không* phải "chuyển vào `ServerHandle`" như §4.6 viết ban đầu. Điều
   kiện dừng của task refresh IAM thành **"`conn_id` của tôi không còn trong registry"**. Bộ đếm
   generation đúng ở Phase 1 nhưng **sai ở Phase 2**: global thì kết nối thứ hai giết task của kết nối
   thứ nhất (đúng lỗi §4.6 mô tả), per-server thì reconnect một cái giết task của các cái cùng server.
   Kiểm tồn tại theo id đúng ở cả hai, vì "id còn trong registry" nghĩa là kết nối còn sống và token
   vẫn cần refresh. Xoá cả `AppState.conn_generation` lẫn `ServerHandle.generation` (cái sau hiện có
   **0 người đọc**).
3. `connect_db` thôi xoá cái cũ, chỉ insert; `clear()` chỉ còn cho teardown.
4. `CANCEL_KEY` của Data Generator scoped theo `conn_id`.
5. `any_pending()` (**không** mang id) cho guard `onCloseRequested`.
6. Dedupe SQLite theo đường dẫn đã normalize — mở lại cùng tệp thì trả `conn_id` đã có (`find()`).
7. `emit_state()` mang thêm `connId`; `tx_status(conn_id)`; `TxControl` lọc theo nó.

**Sửa lại một điểm của bản trước: xoá shim `currentConnId` thuộc Phase 3, không phải Phase 2.** Mô
hình UI của Phase 2 vẫn là *một kết nối đang chọn tại một thời điểm* (workspace swap khi chuyển, đúng
như `switch_database` hôm nay). Với mô hình đó, một id ambient **mô tả đúng** hiện thực. Race mà §4.1
cảnh báo chỉ thành thật khi **tab cùng tồn tại** — tức Phase 3; xoá shim sớm hơn thì không có gì thay
thế nó.

Frontend tối thiểu: `App.tsx` giữ `connections[]` + `activeConnId`; `DbRail` liệt kê kết nối đang mở
(§4.2c) kèm nút `+` mở `ConnectionManager` trong `Modal` (tái dùng nguyên component); `TxControl` lọc
event theo `connId` và mang badge pending cho từng item rail (§4.2b). Chuyển kết nối thì **workspace
swap** — bước trung gian có chủ ý, §4.5 là Phase 3.

### Phase 3 — nhiều database mỗi server, và UI

Backend: `open_database(conn_id, db) -> conn_id` (thân đã có ở `database.rs:3891-3903`); chia sẻ
`Arc<ServerHandle>`; `switch_database` hạ thành re-point ở frontend. Coi chừng reconnect `USE` của
`restore_backup` (`:2738-2773`) — nó đổi connection dưới chân tab; giữ nguyên cách mutate một entry
cho phase này (restore là thao tác modal một tab).

Frontend: `TabInfo` mang scope + đảo mô hình lưu tab (§4.5); key `catalog.ts` / `dbIndexRegistry.ts`
theo `(connId, db, schema)`; thêm conn id vào 4 CustomEvent; **dỡ either/or `App.tsx:1324`**; cây
Sidebar 2 cấp — lưu ý `SidebarProps.dbType` hiện chưa có `'redis'`, và đây là nơi người dùng chọn
database để **mở** (nguồn dùng `list_databases`).

`DbRail` thành bộ chọn **kết nối đang mở** (hiện nó liệt kê mọi database qua `list_databases`) và mang
badge pending của từng kết nối — §4.2b/§4.2c. Thanh tiêu đề giữ capsule `TxControl` scope theo kết nối
đang chọn cộng dấu hiệu tổng từ `any_pending()`.

Cây đích:

```
🟢 MySQL Localhost (conn_1) [Dev]
├── 📁 sales_db
│   ├── 📊 customers
│   └── 📊 orders
└── 📁 inventory_db
    └── 📊 products

🔴 Postgres AWS Cloud (conn_2) [Production]
└── 📁 production_db
    ├── 📂 public
    └── 📂 analytics
```

### Sau đó — mỗi cái một thay đổi độc lập

Không cái nào chờ Phase 1–3, và không cái nào ràng buộc thiết kế ở §4:

- **Nhãn môi trường / Production Safety Guard**: `readOnly` đã là state global (`tf_readonly`) — cần
  scope theo kết nối, cộng ngữ nghĩa Đỏ/Vàng/Xanh trên `SavedProfile.color` đã có (§3.3), cộng xác
  nhận 2 bước cho `DROP` / `TRUNCATE` / `DELETE`–`UPDATE` không `WHERE`.
- **`Ctrl+K` command palette** — nhảy tới server / database / bảng / tab.
- **Ping & độ trễ ms trên thanh trạng thái** — `get_connection_status` đã ping.
- **Dashboard tiến trình & câu lệnh chậm** — `SHOW PROCESSLIST` / `pg_stat_activity` + Kill.
- **Copy bảng/dữ liệu sang kết nối khác** — ghép `dumpBuilder.ts` + `buildSql()` đã có.

---

## 6. Ước lượng & rủi ro

Xếp theo mức **im lặng**, vì đó mới là thứ đáng ghi:

1. **`conn_generation` để global** → kết nối thứ nhất chết sau ~15 phút với lỗi auth, không ai nối
   được về nguyên nhân. Không test được nhanh (§4.6).
2. **Thiếu `any_pending()`** → đóng cửa sổ bỏ transaction của tab khác, không báo gì (§4.2).
3. **Ghi vào kết nối sai.** Sót ở đường đọc thì lộ ra ngay ("relation does not exist"); sót ở cặp
   `get_primary_key_columns` ↔ `commit_changes` thì **không lỗi gì cả** mà `WHERE` sai — tức **sai
   dòng bị sửa**. Cùng loại rủi ro `postgres-schema-support-plan.md` §6 đã ghi.
4. **`reset()` không remove entry** → id dùng lại thừa hưởng `autocommit = false`, transaction tự mở.
5. **Giữ khoá registry qua `.await`** → chặn nhau, biểu hiện ra là "app treo".
6. **Đảo mô hình lưu tab mà quên đường đọc lùi** → mất hết tab đang mở.

Nghĩa vụ cơ học kèm theo:

- **Chi phí i18n = 0**, nếu **dùng lại nguyên văn `"Chưa kết nối CSDL"` cho `conn_id` không tồn tại**
  — với người dùng, một id lạ và một kết nối đã đóng là cùng một sự kiện. Giữ mọi literal
  byte-identical thì `utils/backendErrors.ts` (38 entry chính xác + 21 pattern; `NORMALIZED_ALIASES`
  đã gộp hai cách viết) và test round-trip tiếng Việt **không phải sửa gì**. Chuỗi UI mới thì vẫn cần
  key ở `en/vi/ja` (`locales.test.ts` chặn thiếu placeholder/tag).
- **Không** đưa `AppError` có cấu trúc vào đợt này. Đúng theo `CODING_STANDARDS.md` §5.3 nhưng sai
  thời điểm: nó đụng test round-trip trên ~55 literal.
- **Không** đổi registry sang `tokio::sync::Mutex`. Clone-out-then-drop là thứ giữ critical section
  dưới micro-giây; async mutex chậm hơn khi không tranh chấp và *mời* giữ qua `.await`.
- **Không** tách `database.rs` (5115 dòng) trong đợt này — nó phá tính review được của một diff cơ học
  56 chỗ. Nhượng bộ duy nhất: registry ở **tệp mới** `state.rs`, vì private field là thứ làm nên
  §4.4c.
- **Không** thêm concurrency mới: mục tiêu là N kết nối **tuần tự** độc lập, không phải song song hoá
  một kết nối.
- Lệnh mới phải đăng ký ở `generate_handler!` duy nhất trong `lib.rs`.
- **`AGENTS.md`: không inline CSS** — cây kết nối, badge môi trường, rail phải là class trong
  `src/index.css`.

---

## 7. Verification

1. **Phase 1 pass = app hoạt động y như trước với 1 kết nối.** Với N == 1 mọi kiểm tra tay hiện có
   vẫn áp dụng. Checklist tối thiểu: restore sakila (funnel 50k câu + reconnect `USE`), Data Generator
   chạy + hủy (`Exec` + `CANCEL_KEY`), `db_compare` với một phía ad-hoc, ô chọn schema Postgres khác
   `public`, manual tx commit/rollback + guard đóng cửa sổ, hủy một stream dài.
2. **Ca ghi-sai-kết-nối — ca chặn của Phase 3.** Hai kết nối cùng có bảng trùng tên; sửa một dòng ở
   lưới tab A trong khi tab B đang ở kết nối kia; Lưu; xác minh dữ liệu vào đúng A. Lặp cho trình sửa
   cấu trúc và Data Generator.
3. **Ca compare + manual mode (lỗi §0).** Bật commit thủ công → mở So sánh 2 database → câu lệnh tiếp
   theo phải chạy vào database của người dùng, không vào database compare.
4. **Ca chặn nhau.** Query dài ở A, đồng thời query ở B — B không được chờ A.
5. **Ca transaction.** Manual mode ở A, ghi vài dòng; `TxControl` không hiển thị nhầm phiên của B;
   refresh lưới A **thấy** dòng chưa commit; đóng cửa sổ khi B dirty vẫn phải bị chặn.
6. **Ca IAM.** Build nháp với chu kỳ refresh rút ngắn, mở 2 kết nối, xác minh kết nối thứ nhất không
   chết.
7. **Ca khôi phục.** Đóng/mở app: tab của cả hai kết nối về đúng kết nối của nó; người dùng nâng cấp
   từ bản cũ không mất tab.
8. Sau mỗi phase: `npm run build-frontend` (`tsc -b`), `npm test`, `npx oxlint` sạch, `cargo check`
   sạch.

---

## 8. Trạng thái

**Phase 1 đã xong** (1a–1d). Tài liệu này thay bản đầu tiên.

Kết quả đo được của Phase 1: 56 → **0** chỗ khoá `db_manager`; `DatabaseManager` đã xoá; 45 lệnh + 4
helper nhận `conn_id`; **0/210** call site frontend phải sửa (nhờ tiêm ở `dbHelper.ts:24`); `sole()` đã
xoá nên compiler bảo đảm không còn đường ngầm nào. Xoá thêm `pg_schema()` và
`execute_raw_sql_unrouted` — cả hai thành dư sau khi `ConnCtx::schema()` defaulted và `ConnId::Adhoc`
thành cấu trúc. `cargo check` sạch, `tsc -b` 0 lỗi, 534 test pass, oxlint sạch.

Đã kiểm tay: manual mode → sửa lưới → Lưu → Discard → đổi database → có câu chờ thì bị chặn.

**Phase 2 code đã xong**, `cargo check` sạch, `tsc -b` 0 lỗi, 534 test pass, oxlint sạch. Backend giờ
giữ N kết nối, mỗi kết nối một phiên transaction riêng; rail liệt kê kết nối đang mở kèm badge
pending; nút `+` thêm kết nối mà không thay cái đang có.

**Đã kiểm tay và chạy được**, gồm cả phần tồn từ Phase 1: hai kết nối song song với phiên transaction
tách riêng, mở thêm database từ bộ chọn khi database cũ còn thay đổi chưa commit, đóng kết nối và
đóng-các-kết-nối-khác từ menu chuột phải của rail, So sánh 2 database, disconnect, restore có `USE`.

**Còn đúng một thứ chưa kiểm, và nó không kiểm được bằng cách dùng thường:** refresh token IAM (§4.6).
Chu kỳ là ~13 phút nên phải build nháp với chu kỳ rút ngắn mới thấy. Điều cần xác nhận là task của
kết nối **thứ nhất** vẫn sống sau khi mở kết nối thứ hai — đây chính là chỗ bộ đếm generation sai và
là lý do nó bị thay bằng "id còn trong registry". Đến khi kiểm được thì nó là **invariant khi review**,
không phải test.

Đã chốt: §4.1 (`conn_id` tường minh, không có `active_conn_id`), §4.3 (identity = `(server,
database)`, đường (iii)), §4.4 (id nằm trong `DbConnection`; xoá `AppState::db_manager` để compiler
chỉ chỗ sót), và phạm vi (bỏ federation, Redis ngoài phạm vi).

Cộng §4.2b (chỗ đặt `TxControl`: chia ba tầng rail / thanh tiêu đề / dialog) và §4.2c (rail chỉ hiện
các kết nối **đang mở**).

**Đã làm: §0** — lỗi `db_compare` bị pin làm phiên transaction. Đứng ngoài mọi phase, đã ship.

**Phase 3 đã xong** (3b, 3c, 3d), đã thử tay và chạy mượt.

- **3b** — `connId` tới được đường per-tab: 29 method `dbHelper` nhận nó làm tham số đầu; `catalog.ts`
  khoá theo kết nối; `src/sql/editorScope.ts` cho tầng Monaco; `dumpReaderFor()` cho `DumpReader`;
  xoá `StructureViewer.catalogRef` (bản sao thứ hai của `catalog.ts`). 26 tệp.
- **3c** — `TabInfo.connId`; `tabs` giữ tab của mọi kết nối, thanh tab render `visibleTabs`; lưu vẫn
  một khoá mỗi scope, chỉ ghi tab của kết nối đang chọn.
- **3d** — 4 CustomEvent mang `detail.connId`, mọi chỗ nghe lọc theo nó.

**Hai mục của 3d đã bị chính rail thay thế, cố ý không làm:** cây Sidebar 2 cấp (rail đã là "kết nối
nào", sidebar là "đối tượng của kết nối đó" — cây 2 cấp là vẽ lại rail) và dỡ either/or ở `App.tsx`
(vấn đề thật của nó là "không thêm được kết nối khi đang kết nối", mà Modal `addingConn` ở Phase 2 đã
giải; phần còn lại là màn hình đầu khi chưa có kết nối, và thế là đúng).

**Shim `currentConnId` vẫn sống, và đó là lựa chọn.** Thanh tab lọc theo kết nối đang chọn nên tab của
kết nối khác **không mount** → không có đường chạy nền nào dùng sai id. Nó chỉ phải chết nếu sau này
chuyển sang hiện mọi tab trên một thanh.

**`open_database` đã làm ở Phase 2**, nên phần "nhiều database mỗi server" coi như xong.

**`switch_database` đã bị xoá hẳn** (sau Phase 3). Cả bốn đường gọi — bộ chọn trên thanh tiêu đề,
Sidebar ("vừa tạo database, chuyển sang?"), popup thống kê, và bước "đổi sang database đích" của
luồng nhập/phục hồi — đều dùng `open_database`. Lý do nó phải chết chứ không chỉ là dọn dẹp: nó thay
pool **dưới chân một `conn_id` đang sống**, và hình dạng đó kéo theo hai thứ không sửa được nếu còn
giữ nó. Một, phải từ chối khi kết nối còn thay đổi chưa commit. Hai, khi nó *thành công* thì mọi tab
đang mở vẫn trỏ vào bảng của database cũ mà không ai báo. Chết theo nó: `handleDatabaseChanged`
(`App.tsx`), `tx_session::reject_if_pending` (guard dựng riêng cho việc thay pool), và ba khoá dịch.

Chỗ tinh nhất là luồng nhập: `restoreBackup` không nhận `conn_id` — nó đi theo id ngầm của
`dbHelper` — nên id đích phải giữ trong biến cục bộ. `activeConnIdState` trong closure đó vẫn là id
**cũ**, dùng nó sẽ gửi cả sự kiện `database-restored` sai địa chỉ.

**Đính chính bản trước của mục này:** nó ghi rằng bỏ `switch_database` sẽ cho phép
`ServerHandle::last_config` bỏ `Mutex`. Không đúng. `restore_backup` cũng ghi vào `last_config` khi
gặp `USE` giữa dump, và đường đó **không** chuyển sang "mở thêm" được: `USE` đến từ bên trong tệp
người dùng đang chạy, không phải từ một lệnh có `conn_id` để mint kết nối mới. `Mutex` ở lại.

### #4 Production Safety Guard — đã xong

Mục đầu tiên trong danh sách "sau đó, mỗi cái một thay đổi độc lập" ở §5.

**Môi trường là một trường riêng của profile (`SavedProfile.env`), KHÔNG suy từ nhãn màu.** Bản kế
hoạch ghi "ngữ nghĩa env-tag trên `color` đã có", và lần dựng đầu làm đúng như vậy — sai. Màu là thứ
người dùng đổi vì thẩm mỹ hoặc để phân loại việc khác; buộc nó mang ý nghĩa production nghĩa là đổi
màu cho dễ nhìn có thể vô hiệu hoá lớp bảo vệ mà không nói một lời, và ngược lại, muốn đánh dấu
production thì buộc phải chấp nhận một màu cụ thể. `utils/connEnv.ts` giữ `legacyEnvOfColor` **chỉ**
để di trú một lần: profile chưa có `env` được điền theo ý nghĩa màu cũ rồi ghi xuống, vì nếu không thì
mọi kết nối đang được đánh dấu production mất dấu ngay ở lần nâng cấp — đúng loại thay đổi im lặng mà
cả lớp bảo vệ này tồn tại để chống.

Ô chọn có ở **hai** chỗ, vì đó là hai thời điểm khác nhau của cùng một nhu cầu: form Connection
Manager (đánh dấu *trước* lần kết nối đầu) và popover thanh tiêu đề (đổi giữa phiên, có hiệu lực
ngay). Giá trị đi vào lần kết nối lấy từ **state của form**, không từ profile đã lưu — cả `config`
(host, port, SSL…) đã làm vậy, và một cờ an toàn mà "thứ đang hiển thị" khác "thứ đang có hiệu lực"
là hụt tệ nhất có thể có.

**Cờ chỉ đọc sống ở backend (`ConnEntry.read_only`), không chỉ ở UI**, cưỡng chế trong ba funnel qua
`reject_if_read_only`. Nhưng ba funnel **không** phải là tất cả: bốn lệnh giữ connection riêng đi
vòng qua chúng — `commit_changes` (Lưu của lưới), `run_fk_wrapped` (Drop/Truncate), `restore_backup`,
`generate_data`. Cả bốn dùng `Exec`/pool riêng vì cần một session cho cả lô, cùng lý do khiến chúng
phải hỏi `use_session()` chứ không phải `is_open()`. Mỗi cái gọi `reject_conn_read_only` ở đầu hàm.
**Một đường mới tự lấy connection phải làm y hệt**, và nó hỏng *không ồn ào*: câu ghi đơn giản là
thành công trên kết nối đang gắn nhãn production.

Hai chỗ đặt cổng có chủ ý: `commit_changes` gọi **sau** nhánh `preview` (xem trước SQL không phải
ghi), `run_fk_wrapped` gọi **trước** câu tắt FK (từ chối giữa chừng sẽ để lại session tắt kiểm tra
khoá ngoại). `preview_generated_data` cố ý không chặn.

**Hai công tắc, hai chỗ, và thông báo phải chỉ đúng cái đang chặn.** `tf_readonly` là công tắc toàn
app trên thanh tiêu đề; `ConnEntry.read_only` là của một kết nối, bật/tắt từ menu chuột phải của
rail. Bản đầu chỉ có một thông báo, và nó bảo người dùng tắt công tắc toàn cục trong khi thứ đang
chặn là cờ per-connection — làm theo thì không có gì thay đổi. Giờ `sqlEditor.errConnReadOnlyRun` chỉ
sang đúng menu của rail.

### Bốn lỗi tìm ra khi kiểm tay Safety Guard, tất cả cùng một họ

Đáng ghi vì chúng không phải lỗi của Safety Guard mà là **nợ còn lại của Phase 3**: code đọc/ghi
`tabs` và `connection` theo phạm vi toàn cục trong khi cả hai đã thành per-connection.

**Bản sao không được cập nhật.** `toggleConnectionReadOnly` chỉ đổi backend rồi refetch rail, kèm một
comment khẳng định "không có gì để mirror trong React state". Có: `connReadOnly` truyền vào SqlEditor
đọc từ `openConns`, được đặt một lần lúc kết nối. Ổ khoá ở rail tắt, editor vẫn từ chối.

**Cuộc đua giữa hai lần render.** Effect lưu tab chọn *ô localStorage* theo `connection.dbName` nhưng
chọn *tab để lưu* theo `activeConnIdState`. Trên đường `selectConnection` chúng được đặt ở hai thời
điểm — id đặt ngay, tên đặt sau một `await` — nên ở render giữa chừng effect ghi **tab của kết nối A
vào ô của kết nối B**. Mở lại B về sau thì thấy tab của A. Sửa bằng cách cho `connection` mang
`connId` của chính nó và effect bỏ qua render nào hai giá trị không khớp: ghép chúng vào một giá trị
là cách duy nhất biến "hai thứ này nói về cùng một kết nối" thành điều kiểm tra được thay vì điều
được giả định.

**Dò trùng trên toàn bộ kết nối.** `handleSelectTable` / `handleOpenViewTab` / `handleOpenRoutineTab`
tìm tab đã mở trong `tabs` chứ không trong `visibleTabs`. Id tab chỉ unique *trong một* kết nối, nên
một bảng trùng tên ở kết nối khác bị coi là "đã mở": hàm không tạo tab nào và chọn một id mà kết nối
này không có → **pane trống**, không phải lỗi. Cùng lúc, ba đường tạo tab (view, routine, terminal)
quên gắn `connId`, và `visibleTabs` coi tab không `connId` là của mọi kết nối.

**Tham số sai chỗ.** `closeConnection` gọi `disconnect(activeConnIdState)` thay vì `disconnect(connId)`
— "Đóng kết nối" trên một ô *không phải* ô đang xem thì ngắt nhầm ô đang xem, còn ô vừa bấm nằm
nguyên trong rail, trông như không đóng được. `handleReconnect` cũng chỉ remap `connId` cho
`openConns` mà không remap cho `tabs`, nên sau khi kết nối lại thanh tab trống và effect lưu ghi đè
danh sách rỗng lên workspace.

### Hai lỗi của Phase 3 đáng ghi lại

**Dựng cơ chế rồi quên nối dây.** `editorScope.ts` được tạo và đọc ở 6 chỗ, nhưng **không ai gọi**
`setEditorConnId` — nên nó luôn rỗng và mọi reader hỏi backend về kết nối `""`. Triệu chứng lộ ra là
inspection báo *mọi* bảng không tồn tại; completion, hover, AI context và schema snapshot cũng hỏng
theo mà chưa ai để ý. `tsc`, 534 test và oxlint đều **xanh** với một mechanism không ai gọi — compiler
kiểm được kiểu, không kiểm được "đã nối dây chưa". Cách bắt sớm: thêm setter cấp module thì grep ngay
xem nó có caller không.

**Memo hoá bị phá bởi chính lời gọi thêm vào.** `buildIndex()` có cờ `isPrimed` nhưng **không đọc**,
nên mỗi lời gọi là một `get_full_catalog` đầy đủ — và nó được gọi bởi *mỗi* `SqlEditor` đang mount,
bởi `inspection.ts` cho từng model, và bởi hai window listener. Effect vừa thêm còn gọi `invalidate()`
trước, phá nốt cơ hội tái dùng: ba tab query mở sẵn = ba lần nạp catalog liên tiếp mỗi lần chuyển kết
nối. Sửa bằng cách cho registry nhớ `builtFor`; đổi kết nối vẫn rebuild vì id không khớp, nên caller
không cần `invalidate()`.

Ngoài Phase 3, một việc riêng người dùng đã nêu: **"Move Tab to New Window"**. Đó là tính năng đa cửa
sổ, không phải một mục menu — app đã có tiền lệ cửa sổ terminal độc lập (`?term=`) nên khả thi, nhưng
nó phụ thuộc câu trả lời của Phase 3 cho ba câu: tab thuộc kết nối nào, state nào chia sẻ giữa hai
cửa sổ, và `tx-state-changed` phát tới cửa sổ nào.

---

## Phụ lục A: một kết nối mở nhiều database — cơ chế theo từng engine

Nền cho §4.3, và ghi lại vì hành vi hiện tại của app khác nhau theo dialect:

- **MySQL** — một pool *có thể* đổi database bằng `USE <db>`, và truy vấn liên-database trực tiếp được
  (`SELECT * FROM db1.t1 JOIN db2.t2`). App **không** dùng đường đó nữa: mỗi database là một pool
  riêng như Postgres, để một `conn_id` luôn trỏ vào đúng một database (§4.3). Chỗ duy nhất `USE` còn
  đổi database dưới chân một entry là restore, vì câu đó nằm trong tệp dump.
- **PostgreSQL** — mỗi TCP connection gắn với **một** database, nên nhiều database dưới cùng một node
  Server buộc phải là **nhiều pool**. Đó chính là §4.3: mỗi `(server, database)` một `conn_id`, chia
  sẻ `Arc<ServerHandle>`. Trong một database Postgres còn nhiều schema — phần đó đã xong, xem
  `docs/postgres-schema-support-plan.md`.
- **SQLite** — một tệp là một database. `open_database` **từ chối** SQLite (*"SQLite không hỗ trợ
  nhiều database trên một kết nối"*). `ATTACH DATABASE` chưa được hỗ trợ ở đâu
  trong app; deep scan của `db_stats` có nhắc database đã ATTACH nhưng không có đường nào tạo ra
  chúng. Nếu muốn thì đó là việc riêng, không thuộc kế hoạch này.
- **Redis** — `db0`…`db15` theo index, `select_db_inner` đã làm. **Ngoài phạm vi** (phụ lục B).

## Phụ lục B: đã cân nhắc và KHÔNG làm

### Truy vấn liên-kết-nối (federation) — bỏ

Ý ở bản trước: một câu SQL JOIN giữa hai kết nối, backend lấy hai bên rồi join trên SQLite in-memory.

Không làm. Backend Rust **không có SQL parser** — parser ANTLR chỉ có ở frontend, trong web worker.
Ngoài parser còn cần: rewrite câu lệnh để biết phần nào là remote, predicate pushdown (không có thì
kéo cả bảng về), map mọi kiểu nguồn vào 5 storage class của SQLite (`numeric` / `uuid` / `jsonb` /
array / `timestamptz` của Postgres không có tương ứng), và một hạn mức bộ nhớ. Giá trị thực tế gần
trùng với "copy bảng/dữ liệu sang kết nối khác" (§5), mà cái đó rẻ hơn nhiều bậc và tái dùng
`dumpBuilder.ts` đã có.

Nếu sau này vẫn muốn: hạ xuống dạng **tường minh** — người dùng khai báo "đính kèm result set từ kết
nối X thành bảng tạm" — chứ không phân giải ngầm `[Conn].table`. Bỏ được phần parser, nhưng vẫn phải
map kiểu.

### Redis vào cùng cây kết nối — ngoài phạm vi

`RedisState` (`redis_db.rs:48-63`) là 43 lệnh trên một state hoàn toàn riêng: không `DbConnection`,
không tx session, không schema. Coupling duy nhất với phần SQL là `cancel_flags`, mà cái đó **không
cần đổi**. Đưa vào đây là cộng 43 lệnh và buộc phải dỡ `App.tsx:1332` mà không được lợi gì cho phần
SQL. Cùng hình thay đổi, làm sau như một đợt riêng.

Hệ quả: cây ở §5 Phase 3 **chỉ có SQL**. Bản trước vẽ MySQL + Postgres + Redis cùng lúc; đó là ngoài
phạm vi.

### `active_conn_id` ở backend — bỏ

Xem §4.1. Rẻ hơn nhiều (gần như không đổi chữ ký nào), nhưng đánh đổi là race giữa các tab async, hệ
quả là ghi vào database sai mà không báo lỗi.

### `db_pools` phẳng trong một entry — bỏ

Xem §4.3. Nó để một `current_schema` cho N pool, phá lại tiền đề của
`postgres-schema-support-plan.md` §5.0.
