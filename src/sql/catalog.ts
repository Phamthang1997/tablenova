// Metadata cache for smart completion: table/view list, and schema (columns + types + FKs) per table.
// Background loading + memory cache, invalidated on DDL execution.
//
// **Cache keyed by `connId`.** Previous global Map keyed strictly on table name caused collisions across
// multiple active connections sharing identical table names (`users`).


import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, TableItem } from '../utils/dbHelper';

interface ConnCache {
  tables: TableItem[];
  fetchedAt: number;
  fetching: boolean;
  primed: boolean;
  priming: boolean;
  schemas: Map<string, SchemaInfo>;
}

const byConn = new Map<string, ConnCache>();
const TTL = 15000;

function cacheFor(connId: string): ConnCache {
  let c = byConn.get(connId);
  if (!c) {
    c = { tables: [], fetchedAt: 0, fetching: false, primed: false, priming: false, schemas: new Map() };
    byConn.set(connId, c);
  }
  return c;
}

// Bulk-loads entire schema (1 call) via get_full_catalog -> warm schemas; if empty, fall back to lazy fetch.
async function primeCatalog(connId: string): Promise<void> {
  const c = cacheFor(connId);
  if (c.primed || c.priming) return;
  c.priming = true;
  try {
    const full = await dbHelper.getFullCatalog(connId);
    for (const [tbl, cols] of Object.entries(full.columns || {})) {
      c.schemas.set(tbl, {
        columns: (cols as any[]).map(col => ({
          name: col.name, type: col.type, nullable: true, isPrimaryKey: !!col.isPrimaryKey, defaultValue: null,
        })),
        indexes: [],
        foreignKeys: (full.foreignKeys?.[tbl] || []) as any,
      });
    }
    c.primed = true;
  } catch {
    /* allow getSchema lazy per-table fallback */
  } finally {
    c.priming = false;
  }
}

export async function getTables(connId: string): Promise<TableItem[]> {
  const c = cacheFor(connId);
  if (Date.now() - c.fetchedAt > TTL && !c.fetching) {
    c.fetching = true;
    try {
      c.tables = await dbHelper.getTables(connId);
      c.fetchedAt = Date.now();
    } catch {
      /* preserve stale cache */
    } finally {
      c.fetching = false;
    }
  }
  void primeCatalog(connId); // background schema warm-up (non-blocking)
  return c.tables;
}

export async function getSchema(connId: string, table: string): Promise<SchemaInfo | null> {
  const c = cacheFor(connId);
  const cached = c.schemas.get(table);
  if (cached) return cached;
  try {
    const s = await dbHelper.getTableSchema(connId, table);
    c.schemas.set(table, s);
    return s;
  } catch {
    return null;
  }
}

/**
 * Reads schema ONLY from memory cache without invoking backend. Used for multi-table scan paths
 * (e.g. column hover when query lacks FROM) avoiding N backend IPC roundtrips.
 */
export function getCachedSchema(connId: string, table: string): SchemaInfo | null {
  return byConn.get(connId)?.schemas.get(table) || null;
}

/**
 * Invalidates cache. Omitting `connId` clears for **all** connections — intended for app-level events
 * (`database-restored`, `table-renamed`) lacking connection ID.
 * Passing id clears that connection only, isolating schema changes across active databases.
 */
export function invalidateCatalog(connId?: string): void {
  if (connId === undefined) {
    byConn.clear();
    return;
  }
  byConn.delete(connId);
}

// Refreshes when schema structure changes (rename table / restore / switch database).
//
// Event contains `detail.connId` of modified connection, selectively invalidating only that cache.
// Previously cleared all caches indiscriminately: restoring on A forced B to reload its entire catalog.
// Events lacking id clear all caches as a safe fallback.
function onSchemaChanged(e: Event): void {
  const connId = (e as CustomEvent<{ connId?: string }>).detail?.connId;
  invalidateCatalog(connId);
}

if (typeof window !== 'undefined' && !(window as any).__catalogListener) {
  (window as any).__catalogListener = true;
  window.addEventListener('table-renamed', onSchemaChanged);
  window.addEventListener('database-restored', onSchemaChanged);
}
