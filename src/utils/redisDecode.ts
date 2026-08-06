// Giải mã value chuỗi của Redis để hiển thị đẹp:
//   1) Nếu gzip (magic 1f 8b) -> giải nén bằng DecompressionStream('gzip') native.
//   2) Nếu là PHP serialize (Laravel cache/model, Neos Flow VariableFrontend) -> unserialize -> JSON.
//   3) Nếu là JSON -> format.
//   4) Còn lại -> text thô.
// Không phụ thuộc thư viện ngoài.

import i18n from '../i18n';

async function gunzipIfNeeded(bytes: Uint8Array): Promise<{ bytes: Uint8Array; gz: boolean }> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Response(bytes as any).body!.pipeThrough(ds);
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return { bytes: out, gz: true };
    } catch {
      return { bytes, gz: false };
    }
  }
  return { bytes, gz: false };
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

export async function decodeRedisValue(input: number[] | Uint8Array): Promise<DecodedRedis> {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { bytes, gz } = await gunzipIfNeeded(raw);
  const prefix = gz ? 'gzip + ' : '';
  const text = new TextDecoder().decode(bytes);
  const trimmed = text.replace(/^\s+/, '');

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
  return { ok: true, format: gz ? 'gzip (text)' : 'raw', text };
}
