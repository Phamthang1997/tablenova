// Giải mã value chuỗi của Redis để hiển thị đẹp:
//   1) Nếu gzip (magic 1f 8b) hoặc zlib (PHP gzcompress) -> giải nén bằng DecompressionStream native.
//   2) Nếu là PHP serialize (Laravel cache/model, Neos Flow VariableFrontend) -> unserialize -> JSON.
//   3) Nếu là JSON -> format.
//   4) Còn lại -> text thô.
// Không phụ thuộc thư viện ngoài.

import i18n from '../i18n';

/**
 * zlib stream (RFC 1950) — what PHP's `gzcompress` produces, and a very common way to store a
 * serialized cache entry in Redis. There is no magic number: the check is the one from the
 * spec (low nibble of CMF is 8 for deflate, and CMF/FLG together are a multiple of 31).
 */
function isZlib(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  return (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
}

/**
 * Decompresses gzip and zlib transparently. `'deflate'` is the zlib-wrapped variant in the
 * Compression Streams spec (raw deflate would be `'deflate-raw'`), so it is the right one for
 * `gzcompress`. Failure falls back to the original bytes — a value that merely looks like a
 * zlib header must still be displayable.
 */
async function decompressIfNeeded(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; algo: '' | 'gzip' | 'zlib' }> {
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip && !isZlib(bytes)) return { bytes, algo: '' };
  const format = isGzip ? 'gzip' : 'deflate';
  try {
    const ds = new DecompressionStream(format);
    const stream = new Response(bytes as any).body!.pipeThrough(ds);
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return { bytes: out, algo: isGzip ? 'gzip' : 'zlib' };
  } catch {
    return { bytes, algo: '' };
  }
}

// Tách tên prop PHP: protected/private có dạng <NUL>*<NUL>name hoặc <NUL>Class<NUL>name.
// Dùng fromCharCode(0) để không đưa ký tự null vào mã nguồn.
function cleanPropName(k: string): string {
  const parts = k.split(String.fromCharCode(0));
  return parts.length > 1 ? parts[parts.length - 1] : k;
}

// Parser PHP serialize -> giá trị JS. Hoạt động trên byte (đúng với s:LEN là độ dài BYTE, hỗ trợ UTF-8).
export function phpUnserialize(bytes: Uint8Array): any {
  const td = new TextDecoder();
  let i = 0;

  const readIntUntil = (stop: number): number => {
    const s = i;
    while (i < bytes.length && bytes[i] !== stop) i++;
    const n = parseInt(td.decode(bytes.subarray(s, i)), 10);
    i++; // bỏ ký tự stop
    return n;
  };
  const readNumSemicolon = (): number => {
    const s = i;
    while (i < bytes.length && bytes[i] !== 0x3b /* ; */) i++;
    const n = Number(td.decode(bytes.subarray(s, i)));
    i++; // bỏ ';'
    return n;
  };
  // Đọc phần LEN:"...." — với s: kết thúc bằng '";', với O: kết thúc bằng '":' (đều 2 byte -> bỏ 2 byte).
  const readLenString = (): string => {
    const len = readIntUntil(0x3a /* : */);
    i++; // bỏ '"'
    const start = i;
    i += len; // LEN là số byte
    const str = td.decode(bytes.subarray(start, i));
    i += 2; // bỏ 2 byte kết thúc
    return str;
  };

  function parse(): any {
    const t = bytes[i];
    if (t === 0x4e /* N */) { i += 2; return null; } // N;
    i += 2; // bỏ type + ':'
    switch (t) {
      case 0x62: { const v = bytes[i] === 0x31; i += 2; return v; } // b:V;
      case 0x69: return readNumSemicolon(); // i:V;
      case 0x64: return readNumSemicolon(); // d:V;
      case 0x73: return readLenString(); // s:LEN:"..";
      case 0x61: { // a:N:{...}
        const n = readIntUntil(0x3a);
        i++; // '{'
        const entries: [any, any][] = [];
        for (let k = 0; k < n; k++) {
          const key = parse();
          const val = parse();
          entries.push([key, val]);
        }
        i++; // '}'
        const isList = entries.length > 0 && entries.every(([k], idx) => k === idx);
        if (isList) return entries.map(([, v]) => v);
        const obj: any = {};
        for (const [k, v] of entries) obj[String(k)] = v;
        return obj;
      }
      case 0x4f: { // O:LEN:"CLASS":N:{...}
        const cls = readLenString();
        const n = readIntUntil(0x3a);
        i++; // '{'
        const obj: any = { __class: cls };
        for (let k = 0; k < n; k++) {
          const key = parse();
          const val = parse();
          obj[cleanPropName(String(key))] = val;
        }
        i++; // '}'
        return obj;
      }
      default:
        throw new Error(i18n.t('errors.phpTokenUnsupported', { token: String.fromCharCode(t) }));
    }
  }

  return parse();
}

export interface DecodedRedis {
  ok: boolean;
  format: string;
  text: string;
}

/**
 * View a value can be shown in. `auto` keeps the original behaviour (sniff gzip, then PHP
 * serialize, then JSON); the rest are explicit choices, because the formats that matter most
 * cannot be sniffed reliably — a picked format must therefore be honoured even if the guess
 * would have said otherwise.
 */
export type RedisFormat = 'auto' | 'raw' | 'json' | 'php' | 'hex' | 'ascii' | 'binary';

export const REDIS_FORMATS: RedisFormat[] = ['auto', 'raw', 'json', 'php', 'hex', 'ascii', 'binary'];

const HEX = '0123456789abcdef';

function hex2(b: number): string {
  return HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
}

/** `00000000  68 65 6c 6c 6f …  |hello…|` — 16 bytes per line, offset and ASCII gutter. */
export function toHexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16);
    const hexPart: string[] = [];
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        hexPart.push(hex2(chunk[i]));
        const c = chunk[i];
        ascii += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.';
      } else {
        hexPart.push('  ');
      }
    }
    const offset = off.toString(16).padStart(8, '0');
    lines.push(`${offset}  ${hexPart.join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

/**
 * Inverse of `toHexDump`, and also accepts bare hex (`48 65 6c` or `48656c`) so a value can be
 * pasted from `redis-cli` or a hex editor. This is what allows a **binary** value to be edited
 * and written back byte-exactly instead of being read-only.
 */
export function parseHexDump(text: string): Uint8Array {
  const digits: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    // Drop the ASCII gutter first: it can contain characters that look like hex.
    const bar = line.indexOf('|');
    if (bar >= 0) line = line.slice(0, bar);
    // Drop a leading offset column ("00000010  " / "00000010: ").
    line = line.replace(/^\s*[0-9a-fA-F]{4,8}\s*:?\s{2,}/, '');
    for (const tok of line.trim().split(/\s+/)) {
      if (!tok) continue;
      if (!/^[0-9a-fA-F]+$/.test(tok)) {
        throw new Error(i18n.t('errors.hexInvalidToken', { token: tok.slice(0, 12) }));
      }
      if (tok.length % 2 !== 0) {
        throw new Error(i18n.t('errors.hexOddLength', { token: tok.slice(0, 12) }));
      }
      for (let i = 0; i < tok.length; i += 2) digits.push(tok.slice(i, i + 2));
    }
  }
  const out = new Uint8Array(digits.length);
  for (let i = 0; i < digits.length; i++) out[i] = parseInt(digits[i], 16);
  return out;
}

/** Printable ASCII kept, everything else a dot. */
export function toAsciiView(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  return out;
}

/** `redis-cli`-style: printable kept, other bytes as `\xNN`. */
export function toBinaryView(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b >= 0x20 && b <= 0x7e && b !== 0x5c ? String.fromCharCode(b) : `\\x${hex2(b)}`;
  }
  return out;
}

export async function decodeRedisValue(
  input: number[] | Uint8Array,
  format: RedisFormat = 'auto',
): Promise<DecodedRedis> {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Byte views work on the value exactly as stored — decompressing first would show bytes the
  // key does not contain, which defeats the point of looking at it in hex.
  if (format === 'hex') return { ok: true, format: 'hex', text: toHexDump(raw) };
  if (format === 'ascii') return { ok: true, format: 'ascii', text: toAsciiView(raw) };
  if (format === 'binary') return { ok: true, format: 'binary', text: toBinaryView(raw) };

  const { bytes, algo } = await decompressIfNeeded(raw);
  const prefix = algo ? `${algo} + ` : '';
  // Compressed but not something we recognise inside -> say so, rather than labelling it 'raw'
  // when the bytes on the server are not what is on screen.
  const plainFormat = algo ? `${algo} (text)` : 'raw';
  const text = new TextDecoder().decode(bytes);
  const trimmed = text.replace(/^\s+/, '');

  if (format === 'raw') return { ok: true, format: plainFormat, text };

  // An explicitly picked format reports failure instead of silently falling back to raw: the
  // user asked for that format, so "this is not JSON" is the useful answer.
  if (format === 'json') {
    try {
      return { ok: true, format: prefix + 'json', text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { ok: false, format: prefix + 'json', text };
    }
  }
  if (format === 'php') {
    try {
      return {
        ok: true,
        format: prefix + 'php-serialize',
        text: JSON.stringify(phpUnserialize(bytes), null, 2),
      };
    } catch {
      return { ok: false, format: prefix + 'php-serialize', text };
    }
  }

  if (/^(N;|[abisdO]:)/.test(trimmed)) {
    try {
      const val = phpUnserialize(bytes);
      return { ok: true, format: prefix + 'php-serialize', text: JSON.stringify(val, null, 2) };
    } catch {
      /* rơi xuống raw */
    }
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      const val = JSON.parse(text);
      return { ok: true, format: prefix + 'json', text: JSON.stringify(val, null, 2) };
    } catch {
      /* rơi xuống raw */
    }
  }
  return { ok: true, format: plainFormat, text };
}
