// Decoding a Redis string value for readable display:
//   1) gzip (magic 1f 8b) or zlib (PHP gzcompress) -> decompressed with the native DecompressionStream.
//   2) PHP serialize (Laravel cache/model, Neos Flow VariableFrontend) -> unserialized -> JSON.
//   3) igbinary (magic 00 00 00 02) -> unserialized -> JSON.
//   4) JSON -> formatted.
//   5) Anything else -> raw text.
// No external library involved.

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

// Splitting a PHP property name: protected/private ones look like <NUL>*<NUL>name or
// <NUL>Class<NUL>name. fromCharCode(0) is used so no null character goes into the source.
function cleanPropName(k: string): string {
  const parts = k.split(String.fromCharCode(0));
  return parts.length > 1 ? parts[parts.length - 1] : k;
}

/**
 * A PHP array is one type covering both a list and a map, so the shape has to be decided from the
 * keys: sequential `0..n-1` becomes a JS array, anything else an object. Shared by both parsers so
 * the same input produces the same JSON whether it arrived as `serialize()` or as igbinary.
 */
function arrayFromEntries(entries: [unknown, unknown][]): any {
  const isList = entries.length > 0 && entries.every(([k], idx) => k === idx);
  if (isList) return entries.map(([, v]) => v);
  const obj: any = {};
  for (const [k, v] of entries) obj[String(k)] = v;
  return obj;
}

// A PHP serialize parser -> JS values. It works on bytes (matching s:LEN, which is a BYTE length, and so handles UTF-8).
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
  // Reads the LEN:"…" part — for s: it ends with '";', for O: with '":' (both 2 bytes -> skip 2).
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
        return arrayFromEntries(entries);
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

/**
 * igbinary — the binary serializer PHP's `igbinary` extension provides, and what Neos Flow's
 * `VariableFrontend` writes into Redis when the extension is loaded (`serialize()` otherwise, which
 * `phpUnserialize` above already reads).
 *
 * Two properties of the format make it impossible to read by scanning the bytes for text, which is
 * worth stating because that is the tempting shortcut:
 *
 *  - **Every string is interned.** A name appears once, and every later use is a `string_id` holding
 *    an index into a table built in order of first appearance — class names included, since the
 *    serializer registers them in that same table. Reading is therefore strictly sequential: skip a
 *    type and every id after it resolves to the wrong string.
 *  - **Lengths are byte counts, big-endian**, and the payload may contain NUL bytes (PHP writes a
 *    private property as `\0Class\0prop` and a protected one as `\0*\0prop`), so no scan can tell a
 *    length byte from data.
 *
 * Type bytes are `enum igbinary_type` in igbinary's `igbinary.h`. Format version 1 and 2 share the
 * enum, so both headers are accepted.
 *
 * Deliberately strict: an unknown type, a truncated buffer or an out-of-range id throws rather than
 * returning a partial object, because callers fall back to showing the raw bytes and a half-decoded
 * object that *looks* complete is worse than an obvious failure.
 */
export function igbinaryUnserialize(bytes: Uint8Array): any {
  const td = new TextDecoder();
  let i = 0;

  /** Interned strings, in order of first appearance. Class names share this table with data. */
  const strings: string[] = [];
  /**
   * Containers in creation order — the targets of `ref*`/`objref*`. Objects are registered before
   * their properties are read, so a cycle through an object graph (a Doctrine parent ↔ child) comes
   * out as a real cycle; arrays are registered as a placeholder and filled in afterwards, since the
   * list-vs-map shape is only known once the keys are read. A slot therefore keeps its index — the
   * writer numbers parents before children and the reader must agree — but an array that contains
   * *itself* resolves to null. That needs a PHP `&` reference to an array to happen at all, and no
   * cache payload does it.
   */
  const refs: any[] = [];

  const need = (n: number): void => {
    if (i + n > bytes.length) throw new Error(i18n.t('errors.igbinaryTruncated', { n: i }));
  };
  const u8 = (): number => {
    need(1);
    return bytes[i++];
  };
  /** Big-endian unsigned, 1/2/4 bytes — every length, id and count in the format. */
  const uint = (width: number): number => {
    need(width);
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + bytes[i++];
    return v;
  };
  /** 64-bit longs go through BigInt: a PHP int can exceed what a JS number holds exactly. */
  const long64 = (negative: boolean): number | string => {
    need(8);
    let v = 0n;
    for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(bytes[i++]);
    if (negative) v = -v;
    // A value outside the safe range is kept as text: rounding it would silently corrupt an id,
    // and JSON.stringify cannot serialize a BigInt at all.
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  };
  const double = (): number => {
    need(8);
    const dv = new DataView(bytes.buffer, bytes.byteOffset + i, 8);
    i += 8;
    return dv.getFloat64(0, false); // big-endian, like every other multi-byte field
  };
  /** An inline string: read it *and* intern it, exactly as the serializer did. */
  const inlineString = (width: number): string => {
    const len = uint(width);
    need(len);
    const s = td.decode(bytes.subarray(i, i + len));
    i += len;
    strings.push(s);
    return s;
  };
  const internedString = (width: number): string => {
    const id = uint(width);
    if (id >= strings.length) throw new Error(i18n.t('errors.igbinaryStringId', { n: id }));
    return strings[id];
  };
  const deref = (width: number): any => {
    const id = uint(width);
    if (id >= refs.length) throw new Error(i18n.t('errors.igbinaryRefId', { n: id }));
    return refs[id];
  };
  const unsupported = (t: number, at: number): never => {
    throw new Error(i18n.t('errors.igbinaryUnsupportedType', { token: hex2(t), n: at }));
  };

  /** An array/property key is a long or a string — never a container. */
  const readKey = (): string | number => {
    const at = i;
    const t = u8();
    switch (t) {
      case 0x06: return uint(1);
      case 0x07: return -uint(1);
      case 0x08: return uint(2);
      case 0x09: return -uint(2);
      case 0x0a: return uint(4);
      case 0x0b: return -uint(4);
      case 0x20: return Number(long64(false));
      case 0x21: return Number(long64(true));
      case 0x0d: return '';
      case 0x0e: return internedString(1);
      case 0x0f: return internedString(2);
      case 0x10: return internedString(4);
      case 0x11: return inlineString(1);
      case 0x12: return inlineString(2);
      case 0x13: return inlineString(4);
      default: return unsupported(t, at);
    }
  };

  const readArray = (width: number): any => {
    const slot = refs.length;
    refs.push(null);
    const n = uint(width);
    const entries: [string | number, any][] = [];
    for (let k = 0; k < n; k++) {
      const key = readKey();
      entries.push([key, readValue()]);
    }
    const built = arrayFromEntries(entries);
    refs[slot] = built;
    return built;
  };

  /**
   * The class name is already consumed by the caller (inline for `object*`, interned for
   * `object_id*`); what follows is either the property array or a `Serializable`/`__serialize`
   * payload, which igbinary hands to PHP's own `unserialize` handler and is therefore in
   * `serialize()` format.
   */
  const readObject = (cls: string): any => {
    const obj: Record<string, any> = { __class: cls };
    refs.push(obj);
    const at = i;
    const t = u8();
    if (t === 0x1d || t === 0x1e || t === 0x1f) {
      const len = uint(t === 0x1d ? 1 : t === 0x1e ? 2 : 4);
      need(len);
      const payload = bytes.subarray(i, i + len);
      i += len;
      obj.__serialized = decodeSerializedPayload(payload);
      return obj;
    }
    if (t !== 0x14 && t !== 0x15 && t !== 0x16) unsupported(t, at);
    const n = uint(t === 0x14 ? 1 : t === 0x15 ? 2 : 4);
    for (let k = 0; k < n; k++) {
      const key = cleanPropName(String(readKey()));
      obj[key] = readValue();
    }
    return obj;
  };

  function readValue(): any {
    const at = i;
    const t = u8();
    switch (t) {
      case 0x00: return null;
      case 0x04: return false;
      case 0x05: return true;
      case 0x06: return uint(1);
      case 0x07: return -uint(1);
      case 0x08: return uint(2);
      case 0x09: return -uint(2);
      case 0x0a: return uint(4);
      case 0x0b: return -uint(4);
      case 0x20: return long64(false);
      case 0x21: return long64(true);
      case 0x0c: return double();
      case 0x0d: return '';
      case 0x0e: return internedString(1);
      case 0x0f: return internedString(2);
      case 0x10: return internedString(4);
      case 0x11: return inlineString(1);
      case 0x12: return inlineString(2);
      case 0x13: return inlineString(4);
      case 0x14: return readArray(1);
      case 0x15: return readArray(2);
      case 0x16: return readArray(4);
      case 0x17: return readObject(inlineString(1));
      case 0x18: return readObject(inlineString(2));
      case 0x19: return readObject(inlineString(4));
      case 0x1a: return readObject(internedString(1));
      case 0x1b: return readObject(internedString(2));
      case 0x1c: return readObject(internedString(4));
      case 0x01: return deref(1);
      case 0x02: return deref(2);
      case 0x03: return deref(4);
      case 0x22: return deref(1);
      case 0x23: return deref(2);
      case 0x24: return deref(4);
      // "Simple reference" — a marker saying the value that follows was a PHP `&`. JSON has no
      // such thing, so the value itself is the whole answer.
      case 0x25: return readValue();
      default: return unsupported(t, at);
    }
  }

  if (!looksLikeIgbinary(bytes)) {
    const head = Array.from(bytes.subarray(0, 4), hex2).join(' ');
    throw new Error(i18n.t('errors.igbinaryBadHeader', { token: head }));
  }
  i = 4;
  return readValue();
}

/**
 * A `Serializable::serialize()` payload is normally a `serialize()` string, but a class is free to
 * return anything from it (Flow proxies have been seen returning igbinary again). Tried in that
 * order, with the text as the last resort so the bytes are never dropped — this is one property of
 * one object, and failing it must not fail the whole value.
 */
function decodeSerializedPayload(payload: Uint8Array): any {
  try {
    return phpUnserialize(payload);
  } catch {
    /* not serialize() format */
  }
  try {
    return igbinaryUnserialize(payload);
  } catch {
    /* not igbinary either */
  }
  return new TextDecoder().decode(payload);
}

/**
 * Header is a big-endian format version, 1 or 2. Requires a byte after it as well: four bytes on
 * their own carry no value, and `00 00 00 02` is also just four NULs, which a non-igbinary binary
 * value can plausibly start with.
 */
export function looksLikeIgbinary(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x00 &&
    (bytes[3] === 0x01 || bytes[3] === 0x02)
  );
}

/**
 * `JSON.stringify` with cycles rendered as `"[circular]"` instead of throwing — igbinary can
 * express an object graph that refers back to itself, and the point of the viewer is to show what
 * the key holds. The ancestor stack is tracked through the replacer's `this` (the holder), so an
 * object that merely appears twice as a *sibling* still prints in full; only a real cycle is cut.
 */
function stringifyDecoded(value: unknown): string {
  const stack: unknown[] = [];
  return JSON.stringify(
    value,
    function (this: unknown, _key: string, val: unknown) {
      while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
      if (val !== null && typeof val === 'object') {
        if (stack.includes(val)) return '[circular]';
        stack.push(val);
      }
      return val;
    },
    2,
  );
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
export type RedisFormat = 'auto' | 'raw' | 'json' | 'php' | 'igbinary' | 'hex' | 'ascii' | 'binary';

export const REDIS_FORMATS: RedisFormat[] = [
  'auto', 'raw', 'json', 'php', 'igbinary', 'hex', 'ascii', 'binary',
];

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
  if (format === 'igbinary') {
    try {
      return {
        ok: true,
        format: prefix + 'igbinary',
        text: stringifyDecoded(igbinaryUnserialize(bytes)),
      };
    } catch {
      return { ok: false, format: prefix + 'igbinary', text };
    }
  }

  // Sniffed before the text formats: the header is four NUL bytes, so the decoded `text` is empty
  // up to the first real byte and none of the regexes below could ever match it.
  if (looksLikeIgbinary(bytes)) {
    try {
      return {
        ok: true,
        format: prefix + 'igbinary',
        text: stringifyDecoded(igbinaryUnserialize(bytes)),
      };
    } catch {
      /* falls through to raw */
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
