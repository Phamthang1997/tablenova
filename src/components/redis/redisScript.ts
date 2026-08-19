// Tách một buffer nhiều dòng của CLI Console thành từng lệnh Redis.
//
// **Không import monaco** — cùng lý do `src/sql/statements.ts` không import: bất cứ thứ gì kéo theo
// `monaco-editor` đều không chạy được dưới môi trường `node` của Vitest. Editor quyết định cái gì
// được tô sáng, file này quyết định cái gì thật sự chạy; giữ nó thuần là cách duy nhất để kiểm được
// phần thứ hai.
//
// Quy tắc tách đơn giản hơn SQL rất nhiều và đó là điều đúng: giao thức Redis là **một lệnh một
// dòng**. Không có dấu kết câu, không có khối lồng nhau, không có `$$…$$`. Cố dựng một bộ tách
// giống `split_sql_statements` ở đây là bịa ra độ phức tạp mà giao thức không có.

export interface RedisCommandLine {
  /** Nội dung lệnh, đã cắt khoảng trắng hai đầu. */
  text: string;
  /** Số dòng trong buffer, đếm từ 1 — để đặt con trỏ và đánh dấu dòng lỗi. */
  line: number;
}

/**
 * Mọi lệnh chạy được trong buffer, theo thứ tự.
 *
 * Bỏ qua dòng trống và dòng chú thích. `#` là ký tự chú thích của chính `redis.conf` và của
 * `redis-cli`, nên người dùng Redis đã quen với nó; `//` không phải.
 */
export function splitRedisCommands(text: string): RedisCommandLine[] {
  const out: RedisCommandLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.push({ text: trimmed, line: i + 1 });
  }
  return out;
}

/**
 * Lệnh mà con trỏ đang đứng trên, cho Ctrl+Enter.
 *
 * Con trỏ ở dòng trống hoặc dòng chú thích thì lùi lên lệnh gần nhất phía trên, thay vì không làm
 * gì: gõ xong một lệnh rồi Enter xuống dòng mới là thói quen phổ biến, và ở trạng thái đó "không có
 * lệnh nào" là câu trả lời vô ích.
 */
export function commandAtLine(text: string, line: number): RedisCommandLine | null {
  const cmds = splitRedisCommands(text);
  if (cmds.length === 0) return null;
  let found: RedisCommandLine | null = null;
  for (const c of cmds) {
    if (c.line > line) break;
    found = c;
  }
  return found;
}

/**
 * Tên lệnh của một dòng, viết hoa — có tính tới các lệnh hai từ (`CONFIG GET`, `CLIENT LIST`,
 * `XINFO STREAM`…).
 *
 * Nhận danh sách tên đã biết thay vì tự đoán: chỉ nhìn văn bản thì không phân biệt được `CONFIG GET`
 * (một lệnh hai từ) với `GET key` (một lệnh một từ kèm tham số). Bảng lệnh là thứ biết điều đó.
 */
export function commandNameOf(line: string, known: string[]): string {
  const parts = line.trim().split(/\s+/);
  if (parts.length === 0) return '';
  const one = parts[0].toUpperCase();
  if (parts.length >= 2) {
    const two = `${one} ${parts[1].toUpperCase()}`;
    if (known.includes(two)) return two;
  }
  return one;
}
