import { describe, expect, it, beforeEach } from 'vitest';
// `?raw` rather than node:fs — the app tsconfig types `vite/client`, not node, and Vite inlines the
// text at transform time, so this reads the real source without pulling in @types/node.
import dbHelperSource from '../dbHelper.ts?raw';
import {
  COMMAND_KINDS,
  commandKind,
  isReadStatement,
  registerConnection,
  resetSafeModeState,
  sqlHasWrite,
  statementHead,
  summarizeSql,
  getSafeMode,
  getSafeModeForKey,
  setSafeModeForKey,
  STATEMENT_PREVIEW_CAP,
} from '../safeMode';
import { connKey } from '../connKey';
import type { DbConnectionConfig } from '../dbHelper';

// Vitest runs with `environment: 'node'`, which has no localStorage — `safeMode` degrades to
// "nothing stored" there (same shape as the i18n detector no-oping without `window`). The storage
// tests need a real one, so install the smallest thing that behaves like it.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
} satisfies Storage;

/** Every command name `dbHelper` invokes, straight from its source. */
function invokedCommands(): string[] {
  const names = new Set<string>();
  for (const m of dbHelperSource.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

describe('COMMAND_KINDS is the twin of dbHelper', () => {
  // The whole point of the table: an unclassified command counts as a write, so forgetting one
  // costs a needless prompt rather than a silent bypass. This test turns "needless prompt" into
  // "the build tells you", which is the only reason the table stays trustworthy.
  it('classifies every command dbHelper invokes', () => {
    const missing = invokedCommands().filter((cmd) => !(cmd in COMMAND_KINDS));
    expect(missing).toEqual([]);
  });

  it('has no entry for a command dbHelper no longer invokes', () => {
    const live = new Set(invokedCommands());
    const stale = Object.keys(COMMAND_KINDS).filter((cmd) => !live.has(cmd));
    expect(stale).toEqual([]);
  });

  it('treats an unknown command as a write', () => {
    expect(commandKind('some_new_command_nobody_classified')).toBe('write');
  });

  it('never marks a SQL-carrying command as internal', () => {
    for (const cmd of ['execute_query', 'execute_multi_query', 'execute_query_stream']) {
      expect(COMMAND_KINDS[cmd]).toBe('sql');
    }
  });

  it('keeps the paths that build SQL in Rust on the write side', () => {
    for (const cmd of [
      'commit_changes',
      'drop_table',
      'truncate_table',
      'alter_table_schema',
      'restore_backup',
      'generate_data',
      'rename_table',
      'import_table_data',
    ]) {
      expect(COMMAND_KINDS[cmd]).toBe('write');
    }
  });
});

describe('statement classification', () => {
  it('reads the first keyword past comments, parens and whitespace', () => {
    expect(statementHead('  SELECT 1')).toBe('SELECT');
    expect(statementHead('/* note */ select 1')).toBe('SELECT');
    expect(statementHead('(SELECT 1) UNION (SELECT 2)')).toBe('SELECT');
    expect(statementHead('-- drop table x\nUPDATE t SET a = 1')).toBe('UPDATE');
  });

  it('counts only plain reads as reads', () => {
    expect(isReadStatement('SELECT * FROM t')).toBe(true);
    expect(isReadStatement('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadStatement('SHOW TABLES')).toBe(true);
    expect(isReadStatement('DESCRIBE users')).toBe(true);
    expect(isReadStatement('UPDATE t SET a = 1')).toBe(false);
    expect(isReadStatement('CREATE TABLE t (id int)')).toBe(false);
  });

  it('treats WITH and anything unrecognised as a write', () => {
    // Postgres allows `WITH ... DELETE`, so the head alone cannot clear it.
    expect(isReadStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
    expect(isReadStatement('CALL do_something()')).toBe(false);
    expect(isReadStatement('¿qué?')).toBe(false);
  });

  it('ignores keywords inside strings and comments', () => {
    expect(sqlHasWrite("SELECT * FROM t WHERE note = 'delete from x'")).toBe(false);
    expect(sqlHasWrite('SELECT 1; -- DELETE FROM t')).toBe(false);
    expect(sqlHasWrite('SELECT 1; DELETE FROM t WHERE id = 1')).toBe(true);
  });

  it('says no write for empty or comment-only text', () => {
    expect(sqlHasWrite('')).toBe(false);
    expect(sqlHasWrite('   -- nothing here\n')).toBe(false);
  });
});

describe('summarizeSql', () => {
  it('counts every statement but previews only the first few', () => {
    const sql = Array.from({ length: STATEMENT_PREVIEW_CAP + 7 }, (_, i) => `UPDATE t SET a = ${i} WHERE id = ${i}`).join(';\n');
    const s = summarizeSql(sql);
    expect(s.total).toBe(STATEMENT_PREVIEW_CAP + 7);
    expect(s.preview).toHaveLength(STATEMENT_PREVIEW_CAP);
    expect(s.counts).toEqual({ UPDATE: STATEMENT_PREVIEW_CAP + 7 });
  });

  it('groups counts by leading keyword', () => {
    const s = summarizeSql('SELECT 1; UPDATE t SET a=1 WHERE id=1; UPDATE t SET a=2 WHERE id=2; DELETE FROM t WHERE id=3');
    expect(s.counts).toEqual({ SELECT: 1, UPDATE: 2, DELETE: 1 });
  });

  it('carries the SQL editor’s unsafe shapes through', () => {
    const s = summarizeSql('DELETE FROM users');
    expect(s.unsafe.map((u) => u.kind)).toEqual(['deleteNoWhere']);
  });
});

describe('mode storage', () => {
  const pgConfig = { type: 'postgres', host: 'prod.db', port: 5432 } as unknown as DbConnectionConfig;
  const localConfig = { type: 'postgres', host: 'localhost', port: 5432 } as unknown as DbConnectionConfig;

  beforeEach(() => {
    localStorage.clear();
    resetSafeModeState();
  });

  it('defaults to silent so nothing changes for an existing user', () => {
    registerConnection('c1', pgConfig);
    expect(getSafeMode('c1')).toBe('silent');
  });

  it('stores per server, not per connection id', () => {
    registerConnection('c1', pgConfig);
    registerConnection('c2', pgConfig);
    registerConnection('c3', localConfig);
    setSafeModeForKey(connKey(pgConfig), 'writes');
    // Same host:port -> same policy, even though it is a different connection.
    expect(getSafeMode('c1')).toBe('writes');
    expect(getSafeMode('c2')).toBe('writes');
    expect(getSafeMode('c3')).toBe('silent');
  });

  it('falls back to the strictest configured mode for an unregistered id', () => {
    setSafeModeForKey(connKey(pgConfig), 'all');
    expect(getSafeMode('unknown-id')).toBe('all');
  });

  it('ignores a write with no key — nothing to store it under', () => {
    setSafeModeForKey('', 'all');
    expect(getSafeModeForKey('')).toBe('silent');
  });

  it('keeps Redis on its own server key, not on whatever connection is active', () => {
    // Redis is a registry entry with its own conn id now, so it resolves through the SAME
    // id -> server map as SQL. The property under test is unchanged — a Redis write must never be
    // judged by an unrelated SQL server's policy — but it no longer needs a prefix special case,
    // and unlike the old single `redisServerKey` this also holds for two Redis servers at once.
    const redisConfig = { type: 'redis', host: 'cache.local', port: 6379 } as unknown as DbConnectionConfig;
    const redis2 = { type: 'redis', host: 'other.local', port: 6379 } as unknown as DbConnectionConfig;
    registerConnection('c1', pgConfig);
    setSafeModeForKey(connKey(pgConfig), 'all');
    registerConnection('r1', redisConfig);
    registerConnection('r2', redis2);
    expect(getSafeMode('r1')).toBe('silent');
    setSafeModeForKey(connKey(redisConfig), 'writes');
    expect(getSafeMode('r1')).toBe('writes');
    // The second Redis server keeps its own policy — impossible with one global Redis key.
    expect(getSafeMode('r2')).toBe('silent');
    expect(getSafeMode('c1')).toBe('all');
  });
});
