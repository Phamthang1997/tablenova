// Parser XML tối giản, thuần chuỗi — không dùng DOMParser.
//
// Lý do tồn tại: XLSX do người dùng chọn là dữ liệu không tin cậy. Đưa chuỗi đó vào
// DOMParser.parseFromString() là "diễn giải văn bản thành DOM" (CodeQL js/xss-through-dom).
// Ở đây ta chỉ cần đọc tên thẻ / thuộc tính / văn bản, nên tự tách chuỗi ra cây dữ liệu
// thường: không tạo node DOM, không chạy script, không phân giải entity ngoài (không XXE).
//
// API bắt chước phần DOM mà xlsxReader cần: getElementsByTagName / getAttribute / textContent.

import i18n from '../i18n';

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// Chỉ giải mã 5 entity dựng sẵn của XML + tham chiếu ký tự số.
// Entity tự định nghĩa (kể cả entity ngoài) được giữ nguyên dạng chữ, không phân giải.
export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9._-]*);/g, (m, ent: string) => {
    if (ent.charCodeAt(0) === 35 /* # */) {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const code = parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = XML_ENTITIES[ent];
    return v === undefined ? m : v;
  });
}

// Phần tên sau dấu ':' (bỏ prefix namespace), vd 'r:id' -> 'id'.
function localPart(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export class XmlElement {
  readonly name: string;
  readonly localName: string;
  readonly attrs: Map<string, string>;
  /** Con trực tiếp là phần tử (dùng cho duyệt cây). */
  readonly children: XmlElement[] = [];
  /** Con trực tiếp gồm cả chuỗi văn bản, giữ đúng thứ tự tài liệu. */
  readonly nodes: Array<string | XmlElement> = [];

  constructor(name: string, attrs: Map<string, string>) {
    this.name = name;
    this.localName = localPart(name);
    this.attrs = attrs;
  }

  /** Nối toàn bộ văn bản của phần tử này và mọi hậu duệ, theo thứ tự tài liệu. */
  get textContent(): string {
    let out = '';
    for (const n of this.nodes) out += typeof n === 'string' ? n : n.textContent;
    return out;
  }

  /** Khớp tên đầy đủ trước, sau đó khớp phần local (chấp nhận file có prefix namespace). */
  getAttribute(name: string): string | null {
    const exact = this.attrs.get(name);
    if (exact !== undefined) return exact;
    const local = localPart(name);
    for (const [k, v] of this.attrs) {
      if (localPart(k) === local) return v;
    }
    return null;
  }

  /** Hậu duệ khớp tên (đầy đủ hoặc phần local), theo thứ tự tài liệu — như DOM. */
  getElementsByTagName(name: string): XmlElement[] {
    const local = localPart(name);
    const out: XmlElement[] = [];
    const walk = (el: XmlElement): void => {
      for (const c of el.children) {
        if (c.name === name || c.localName === local) out.push(c);
        if (c.children.length > 0) walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export class XmlParseError extends Error {}

// Tìm '>' kết thúc thẻ, bỏ qua '>' nằm trong chuỗi trích dẫn của thuộc tính.
function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

// Bỏ qua '<!DOCTYPE ...>' và khai báo '<! ...>' khác, kể cả internal subset '[...]'.
function skipDeclaration(text: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
    } else if (ch === '>' && depth <= 0) {
      return i + 1;
    }
  }
  throw new XmlParseError(i18n.t('errors.xmlDeclNotClosed'));
}

const ATTR_RE = /([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  if (src.indexOf('=') < 0) return attrs;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src)) !== null) {
    attrs.set(m[1], decodeXmlEntities(m[2] !== undefined ? m[2] : m[3] ?? ''));
  }
  return attrs;
}

/**
 * Phân tích chuỗi XML thành cây `XmlElement`.
 *
 * Phần tử trả về là node gốc ảo `#document`: dùng `getElementsByTagName` trên nó để tìm
 * phần tử ở bất kỳ độ sâu nào (kể cả phần tử gốc thật của tài liệu).
 *
 * Ném `XmlParseError` khi XML không hợp lệ (thẻ không đóng, thẻ đóng lệch, ...).
 */
export function parseXml(text: string): XmlElement {
  const root = new XmlElement('#document', new Map());
  const stack: XmlElement[] = [root];

  const addText = (raw: string, decode: boolean): void => {
    if (raw === '') return;
    stack[stack.length - 1].nodes.push(decode ? decodeXmlEntities(raw) : raw);
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i), true);
      break;
    }
    if (lt > i) addText(text.slice(i, lt), true);

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlParseError(i18n.t('errors.xmlCommentNotClosed'));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlParseError(i18n.t('errors.xmlCdataNotClosed'));
      addText(text.slice(lt + 9, end), false); // CDATA: giữ nguyên, không giải mã entity
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlParseError(i18n.t('errors.xmlPiNotClosed'));
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = skipDeclaration(text, lt);
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt < 0) throw new XmlParseError(i18n.t('errors.xmlTagNotClosed'));
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      const open = stack.pop();
      if (!open || open === root || open.name !== name) {
        throw new XmlParseError(i18n.t('errors.xmlMismatchedClose', { name }));
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).trim();
    if (name === '') throw new XmlParseError(i18n.t('errors.xmlTagMissingName'));

    const el = new XmlElement(name, nameEnd < 0 ? new Map() : parseAttrs(body.slice(nameEnd)));
    const parent = stack[stack.length - 1];
    parent.nodes.push(el);
    parent.children.push(el);
    if (!selfClosing) stack.push(el);
  }

  if (stack.length !== 1) {
    throw new XmlParseError(i18n.t('errors.xmlUnclosedTag', { name: stack[stack.length - 1].name }));
  }
  return root;
}
