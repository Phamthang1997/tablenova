// Constants and pure formatters shared by the Redis panels. No JSX here on purpose:
// oxlint's `react/only-export-components` is an error in this repo, so a module that mixes
// components with helpers would fail lint.

export const TYPE_COLORS: Record<string, string> = {
  string: '#3b82f6',
  hash: '#10b981',
  list: '#f59e0b',
  set: '#8b5cf6',
  zset: '#ec4899',
  stream: '#06b6d4',
};

/** SCAN COUNT hint per round trip. */
export const SCAN_COUNT = 300;

/**
 * How many keys the browser keeps in memory. The scan used to run until the cursor came back
 * 0, pushing every key into React state — two million keys meant two million objects and two
 * million rows. Hitting this stops the scan and says so; it never truncates silently.
 */
export const KEY_CAP = 100_000;

/** Fixed row height the virtualized list is measured against (must match the rendered row). */
export const ROW_HEIGHT = 24;

/** Elements fetched per page of a hash/list/set/zset/stream. */
export const ELEMENT_PAGE = 200;

export function ttlText(ttl: number): string {
  if (ttl === -1) return '∞';
  if (ttl < 0) return '-';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Microseconds as reported by SLOWLOG. */
export function formatMicros(us: number): string {
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

// CSS properties extracted to classes in `index.css`: `.redis-cell`, `.redis-inline-input`,
// `.redis-mono-box`, `.redis-log-box`, `.redis-pill` adhering to project CSS guidelines.


