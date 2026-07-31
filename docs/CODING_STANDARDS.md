# Coding Standards — React + TypeScript + Rust + Tauri

Tài liệu này quy định cách viết code cho ứng dụng dùng React, TypeScript, Rust và Tauri.
Mục tiêu là tạo code đúng kiểu, dễ đọc, nhất quán và an toàn tại biên IPC.

## 1. Thứ tự ưu tiên

Khi các quy tắc xung đột, áp dụng theo thứ tự:

1. Compiler, formatter, linter và cấu hình của repository.
2. Tài liệu chính thức của React, TypeScript, Rust và Tauri.
3. Quy ước được ghi trong tài liệu này.
4. Phong cách đang tồn tại trong module được sửa, miễn là không vi phạm ba mức trên.

Không biến một pattern ngẫu nhiên trong code cũ thành “chuẩn ngôn ngữ”. Quy ước riêng của repository phải được mô tả rõ là quy ước dự án.

Các từ khóa trong tài liệu:

- **Bắt buộc**: phải tuân thủ.
- **Nên**: mặc định áp dụng, chỉ khác đi khi có lý do rõ ràng.
- **Có thể**: tùy ngữ cảnh.

---

## 2. Quy ước đặt tên

### 2.1 TypeScript và React

| Đối tượng | Quy ước | Ví dụ |
|---|---|---|
| Component | `PascalCase` | `DatabaseInfoModal` |
| Type / interface | `PascalCase` | `DatabaseStats`, `QueryResult` |
| Biến / function | `camelCase` | `fetchDatabaseStats`, `selectedTable` |
| Custom Hook | bắt đầu bằng `use` | `useDatabaseStats` |
| Event handler nội bộ | `handle<Action>` | `handleSave`, `handleRowSelect` |
| Callback prop | `on<Action>` | `onSave`, `onRowSelect` |
| Boolean | ưu tiên `is`, `has`, `can`, `should` | `isLoading`, `hasError` |
| Hằng số dùng chung | `SCREAMING_SNAKE_CASE` | `DEFAULT_PAGE_SIZE` |
| File component | `PascalCase.tsx` | `DatabaseInfoModal.tsx` |
| File hook | `useXxx.ts` | `useDatabaseStats.ts` |
| File util/service | dùng một quy ước nhất quán trong repo | `queryParser.ts`, `tauriClient.ts` |

Tên phải mô tả ý nghĩa nghiệp vụ, không mô tả kiểu dữ liệu:

```ts
// Tốt
const tables = [];
const searchTerm = '';

// Tránh
const tableArray = [];
const searchString = '';
```

### 2.2 Rust

| Đối tượng | Quy ước | Ví dụ |
|---|---|---|
| Module | `snake_case` | `database_stats` |
| Function / method / biến | `snake_case` | `load_database_stats` |
| Struct / enum / trait | `UpperCamelCase` | `DatabaseStats`, `AppError` |
| Enum variant | `UpperCamelCase` | `NotConnected` |
| Const / static | `SCREAMING_SNAKE_CASE` | `DEFAULT_PAGE_SIZE` |
| Lifetime | ngắn, chữ thường | `'a`, `'de` |

Không thêm tiền tố `get_` cho getter thông thường nếu tên ngắn hơn đã diễn đạt rõ:

```rust
impl Connection {
    pub fn status(&self) -> ConnectionStatus {
        self.status
    }
}
```

---

## 3. TypeScript

### 3.1 Kiểm tra kiểu

**Bắt buộc bật `strict`** trong `tsconfig` cho code mới. Các tùy chọn cụ thể do cấu hình repository quyết định.

- Dùng inference cho biến cục bộ khi kiểu đã rõ.
- Khai báo kiểu tường minh cho public API, props, payload IPC, dữ liệu lưu trữ và giá trị trả về phức tạp.
- Không dùng `any` để bỏ qua thiết kế kiểu. Dữ liệu chưa tin cậy phải bắt đầu bằng `unknown` và được kiểm tra trước khi sử dụng.
- Không ép kiểu chỉ để làm compiler im lặng.
- Hạn chế toán tử non-null `!`; chỉ dùng khi invariant đã được đảm bảo và lý do không thể biểu diễn trong type system.

```ts
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Đã xảy ra lỗi không xác định';
}
```

### 3.2 Mô hình hóa trạng thái

Ưu tiên union có discriminator thay cho nhiều boolean có thể mâu thuẫn:

```ts
type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string };
```

Không tạo kiểu quá rộng như `string` khi miền giá trị đã biết:

```ts
type SortMode = 'nameAsc' | 'sizeDesc' | 'rowsDesc';
```

`type` và `interface` đều hợp lệ. Chọn theo nhu cầu và giữ nhất quán trong cùng module; không bắt buộc mọi props phải là `interface`.

### 3.3 Import và escape hatch

- Dùng `import type` hoặc inline type import khi cấu hình module yêu cầu, đặc biệt khi `verbatimModuleSyntax` được bật.
- Không để import, biến hoặc parameter thừa.
- Không dùng `@ts-ignore`.
- `@ts-expect-error` chỉ được dùng cho trường hợp đã biết, kèm comment mô tả lý do và điều kiện gỡ bỏ.

---

## 4. React

### 4.1 Component

Dùng function component. `React.FC` là tùy chọn, không phải yêu cầu.

```tsx
type DatabaseInfoModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function DatabaseInfoModal({
  isOpen,
  onClose,
}: DatabaseInfoModalProps) {
  if (!isOpen) return null;

  return (
    <section aria-label="Thông tin database">
      <button type="button" onClick={onClose}>
        Đóng
      </button>
    </section>
  );
}
```

Tách component theo trách nhiệm và khả năng tái sử dụng, không theo một giới hạn số dòng tùy ý. Khi component trộn nhiều nhiệm vụ như gọi dữ liệu, quản lý form, render bảng và điều khiển modal, nên tách custom hook hoặc component con.

### 4.2 Hooks

- Chỉ gọi Hook ở top level của function component hoặc custom Hook.
- Không gọi Hook trong điều kiện, vòng lặp, callback, `try/catch` hoặc sau conditional return.
- Dependency của Effect/Memo/Callback phải đầy đủ theo giá trị reactive được sử dụng.
- Không xóa dependency để né re-render; sửa cấu trúc code gây vòng lặp.

### 4.3 State dẫn xuất

Không lưu vào state giá trị có thể tính trực tiếp từ props hoặc state khác.

```tsx
const filteredTables = tables.filter((table) =>
  table.name.toLowerCase().includes(searchTerm.toLowerCase()),
);
```

Không bắt buộc bọc mọi phép tính dẫn xuất bằng `useMemo`. Chỉ dùng `useMemo` khi phép tính thực sự đáng kể, cần ổn định reference cho một tối ưu khác, hoặc đã đo được lợi ích.

### 4.4 Effects

`useEffect` dùng để đồng bộ với hệ thống bên ngoài React: event listener, timer, network subscription, Tauri event, Monaco, terminal hoặc thư viện imperative.

Nếu không đồng bộ với hệ thống bên ngoài, thường không cần Effect.

Mọi Effect tạo resource phải trả cleanup tương ứng:

```tsx
useEffect(() => {
  const unlistenPromise = listen<DatabaseChangedPayload>(
    'database-changed',
    handleDatabaseChanged,
  );

  return () => {
    void unlistenPromise.then((unlisten) => unlisten());
  };
}, [handleDatabaseChanged]);
```

### 4.5 Render list

Key phải ổn định và duy nhất trong tập anh em. Không dùng index khi danh sách có thể chèn, xóa, lọc, sắp xếp hoặc đổi thứ tự.

```tsx
{tables.map((table) => (
  <TableRow key={table.id} table={table} />
))}
```

### 4.6 Accessibility

- Dùng đúng semantic HTML trước khi dùng `div` có role.
- Button phải là `<button>` và khai báo `type` khi nằm trong form.
- Input phải có label hoặc accessible name.
- Modal phải quản lý focus, Escape và quan hệ ARIA phù hợp.
- Không chỉ dùng màu sắc để biểu diễn trạng thái.

---

## 5. Biên Frontend ↔ Tauri

### 5.1 Tổ chức IPC

Nên tập trung lời gọi Tauri vào một lớp client/service có kiểu, ví dụ `src/services/tauri/`. Component không nên tự xây payload và xử lý lỗi IPC lặp lại ở nhiều nơi.

Đây là quy ước kiến trúc của dự án, không phải yêu cầu bắt buộc của Tauri.

```ts
import { invoke } from '@tauri-apps/api/core';

type DatabaseStats = {
  totalSizeBytes: number | null;
  tableCount: number;
};

export async function getDatabaseStats(): Promise<DatabaseStats> {
  return invoke<DatabaseStats>('get_database_stats');
}
```

Không bọc kết quả thành `{ success: boolean }` một cách máy móc. Promise resolve/reject đã biểu diễn thành công/thất bại. Chỉ dùng result object khi UI hoặc domain thực sự cần lỗi như dữ liệu.

### 5.2 Quy ước tên và serialization

- Tên command Rust dùng `snake_case`.
- Tên argument trong Rust dùng `snake_case`.
- Payload JavaScript mặc định dùng `camelCase`; Tauri ánh xạ sang argument Rust tương ứng.
- Chỉ dùng `#[tauri::command(rename_all = "snake_case")]` khi chủ động muốn payload JavaScript dùng `snake_case`.
- Response gửi sang TypeScript nên dùng `camelCase` để phù hợp hệ sinh thái JavaScript, thông qua `#[serde(rename_all = "camelCase")]`.

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub total_size_bytes: Option<u64>,
    pub table_count: usize,
}

#[tauri::command]
pub async fn get_table_stats(table_name: String) -> Result<DatabaseStats, AppError> {
    // ...
}
```

```ts
await invoke<DatabaseStats>('get_table_stats', {
  tableName,
});
```

Không dùng `serde_json::Value` làm response mặc định. Ưu tiên struct/enum cụ thể để Rust và TypeScript cùng có contract rõ ràng.

### 5.3 Lỗi IPC

Không bắt buộc mọi command trả `Result<T, String>`. Với prototype nhỏ, `String` có thể chấp nhận; với ứng dụng thực tế, ưu tiên error type có cấu trúc và serialize được.

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Chưa kết nối database")]
    NotConnected,

    #[error("Không thể đọc dữ liệu: {0}")]
    Database(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
```

Nếu frontend cần xử lý theo loại lỗi, serialize object có `code`, `message` và dữ liệu bổ sung thay vì phân tích chuỗi.

### 5.4 Command, event và channel

- Dùng command cho request/response.
- Dùng event cho thông báo một chiều hoặc broadcast không yêu cầu response có kiểu chặt.
- Dùng channel cho dữ liệu streaming hoặc tiến trình dài.
- Command mới phải được đăng ký trong một `tauri::generate_handler![...]` duy nhất.
- Tác vụ I/O hoặc tác vụ nặng phải chạy bất đồng bộ để không chặn UI/main thread.

### 5.5 Bảo mật

Mọi dữ liệu từ frontend được xem là không tin cậy.

- Validate path, URL, SQL identifier, command-line argument và mọi input có thể chạm tài nguyên hệ thống.
- Không nối input trực tiếp vào shell command hoặc SQL value.
- Dùng parameter binding cho SQL value; identifier động phải quote và escape đúng dialect.
- Chỉ cấp capability/permission cần thiết cho từng window hoặc webview.
- Không đưa secret, token hoặc credential vào log hay response IPC.

---

## 6. Rust

### 6.1 Formatting và lint

`rustfmt` là nguồn sự thật cho format. Không căn chỉnh thủ công trái với formatter.

- Indent 4 spaces.
- Dùng trailing comma cho cấu trúc nhiều dòng.
- Chạy Clippy và xử lý warning thay vì tắt lint rộng.
- Mọi `allow` lint phải có phạm vi nhỏ và lý do cụ thể.

### 6.2 Error handling

- Dùng `Result` cho lỗi có thể phục hồi và `Option` cho trường hợp không có giá trị nhưng không phải lỗi.
- Dùng toán tử `?` để propagate lỗi khi caller có trách nhiệm xử lý.
- Không dùng `unwrap`, `expect` hoặc `panic!` trên đường đi xử lý input người dùng, IPC, file, network hoặc database.
- Có thể dùng `expect` tại bootstrap hoặc invariant thực sự không thể vi phạm, nhưng message phải giải thích invariant.
- Trong test, `unwrap`/`expect` được chấp nhận khi giúp test ngắn và rõ.

### 6.3 Async và locking

Không giữ `std::sync::MutexGuard` hoặc `parking_lot::MutexGuard` qua `.await`.

```rust
let connection = {
    let manager = state.database.lock().map_err(|error| error.to_string())?;
    manager.connection.clone().ok_or(AppError::NotConnected)?
};

let rows = load_rows(&connection).await?;
```

Giữ critical section ngắn. Không clone dữ liệu lớn chỉ để né thiết kế ownership; clone `Arc`, pool handle hoặc value nhỏ khi đó là lựa chọn có chủ đích.

### 6.4 Module và visibility

Tổ chức module theo domain hoặc feature. Chỉ export API cần cho module khác; helper nội bộ để private.

```text
src-tauri/src/
├── commands/
├── domain/
├── services/
├── state/
├── error.rs
└── lib.rs
```

Cấu trúc trên là gợi ý. Repository có thể dùng cấu trúc khác nếu ranh giới trách nhiệm vẫn rõ.

### 6.5 `unsafe`

Không thêm `unsafe` nếu có giải pháp safe hợp lý. Mỗi block `unsafe` phải có comment `SAFETY:` mô tả invariant mà caller hoặc code xung quanh đảm bảo.

---

## 7. Comment, tài liệu và ngôn ngữ hiển thị

Ngôn ngữ lập trình không bắt buộc comment phải là tiếng Việt hay tiếng Anh. Dự án chọn một ngôn ngữ thống nhất cho comment kỹ thuật và tài liệu nội bộ.

Comment phải giải thích **tại sao**, invariant, giới hạn hoặc quyết định không hiển nhiên; không lặp lại code.

```rust
// Tốt: lock phải được thả trước khi query async để tránh giữ guard qua await.
let connection = { /* ... */ };

// Tránh: lấy connection.
let connection = { /* ... */ };
```

Chuỗi UI phải đi qua cơ chế i18n nếu ứng dụng hỗ trợ nhiều ngôn ngữ. Không hardcode thêm chuỗi ở component đã dùng translation system.

Message gửi cho người dùng phải dễ hiểu; log kỹ thuật có thể chi tiết hơn nhưng không được chứa secret.

---

## 8. CSS và giao diện

- Dùng hệ thống style đang tồn tại trong dự án; không thêm framework mới chỉ cho một component.
- Ưu tiên design token hoặc CSS variable thay vì hardcode màu lặp lại.
- Không dùng inline style cho trạng thái phức tạp nếu class hoặc component variant diễn đạt rõ hơn.
- Giao diện phải hoạt động ở theme, scale và kích thước cửa sổ mà ứng dụng hỗ trợ.
- Không coi một pattern CSS hiện tại là chuẩn framework nếu nó chỉ là lựa chọn cục bộ của repository.

---

## 9. Testing

### 9.1 TypeScript và React

- Dùng Vitest hoặc runner được cấu hình trong repository.
- Test hành vi quan sát được, không test chi tiết implementation.
- Logic thuần nên đặt ngoài component để test độc lập.
- Test parser, serializer, transformer, validation và IPC mapping.
- Component test nên ưu tiên tương tác người dùng và kết quả hiển thị.
- Tên test phải mô tả hành vi; không bắt buộc một mẫu câu duy nhất nếu team chưa quy định.

```ts
describe('extractQueryParams', () => {
  it('extracts named parameters', () => {
    expect(extractQueryParams('SELECT * FROM users WHERE id = :userId'))
      .toEqual([':userId']);
  });
});
```

### 9.2 Rust

- Dùng unit test cho logic thuần và invariant.
- Dùng integration test cho ranh giới module hoặc command khi phù hợp.
- Không phụ thuộc database/network thật trong unit test nếu có thể dùng abstraction hoặc fixture nhỏ.
- Test cả success path, invalid input và error mapping.

---

## 10. Logging và debug

- Không để lại `console.log`, `println!`, `dbg!` dùng tạm để debug trong mã nguồn.
- Dùng logger có level phù hợp cho thông tin vận hành cần giữ lại.
- Error log phải có context kỹ thuật; message UI không được phơi bày stack trace hoặc secret.
- Không nuốt lỗi bằng `catch {}` hoặc `let _ =` nếu lỗi có thể ảnh hưởng hành vi.

---

## 11. Những quy tắc không được coi là chuẩn chung

Các quy tắc sau chỉ được áp dụng khi repository chủ động chọn và ghi rõ, không phải chuẩn mặc định của React, TypeScript, Rust hoặc Tauri:

- Mọi component bắt buộc dùng `React.FC`.
- Mọi giá trị dẫn xuất bắt buộc dùng `useMemo`.
- Mọi Tauri command bắt buộc trả `Result<T, String>`.
- Response Rust bắt buộc giữ key `snake_case` trong TypeScript.
- Mọi `invoke()` bắt buộc nằm trong một file có tên cụ thể như `dbHelper.ts`.
- Mọi component phải dưới một số dòng cố định.
- `window CustomEvent` là cơ chế mặc định cho state cross-component.
- Comment và error kỹ thuật bắt buộc dùng một ngôn ngữ tự nhiên cụ thể.
- Mọi service bắt buộc trả `{ success, error }` thay vì throw/reject.

Những lựa chọn này có thể là quy ước hợp lệ của một repository, nhưng phải được mô tả là **quy ước dự án**, kèm lý do, thay vì gọi là chuẩn của ngôn ngữ/framework.

---

## 12. Công cụ kiểm tra tiêu chuẩn

Tên script trong `package.json` và cấu hình Cargo của repository là nguồn sự thật. Các công cụ sau được dùng để phát hiện code không tuân thủ tiêu chuẩn:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all
```

Với ứng dụng Tauri, lệnh build phải được định nghĩa trong script của repository:

```bash
npm run tauri build
```

Không hardcode đường dẫn hoặc cấu hình riêng của một máy trong Coding Standards. Những cấu hình môi trường đặc biệt phải nằm trong script hoặc tài liệu cài đặt dự án.

## Tài liệu nền tảng

Tài liệu này được xây dựng dựa trên:

- React documentation: Rules of Hooks, Choosing the State Structure, useEffect, useMemo, Rendering Lists.
- TypeScript Handbook và TSConfig Reference.
- The Rust Programming Language, Rust Style Guide, Rust API Guidelines và Clippy.
- Tauri v2 documentation: Calling Rust from the Frontend, IPC, Capabilities, Permissions và Scopes.
