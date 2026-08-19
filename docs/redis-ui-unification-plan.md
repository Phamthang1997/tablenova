# Kế hoạch hợp nhất giao diện Redis vào Unified Workspace

Chuyển **Redis Browser** từ layout độc lập (`<RedisBrowser />` chiếm trọn workspace) sang chung bố
cục `DbRail + Sidebar + TabManager + ActivePanel` như Postgres/MySQL/SQLite.

Tài liệu này là bản viết lại. Bản đầu tiên bỏ sót một chặn cứng ở backend và có hai chỗ mâu thuẫn
với mô hình dữ liệu hiện tại; §2 ghi lại các quyết định đã chốt để không phải mở lại giữa chừng.

---

## 1. Hiện trạng — đo được, không ước

| Thứ | Số liệu | Nguồn |
| :--- | :--- | :--- |
| Component Redis | 12 file, 3417 dòng | `src/components/redis/` |
| Inline style | **303 chỗ** `style={{` | nặng nhất: `StreamPanel` 52, `KeyList` 47, `Analysis`/`ValuePanel` 33 |
| i18n | **đã xong** — 259 lời gọi `t('redis…')`, key tree tại `en.ts:1999` | `src/components/redis/` |
| Ảo hoá danh sách key | **đã có** — `windowSlice` | `KeyList.tsx:207` |
| Lệnh Rust | 43 `#[tauri::command]` | `redis_db.rs` |
| Method frontend | 44 `dbHelper.redis*` | `dbHelper.ts` |
| Safe Mode cho Redis | **đã xong** — mọi lệnh ghi đã liệt kê | `safeMode.ts:73+` |
| `conn_id` trong `redis_db.rs` | **0** | — |

Hai dòng cuối là điểm mấu chốt: phần SQL đã chuyển sang registry theo `conn_id` (`state.rs`), Redis
thì chưa — `AppState.redis` là **một** `RedisState` (`redis_db.rs:48`) với đúng một
`MultiplexedConnection` và một `db_index: Mutex<i64>`.

`docs/multi-connection-plan.md` Phụ lục B đã ghi rõ điều này và **cố ý** để Redis ngoài phạm vi:

> `RedisState` là 43 lệnh trên một state hoàn toàn riêng […] Cùng hình thay đổi, làm sau như một đợt
> riêng.

"Đợt riêng" đó chính là Giai đoạn 0 dưới đây. Không có nó thì không mở được 2 kết nối Redis, và
`DbRail` — thứ mà kế hoạch này dựa vào — không có gì để vẽ.

---

## 2. Quyết định phải chốt TRƯỚC khi code

### 2.1 Một `conn_id` = một `(server, db index)` — db index thuộc **kết nối**, không thuộc tab

Bản đầu cho tab `redis-key` mang theo `dbIndex`. Không làm được: chỉ có một connection và một
`db_index`, `redis_select_db` (`redis_db.rs:394`) đổi db cho **cả** connection, nên hai tab ở `db0`
và `db3` giẫm chân nhau. Đúng hình dạng luật đã ghi trong CLAUDE.md cho transaction:

> A transaction belongs to the connection, not to a tab.

**Chốt:** đổi db index = **mint một `conn_id` mới**, y hệt §4.3 của multi-connection-plan ("mở
database thứ hai sinh `conn_id` mới"). Hệ quả kéo theo, tất cả đều là thứ đã có sẵn:

- `DbRail` hiển thị `db0` và `db3` như hai entry của cùng một server Redis — giống hai database của
  một server Postgres. Không cần code riêng cho Redis.
- `scopeKey(config, 'db3')` cho ra `redis:host:6379|db3`, nên bộ tab tự tách theo db index qua
  `tabsStorageKey()` — không phải thêm chiều nào vào khoá.
- `redis_select_db` không còn là "đổi state dùng chung" mà là "mở/chuyển sang kết nối khác".
- `dedicated_client` (Pub/Sub, Profiler) đọc config + db index của **conn_id của nó**, không đọc
  state toàn cục.

### 2.2 `SELECT n` gõ trong CLI Console

`redis_execute_cmd` hiện chặn `SELECT` và tự đổi db toàn cục (`redis_db.rs:1109-1110`) — với 2.1 thì
hành vi đó vừa sai vừa vô hình với các tab khác.

**Chốt:** giữ nguyên việc chặn, nhưng đổi kết quả thành **tín hiệu** (`{ switchDb: n }`) trả về cho
frontend; frontend mở (hoặc focus) kết nối của `dbN` rồi chạy tiếp. Không mutate gì sau lưng tab
khác. Phương án dự phòng nếu tín hiệu này phát sinh vòng lặp khó chịu: từ chối lệnh kèm câu gợi ý
dùng bộ chuyển db — kém hơn nhưng vẫn trung thực.

### 2.3 Redis nằm **trong** registry, `acquire()` vẫn chỉ dành cho SQL

Hai lựa chọn: một `RedisRegistry` song song, hay mở rộng registry hiện có.

**Chốt: mở rộng registry hiện có.** Lý do là `DbRail` và `QuickSwitcherPopover` liệt kê "kết nối
đang mở" từ registry (§4.2c). Registry song song nghĩa là hai nguồn sự thật cho một danh sách, cho
vòng đời, và cho cờ read-only — đúng lỗi "duplicate cache" mà `state.rs` đã ghi là dự án trả giá hai
lần rồi.

Cách mở rộng, để **không** đụng vào ~210 call site SQL:

- `ConnEntry` mang thêm phần kết nối theo kiểu: SQL giữ `DbConnection`, Redis giữ
  `MultiplexedConnection` + `caps`.
- `acquire(conn_id)` **giữ nguyên chữ ký và ngữ nghĩa**, trả lỗi nếu conn_id là Redis. Không call
  site SQL nào phải sửa.
- Thêm `acquire_redis(conn_id) -> RedisCtx`. 43 lệnh Redis đổi sang nhận `conn_id: String` và gọi
  hàm này.
- SSH tunnel về `ServerHandle` (đã là nơi giữ tunnel per-server, drop = đóng port), bỏ
  `RedisState.ssh_tunnel`.
- Cờ read-only: bỏ `RedisState.read_only: AtomicBool`, dùng `conn_is_read_only(&ConnId)` của
  registry. Hiện đang là **hai** nguồn sự thật; gộp lại là một phần của giai đoạn này chứ không phải
  việc dọn về sau.
- `cancel_flags` **không đổi** (Phụ lục B đã kết luận).

### 2.4 Đây là **restyle + re-host**, không phải rewrite

Bảng so sánh của bản đầu mô tả `KeyList` là "tự viết, lệch chuẩn" và ngụ ý viết lại. Sai với thực
tế: `KeyList` đã windowed (`KeyList.tsx:207`) và cả thư mục đã i18n xong (259 key). Viết lại là vứt
cả hai và làm lại từ đầu phần khó nhất.

**Chốt:** giữ nguyên logic scan/window/xử lý và **giữ nguyên key i18n**; chỉ đổi (a) nơi component
được mount (tab thay vì panel cố định), (b) lớp trình bày (class CSS thay inline style). Key i18n
mới chỉ thêm cho phần UI thật sự mới (breadcrumb, TTL popover, nhãn tab).

### 2.5 Tab Redis có persist, và mở lại một key đã mất **không** phải lỗi

Tab list lưu qua `tabsStorageKey()`; tab `redis-key` cũng lưu như tab bảng. Nhưng key Redis có thể
biến mất giữa hai lần chạy (bị xoá, hết TTL) — chuyện bình thường, không phải table bị DROP.

**Chốt:** khôi phục tab và hiển thị trạng thái rỗng "key không còn tồn tại" kèm nút tạo lại/đóng.
Không im lặng bỏ tab (người dùng mất chỗ làm việc), không báo lỗi đỏ (không có gì sai).

---

## 3. Kiến trúc đích

```
TitleBar
└── workspace-container
    ├── DbRail            ← liệt kê cả kết nối SQL lẫn Redis (db0, db3… là entry riêng)
    ├── Sidebar           ← khung chung; thân là RedisSidebarView khi dbType === 'redis'
    └── main-workspace-area
        ├── TabManager    ← redis-key | redis-console | redis-dashboard | redis-slowlog
        │                   | redis-pubsub | redis-profiler | redis-analysis
        └── ActivePanel
```

`RedisBrowser.tsx` (320 dòng) biến mất: state nó đang giữ (`dbIndex`, `selectedKey`, `detail`, `tab`,
toast, 6 dialog) được phân về đúng chỗ — `dbIndex` về `conn_id`, `selectedKey`/`detail` về từng tab,
dialog về `Sidebar` hoặc tab tương ứng.

### Sidebar

`Sidebar.tsx` đã **2762 dòng**; không nhét chế độ Redis vào đó. Giữ `Sidebar.tsx` làm khung
(header, ô tìm kiếm, footer action, primitive context-menu) và tách thân thành
`components/redis/RedisSidebarView.tsx` — `KeyList` hiện tại chuyển vào đây, dùng chung class CSS
với sidebar SQL.

### TabInfo

`TabManager.tsx:21` mở rộng union `type`. Field mới đi kèm, đặt cạnh `routineInfo`/`viewInfo` theo
đúng nếp có sẵn:

```ts
redisKeyInfo?: { keyName: string; keyType: string };
```

Không có `dbIndex` ở đây — xem 2.1, db index nằm ở `connId`.

---

## 4. Các giai đoạn

Thứ tự đã đổi so với bản đầu: CSS **không** còn là một pass dọn dẹp ở cuối. Đặt cuối nghĩa là GĐ 1-3
đẻ thêm inline style rồi GĐ 4 xoá lại. Thay vào đó **mỗi component chuẩn hoá CSS ngay khi đụng vào
nó**, và §5 chốt bằng tiêu chí "0 inline style".

### Giai đoạn 0 — đưa Redis vào registry `conn_id` (backend)

Đây là khối lớn nhất và là điều kiện cần của mọi giai đoạn sau.

1. Mở rộng `ConnEntry`/`ServerHandle` theo 2.3; thêm `acquire_redis()`; `acquire()` giữ nguyên.
2. Chuyển 43 lệnh trong `redis_db.rs` sang nhận `conn_id: String`.
3. Bỏ `RedisState` (conn / config / ssh_tunnel / db_index / read_only / caps đều về registry).
4. `redis_connect` mint `conn_id`; `redis_select_db` → mint/trả về `conn_id` của db mới (2.1).
5. `redis_execute_cmd` trả tín hiệu `switchDb` thay vì tự đổi (2.2).
6. `dedicated_client` (Pub/Sub, Profiler) đọc từ ctx của conn_id.
7. 44 method `dbHelper.redis*` thêm tham số `connId`.

**Xong khi:** mở được 2 kết nối Redis + 1 Postgres cùng lúc, mỗi cái đọc đúng dữ liệu của nó.

### Giai đoạn 1 — Tab & layout (`App.tsx`, `TabManager.tsx`)

1. Mở rộng `TabInfo.type` + `redisKeyInfo`; icon/nhãn cho 7 loại tab.
2. Gỡ nhánh `connection.dbType === 'redis'` ở `App.tsx:1760`, cho Redis đi chung nhánh với SQL.
3. `restoreTabs()` xử lý tab Redis (2.5) — nhớ đường `tabsStorageKeyCandidates()`, quên là người
   dùng mất hết tab.
4. Xét lại `queryCount` và invariant "tối đa một tab dirty" cho tab Redis (§4.5
   multi-connection-plan).

### Giai đoạn 2 — Sidebar

1. `RedisSidebarView.tsx`: chuyển `KeyList` vào, **giữ nguyên** phần scan/window.
2. Header: pattern search, type filter dạng pill, toggle Tree/Flat. Bộ chọn db **không** phải
   dropdown nội bộ nữa — nó là `DbRail`/QuickSwitcher (2.1).
3. Context menu + footer action (Console, Dashboard, SlowLog, PubSub, Profiler, Analysis, Flush DB)
   dùng primitive của `Sidebar`.

### Giai đoạn 3 — Các tab nội dung

Mỗi component: re-host thành tab + chuẩn hoá CSS + bỏ inline style, làm gọn từng file một.

1. `ValuePanel` → `RedisValueTab`: toolbar kiểu `DataGrid` (breadcrumb `dbN > type > key`, TTL badge
   + popover, memory/encoding badge, nhóm nút Refresh/Save/Export/Delete/Duplicate).
2. `CollectionTable`, `StreamPanel` theo style `DataGrid`.
3. `Console` theo style `TerminalPanel`; `Dashboard`, `SlowLog`, `PubSub`, `Profiler`, `Analysis`.

Nhóm class trong `index.css`: `.redis-sidebar-*`, `.redis-value-*`, `.redis-console-*`,
`.redis-dashboard-*`, `.redis-tool-*` — cả Dark lẫn Light.

### Giai đoạn 4 — Hoàn thiện đa kết nối

1. `DbRail` + `QuickSwitcherPopover`: icon/nhãn Redis, chuyển SQL ↔ Redis mượt.
2. Safe Mode: **kiểm chứng**, không phải triển khai (`safeMode.ts` đã đủ). Việc thật ở đây là gộp cờ
   read-only về một nguồn — đã nằm trong GĐ 0.
3. `aiContextBuilder.ts` nhận ngữ cảnh key đang mở.

### Giai đoạn 5 — i18n cho phần mới

Key mới cho breadcrumb / TTL popover / nhãn tab / trạng thái rỗng, thêm đủ `en` + `vi` + `ja`
(thiếu key là compile error). Bản đầu không có bước này.

---

## 5. Verification

### Đo được (chạy được, không phải nhìn bằng mắt)

- `grep -rc "style={{" src/components/redis/` → **0**
- `npm run build-frontend` — pass
- `npx oxlint` — sạch (không chỉ 2 rule error; cảnh báo cũng phải sạch)
- `npm test` — pass
- Rust: **không** chạy `cargo check` khi `tauri dev` đang lên (hook chặn) — hot-reload của dev tự báo
  lỗi biên dịch.

### Thủ công

1. **Đa kết nối**: mở 2 Redis + 1 Postgres; đổi qua lại trên `DbRail`; mở `db0` và `db3` của cùng
   server, xác nhận mỗi bên có bộ tab riêng và đọc đúng key của db mình.
2. **Tab**: mở nhiều key cùng lúc, kéo thả, nhóm màu, pin; sửa dở ở tab A rồi sang tab B và quay lại
   — không mất dữ liệu.
3. **Tab công cụ**: Console, Dashboard, SlowLog, PubSub, Profiler, Analysis mở như tab độc lập.
4. **CLI**: gõ `SELECT 3` trong Console → chuyển đúng theo 2.2, các tab khác không bị đổi db sau lưng.
5. **Persist**: restart app → tab khôi phục; xoá một key ở ngoài rồi restart → tab đó hiện trạng thái
   rỗng, không văng lỗi.
6. **CRUD** đủ 6 kiểu: String, Hash, List, Set, ZSet, Stream (thêm/sửa/xoá/đổi tên/TTL).
7. **Read-only**: bật Safe Mode, xác nhận mọi thao tác ghi bị chặn — kể cả lệnh ghi gõ tay trong
   Console.
8. **Theme**: Dark ↔ Light, kiểm tương phản, viền, scrollbar.

---

## 6. Rủi ro & ước lượng

| Giai đoạn | Khối lượng | Rủi ro |
| :--- | :--- | :--- |
| 0 — registry | Lớn nhất. 43 lệnh + 44 method + gỡ `RedisState` | Cao. Cùng họ với Phase 1/2 của multi-connection-plan; hình mẫu đã có nên rủi ro là công sức, không phải thiết kế |
| 1 — tab/layout | Vừa | Vừa — `restoreTabs()` back-compat là chỗ dễ làm mất tab người dùng |
| 2 — sidebar | Vừa | Thấp nếu **không** viết lại `KeyList` (2.4) |
| 3 — tab nội dung | Lớn về số dòng (303 inline style) nhưng cơ học | Thấp |
| 4 — đa kết nối | Nhỏ | Thấp |
| 5 — i18n | Nhỏ | Thấp; compiler bắt giúp |

Rủi ro lớn nhất **không** phải kỹ thuật mà là thứ tự: bắt đầu từ GĐ 1 trước GĐ 0 sẽ dựng UI đa tab
trên một backend chỉ giữ được một kết nối, và mọi thứ trông chạy được cho tới khi mở kết nối thứ hai.

---

## 7. Trạng thái

### Giai đoạn 0 — ✅ XONG
`RedisState` đã bị xoá; 43 lệnh nhận `conn_id`; `acquire_redis()` + `LiveConn`/`RedisConn`/`RedisCtx`
trong `state.rs`; `redis_select_db` mint `conn_id` mới (§2.1); `redis_execute_cmd` trả `switchDb`
(§2.2); cờ read-only gộp về `ConnEntry`, Safe Mode bỏ đường tắt `redis_*` và đi chung `keyByConn`.
Kiểm tra biên dịch Rust: sạch.

Rẻ hơn dự kiến ở frontend: shim `invoke()` trong `dbHelper` vốn đã tự chèn `connId` vào mọi lệnh,
nên 44 method `redis*` không phải đổi chữ ký.

### Giai đoạn 1 — ✅ XONG (kèm phần khung của Giai đoạn 2)
`RedisBrowser.tsx` đã xoá. `TabInfo` có 7 loại `redis-*` + `redisKeyInfo`; Redis đi chung nhánh
layout với SQL; `DbRail` vẽ được kết nối Redis. Năm file mới trong `components/redis/`:
`redisTabs.ts` (id tab, nhãn, sự kiện), `useRedisToast.tsx`, `RedisKeyTab.tsx`, `RedisToolTab.tsx`,
`RedisSidebarView.tsx`.

Hai quyết định phát sinh trong lúc làm, không có trong bản kế hoạch:

- **Sáu tab công cụ mount thường trực**, ẩn/hiện bằng `visibility` như tab truy vấn. Console giữ log,
  Pub/Sub và Profiler đang giữ socket đọc liên tục, Dashboard giữ chuỗi số liệu — tháo ra khi chuyển
  tab là mất hết, và với Pub/Sub còn là bỏ lỡ message.
- **Toast là của từng tab**, không phải một toast toàn cục. `RedisBrowser` có đúng một dòng thông báo
  cho cả workspace; giữ nguyên kiểu đó sẽ hiện "đã lưu key X" trên tab đang xem key Y.

Một hồi quy đã bắt được khi xoá `RedisBrowser`: nó là nơi duy nhất đẩy công tắc chỉ-đọc toàn cục
xuống backend cho Redis, thiếu nó thì một `FLUSHALL` gõ trong CLI không còn bị chặn. Effect đã
chuyển về `App.tsx` và ghi **HOẶC** của công tắc toàn cục với cờ của kết nối — vì sau Giai đoạn 0
hai thứ đó dùng chung một cờ, ghi thẳng công tắc sẽ mở khoá ghi cho một kết nối production.

### Giai đoạn 2 — ✅ XONG
`KeyList` chuyển hết sang class CSS: 46 → **6** inline style. Sáu chỗ còn lại đều là giá trị
động thật và cố ý giữ: chiều cao hai spacer của windowing, `--redis-depth` + chiều cao mỗi dòng,
màu badge tra theo `TYPE_COLORS`, toạ độ menu đo lúc chạy.

Chiều cao dòng **phải** ở TS chứ không phải CSS: nó phải bằng đúng `ROW_HEIGHT` mà
`windowSlice` dùng để tính cửa sổ, và một bản sao trong CSS lệch đi thì danh sách cuộn sai chỗ
chứ không báo lỗi. Độ thụt theo cấp đi qua biến CSS `--redis-depth` — phần động (độ sâu) ở TS,
công thức trình bày (10px + 12px mỗi cấp) ở CSS.

### Giai đoạn 3 — ✅ XONG, 303 → **12**
Mười hai chỗ `style={...}` còn lại là giá trị động thật hoặc API của `Modal`, không phải nợ:

| Chỗ | Vì sao ở lại |
| :--- | :--- |
| `KeyList` — 2 spacer | chiều cao do windowing tính |
| `KeyList` — 2 dòng cây | `--redis-depth` + `ROW_HEIGHT`, phải bằng đúng số mà `windowSlice` dùng |
| `KeyList` — menu ngữ cảnh | toạ độ đo lúc chạy |
| `KeyList`/`ValuePanel` — badge kiểu | màu tra theo `TYPE_COLORS` |
| `Analysis` — thanh tỉ lệ | bề rộng = bytes/max |
| `CollectionTable` — nút icon, bề rộng cột | màu và bề rộng do chỗ gọi truyền |
| `PromptDialog`/`BulkDeleteDialog` — `ModalBody style` | là API của `Modal.tsx`, và style inline của nó **cố ý** thắng CSS |

Ba chỗ trạng thái động biến mất hẳn thay vì đổi nơi ở, vì cờ điều khiển chúng vốn đã đi vào
`disabled` nên CSS suy ra được: nút icon trong bảng (`busy`), nút xoá hàng loạt (`ready`, bốn thuộc
tính), và nút ghost trong Console. Tab Entries/Groups của `StreamPanel` từ hai thuộc tính màu theo
điều kiện thành một tên class.

Đáng ghi lại: `shared.ts` có năm object `CSSProperties` dùng chung ở bảy file, không khớp grep
`style={{` nên trước giờ không bị đếm. Gom style vào một object và đặt tên **không** làm nó bớt là
inline style — nó vẫn vào thuộc tính `style`, vẫn thắng mọi rule, vẫn không viết được `:hover`.
`PubSub` còn một object thứ sáu (`inputStyle`) khai báo ngay trong thân component.

### Còn lại
- **GĐ 4 — `QuickSwitcherPopover`**: hoá ra **đã xong sẵn** từ trước; nó vốn có `RedisIcon` và
  `'redis'` trong union type.
- **GĐ 4 — `aiContextBuilder.ts`**: **cố ý chưa làm.** `buildSchemaContext` dựng ngữ cảnh bảng/cột,
  vô nghĩa với Redis; mà `ai_chat` (`database.rs:2517`) vẫn là stub echo lại prompt, chưa nối model
  nào. Dựng ngữ cảnh key cho một hàm không gọi model là viết code không ai chạy — nên để lại cho
  lúc AI Copilot được nối thật.
- **Kiểm thử thủ công §5**: chưa chạy lần nào. Đây là phần rủi ro còn lại lớn nhất.
