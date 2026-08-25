import { describe, it, expect } from 'vitest';
import {
  applyRedisImport,
  buildRedisExport,
  countByType,
  isValidEntry,
  parseRedisExport,
  patternToPrefix,
  prefixPattern,
  suggestExportFileName,
  type RedisDumpEntry,
  type RedisExportReader,
  type RedisImportWriter,
} from '../redisTransfer';

// Reader giả: một keyspace in RAM. Chính vì `buildRedisExport` receive reader qua tham số mà
// định dạng tệp and vòng lặp phân lô kiểm is at đây, not cần Redis thật.
function fakeReader(
  keyspace: { key: string; type: string }[],
  opts: { pageSize?: number; vanish?: Set<string> } = {},
): RedisExportReader & { dumpCalls: number; scanCalls: number } {
  const pageSize = opts.pageSize ?? 2;
  const vanish = opts.vanish ?? new Set<string>();
  const state = {
    dumpCalls: 0,
    scanCalls: 0,
    async scan(_pattern: string, cursor: number, _count: number) {
      state.scanCalls += 1;
      const page = keyspace.slice(cursor, cursor + pageSize);
      const next = cursor + pageSize >= keyspace.length ? 0 : cursor + pageSize;
      return { success: true, cursor: next, keys: page };
    },
    async dump(keys: string[]) {
      state.dumpCalls += 1;
      const entries: RedisDumpEntry[] = [];
      const missing: string[] = [];
      for (const k of keys) {
        if (vanish.has(k)) { missing.push(k); continue; }
        const t = keyspace.find((x) => x.key === k)?.type ?? 'string';
        // Payload not cần is DUMP thật, chỉ cần is base64 valid.
        entries.push({ key: k, type: t, ttlMs: -1, payload: btoa(`v:${k}`) });
      }
      return { success: true, entries, missing };
    },
  };
  return state;
}

const AT = '2026-08-20T10:00:00.000Z';

const spec = (over: Partial<Parameters<typeof buildRedisExport>[0]> = {}) => ({
  pattern: 'user:*',
  db: 0,
  createdAt: AT,
  ...over,
});

describe('prefixPattern', () => {
  it('leaves an ordinary prefix alone', () => {
    expect(prefixPattern('user:')).toBe('user:*');
  });

  // not escape thì `log[1]:` khớp key bắt đầu bằng `log1:` — xuất sai tập key mà not báo gì.
  it('escapes glob metacharacters so a prefix means itself', () => {
    expect(prefixPattern('log[1]:')).toBe('log\\[1\\]:*');
    expect(prefixPattern('a*b')).toBe('a\\*b*');
    expect(prefixPattern('q?')).toBe('q\\?*');
    expect(prefixPattern('c\\d')).toBe('c\\\\d*');
  });

  it('an empty prefix means the whole db', () => {
    expect(prefixPattern('')).toBe('*');
    expect(prefixPattern('   ')).toBe('*');
  });
});

describe('buildRedisExport', () => {
  it('writes a header, one line per key and a footer with the count', async () => {
    const reader = fakeReader([
      { key: 'user:1', type: 'string' },
      { key: 'user:2', type: 'hash' },
      { key: 'user:3', type: 'zset' },
    ]);
    const res = await buildRedisExport(spec(), reader);

    const lines = res.text.trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({
      tablenova: 'redis-keys',
      version: 1,
      createdAt: AT,
      db: 0,
      pattern: 'user:*',
    });
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[4])).toEqual({ tablenova: 'redis-keys-end', keys: 3 });
    expect(res.keys).toBe(3);
    expect(res.capped).toBe(false);
    expect(res.stopped).toBe(false);
  });

  it('round-trips through parseRedisExport', async () => {
    const reader = fakeReader([
      { key: 'user:1', type: 'string' },
      { key: 'user:2', type: 'hash' },
    ]);
    const res = await buildRedisExport(spec(), reader);
    const parsed = parseRedisExport(res.text);

    expect(parsed.header?.pattern).toBe('user:*');
    expect(parsed.truncated).toBe(false);
    expect(parsed.declaredKeys).toBe(2);
    expect(parsed.badLines).toEqual([]);
    expect(parsed.entries.map((e) => e.key)).toEqual(['user:1', 'user:2']);
    expect(parsed.entries[1].type).toBe('hash');
  });

  it('drops keys the type filter excludes and counts them', async () => {
    const reader = fakeReader([
      { key: 'user:1', type: 'string' },
      { key: 'user:2', type: 'hash' },
      { key: 'user:3', type: 'string' },
    ]);
    const res = await buildRedisExport(spec({ typeFilter: 'string' }), reader);

    expect(res.keys).toBe(2);
    expect(res.filtered).toBe(1);
    expect(parseRedisExport(res.text).entries.map((e) => e.key)).toEqual(['user:1', 'user:3']);
  });

  // Một key hết hạn giữa SCAN and DUMP is chuyện thường, not must error — nhưng must đếm is,
  // vì nó is chênh lệch giữa "already quét" and "already write".
  it('reports keys that vanished between SCAN and DUMP', async () => {
    const reader = fakeReader(
      [
        { key: 'user:1', type: 'string' },
        { key: 'user:2', type: 'string' },
      ],
      { vanish: new Set(['user:2']) },
    );
    const res = await buildRedisExport(spec(), reader);

    expect(res.keys).toBe(1);
    expect(res.missing).toEqual(['user:2']);
    expect(JSON.parse(res.text.trim().split('\n').at(-1)!)).toEqual({
      tablenova: 'redis-keys-end',
      keys: 1,
    });
  });

  // Chạm trần and is stop đều nghĩa is tệp not đầy đủ, nên nó cố ý not có footer: lúc nhập
  // lại, thiếu footer is dấu hiệu unique for biết điều đó.
  it('stops at maxKeys and writes no footer', async () => {
    const reader = fakeReader(
      Array.from({ length: 10 }, (_, i) => ({ key: `k:${i}`, type: 'string' })),
    );
    const res = await buildRedisExport(spec({ maxKeys: 3 }), reader);

    expect(res.capped).toBe(true);
    expect(res.keys).toBeLessThanOrEqual(3);
    expect(res.text).not.toContain('redis-keys-end');
    expect(parseRedisExport(res.text).truncated).toBe(true);
  });

  it('honours shouldStop and writes no footer', async () => {
    const reader = fakeReader(
      Array.from({ length: 10 }, (_, i) => ({ key: `k:${i}`, type: 'string' })),
    );
    let seen = 0;
    const res = await buildRedisExport(
      spec({ shouldStop: () => (seen += 1) > 2 }),
      reader,
    );

    expect(res.stopped).toBe(true);
    expect(res.text).not.toContain('redis-keys-end');
  });

  it('batches DUMP instead of one round trip per key', async () => {
    const reader = fakeReader(
      Array.from({ length: 6 }, (_, i) => ({ key: `k:${i}`, type: 'string' })),
      { pageSize: 6 },
    );
    const res = await buildRedisExport(spec(), reader);

    expect(res.keys).toBe(6);
    // 6 key < DUMP_BATCH -> đúng một lượt DUMP (lượt flush cuối), not must sáu.
    expect(reader.dumpCalls).toBe(1);
  });

  it('reports progress for both phases', async () => {
    const reader = fakeReader([
      { key: 'a', type: 'string' },
      { key: 'b', type: 'string' },
    ]);
    const phases: string[] = [];
    await buildRedisExport(spec({ onProgress: (p) => phases.push(p.phase) }), reader);

    expect(phases).toContain('scan');
    expect(phases).toContain('dump');
  });

  it('surfaces a failed SCAN as an error rather than an empty file', async () => {
    const reader = fakeReader([]);
    reader.scan = async () => ({ success: false, cursor: 0, keys: [], error: 'boom' });
    await expect(buildRedisExport(spec(), reader)).rejects.toThrow('boom');
  });

  it('writes just a header when nothing matches', async () => {
    const res = await buildRedisExport(spec(), fakeReader([]));
    expect(res.keys).toBe(0);
    expect(parseRedisExport(res.text).entries).toEqual([]);
  });
});

describe('isValidEntry', () => {
  const ok: RedisDumpEntry = { key: 'k', type: 'string', ttlMs: -1, payload: 'YWJj' };

  it('accepts a well-formed entry', () => {
    expect(isValidEntry(ok)).toBe(true);
  });

  it('rejects a missing key or payload', () => {
    expect(isValidEntry({ ...ok, key: '' })).toBe(false);
    expect(isValidEntry({ ...ok, payload: '' })).toBe(false);
    expect(isValidEntry({ key: 'k' })).toBe(false);
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry('YWJj')).toBe(false);
  });

  // Payload rác is bắt at đây chứ not to RESTORE returns một error driver khó hiểu.
  it('rejects a payload that is not standard base64', () => {
    expect(isValidEntry({ ...ok, payload: 'YWJ' })).toBe(false);
    expect(isValidEntry({ ...ok, payload: 'not base64!' })).toBe(false);
    expect(isValidEntry({ ...ok, payload: 'YW-j' })).toBe(false);
  });

  it('rejects a non-numeric ttl', () => {
    expect(isValidEntry({ ...ok, ttlMs: '5' })).toBe(false);
  });
});

describe('parseRedisExport', () => {
  const header = JSON.stringify({
    tablenova: 'redis-keys', version: 1, createdAt: AT, db: 2, pattern: 'a*',
  });
  const entry = (k: string) => JSON.stringify({ key: k, type: 'string', ttlMs: -1, payload: 'YWJj' });

  // Một tệp 100.000 key not is vô hiệu vì row thứ 4 is error.
  it('keeps the good lines and numbers the bad ones', () => {
    const text = [header, entry('a'), '{oops', entry('b'), '{"key":"c"}'].join('\n');
    const parsed = parseRedisExport(text);

    expect(parsed.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(parsed.badLines).toEqual([3, 5]);
  });

  it('ignores blank lines', () => {
    const parsed = parseRedisExport(`${header}\n\n${entry('a')}\n\n`);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.badLines).toEqual([]);
  });

  it('flags a file with no footer as truncated', () => {
    expect(parseRedisExport(`${header}\n${entry('a')}\n`).truncated).toBe(true);
  });

  it('reads the declared count from the footer', () => {
    const text = [header, entry('a'), JSON.stringify({ tablenova: 'redis-keys-end', keys: 9 })].join('\n');
    const parsed = parseRedisExport(text);
    expect(parsed.truncated).toBe(false);
    expect(parsed.declaredKeys).toBe(9);
    // Khai báo 9 nhưng read-only is 1 — người gọi so hai số này to biết tệp is cắt.
    expect(parsed.entries).toHaveLength(1);
  });

  it('has no header when the file is not one of ours', () => {
    const parsed = parseRedisExport('{"hello":1}\n');
    expect(parsed.header).toBeNull();
    expect(parsed.badLines).toEqual([1]);
  });

  it('reads the header fields', () => {
    expect(parseRedisExport(header).header).toEqual({
      tablenova: 'redis-keys', version: 1, createdAt: AT, db: 2, pattern: 'a*',
    });
  });
});

describe('applyRedisImport', () => {
  const entries: RedisDumpEntry[] = [
    { key: 'a', type: 'string', ttlMs: -1, payload: 'YWJj' },
    { key: 'b', type: 'hash', ttlMs: 5000, payload: 'YWJj' },
    { key: 'c', type: 'string', ttlMs: -1, payload: 'YWJj' },
  ];

  function fakeWriter(over: Partial<RedisImportWriter> = {}) {
    const calls: { n: number; replace: boolean }[] = [];
    const writer: RedisImportWriter & { calls: typeof calls } = {
      calls,
      async restore(batch, replace) {
        calls.push({ n: batch.length, replace });
        return { success: true, restored: batch.length, skipped: 0, failed: [] };
      },
      ...over,
    };
    return writer;
  }

  it('restores everything and passes the replace flag through', async () => {
    const w = fakeWriter();
    const res = await applyRedisImport(entries, w, { replace: true });

    expect(res.restored).toBe(3);
    expect(res.failed).toEqual([]);
    expect(w.calls).toEqual([{ n: 3, replace: true }]);
  });

  it('filters by type before restoring', async () => {
    const w = fakeWriter();
    const res = await applyRedisImport(entries, w, { replace: false, types: ['string'] });

    expect(res.restored).toBe(2);
    expect(w.calls[0].n).toBe(2);
  });

  // Key already tồn tại mà not select write đè is "skip", not must error — gộp hai thứ lại thì một
  // lần nhập hoàn toàn bình thường hiện lên như row nghìn error.
  it('keeps skipped and failed apart', async () => {
    const w = fakeWriter({
      restore: async () => ({
        success: true,
        restored: 1,
        skipped: 1,
        failed: [{ key: 'c', error: 'DUMP payload version or checksum are wrong' }],
      }),
    });
    const res = await applyRedisImport(entries, w, { replace: false });

    expect(res.restored).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.failed).toEqual([{ key: 'c', error: 'DUMP payload version or checksum are wrong' }]);
  });

  it('throws when the command itself fails', async () => {
    const w = fakeWriter({
      restore: async () => ({ success: false, restored: 0, skipped: 0, failed: [], error: 'read-only' }),
    });
    await expect(applyRedisImport(entries, w, { replace: false })).rejects.toThrow('read-only');
  });

  it('stops between batches when asked', async () => {
    const w = fakeWriter();
    const res = await applyRedisImport(entries, w, { replace: false, shouldStop: () => true });

    expect(res.stopped).toBe(true);
    expect(res.restored).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('reports progress against a known total', async () => {
    const seen: number[] = [];
    await applyRedisImport(entries, fakeWriter(), {
      replace: false,
      onProgress: (p) => { seen.push(p.total ?? -1); },
    });
    expect(seen).toEqual([3]);
  });
});

describe('countByType', () => {
  it('counts by type, biggest first', () => {
    expect(countByType([
      { key: 'a', type: 'string', ttlMs: -1, payload: 'YWJj' },
      { key: 'b', type: 'hash', ttlMs: -1, payload: 'YWJj' },
      { key: 'c', type: 'string', ttlMs: -1, payload: 'YWJj' },
    ])).toEqual([{ type: 'string', n: 2 }, { type: 'hash', n: 1 }]);
  });

  it('labels a missing type rather than dropping the entry', () => {
    expect(countByType([{ key: 'a', type: '', ttlMs: -1, payload: 'YWJj' }]))
      .toEqual([{ type: '?', n: 1 }]);
  });
});

describe('suggestExportFileName', () => {
  // `:` có in gần như mọi prefix Redis and not valid in tên tệp Windows.
  it('strips characters a Windows path cannot hold', () => {
    const name = suggestExportFileName(3, 'user:session:', AT);
    expect(name).toBe('redis-db3-user_session-2026-08-20_10-00-00.ndjson');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('says "all" when there is no prefix', () => {
    expect(suggestExportFileName(0, '', AT)).toContain('redis-db0-all-');
  });
});

describe('patternToPrefix', () => {
  it('drops the trailing star of a plain pattern', () => {
    expect(patternToPrefix('user:*')).toBe('user:');
    expect(patternToPrefix('user:1')).toBe('user:1');
  });

  it('has nothing to prefill for the match-everything pattern', () => {
    expect(patternToPrefix('*')).toBe('');
    expect(patternToPrefix('')).toBe('');
  });

  // Đoán at đây rồi to `prefixPattern` escape lần hai is ra một glob khác hẳn, nên thà bỏ trống.
  it('refuses to guess when the body still holds glob syntax', () => {
    // Dấu `*` already escape: bỏ `*` cuối rồi for `prefixPattern` escape lần hai is ra glob khác.
    expect(patternToPrefix('a\\*b*')).toBe('');
    expect(patternToPrefix('log[1]:*')).toBe('');
    expect(patternToPrefix('a?b*')).toBe('');
    expect(patternToPrefix('a*b*')).toBe('');
  });
});
