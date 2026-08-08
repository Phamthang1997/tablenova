import { describe, it, expect } from 'vitest';
import {
  phpUnserialize,
  decodeRedisValue,
  toHexDump,
  parseHexDump,
  toAsciiView,
  toBinaryView,
} from '../redisDecode';

describe('byte views', () => {
  const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff]);

  it('hex dump has an offset column, 16 bytes per line and an ASCII gutter', () => {
    const dump = toHexDump(bytes);
    expect(dump).toBe('00000000  68 65 6c 6c 6f 00 ff                             |hello..|');
    const long = toHexDump(new Uint8Array(20));
    expect(long.split('\n')).toHaveLength(2);
    expect(long.split('\n')[1].startsWith('00000010')).toBe(true);
  });

  it('parseHexDump round-trips its own output byte for byte', () => {
    expect(parseHexDump(toHexDump(bytes))).toEqual(bytes);
    const big = new Uint8Array(300).map((_, i) => i % 256);
    expect(parseHexDump(toHexDump(big))).toEqual(big);
  });

  it('accepts bare hex pasted from redis-cli or an editor', () => {
    expect(parseHexDump('48 65 6c')).toEqual(new Uint8Array([0x48, 0x65, 0x6c]));
    expect(parseHexDump('48656c')).toEqual(new Uint8Array([0x48, 0x65, 0x6c]));
    expect(parseHexDump('  48\n65  \n')).toEqual(new Uint8Array([0x48, 0x65]));
    expect(parseHexDump('')).toEqual(new Uint8Array([]));
  });

  it('does not read the ASCII gutter as hex', () => {
    // "|dead|" is valid hex if the gutter is not stripped first.
    const line = '00000000  61 62                                             |dead|';
    expect(parseHexDump(line)).toEqual(new Uint8Array([0x61, 0x62]));
  });

  it('rejects invalid or odd-length hex instead of writing wrong bytes', () => {
    expect(() => parseHexDump('zz')).toThrow();
    expect(() => parseHexDump('4 8')).toThrow();
  });

  it('ascii and binary views mark non-printable bytes differently', () => {
    expect(toAsciiView(bytes)).toBe('hello..');
    expect(toBinaryView(bytes)).toBe('hello\\x00\\xff');
    // a backslash in the data must not read as an escape
    expect(toBinaryView(new Uint8Array([0x5c]))).toBe('\\x5c');
  });
});

describe('decodeRedisValue format override', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('byte views show the value as stored', async () => {
    const d = await decodeRedisValue(enc('hi'), 'hex');
    expect(d.format).toBe('hex');
    expect(d.text.startsWith('00000000  68 69')).toBe(true);
    expect((await decodeRedisValue(enc('hi'), 'ascii')).text).toBe('hi');
    expect((await decodeRedisValue(enc('hi'), 'binary')).text).toBe('hi');
  });

  it('raw keeps the text untouched even when it looks like JSON', async () => {
    const d = await decodeRedisValue(enc('{"a":1}'), 'raw');
    expect(d.format).toBe('raw');
    expect(d.text).toBe('{"a":1}');
  });

  it('an explicit format reports failure instead of silently falling back', async () => {
    const bad = await decodeRedisValue(enc('not json'), 'json');
    expect(bad.ok).toBe(false);
    expect(bad.text).toBe('not json');
    const good = await decodeRedisValue(enc('{"a":1}'), 'json');
    expect(good.ok).toBe(true);
    expect(good.text).toContain('"a": 1');
  });

  it('auto still sniffs php-serialize and json', async () => {
    expect((await decodeRedisValue(enc('i:5;'))).format).toBe('php-serialize');
    expect((await decodeRedisValue(enc('[1,2]'))).format).toBe('json');
    expect((await decodeRedisValue(enc('plain'))).format).toBe('raw');
  });
});

describe('decompression', () => {
  /**
   * Fixtures are built with `CompressionStream`, the counterpart of the API the decoder uses —
   * no `node:zlib`, so the test needs no Node types and exercises the same code path a WebView
   * would. `deflate` is the zlib-wrapped variant, i.e. what PHP's `gzcompress` writes.
   */
  const compress = async (text: string, format: 'gzip' | 'deflate'): Promise<Uint8Array> => {
    const cs = new CompressionStream(format);
    const stream = new Response(new TextEncoder().encode(text) as any).body!.pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  it('decompresses zlib (PHP gzcompress) and still sniffs the payload inside', async () => {
    const z = await compress('a:1:{s:3:"key";s:5:"value";}', 'deflate');
    const d = await decodeRedisValue(z);
    expect(d.format).toBe('zlib + php-serialize');
    expect(JSON.parse(d.text)).toEqual({ key: 'value' });
  });

  it('decompresses gzip', async () => {
    const g = await compress('{"a":1}', 'gzip');
    const d = await decodeRedisValue(g);
    expect(d.format).toBe('gzip + json');
    expect(JSON.parse(d.text)).toEqual({ a: 1 });
  });

  it('labels a compressed value with no recognised payload by its algorithm', async () => {
    const z = await compress('just text', 'deflate');
    expect((await decodeRedisValue(z)).format).toBe('zlib (text)');
  });

  it('byte views show the stored (still compressed) bytes', async () => {
    const z = await compress('hello', 'deflate');
    const d = await decodeRedisValue(z, 'hex');
    expect(parseHexDump(d.text)).toEqual(z);
  });

  it('a value that only looks like a zlib header is still displayable', async () => {
    // 78 9c is the usual zlib header and passes the %31 check, but this is not a valid stream.
    const fake = new Uint8Array([0x78, 0x9c, 0x00, 0x01]);
    const d = await decodeRedisValue(fake);
    expect(d.ok).toBe(true);
    expect(d.format).toBe('raw');
  });
});

describe('redisDecode', () => {
  describe('phpUnserialize', () => {
    it('should unserialize null (N;)', () => {
      const bytes = new TextEncoder().encode('N;');
      expect(phpUnserialize(bytes)).toBeNull();
    });

    it('should unserialize boolean (b:1; / b:0;)', () => {
      const bTrue = new TextEncoder().encode('b:1;');
      const bFalse = new TextEncoder().encode('b:0;');
      expect(phpUnserialize(bTrue)).toBe(true);
      expect(phpUnserialize(bFalse)).toBe(false);
    });

    it('should unserialize integer (i:123;)', () => {
      const bytes = new TextEncoder().encode('i:123;');
      expect(phpUnserialize(bytes)).toBe(123);
    });

    it('should unserialize float (d:45.67;)', () => {
      const bytes = new TextEncoder().encode('d:45.67;');
      expect(phpUnserialize(bytes)).toBe(45.67);
    });

    it('should unserialize string (s:5:"hello";)', () => {
      const bytes = new TextEncoder().encode('s:5:"hello";');
      expect(phpUnserialize(bytes)).toBe('hello');
    });

    it('should unserialize indexed array (a:2:{i:0;s:3:"foo";i:1;s:3:"bar";})', () => {
      const bytes = new TextEncoder().encode('a:2:{i:0;s:3:"foo";i:1;s:3:"bar";}');
      expect(phpUnserialize(bytes)).toEqual(['foo', 'bar']);
    });

    it('should unserialize associative array', () => {
      const bytes = new TextEncoder().encode('a:2:{s:3:"key";s:5:"value";s:4:"page";i:1;}');
      expect(phpUnserialize(bytes)).toEqual({ key: 'value', page: 1 });
    });

    it('should unserialize serialized object', () => {
      const bytes = new TextEncoder().encode('O:4:"User":1:{s:4:"name";s:4:"John";}');
      expect(phpUnserialize(bytes)).toEqual({ __class: 'User', name: 'John' });
    });
  });

  describe('decodeRedisValue', () => {
    it('should decode JSON strings', async () => {
      const input = new TextEncoder().encode('{"name":"Alice","age":30}');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('json');
      expect(JSON.parse(result.text)).toEqual({ name: 'Alice', age: 30 });
    });

    it('should decode PHP serialized strings', async () => {
      const input = new TextEncoder().encode('a:1:{s:4:"role";s:5:"admin";}');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('php-serialize');
      expect(JSON.parse(result.text)).toEqual({ role: 'admin' });
    });

    it('should fallback to raw text for plain text', async () => {
      const input = new TextEncoder().encode('plain text value');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('raw');
      expect(result.text).toBe('plain text value');
    });
  });
});
