// Splitting a SQL column type into "the type" and "its length/precision", so the
// structure editor can offer a plain dropdown for one and a small text box for the
// other instead of making the user hand-type `varchar(255)` into a combobox.
//
// The parens are NOT always at the end — MySQL puts modifiers after them
// (`int(10) unsigned`) — and the type itself may contain spaces
// (`character varying(45)`, `timestamp without time zone`), so what comes before the
// paren and what comes after it are kept separately and re-joined in place.

export interface TypeParts {
  /** Text before the paren: `int`, `character varying`, `enum` */
  head: string;
  /** Inside the paren: `255`, `10,2`, `'M','F'` — empty when the type takes none */
  args: string;
  /** Text after the paren: `unsigned`, `unsigned zerofill` */
  tail: string;
}

export function splitType(raw: string | null | undefined): TypeParts {
  const s = (raw || '').trim();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  // lastIndexOf so `enum('a(1)','b')` keeps its inner paren inside args
  if (open < 0 || close < open) return { head: s, args: '', tail: '' };
  return {
    head: s.slice(0, open).trim(),
    args: s.slice(open + 1, close).trim(),
    tail: s.slice(close + 1).trim(),
  };
}

export function joinType(head: string, args: string, tail: string): string {
  const h = (head || '').trim();
  const a = (args || '').trim();
  const t = (tail || '').trim();
  return `${h}${a ? `(${a})` : ''}${t ? ` ${t}` : ''}`;
}

/** What the "Data type" cell shows — the type without its length: `int unsigned` */
export function typeBase(raw: string | null | undefined): string {
  const { head, tail } = splitType(raw);
  return tail ? `${head} ${tail}` : head;
}

/**
 * Các giá trị của một kiểu `enum(...)` / `set(...)`, đã bỏ dấu nháy.
 *
 * Đây là toàn bộ nền của gợi ý giá trị: MySQL trả `COLUMN_TYPE` nên chuỗi kiểu **đã mang sẵn**
 * danh sách giá trị, không phải hỏi database thêm câu nào. Trả mảng rỗng cho mọi kiểu khác, nên
 * cột `int`/`varchar` tự khắc không gợi ý gì mà không cần luật riêng.
 *
 * Tự tách chứ không `split(',')`: giá trị có thể chứa dấu phẩy (`enum('a,b','c')`) và dấu nháy
 * đơn được nhân đôi để thoát (`'it''s'`).
 */
export function enumValues(raw: string | null | undefined): string[] {
  const { head, args } = splitType(raw);
  const kind = head.trim().toLowerCase();
  if (kind !== 'enum' && kind !== 'set') return [];

  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] !== "'") { i++; continue; }
    i++;
    let value = '';
    while (i < args.length) {
      if (args[i] === "'") {
        if (args[i + 1] === "'") { value += "'"; i += 2; continue; } // nháy đôi = một nháy
        i++;
        break;
      }
      value += args[i++];
    }
    out.push(value);
  }
  return out;
}

/** Nhóm kiểu, đủ thô để so sánh được giữa ba dialect. */
export type TypeFamily = 'number' | 'string' | 'date' | 'bool' | 'binary' | 'json' | 'other';

// Khớp theo TỪ trong `head`, không phải theo tiền tố chuỗi. `timestamp without time zone` và
// `character varying` đều có nhiều từ, còn khớp tiền tố thì `int` sẽ nuốt luôn `interval`.
const FAMILY_WORDS: [TypeFamily, Set<string>][] = [
  ['number', new Set([
    'int', 'int2', 'int4', 'int8', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint',
    'decimal', 'numeric', 'dec', 'fixed', 'float', 'float4', 'float8', 'double', 'real',
    'money', 'serial', 'smallserial', 'bigserial', 'number',
  ])],
  ['bool', new Set(['bool', 'boolean'])],
  ['date', new Set([
    'date', 'datetime', 'datetime2', 'timestamp', 'timestamptz', 'time', 'timetz', 'year',
  ])],
  ['binary', new Set([
    'blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea', 'binary', 'varbinary', 'bit',
  ])],
  ['json', new Set(['json', 'jsonb'])],
  ['string', new Set([
    'char', 'varchar', 'character', 'varying', 'nchar', 'nvarchar', 'text', 'tinytext',
    'mediumtext', 'longtext', 'string', 'clob', 'enum', 'set', 'citext', 'uuid',
  ])],
];

/**
 * Nhóm của một kiểu cột, dùng cho những kiểm tra chỉ cần biết "số hay chữ hay ngày".
 *
 * Cố ý thô: mục đích duy nhất là bắt những so sánh sai rõ ràng (`int_col = 'abc'`), nên phân
 * biệt `int` với `bigint` không giúp gì mà chỉ thêm chỗ để sai. Không nhận ra thì trả `other`,
 * và mọi kiểm tra đọc giá trị này đều phải hiểu `other` là "không kết luận gì".
 */
export function typeFamily(raw: string | null | undefined): TypeFamily {
  const words = typeBase(raw).toLowerCase().split(/[\s_]+/).filter(Boolean);
  for (const [family, set] of FAMILY_WORDS) {
    if (words.some((w) => set.has(w))) return family;
  }
  return 'other';
}
