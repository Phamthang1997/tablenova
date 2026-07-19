// Cache metadata cho smart completion: danh sách bảng/view, và schema (cột + kiểu + FK) từng bảng.
// Dùng lại các command sẵn có của dbHelper (chưa cần get_full_catalog). Nạp nền + cache, invalidate khi DDL.
import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, TableItem } from '../utils/dbHelper';

let tablesCache: TableItem[] = [];
let tablesFetchedAt = 0;
let tablesFetching = false;
let primed = false;
let priming = false;
const schemaCache = new Map<string, SchemaInfo>();
const TTL = 15000;

// Nạp GỘP toàn bộ schema (1 lần) qua get_full_catalog -> warm schemaCache; nếu rỗng thì thôi (lazy sau).
async function primeCatalog(): Promise<void> {
  if (primed || priming) return;
  priming = true;
  try {
    const full = await dbHelper.getFullCatalog();
    for (const [tbl, cols] of Object.entries(full.columns || {})) {
      schemaCache.set(tbl, {
        columns: (cols as any[]).map(c => ({
          name: c.name, type: c.type, nullable: true, isPrimaryKey: !!c.isPrimaryKey, defaultValue: null,
        })),
        indexes: [],
        foreignKeys: (full.foreignKeys?.[tbl] || []) as any,
      });
    }
    primed = true;
  } catch {
    /* để getSchema fallback lazy per-table */
  } finally {
    priming = false;
  }
}

export async function getTables(): Promise<TableItem[]> {
  if (Date.now() - tablesFetchedAt > TTL && !tablesFetching) {
    tablesFetching = true;
    try {
      tablesCache = await dbHelper.getTables();
      tablesFetchedAt = Date.now();
    } catch {
      /* giữ cache cũ */
    } finally {
      tablesFetching = false;
    }
  }
  void primeCatalog(); // warm schema nền (không chặn)
  return tablesCache;
}

export async function getSchema(table: string): Promise<SchemaInfo | null> {
  const cached = schemaCache.get(table);
  if (cached) return cached;
  try {
    const s = await dbHelper.getTableSchema(table);
    schemaCache.set(table, s);
    return s;
  } catch {
    return null;
  }
}

export function invalidateCatalog(): void {
  tablesFetchedAt = 0;
  primed = false;
  schemaCache.clear();
}

// Làm mới khi cấu trúc thay đổi (đổi tên bảng / khôi phục / đổi database).
if (typeof window !== 'undefined' && !(window as any).__catalogListener) {
  (window as any).__catalogListener = true;
  window.addEventListener('table-renamed', invalidateCatalog);
  window.addEventListener('database-restored', invalidateCatalog);
}
