// Stable identity for a connection, used as the localStorage scope for everything
// that must not leak between servers: open tabs + their auto-saved SQL, query
// history, saved queries.
//
// Why this exists: the old key was `${dbType}_${dbName}`, and `dbName` is just
// `config.database || config.sqlitePath` (see dbHelper.connect). Two servers
// hosting a database of the same name therefore shared one key — opening prod
// restored the draft SQL and tabs of localhost, and both wrote over each other.
// Redis was worse: `dbName` is `db${index}`, so every Redis server collapsed
// into `redis_db0`.
//
// Two levels of granularity, deliberately different:
//   connKey  -> the server (host:port, or the SQLite file). Query history uses
//               this, so switching database with USE keeps one timeline.
//   scopeKey -> server + database. Tabs use this, because a tab list belongs to
//               a specific database (a table tab means nothing after USE).
// Credentials are not part of the identity: two profiles pointing at the same
// server with a full and a read-only account are the same server to the user.

import type { DbConnectionConfig } from './dbHelper';

const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
};

/** Windows paths are case-insensitive and mix separators, so normalize before comparing. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * Identity of the server behind `config`, or `''` when there is no config to
 * derive it from (callers fall back to the legacy key in that case).
 *
 * SSH tunnels do not change the result: the frontend config always holds the
 * real remote host/port, the 127.0.0.1 rewrite happens in Rust.
 */
export function connKey(config?: DbConnectionConfig | null): string {
  if (!config) return '';
  if (config.type === 'sqlite') {
    const path = config.sqlitePath?.trim();
    return path ? `sqlite:${normalizePath(path)}` : '';
  }
  const host = (config.host || 'localhost').trim().toLowerCase();
  const port = config.port || DEFAULT_PORTS[config.type] || 0;
  return `${config.type}:${host}:${port}`;
}

/**
 * Identity of one database on that server. `database` overrides the one in
 * `config` (the app switches database without rebuilding the config object).
 * SQLite adds nothing — one file is one database, already in `connKey`.
 */
export function scopeKey(config?: DbConnectionConfig | null, database?: string | null): string {
  const base = connKey(config);
  if (!base || config?.type === 'sqlite') return base;
  const db = (database ?? config?.database ?? '').trim();
  return db ? `${base}/${db}` : base;
}

/** Key holding the open tabs (and the SQL auto-saved inside them) for one database. */
export function tabsStorageKey(
  config: DbConnectionConfig | null | undefined,
  dbType: string,
  dbName: string,
): string {
  const scope = scopeKey(config, dbName);
  return scope ? `tn_tabs_${scope}` : legacyTabsStorageKey(dbType, dbName);
}

/**
 * The pre-`connKey` tab key. Only read, never written: it is adopted once when
 * the new key is still empty so nobody loses the tabs they had open.
 */
export function legacyTabsStorageKey(dbType: string, dbName: string): string {
  return `tn_tabs_${dbType}_${dbName}`;
}
