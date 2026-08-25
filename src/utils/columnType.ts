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
 * Các giá trị of một kiểu `enum(...)` / `set(...)`, already bỏ quotes.
 *
 * Đây is toàn bộ nền of suggestion giá trị: MySQL trả `COLUMN_TYPE` nên string kiểu **already mang sẵn**
 * danh sách giá trị, not must hỏi database add câu nào. Trả mảng rỗng for mọi kiểu khác, nên
 * column `int`/`varchar` tự khắc not suggestion gì mà not cần luật riêng.
 *
 * Tự tách chứ not `split(',')`: giá trị can chứa dấu phẩy (`enum('a,b','c')`) and quotes
 * đơn is nhân đôi to thoát (`'it''s'`).
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

/** Nhóm kiểu, đủ thô to compare is giữa ba dialect. */
export type TypeFamily = 'number' | 'string' | 'date' | 'bool' | 'binary' | 'json' | 'other';

// Khớp theo from in `head`, not must theo tiền tố string. `timestamp without time zone` and
// `character varying` đều có nhiều from, còn khớp tiền tố thì `int` will nuốt luôn `interval`.
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
 * Nhóm of một kiểu column, dùng for những check chỉ cần biết "số hay chữ hay ngày".
 *
 * Cố ý thô: mục đích unique is bắt những compare sai rõ ràng (`int_col = 'abc'`), nên phân
 * biệt `int` with `bigint` not giúp gì mà chỉ add chỗ to sai. not receive ra thì trả `other`,
 * and mọi check read giá trị này đều must hiểu `other` is "not kết luận gì".
 */
export function typeFamily(raw: string | null | undefined): TypeFamily {
  const words = typeBase(raw).toLowerCase().split(/[\s_]+/).filter(Boolean);
  for (const [family, set] of FAMILY_WORDS) {
    if (words.some((w) => set.has(w))) return family;
  }
  return 'other';
}
