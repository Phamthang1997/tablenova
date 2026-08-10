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

  /**
   * Builds or refreshes the in-memory index graph by fetching the catalog.
   */
  async buildIndex(): Promise<void> {
    if (this.isBuilding) return;
    this.isBuilding = true;
    try {
      const full = await dbHelper.getFullCatalog();
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
    this.tables.clear();
    this.columns.clear();
    this.foreignKeys.clear();
  }
}

export const dbIndexRegistry = new DbIndexRegistry();

if (typeof window !== 'undefined' && !(window as any).__dbIndexListener) {
  (window as any).__dbIndexListener = true;
  window.addEventListener('table-renamed', () => {
    dbIndexRegistry.invalidate();
    void dbIndexRegistry.buildIndex();
  });
  window.addEventListener('database-restored', () => {
    dbIndexRegistry.invalidate();
    void dbIndexRegistry.buildIndex();
  });
}
