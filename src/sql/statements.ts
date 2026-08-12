// Tách văn bản SQL thành các câu lệnh theo dấu ';' NGOÀI chuỗi/comment/khối $$...$$.
// Dùng chung cho: xác định "câu lệnh hiện tại" (Ctrl+Enter) và tô sáng câu lệnh dưới con trỏ.
import { maskCommentsAndStrings } from '../utils/queryParamHelper';

// Mở đầu một khối dollar-quote của Postgres: $$ hoặc $tag$ (KHÔNG khớp $1 của bind param
// hay ${name} của tham số truy vấn).
const DOLLAR_TAG = /^\$([A-Za-z_]\w*)?\$/;

// Lệnh DELIMITER của client mysql (KHÔNG phải SQL gửi xuống server): đổi dấu kết thúc câu
// để có thể viết thân trigger/procedure chứa dấu ';'. Bắt buộc nằm riêng một dòng.
const DELIMITER_CMD = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?$/i;

// Script có dùng lệnh DELIMITER -> đây là script kiểu MySQL, không áp dụng dollar-quote của
// Postgres. Cần thiết vì `DELIMITER $$` rất phổ biến: nếu vẫn coi '$$' là mở khối dollar-quote
// thì toàn bộ thân trigger sẽ bị mask sai.
function usesDelimiterCommand(sql: string): boolean {
  return /^[ \t]*DELIMITER[ \t]+\S+/im.test(sql);
}

/**
 * Mask đầy đủ cho việc tách câu lệnh: comment + chuỗi (nhờ maskCommentsAndStrings), CỘNG THÊM
 * khối dollar-quote của Postgres (`$$ ... $$`, `$body$ ... $body$`) — thân function/trigger
 * chứa rất nhiều ';' và nếu không mask thì Ctrl+Enter sẽ cắt giữa thân hàm.
 *
 * Chuỗi trả về cùng độ dài với `sql`; ký tự thuộc vùng cần bỏ qua được thay bằng khoảng trắng.
 */
export function maskForSplit(sql: string): string {
  const base = maskCommentsAndStrings(sql);
  if (usesDelimiterCommand(sql)) return base; // script MySQL -> '$$' là delimiter, không phải khối
  const out = base.split('');
  let i = 0;
  while (i < sql.length) {
    // Chỉ xét vị trí là code thật (không nằm trong chuỗi/comment theo pass đầu)
    if (sql[i] === '$' && base[i] === '$') {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        for (let k = i; k < end; k++) out[k] = sql[k] === '\n' ? '\n' : ' ';
        i = end;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

export interface StatementRange {
  /** offset ký tự đầu (đã bỏ khoảng trắng ở đầu) */
  start: number;
  /** offset ký tự cuối, KHÔNG bao gồm dấu ';' (đã bỏ khoảng trắng ở cuối) */
  end: number;
  text: string;
}

// Cắt khoảng trắng 2 đầu; trả null nếu đoạn chỉ có khoảng trắng hoặc chỉ có comment.
function trimRange(text: string, mask: string, from: number, to: number): StatementRange | null {
  let s = from;
  let e = to;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s >= e) return null;
  // Chỉ có comment -> mask toàn khoảng trắng -> không phải câu lệnh chạy được
  if (!mask.slice(s, e).trim()) return null;
  return { start: s, end: e, text: text.slice(s, e) };
}

/** Một bảng được tham chiếu trong FROM/JOIN/UPDATE/INTO. */
export interface TableRef {
  table: string;
  alias?: string;
}

// Từ có thể đứng ngay sau tên bảng nhưng KHÔNG phải alias.
const ALIAS_STOP_WORDS = [
  'on', 'where', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'join', 'group',
  'order', 'limit', 'set', 'using', 'values', 'select', 'having', 'union', 'and', 'or',
];

/**
 * `FROM|JOIN|UPDATE|INTO <bảng> [AS] [alias]`.
 *
 * Từ khoá bị loại bằng LOOKAHEAD, không phải kiểm tra sau khi khớp: nếu để nhóm alias
 * khớp rồi mới bỏ, con trỏ regex đã trượt qua từ khoá đó — `FROM a JOIN b` nuốt mất
 * `JOIN` và bảng `b` không bao giờ được nhìn thấy (bug này có từ trước, xem test).
 */
const TABLE_REF_SOURCE =
  '\\b(?:from|join|update|into)\\s+([`"\\[\\]\\w.]+)' +
  `(?:\\s+(?:as\\s+)?(?!(?:${ALIAS_STOP_WORDS.join('|')})\\b)([a-zA-Z_]\\w*))?`;

/**
 * Các bảng được tham chiếu trong một câu lệnh, **theo đúng thứ tự xuất hiện**.
 *
 * Đây là nguồn dự phòng cho cả hover và completion. Lý do cần nó dù đã có parser ANTLR:
 * khi câu lệnh còn gõ dở, `getAllEntities()` không đáng tin và sai theo từng dialect —
 * đo được: với `... JOIN address a on ` parser Postgres bỏ mất chính bảng `address`
 * (2 entity thay vì 3), còn với `... on c.` parser MySQL trả về 0 entity. Regex trên
 * văn bản không hiểu SQL sâu nhưng lại ổn định đúng ở những trạng thái dở dang đó.
 *
 * Thứ tự được giữ vì gợi ý điều kiện JOIN cần biết bảng nào vừa được JOIN sau cùng.
 */
export function collectTableRefs(statement: string): TableRef[] {
  const out: TableRef[] = [];
  // RegExp mới mỗi lần gọi: cờ /g mang lastIndex, dùng chung một instance sẽ lẫn state.
  const re = new RegExp(TABLE_REF_SOURCE, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const table = (m[1] || '').replace(/[`"[\]]/g, '').split('.').pop() || '';
    if (!table) continue;
    out.push({ table, alias: m[2] || undefined });
  }
  return out;
}

/**
 * Bản đồ alias -> tên bảng trong một câu lệnh. Cùng một bộ dò với `collectTableRefs`
 * để hover và completion không bao giờ hiểu alias khác nhau.
 * Để ở đây (module không phụ thuộc monaco) nên test được độc lập.
 */
export function resolveAliases(statement: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { table, alias } of collectTableRefs(statement)) {
    map.set(table.toLowerCase(), table);
    if (alias) map.set(alias.toLowerCase(), table);
  }
  return map;
}

/**
 * Câu lệnh có làm đổi cấu trúc DB (DDL) hay đổi database/schema đang dùng?
 * Dùng để xoá cache catalog ngay sau khi chạy, cho autocomplete/hover thấy bảng mới.
 *
 * `USE db` (MySQL) và `SET search_path` (Postgres) cũng phải tính: backend chuyển sang
 * database/schema khác nên toàn bộ danh sách bảng đã cache trở thành sai.
 * Dò trên bản đã mask nên từ khoá nằm trong chuỗi/comment không tính.
 */
export function isSchemaChangingSql(text: string): boolean {
  if (!text) return false;
  const masked = maskForSplit(text);
  return /\b(CREATE|ALTER|DROP|RENAME|TRUNCATE|USE)\b/i.test(masked)
    || /\bCOMMENT\s+ON\b/i.test(masked)
    || /\bSET\s+search_path\b/i.test(masked);
}

/**
 * Lõi chung: mask văn bản 1 lần rồi cắt thành các ĐOẠN theo ';' (kể cả đoạn trống, vì cần
 * chúng để biết con trỏ đang ở giữa hai ';' — lúc đó không có câu lệnh nào để chạy).
 */
// `text[i..]` có đúng là dấu kết thúc câu đang dùng, và nằm ngoài chuỗi/comment/khối $$?
function matchesDelimiter(text: string, mask: string, i: number, delim: string): boolean {
  for (let k = 0; k < delim.length; k++) {
    const c = text[i + k];
    if (c !== delim[k] || mask[i + k] !== c) return false;
  }
  return true;
}

// Ở đầu dòng tại `i` có phải lệnh `DELIMITER <token>`? Trả về token mới + offset sau dòng đó.
function matchDelimiterCommand(
  text: string,
  mask: string,
  i: number
): { delim: string; end: number } | null {
  const nl = text.indexOf('\n', i);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(i, lineEnd);
  const m = DELIMITER_CMD.exec(line);
  if (!m) return null;
  // Từ 'DELIMITER' phải là code thật (nằm trong chuỗi/comment thì không phải lệnh)
  const lead = line.length - line.trimStart().length;
  if (mask[i + lead] !== text[i + lead]) return null;
  return { delim: m[1], end: nl === -1 ? text.length : nl + 1 };
}

// Đầu một câu CREATE TRIGGER (SQLite/MySQL/Postgres đều cùng dạng mở đầu này).
// Khớp trên văn bản GỐC chứ không phải bản mask: MySQL viết `DEFINER=`root`@`localhost``,
// mà mask xoá ruột hai cặp backtick thành khoảng trắng nên `\S+` không còn khớp được.
const TRIGGER_HEAD = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/i;
// `BEGIN` như một TỪ trong phần code (đã mask nên BEGIN trong chuỗi/comment không tính).
const BEGIN_WORD = /\bBEGIN\b/i;

/**
 * Đoạn [from, to) có kết thúc bằng từ khoá `END` không (bỏ qua khoảng trắng/comment ở cuối).
 *
 * Đọc trên bản đã mask nên `-- END` hay chuỗi 'END' không tính.
 */
function endsWithEndKeyword(mask: string, from: number, to: number): boolean {
  let e = to;
  while (e > from && /\s/.test(mask[e - 1])) e--;
  if (e - from < 3) return false;
  if (mask.slice(e - 3, e).toUpperCase() !== 'END') return false;
  const before = e - 4 >= from ? mask[e - 4] : ' ';
  return !/[A-Za-z0-9_$]/.test(before);
}

/**
 * Dấu ';' này có nằm GIỮA thân một trigger không?
 *
 * Thân trigger dạng `BEGIN ... END` chứa dấu ';' của riêng nó, nên cắt theo ';' sẽ tạo ra một
 * câu `CREATE TRIGGER ... BEGIN UPDATE t SET ...;` cụt — SQLite báo "incomplete input" và cả
 * lần nhập dump bị rollback. MySQL né chuyện này bằng lệnh `DELIMITER`, còn SQLite thì không
 * có, nên phải nhận diện ngay ở đây: đây đúng là quy tắc của `sqlite3_complete()` — một câu
 * mở đầu bằng CREATE TRIGGER chỉ kết thúc ở dấu ';' đứng ngay sau từ khoá `END`.
 *
 * Điều kiện `BEGIN` là bắt buộc: trigger của Postgres (`... EXECUTE FUNCTION f();`) và dạng
 * một lệnh của MySQL (`... FOR EACH ROW SET NEW.a = 1;`) không có thân BEGIN...END, và nếu
 * bắt chúng chờ `END` thì dấu ';' thật bị bỏ qua và phần còn lại của dump bị nuốt sạch.
 */
function insideTriggerBody(text: string, mask: string, from: number, to: number): boolean {
  // Ký tự code thật đầu tiên: mask đã biến comment thành khoảng trắng nên bỏ qua luôn được
  // phần comment đứng trước câu lệnh.
  let s = from;
  while (s < to && /\s/.test(mask[s])) s++;
  if (!TRIGGER_HEAD.test(text.slice(s, to))) return false;
  // BEGIN/END thì đọc trên bản mask: chữ 'BEGIN' trong chuỗi hay comment không tính.
  if (!BEGIN_WORD.test(mask.slice(s, to))) return false;
  return !endsWithEndKeyword(mask, s, to);
}

/**
 * Lõi chung: mask văn bản 1 lần rồi cắt thành các ĐOẠN theo dấu kết thúc câu đang hiệu lực
 * (mặc định ';', đổi được bằng lệnh `DELIMITER` của MySQL). Giữ cả đoạn trống vì cần chúng
 * để biết con trỏ đang ở giữa hai dấu kết thúc câu — lúc đó không có câu lệnh nào để chạy.
 *
 * Bản thân dòng `DELIMITER ...` KHÔNG bao giờ nằm trong đoạn nào: nó là lệnh của client
 * mysql, gửi xuống server sẽ báo lỗi cú pháp.
 */
function scanSegments(text: string): { mask: string; segments: [number, number][] } {
  const mask = maskForSplit(text);
  const segments: [number, number][] = [];
  let from = 0;
  let delim = ';';
  let atLineStart = true;
  let i = 0;

  while (i < text.length) {
    if (atLineStart) {
      const cmd = matchDelimiterCommand(text, mask, i);
      if (cmd) {
        segments.push([from, i]); // phần trước lệnh (thường chỉ là khoảng trắng -> bị bỏ)
        delim = cmd.delim;
        from = cmd.end;
        i = cmd.end;
        atLineStart = true;
        continue;
      }
    }
    if (matchesDelimiter(text, mask, i, delim)) {
      // Chỉ áp dụng khi delimiter vẫn là ';': script MySQL đã đổi delimiter thì thân trigger
      // được bảo vệ bằng chính cơ chế đó rồi.
      if (delim === ';' && insideTriggerBody(text, mask, from, i)) {
        i += 1;
        atLineStart = false;
        continue;
      }
      segments.push([from, i]);
      i += delim.length;
      from = i;
      atLineStart = false; // dấu kết thúc câu không bao giờ là ký tự xuống dòng
      continue;
    }
    atLineStart = text[i] === '\n';
    i++;
  }

  segments.push([from, text.length]);
  return { mask, segments };
}

// Đoạn chứa `offset`: con trỏ đứng NGAY SAU ';' thuộc đoạn kế tiếp (giống DataGrip/DBeaver).
function pickCurrent(
  text: string,
  mask: string,
  segments: [number, number][],
  offset: number
): StatementRange | null {
  for (const [from, to] of segments) {
    if (offset <= to) return trimRange(text, mask, from, to);
  }
  return null;
}

/** Danh sách câu lệnh trong văn bản (bỏ đoạn trống / chỉ có comment). */
export function splitStatements(text: string): StatementRange[] {
  if (!text) return [];
  const { mask, segments } = scanSegments(text);
  const out: StatementRange[] = [];
  for (const [from, to] of segments) {
    const r = trimRange(text, mask, from, to);
    if (r) out.push(r);
  }
  return out;
}

/** Loại câu lệnh bị cảnh báo trước khi chạy. */
export type UnsafeStatementKind = 'deleteNoWhere' | 'dropTable';

export interface UnsafeStatement {
  kind: UnsafeStatementKind;
  /** Câu lệnh nguyên văn (đã trim) để hiện trong hộp cảnh báo. */
  text: string;
}

/**
 * Tìm các câu lệnh có thể xoá sạch dữ liệu do gõ thiếu điều kiện:
 *   - `DELETE FROM ...` không có `WHERE` -> xoá mọi dòng của bảng
 *   - `DROP TABLE ...`                   -> xoá luôn cả bảng
 *
 * Chỉ để CẢNH BÁO, không phải để chặn: `DELETE FROM tmp_import` không WHERE là hoàn toàn hợp
 * lệ, nên quyết định cuối cùng thuộc người dùng (muốn chặn hẳn thì bật chế độ Chỉ đọc).
 *
 * Dò trên bản đã mask (`maskForSplit`) nên từ khoá nằm trong chuỗi/comment/tên có dấu nháy
 * đều không tính. Hai hệ quả đáng chú ý, cả hai đều là hướng an toàn:
 *   - `DELETE FROM t -- WHERE id=1` VẪN bị cảnh báo (WHERE nằm trong comment, không chạy).
 *   - `DELETE FROM t WHERE note='drop table x'` KHÔNG bị cảnh báo (chuỗi đã bị mask).
 */
export function findUnsafeStatements(text: string): UnsafeStatement[] {
  if (!text) return [];
  const out: UnsafeStatement[] = [];
  for (const stmt of splitStatements(text)) {
    const masked = maskForSplit(stmt.text);
    // Bao cả dạng nhiều bảng của MySQL (`DELETE t1 FROM t1 JOIN t2 ...`) vì vẫn mở đầu bằng DELETE.
    if (/^\s*DELETE\b/i.test(masked)) {
      if (!/\bWHERE\b/i.test(masked)) out.push({ kind: 'deleteNoWhere', text: stmt.text });
    } else if (/^\s*DROP\s+(TEMPORARY\s+)?TABLE\b/i.test(masked)) {
      out.push({ kind: 'dropTable', text: stmt.text });
    }
  }
  return out;
}

/** Câu lệnh chứa con trỏ tại `offset` (null nếu chỗ đó không có câu lệnh chạy được). */
export function statementAt(text: string, offset: number): StatementRange | null {
  if (!text) return null;
  const { mask, segments } = scanSegments(text);
  return pickCurrent(text, mask, segments, offset);
}

/**
 * Vừa danh sách câu lệnh vừa câu dưới con trỏ, CHỈ mask văn bản 1 lần.
 * Dùng cho đường tô sáng (chạy mỗi lần gõ) — gọi splitStatements + statementAt riêng lẻ
 * sẽ mask 2 lần và gây giật khi giữ Backspace trên script dài.
 */
export function analyzeStatements(
  text: string,
  offset: number
): { statements: StatementRange[]; current: StatementRange | null } {
  if (!text) return { statements: [], current: null };
  const { mask, segments } = scanSegments(text);
  const statements: StatementRange[] = [];
  for (const [from, to] of segments) {
    const r = trimRange(text, mask, from, to);
    if (r) statements.push(r);
  }
  return { statements, current: pickCurrent(text, mask, segments, offset) };
}
