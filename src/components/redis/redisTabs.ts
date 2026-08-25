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
 * Label for a tool tab.
 *
 * Switch returns literal i18n keys ensuring compile-time key verification.
 
 
 
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
 * Tab ID for viewing a specific key.
 *
 * Contains `connId` to ensure unique tab ID across multiple open Redis connections/databases.
 
 
 */
export function redisKeyTabId(connId: string, key: string): string {
  return `rediskey_${connId}_${key}`;
}

/** Tool tab ID. One instance per tool type per connection — re-clicking focuses existing tab. */
export function redisToolTabId(connId: string, type: RedisTabType): string {
  return `redistool_${connId}_${type}`;
}

/**
 * Dispatched when a tab mutates keys and the sidebar tree requires scanning.
 *
 * CustomEvent on window bridges ActivePanel tab to Sidebar without prop drilling.
 
 
 *
 * `detail.connId` is required to isolate key refresh to the targeted connection only.
 
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
