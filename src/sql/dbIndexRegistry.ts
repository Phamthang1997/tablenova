import { editorConnId } from './editorScope';
import { dbHelper } from '../utils/dbHelper';

export interface ColumnIndexMeta {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  nullable: boolean;
}

export interface TableIndexMeta {
  name: string;
  columnCount: number;
}

/**
 * In-Memory DB Index Registry for instant O(1) symbol resolution & static inspection.
 */
export class DbIndexRegistry {
  private tables = new Map<string, TableIndexMeta>();
  private columns = new Map<string, Map<string, ColumnIndexMeta>>();
  private foreignKeys = new Map<string, any[]>();
  private isBuilding = false;
  private isPrimed = false;
  /** Connection the current index was built from. `null` = nothing built yet. */
  private builtFor: string | null = null;

  /**
   * Builds the in-memory index graph, **or returns immediately if it already holds this
   * connection's**.
   *
   * The check is the point. Callers are many and repetitive: every mounted `SqlEditor` runs it on
   * mount and whenever its connection changes, `inspection.ts` runs it per Monaco model, and two
   * window listeners run it on schema changes. Without a memory of what it already has, each of
   * those was a full `get_full_catalog` round trip — with three query tabs open, three fetches of
   * the same catalog back to back, which is what made switching connections feel slow.
   *
   * A different connection still rebuilds: `builtFor` not matching is exactly that case, so callers
   * do not need to `invalidate()` first. `invalidate()` stays for the real reason to discard —
   * the schema changed under us.
   */
  async buildIndex(): Promise<void> {
    const connId = editorConnId();
    if (this.isBuilding) return;
    if (this.isPrimed && this.builtFor === connId) return;
    this.isBuilding = true;
    try {
      const full = await dbHelper.getFullCatalog(connId);
      this.tables.clear();
      this.columns.clear();
      this.foreignKeys.clear();

      for (const [tblName, colList] of Object.entries(full.columns || {})) {
        const lowerTbl = tblName.toLowerCase();
        const cols = (colList as any[]).map((c) => ({
          name: c.name,
          type: c.type || 'UNKNOWN',
          isPrimaryKey: !!c.isPrimaryKey,
          nullable: c.nullable !== false,
        }));

        this.tables.set(lowerTbl, { name: tblName, columnCount: cols.length });

        const colMap = new Map<string, ColumnIndexMeta>();
        for (const col of cols) {
          colMap.set(col.name.toLowerCase(), col);
        }
        this.columns.set(lowerTbl, colMap);
      }

      for (const [tblName, fks] of Object.entries(full.foreignKeys || {})) {
        this.foreignKeys.set(tblName.toLowerCase(), fks as any[]);
      }

      this.isPrimed = true;
      this.builtFor = connId;
    } catch {
      /* Keep existing index state if network/backend fails */
    } finally {
      this.isBuilding = false;
    }
  }

  isReady(): boolean {
    return this.isPrimed;
  }

  hasTable(tableName: string): boolean {
    if (!tableName) return false;
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return this.tables.has(clean);
  }

  getRealTableName(tableName: string): string | null {
    if (!tableName) return null;
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return this.tables.get(clean)?.name || null;
  }

  getTableColumns(tableName: string): ColumnIndexMeta[] {
    if (!tableName) return [];
    const clean = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(clean);
    return colMap ? Array.from(colMap.values()) : [];
  }

  hasColumn(tableName: string, columnName: string): boolean {
    if (!tableName || !columnName) return false;
    const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const cleanCol = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(cleanTbl);
    return colMap ? colMap.has(cleanCol) : false;
  }

  getColumn(tableName: string, columnName: string): ColumnIndexMeta | null {
    if (!tableName || !columnName) return null;
    const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    const cleanCol = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const colMap = this.columns.get(cleanTbl);
    return colMap ? colMap.get(cleanCol) || null : null;
  }

  findSimilarColumns(columnName: string, tableName?: string): string[] {
    const search = columnName.replace(/[`"[\]]/g, '').toLowerCase();
    const suggestions: string[] = [];

    if (tableName) {
      const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
      const colMap = this.columns.get(cleanTbl);
      if (colMap) {
        for (const col of colMap.values()) {
          if (col.name.toLowerCase().includes(search) || search.includes(col.name.toLowerCase())) {
            suggestions.push(col.name);
          }
        }
      }
    } else {
      for (const colMap of this.columns.values()) {
        for (const col of colMap.values()) {
          if (col.name.toLowerCase().includes(search)) {
            if (!suggestions.includes(col.name)) suggestions.push(col.name);
          }
        }
      }
    }
    return suggestions.slice(0, 5);
  }

  invalidate(): void {
    this.isPrimed = false;
    this.builtFor = null;
    this.tables.clear();
    this.columns.clear();
    this.foreignKeys.clear();
  }
}

export const dbIndexRegistry = new DbIndexRegistry();

/**
 * The index holds ONE connection's symbols — the one the focused editor belongs to.
 *
 * So a schema change somewhere else must not rebuild it: doing so would refill it from the focused
 * editor's connection over and over for events that have nothing to do with it, and — while the
 * event carried no id at all — could rebuild it at a moment when the focused editor and the changed
 * database were different connections. An event with no id is treated as "mine", which is what
 * every dispatch looked like before they carried one.
 */
function onSchemaChanged(e: Event): void {
  const connId = (e as CustomEvent<{ connId?: string }>).detail?.connId;
  if (connId && connId !== editorConnId()) return;
  dbIndexRegistry.invalidate();
  void dbIndexRegistry.buildIndex();
}

if (typeof window !== 'undefined' && !(window as any).__dbIndexListener) {
  (window as any).__dbIndexListener = true;
  window.addEventListener('table-renamed', onSchemaChanged);
  window.addEventListener('database-restored', onSchemaChanged);
}
