import { describe, it, expect } from 'vitest';
import {
  phpUnserialize,
  igbinaryUnserialize,
  looksLikeIgbinary,
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

/**
 * igbinary fixtures are written byte by byte rather than captured from a real key, because the
 * point of each test is one rule of the format (big-endian widths, the shared string table, the
 * reference table) and a captured blob exercises all of them at once while pinning none.
 *
 * The writer's string table is modelled by hand: every `str8`/`obj8` here interns one string, in
 * source order starting at 0, and `strId8`/`objId8` index into that.
 */
const ig = {
  header: [0x00, 0x00, 0x00, 0x02],
  headerV1: [0x00, 0x00, 0x00, 0x01],
  null: [0x00],
  true: [0x05],
  false: [0x04],
  emptyStr: [0x0d],
  long8p: (n: number) => [0x06, n],
  long8n: (n: number) => [0x07, n],
  long16p: (n: number) => [0x08, (n >> 8) & 0xff, n & 0xff],
  long32p: (n: number) => [0x0a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff],
  long64p: (hi: number[], lo: number[]) => [0x20, ...hi, ...lo],
  double: (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, false);
    return [0x0c, ...b];
  },
  str8: (s: string) => {
    const b = [...new TextEncoder().encode(s)];
    return [0x11, b.length, ...b];
  },
  strId8: (id: number) => [0x0e, id],
  arr8: (n: number) => [0x14, n],
  obj8: (cls: string) => {
    const b = [...new TextEncoder().encode(cls)];
    return [0x17, b.length, ...b];
  },
  objId8: (id: number) => [0x1a, id],
  objSer8: (payload: string) => {
    const b = [...new TextEncoder().encode(payload)];
    return [0x1d, b.length, ...b];
  },
  objref8: (id: number) => [0x22, id],
};
const bin = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat());

// PHP prefixes a non-public property name with NUL-wrapped visibility. Built with fromCharCode(0)
// rather than an escape, matching redisDecode.ts: no NUL byte in the source file.
const NUL = String.fromCharCode(0);
const prot = (name: string) => `${NUL}*${NUL}${name}`;
const priv = (cls: string, name: string) => `${NUL}${cls}${NUL}${name}`;

describe('igbinaryUnserialize', () => {
  it('reads the scalar types, big-endian', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.arr8(8),
        ig.str8('nul'), ig.null,
        ig.str8('t'), ig.true,
        ig.str8('f'), ig.false,
        ig.str8('i'), ig.long8p(42),
        ig.str8('neg'), ig.long8n(42),
        ig.str8('wide'), ig.long16p(300),
        ig.str8('wider'), ig.long32p(70000),
        ig.str8('d'), ig.double(1.5),
      ),
    );
    expect(v).toEqual({
      nul: null, t: true, f: false, i: 42, neg: -42, wide: 300, wider: 70000, d: 1.5,
    });
  });

  it('keeps a 64-bit long that a JS number cannot hold exactly as text', () => {
    // 2^62 = 4611686018427387904, well past Number.MAX_SAFE_INTEGER.
    const v = igbinaryUnserialize(
      bin(ig.header, ig.long64p([0x40, 0x00, 0x00, 0x00], [0x00, 0x00, 0x00, 0x00])),
    );
    expect(v).toBe('4611686018427387904');
    // …while one inside the safe range stays a number.
    expect(igbinaryUnserialize(bin(ig.header, ig.long64p([0, 0, 0, 0], [0, 0, 0x01, 0x00])))).toBe(256);
  });

  it('resolves a repeated string through the string table', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.arr8(2),
        ig.str8('a'), ig.str8('dup'), //   'a' -> id 0, 'dup' -> id 1
        ig.str8('b'), ig.strId8(1), //     'b' -> id 2, then reuse 'dup'
      ),
    );
    expect(v).toEqual({ a: 'dup', b: 'dup' });
  });

  it('reads the empty string, a type of its own that is never interned', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.arr8(3),
        ig.str8('a'), ig.emptyStr, //   'a' -> id 0, and the empty value takes no id
        ig.str8('b'), ig.str8('x'), //  'b' -> id 1, 'x' -> id 2
        ig.emptyStr, ig.strId8(2), //   an empty *key*, then id 2 still resolves to 'x'
      ),
    );
    expect(v).toEqual({ a: '', b: 'x', '': 'x' });
  });

  it('interns class names in the same table as data strings', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.arr8(2),
        ig.str8('first'), //                        id 0
        ig.obj8('Node'), ig.arr8(0), //             id 1 = 'Node'
        ig.str8('second'), //                       id 2
        ig.objId8(1), ig.arr8(0), //                class name read back by id
      ),
    );
    expect(v).toEqual({ first: { __class: 'Node' }, second: { __class: 'Node' } });
  });

  it('builds a JS array for sequential integer keys and an object otherwise', () => {
    const list = igbinaryUnserialize(
      bin(
        ig.header, ig.arr8(3),
        ig.long8p(0), ig.str8('x'),
        ig.long8p(1), ig.str8('y'),
        ig.long8p(2), ig.str8('z'),
      ),
    );
    expect(list).toEqual(['x', 'y', 'z']);
    const sparse = igbinaryUnserialize(
      bin(ig.header, ig.arr8(2), ig.long8p(0), ig.str8('x'), ig.long8p(7), ig.str8('y')),
    );
    expect(sparse).toEqual({ 0: 'x', 7: 'y' });
    expect(igbinaryUnserialize(bin(ig.header, ig.arr8(0)))).toEqual({});
  });

  it('strips the NUL-wrapped visibility prefix off property names', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.obj8('Z3\\MOUVEMENT\\Domain\\Model\\Token\\PasswordUrlToken'),
        ig.arr8(2),
        ig.str8(prot('token')), ig.str8('5cd909a5'), //          protected
        ig.str8(priv('Token', 'customerId')), ig.str8('devtest62728'), // private
      ),
    );
    expect(v).toEqual({
      __class: 'Z3\\MOUVEMENT\\Domain\\Model\\Token\\PasswordUrlToken',
      token: '5cd909a5',
      customerId: 'devtest62728',
    });
  });

  it('decodes a DateTimeImmutable the way PHP stores it', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.obj8('DateTimeImmutable'),
        ig.arr8(3),
        ig.str8('date'), ig.str8('2026-08-08 04:41:17.760585'),
        ig.str8('timezone_type'), ig.long8p(3),
        ig.str8('timezone'), ig.str8('Asia/Tokyo'),
      ),
    );
    expect(v).toEqual({
      __class: 'DateTimeImmutable',
      date: '2026-08-08 04:41:17.760585',
      timezone_type: 3,
      timezone: 'Asia/Tokyo',
    });
  });

  it('runs a Serializable payload through the serialize() parser', () => {
    const v = igbinaryUnserialize(
      bin(ig.header, ig.obj8('Ser'), ig.objSer8('a:2:{s:1:"a";i:1;s:1:"b";b:1;}')),
    );
    expect(v).toEqual({ __class: 'Ser', __serialized: { a: 1, b: true } });
  });

  it('keeps a Serializable payload as text when it is neither format', () => {
    const v = igbinaryUnserialize(bin(ig.header, ig.obj8('Ser'), ig.objSer8('not serialized')));
    expect(v).toEqual({ __class: 'Ser', __serialized: 'not serialized' });
  });

  it('resolves an object reference to the same object, cycle included', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.obj8('Node'), ig.arr8(2),
        ig.str8('name'), ig.str8('root'),
        ig.str8('self'), ig.objref8(0),
      ),
    );
    expect(v.name).toBe('root');
    expect(v.self).toBe(v); // the same object, not a copy
  });

  it('numbers reference slots parent-before-child, like the writer does', () => {
    const v = igbinaryUnserialize(
      bin(
        ig.header,
        ig.obj8('Outer'), ig.arr8(2), //                              refs[0] = Outer
        ig.str8('a'), ig.obj8('Inner'), ig.arr8(1), ig.str8('v'), ig.long8p(1), // refs[1] = Inner
        ig.str8('b'), ig.objref8(1),
      ),
    );
    expect(v.a.v).toBe(1);
    expect(v.b).toBe(v.a);
  });

  it('rejects a bad header, an unknown type and a truncated buffer', () => {
    expect(() => igbinaryUnserialize(new TextEncoder().encode('O:4:"User":0:{}'))).toThrow();
    expect(() => igbinaryUnserialize(bin(ig.header))).toThrow(); // header only, no value
    expect(() => igbinaryUnserialize(bin(ig.header, [0x7f]))).toThrow(); // no such type
    expect(() => igbinaryUnserialize(bin(ig.header, [0x11, 0x40, 0x61]))).toThrow(); // len 64, 1 byte
    expect(() => igbinaryUnserialize(bin(ig.header, ig.strId8(9)))).toThrow(); // empty string table
    expect(() => igbinaryUnserialize(bin(ig.header, ig.objref8(9)))).toThrow(); // no such ref
  });

  it('accepts format version 1 as well as 2', () => {
    expect(igbinaryUnserialize(bin(ig.headerV1, ig.str8('hi')))).toBe('hi');
    expect(looksLikeIgbinary(bin(ig.header, ig.true))).toBe(true);
    expect(looksLikeIgbinary(bin(ig.headerV1, ig.true))).toBe(true);
    // Four NULs on their own are not a value, and a v3 header is not something this can read.
    expect(looksLikeIgbinary(new Uint8Array([0, 0, 0, 2]))).toBe(false);
    expect(looksLikeIgbinary(bin([0x00, 0x00, 0x00, 0x03], ig.true))).toBe(false);
  });
});

describe('decodeRedisValue with igbinary', () => {
  const token = bin(
    ig.header,
    ig.obj8('PasswordUrlToken'), ig.arr8(2),
    ig.str8(prot('token')), ig.str8('5cd909a5'),
    ig.str8(prot('createdDate')),
    ig.obj8('DateTimeImmutable'), ig.arr8(1), ig.str8('date'), ig.str8('2026-08-08 04:41:17'),
  );

  it('auto sniffs the header and decodes without being told', async () => {
    const d = await decodeRedisValue(token);
    expect(d.ok).toBe(true);
    expect(d.format).toBe('igbinary');
    expect(JSON.parse(d.text)).toEqual({
      __class: 'PasswordUrlToken',
      token: '5cd909a5',
      createdDate: { __class: 'DateTimeImmutable', date: '2026-08-08 04:41:17' },
    });
  });

  it('honours the explicit format and reports failure on other data', async () => {
    const d = await decodeRedisValue(token, 'igbinary');
    expect(d.ok).toBe(true);
    expect(d.format).toBe('igbinary');
    const bad = await decodeRedisValue(new TextEncoder().encode('i:5;'), 'igbinary');
    expect(bad.ok).toBe(false);
    expect(bad.text).toBe('i:5;');
  });

  it('falls back to raw when the header matches but the body does not parse', async () => {
    const d = await decodeRedisValue(bin(ig.header, [0x7f, 0x7f]));
    expect(d.ok).toBe(true);
    expect(d.format).toBe('raw');
  });

  it('prints a cycle instead of throwing, and a shared sibling in full', async () => {
    const cyclic = bin(
      ig.header, ig.obj8('Node'), ig.arr8(1), ig.str8('self'), ig.objref8(0),
    );
    const d = await decodeRedisValue(cyclic);
    expect(d.ok).toBe(true);
    expect(d.text).toContain('[circular]');

    const shared = bin(
      ig.header, ig.obj8('Outer'), ig.arr8(2),
      ig.str8('a'), ig.obj8('Inner'), ig.arr8(1), ig.str8('v'), ig.long8p(1),
      ig.str8('b'), ig.objref8(1),
    );
    const s = await decodeRedisValue(shared);
    expect(s.text).not.toContain('[circular]');
    expect(JSON.parse(s.text)).toEqual({
      __class: 'Outer',
      a: { __class: 'Inner', v: 1 },
      b: { __class: 'Inner', v: 1 },
    });
  });

  it('decompresses first, so a compressed igbinary value still decodes', async () => {
    const cs = new CompressionStream('deflate');
    const stream = new Response(token as any).body!.pipeThrough(cs);
    const z = new Uint8Array(await new Response(stream).arrayBuffer());
    const d = await decodeRedisValue(z);
    expect(d.format).toBe('zlib + igbinary');
    expect(JSON.parse(d.text).token).toBe('5cd909a5');
  });

  it('byte views still show the stored bytes, not the decoded object', async () => {
    const d = await decodeRedisValue(token, 'hex');
    expect(parseHexDump(d.text)).toEqual(token);
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
