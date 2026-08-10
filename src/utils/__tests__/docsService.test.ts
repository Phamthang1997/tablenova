import { describe, expect, it } from 'vitest';
import { getDoc, searchDocs, formatDocMarkdown, normalizeEngine } from '../docsService';

describe('docsService', () => {
  it('normalizes database engine strings correctly', () => {
    expect(normalizeEngine('postgres')).toBe('postgres');
    expect(normalizeEngine('pgsql')).toBe('postgres');
    expect(normalizeEngine('mysql')).toBe('mysql');
    expect(normalizeEngine('sqlite')).toBe('sqlite');
    expect(normalizeEngine('redis')).toBe('redis');
    expect(normalizeEngine('unknown')).toBeUndefined();
  });

  it('retrieves documentation by name and engine', () => {
    const sqliteDoc = getDoc('COALESCE', 'sqlite');
    expect(sqliteDoc).not.toBeNull();
    expect(sqliteDoc?.name).toBe('COALESCE');
    expect(sqliteDoc?.engine).toBe('sqlite');

    const mysqlVecDoc = getDoc('VEC_DISTANCE', 'mysql');
    expect(mysqlVecDoc).not.toBeNull();
    expect(mysqlVecDoc?.name).toBe('VEC_DISTANCE');

    const pgJsonDoc = getDoc('JSON_TABLE', 'postgres');
    expect(pgJsonDoc).not.toBeNull();
    expect(pgJsonDoc?.name).toBe('JSON_TABLE');

    const redisDoc = getDoc('XADD', 'redis');
    expect(redisDoc).not.toBeNull();
    expect(redisDoc?.name).toBe('XADD');
  });

  it('searches docs accurately with filters', () => {
    const jsonResults = searchDocs({ query: 'json' });
    expect(jsonResults.length).toBeGreaterThan(0);

    const redisCmds = searchDocs({ engine: 'redis', category: 'command' });
    expect(redisCmds.length).toBeGreaterThan(0);
    expect(redisCmds.every((d) => d.engine === 'redis')).toBe(true);
  });

  it('formats documentation into valid markdown string', () => {
    const doc = getDoc('VEC_DISTANCE', 'mysql');
    expect(doc).not.toBeNull();
    const markdown = formatDocMarkdown(doc!);
    expect(markdown).toContain('VEC_DISTANCE');
    expect(markdown).toContain('MySQL 8.x/9.x');
    expect(markdown).toContain('Official Documentation');
  });
});
