// Minimal string-based XML parser without DOMParser.
//
// Rationale: User-uploaded XLSX files are untrusted. Passing raw XML into
// DOMParser.parseFromString() risks DOM-based XSS (CodeQL js/xss-through-dom).
// We only need tags, attributes, and text; this pure tokenizer builds a lightweight data tree
// with zero live DOM nodes, zero script execution, and zero XXE external entity expansion.
//
// Minimal DOM-like API tailored for xlsxReader: getElementsByTagName / getAttribute / textContent.

import i18n from '../i18n';

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// Decodes only the 5 standard XML built-in entities + numeric character references.
// Custom entities (including external entities) are preserved verbatim, preventing XXE.
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

// Local name after ':' (strips namespace prefix), e.g. 'r:id' -> 'id'.
function localPart(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export class XmlElement {
  readonly name: string;
  readonly localName: string;
  readonly attrs: Map<string, string>;
  /** Direct element children for tree traversal. */
  readonly children: XmlElement[] = [];
  /** Direct children including text fragments in document order. */
  readonly nodes: Array<string | XmlElement> = [];

  constructor(name: string, attrs: Map<string, string>) {
    this.name = name;
    this.localName = localPart(name);
    this.attrs = attrs;
  }

  /** Concatenates text content of element and all descendants in document order. */
  get textContent(): string {
    let out = '';
    for (const n of this.nodes) out += typeof n === 'string' ? n : n.textContent;
    return out;
  }

  /** Matches full tag name first, then local name (handles prefixed XML files). */
  getAttribute(name: string): string | null {
    const exact = this.attrs.get(name);
    if (exact !== undefined) return exact;
    const local = localPart(name);
    for (const [k, v] of this.attrs) {
      if (localPart(k) === local) return v;
    }
    return null;
  }

  /** Descendant elements matching tag name in document order. */
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

// Locates closing '>', skipping '>' inside quoted attribute strings.
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

// Skips '<!DOCTYPE ...>' declarations including internal subsets '[...]'.
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
 * Parses XML string into `XmlElement` tree.
 *
 * Root node is virtual `#document`: use `getElementsByTagName` to query elements at any depth.
 
 *
 * Throws `XmlParseError` on malformed XML (unclosed tags, mismatched tags, etc.).
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
      addText(text.slice(lt + 9, end), false); // CDATA: preserved verbatim without entity decoding
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
