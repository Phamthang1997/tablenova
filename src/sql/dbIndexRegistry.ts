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

/** Tối đa số gợi ý trả về — thông báo lỗi và menu Quick Fix đều phải đọc được trong một liếc. */
const MAX_SUGGESTIONS = 3;

/**
 * Khoảng cách Damerau–Levenshtein, dừng sớm khi đã chắc chắn vượt `max`.
 *
 * Cần *Damerau* (có phép hoán vị hai ký tự liền nhau) chứ không phải Levenshtein thuần: lỗi gõ
 * phổ biến nhất là đảo hai phím — `nmae` ↔ `name` cách nhau **1** phép hoán vị nhưng **2** phép
 * sửa thường, nên với ngưỡng chặt thì Levenshtein thuần bỏ lọt đúng trường hợp hay gặp nhất.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = [];
  let cur: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Hoán vị: "ab" -> "ba" tính là một phép.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // cả hàng đã vượt ngưỡng -> không thể tốt hơn
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Xếp hạng tên gần giống `search` trong `pool`.
 *
 * Bản trước chỉ so **chuỗi con**, nên nó bắt được `emai` → `email` nhưng bỏ qua `nmae` → `name`,
 * tức đúng loại lỗi mà một gợi ý "ý bạn là…" sinh ra để phục vụ. Giữ lại chuỗi con (gõ dở là
 * trạng thái rất thường gặp trong editor) và xếp nó **trên** khoảng cách sửa, rồi mới tới các tên
 * cách vài phép gõ.
 *
 * Ngưỡng nới theo độ dài: với tên 3 ký tự thì cho phép 2 phép sửa là gần như khớp mọi thứ.
 */
function rankSimilar(search: string, pool: string[]): string[] {
  if (!search) return [];
  const max = search.length <= 3 ? 1 : 2;
  const scored: { name: string; rank: number; dist: number }[] = [];

  for (const name of pool) {
    const lower = name.toLowerCase();
    if (lower === search) continue; // trùng khít thì đã không có lỗi để gợi ý
    if (lower.includes(search) || search.includes(lower)) {
      scored.push({ name, rank: 0, dist: Math.abs(lower.length - search.length) });
      continue;
    }
    const dist = editDistance(search, lower, max);
    if (dist <= max) scored.push({ name, rank: 1, dist });
  }

  scored.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.name);
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
    const pool: string[] = [];

    if (tableName) {
      const cleanTbl = tableName.replace(/[`"[\]]/g, '').toLowerCase();
      const colMap = this.columns.get(cleanTbl);
      if (colMap) for (const col of colMap.values()) pool.push(col.name);
    } else {
      for (const colMap of this.columns.values()) {
        for (const col of colMap.values()) if (!pool.includes(col.name)) pool.push(col.name);
      }
    }
    return rankSimilar(search, pool);
  }

  /** Bảng có tên gần giống — nguồn của Quick Fix trên lỗi "bảng không tồn tại". */
  findSimilarTables(tableName: string): string[] {
    const search = tableName.replace(/[`"[\]]/g, '').toLowerCase();
    return rankSimilar(search, Array.from(this.tables.values()).map((tbl) => tbl.name));
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
