// Shared definitions for Redis tabs across sidebar, TabManager, and App.tsx:
// tab IDs, tool tab list, and key change mutation event names.
// Independent of React to allow shared usage without circular imports (similar to `utils/tabGroups.ts`).

import type { TFunction } from 'i18next';

import type { TabInfo } from '../TabManager';

/** 7 tab types of a Redis connection extracted from TabInfo union. */
export type RedisTabType = Extract<TabInfo['type'], `redis-${string}`>;

/** Tool tabs (all kinds except `redis-key`), in sidebar footer display order. */
export const REDIS_TOOL_TABS: Exclude<RedisTabType, 'redis-key'>[] = [
  'redis-console',
  'redis-dashboard',
  'redis-slowlog',
  'redis-pubsub',
  'redis-profiler',
  'redis-analysis',
];

/**
 * The label of a tool tab.
 *
 * A `switch` returning **literal** keys, not `t(labelKey)` with a key taken from a table: a dynamic
 * key is something `i18next.d.ts` cannot check, so a mistyped one survives to runtime instead of
 * failing the build (see CLAUDE.md, the i18n section). `t` is taken as a parameter because this is a
 * module-level function and cannot call the hook — the same way `formatRestoreEta` does it.
 */
export function redisToolTabLabel(type: Exclude<RedisTabType, 'redis-key'>, t: TFunction): string {
  switch (type) {
    case 'redis-console': return t('redis.tabConsole');
    case 'redis-dashboard': return t('redis.tabDashboard');
    case 'redis-slowlog': return t('redis.tabSlowLog');
    case 'redis-pubsub': return t('redis.tabPubSub');
    case 'redis-profiler': return t('redis.tabProfiler');
    case 'redis-analysis': return t('redis.tabAnalysis');
  }
}

/**
 * The id of a tab viewing one key.
 *
 * It carries `connId` and not just the key name: a tab id is unique across the whole app (see
 * `handleCloseTab`), and the same key name can perfectly well be open on two different Redis
 * connections — or on `db0` and `db3` of one server, which are two different `connId`s (§2.1).
 */
export function redisKeyTabId(connId: string, key: string): string {
  return `rediskey_${connId}_${key}`;
}

/** Tool tab ID. One instance per tool type per connection — re-clicking focuses existing tab. */
export function redisToolTabId(connId: string, type: RedisTabType): string {
  return `redistool_${connId}_${type}`;
}

/**
 * A tab has written or deleted keys and the sidebar list needs rescanning.
 *
 * A `CustomEvent` on `window` rather than props: the sender is a tab inside `ActivePanel` and the
 * receiver is the sidebar — two different branches of the tree, and this is already how
 * `table-renamed` / `database-restored` travel in this project.
 *
 * `detail.connId` is required: two Redis connections can be open at once, and rescanning the wrong
 * one both costs a SCAN round and fails to fix the list that actually went stale.
 */
export const REDIS_KEYS_CHANGED_EVENT = 'redis-keys-changed';

export interface RedisKeysChangedDetail {
  connId: string;
  /** Key deleted — sidebar removes it immediately without a full keyspace rescan. */
  removed?: string;
  /** Renamed key: removes `removed` and inserts new name. */
  renamedTo?: string;
}

export function notifyRedisKeysChanged(detail: RedisKeysChangedDetail): void {
  window.dispatchEvent(new CustomEvent(REDIS_KEYS_CHANGED_EVENT, { detail }));
}
