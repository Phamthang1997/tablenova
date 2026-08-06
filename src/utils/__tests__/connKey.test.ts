import { describe, it, expect } from 'vitest';
import { connKey, scopeKey, tabsStorageKey, legacyTabsStorageKey } from '../connKey';
import type { DbConnectionConfig } from '../dbHelper';

const mysql = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'sakila',
  ...over,
});

describe('connKey', () => {
  it('separates two servers hosting a database of the same name', () => {
    const local = connKey(mysql());
    const prod = connKey(mysql({ host: 'prod.example.com' }));
    expect(local).not.toBe(prod);
  });

  it('ignores the database, so USE keeps one identity', () => {
    expect(connKey(mysql({ database: 'sakila' }))).toBe(connKey(mysql({ database: 'world' })));
  });

  it('ignores credentials: same server with two accounts is one connection', () => {
    expect(connKey(mysql({ user: 'root', password: 'a' })))
      .toBe(connKey(mysql({ user: 'readonly', password: 'b' })));
  });

  it('fills in the default port so :3306 and an empty port agree', () => {
    expect(connKey(mysql({ port: undefined }))).toBe(connKey(mysql({ port: 3306 })));
    expect(connKey(mysql({ port: 3307 }))).not.toBe(connKey(mysql({ port: 3306 })));
  });

  it('folds host case and default port for postgres and redis too', () => {
    expect(connKey({ type: 'postgres', host: 'DB.Example.COM' })).toBe('postgres:db.example.com:5432');
    expect(connKey({ type: 'redis', host: 'cache' })).toBe('redis:cache:6379');
  });

  it('separates redis servers that share a database index', () => {
    const a = connKey({ type: 'redis', host: 'a', dbIndex: 0 });
    const b = connKey({ type: 'redis', host: 'b', dbIndex: 0 });
    expect(a).not.toBe(b);
  });

  it('identifies sqlite by file path, normalizing separators and case', () => {
    expect(connKey({ type: 'sqlite', sqlitePath: 'C:\\data\\Demo.db' })).toBe('sqlite:c:/data/demo.db');
    expect(connKey({ type: 'sqlite', sqlitePath: ' C:/data/demo.db ' })).toBe('sqlite:c:/data/demo.db');
  });

  it('separates two sqlite files with the same name in different folders', () => {
    expect(connKey({ type: 'sqlite', sqlitePath: '/a/demo.db' }))
      .not.toBe(connKey({ type: 'sqlite', sqlitePath: '/b/demo.db' }));
  });

  it('returns an empty identity when there is nothing to derive it from', () => {
    expect(connKey(null)).toBe('');
    expect(connKey(undefined)).toBe('');
    expect(connKey({ type: 'sqlite' })).toBe('');
  });
});

describe('scopeKey', () => {
  it('adds the database on top of the server', () => {
    expect(scopeKey(mysql())).toBe('mysql:localhost:3306/sakila');
  });

  it('lets an explicit database win over the one in the config', () => {
    // Đổi database (USE / switch_database) không dựng lại config, nên phải truyền tay.
    expect(scopeKey(mysql(), 'world')).toBe('mysql:localhost:3306/world');
  });

  it('adds nothing for sqlite: one file is one database', () => {
    const config: DbConnectionConfig = { type: 'sqlite', sqlitePath: '/a/demo.db' };
    expect(scopeKey(config, 'demo')).toBe(connKey(config));
  });

  it('falls back to the server alone when no database is known', () => {
    expect(scopeKey(mysql({ database: undefined }))).toBe('mysql:localhost:3306');
  });
});

describe('tabsStorageKey', () => {
  it('uses the connection-scoped key when a config is available', () => {
    expect(tabsStorageKey(mysql(), 'mysql', 'sakila')).toBe('tn_tabs_mysql:localhost:3306/sakila');
  });

  it('does not collide across servers, unlike the legacy key', () => {
    const local = tabsStorageKey(mysql(), 'mysql', 'sakila');
    const prod = tabsStorageKey(mysql({ host: 'prod' }), 'mysql', 'sakila');
    expect(local).not.toBe(prod);
    expect(legacyTabsStorageKey('mysql', 'sakila')).toBe('tn_tabs_mysql_sakila');
  });

  it('falls back to the legacy key without a config (vite-dev, no backend)', () => {
    expect(tabsStorageKey(null, 'mysql', 'sakila')).toBe(legacyTabsStorageKey('mysql', 'sakila'));
  });
});
