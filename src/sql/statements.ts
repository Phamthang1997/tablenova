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

/**
 * Bản đồ alias -> tên bảng trong một câu lệnh, dò bằng regex. Đủ dùng cho hover;
 * completion đã có bản chính xác hơn nhờ parser ANTLR (xem sqlLanguage.ts).
 * Để ở đây (module không phụ thuộc monaco) nên test được độc lập.
 */
export function resolveAliases(statement: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join|update|into)\s+([`"[\]\w.]+)(?:\s+(?:as\s+)?([a-zA-Z_]\w*))?/gi;
  const stop = new Set(['on', 'where', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'join', 'group', 'order', 'limit', 'set', 'using', 'values', 'select', 'having', 'union', 'and', 'or']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const table = (m[1] || '').replace(/[`"[\]]/g, '').split('.').pop() || '';
    if (!table) continue;
    map.set(table.toLowerCase(), table);
    const alias = m[2];
    if (alias && !stop.has(alias.toLowerCase())) map.set(alias.toLowerCase(), table);
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
