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

## 0. Một lỗi đang tồn tại, sửa được ngay và độc lập

Tìm ra khi soát cho kế hoạch này. Không liên quan đa kết nối, **nên sửa trước**.

`should_route()` (`tx_session.rs:476`) trả `true` khi `!m.autocommit || m.open` — **trước khi** xét
connection nào. Nhưng `db_compare.rs` đọc metadata qua `execute_raw_sql_generic`
(`db_compare.rs:295`), và connection nó truyền có thể là **pool ad-hoc** do `resolve_side()` mở cho
phía không phải database hiện tại.

Hệ quả: bật commit thủ công → mở "So sánh 2 database" trỏ một database khác → `lock_pinned`
(`tx_session.rs:493`) pin **pool tạm của compare** làm phiên và `ensure_begin` chạy `BEGIN` trên đó.
Từ đó **mọi câu lệnh của người dùng chạy vào database compare**, rồi `Resolved::close()` đóng pool
trong khi phiên vẫn trỏ vào nó. Deep scan của `db_stats` cùng phơi nhiễm nếu sau này nó bọc pool.

Cách sửa trùng đúng bước đầu của refactor này (§4.4a): pool ad-hoc mang `ConnId::Adhoc` và
`should_route` trả `false` cho nó. Vì vậy nó nằm ở Phase 1a và ship được ngay.

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
static SESSIONS: OnceLock<Mutex<HashMap<SessionId, Arc<Session>>>>;
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
- **`reset()` (`:787`) phải `SESSIONS.remove(&id)`.** Không thì map rò một entry mỗi vòng
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
thì phải chốt một trong hai: nút theo kết nối đang chọn ở UI, hay chuyển vào toolbar từng tab. **Chưa
chốt** — xem §8.

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
pub type SessionId = Arc<str>;

pub enum ConnId {
    Session(SessionId),
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
pub struct ConnRegistry { inner: Mutex<HashMap<SessionId, ConnEntry>> }   // `inner` PRIVATE

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

- **1a.** Bọc `DbConnection` + đổi tên `DbKind` + `ConnId::Adhoc` (§4.4a). ~70 chỗ compiler chỉ.
  `tx_session` còn global; `should_route` trả `false` cho `Adhoc` → **ship luôn bản sửa lỗi §0**.
- **1b.** `state.rs` mới (`ConnRegistry`, `ConnCtx`, `Arc<ServerHandle>`); **xoá
  `AppState::db_manager`**; sửa 56 `E0609`.
- **1c.** Mọi lệnh chạm kết nối nhận `conn_id: String`; `dbHelper` chuyển tiếp.

### Phase 2 — N kết nối, mỗi kết nối một database

Registry nhận nhiều entry; `connect_db` thôi đóng cái trước; `disconnect_db(conn_id)`; frontend truyền
id thật (≈63 method `dbHelper` có kiểu, không phải 210 call site thô); xoá shim của Phase 1.

**`tx_session` map + `pinned`/`meta` per-session phải nằm ở ĐÂY** (§4.2) — N entry với một `pinned`
global là ghi sai database, không phải chỉ chậm. Cùng phase: `conn_generation` → `ServerHandle`
(§4.6), `CANCEL_KEY` scoped theo `conn_id`, `reject_if_manual_or_open` per-conn, dedupe SQLite theo
path, `any_pending()` cho guard đóng cửa sổ.

### Phase 3 — nhiều database mỗi server, và UI

Backend: `open_database(conn_id, db) -> conn_id` (thân đã có ở `database.rs:3891-3903`); chia sẻ
`Arc<ServerHandle>`; `switch_database` hạ thành re-point ở frontend. Coi chừng reconnect `USE` của
`restore_backup` (`:2738-2773`) — nó đổi connection dưới chân tab; giữ nguyên cách mutate một entry
cho phase này (restore là thao tác modal một tab).

Frontend: `TabInfo` mang scope + đảo mô hình lưu tab (§4.5); key `catalog.ts` / `dbIndexRegistry.ts`
theo `(connId, db, schema)`; thêm conn id vào 4 CustomEvent; **dỡ either/or `App.tsx:1324`**;
`DbRail` thành bộ chọn **kết nối** (hiện nó chọn database); cây Sidebar 2 cấp — lưu ý
`SidebarProps.dbType` hiện chưa có `'redis'`.

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

**Chưa bắt đầu code.** Tài liệu này thay bản đầu tiên.

Đã chốt: §4.1 (`conn_id` tường minh, không có `active_conn_id`), §4.3 (identity = `(server,
database)`, đường (iii)), §4.4 (id nằm trong `DbConnection`; xoá `AppState::db_manager` để compiler
chỉ chỗ sót), và phạm vi (bỏ federation, Redis ngoài phạm vi).

**Còn một quyết định chặn Phase 2:** §4.2 — `TxControl` đặt ở đâu khi có N phiên (nút theo kết nối
đang chọn, hay chuyển vào toolbar từng tab).

Việc nên làm trước, độc lập với mọi thứ còn lại: **sửa lỗi §0**.

---

## Phụ lục A: một kết nối mở nhiều database — cơ chế theo từng engine

Nền cho §4.3, và ghi lại vì hành vi hiện tại của app khác nhau theo dialect:

- **MySQL** — một pool switch database bằng `USE <db>`, và truy vấn liên-database trực tiếp được
  (`SELECT * FROM db1.t1 JOIN db2.t2`). `switch_database` hiện đã làm đường này.
- **PostgreSQL** — mỗi TCP connection gắn với **một** database, nên nhiều database dưới cùng một node
  Server buộc phải là **nhiều pool**. Đó chính là §4.3: mỗi `(server, database)` một `conn_id`, chia
  sẻ `Arc<ServerHandle>`. Trong một database Postgres còn nhiều schema — phần đó đã xong, xem
  `docs/postgres-schema-support-plan.md`.
- **SQLite** — một tệp là một database. `switch_database` **từ chối** SQLite (`database.rs:3874`:
  *"SQLite không hỗ trợ nhiều database trên một kết nối"*). `ATTACH DATABASE` chưa được hỗ trợ ở đâu
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
