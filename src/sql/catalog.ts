// Cache metadata cho smart completion: danh sách bảng/view, và schema (cột + kiểu + FK) từng bảng.
// Nạp nền + cache, invalidate khi DDL.
//
// **Cache khoá theo `connId`.** Bản trước là một `Map` cấp module khoá bằng **tên bảng trơn**, đúng
// khi cả app chỉ có một kết nối nhưng đụng nhau *theo cấu trúc* khi có nhiều: hai kết nối cùng có
// bảng `users` thì kết nối thứ hai đọc phải cột của kết nối thứ nhất, và completion gợi ý sai mà
// không có dấu hiệu gì. Khoá theo kết nối làm chuyện đó không biểu diễn được.
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

// Nạp GỘP toàn bộ schema (1 lần) qua get_full_catalog -> warm schemas; nếu rỗng thì thôi (lazy sau).
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
    /* để getSchema fallback lazy per-table */
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
      /* giữ cache cũ */
    } finally {
      c.fetching = false;
    }
  }
  void primeCatalog(connId); // warm schema nền (không chặn)
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
 * Chỉ đọc schema ĐÃ có trong cache, không gọi backend. Dùng cho các đường phải quét nhiều bảng
 * (vd hover một cột khi câu lệnh chưa có FROM) để tránh N lời gọi xuống Rust.
 */
export function getCachedSchema(connId: string, table: string): SchemaInfo | null {
  return byConn.get(connId)?.schemas.get(table) || null;
}

/**
 * Vứt cache. Không truyền `connId` thì vứt của **mọi** kết nối — đó là hành vi đúng cho các sự kiện
 * cấp app (`database-restored`, `table-renamed`) vì chúng chưa mang conn id (§4.5, Phase 3 sẽ thêm).
 * Truyền id thì chỉ vứt của kết nối đó, để đổi schema ở một kết nối không xoá cache của cái khác.
 */
export function invalidateCatalog(connId?: string): void {
  if (connId === undefined) {
    byConn.clear();
    return;
  }
  byConn.delete(connId);
}

// Làm mới khi cấu trúc thay đổi (đổi tên bảng / khôi phục / đổi database).
//
// Sự kiện mang `detail.connId` của kết nối vừa đổi, nên chỉ cache của kết nối ĐÓ bị vứt. Trước đây
// không mang gì và phải vứt sạch mọi kết nối: restore ở A bắt B nạp lại toàn bộ catalog dù B không
// hề đổi. Sự kiện không mang id (bản cũ) vẫn vứt sạch — an toàn hơn là đoán.
function onSchemaChanged(e: Event): void {
  const connId = (e as CustomEvent<{ connId?: string }>).detail?.connId;
  invalidateCatalog(connId);
}

if (typeof window !== 'undefined' && !(window as any).__catalogListener) {
  (window as any).__catalogListener = true;
  window.addEventListener('table-renamed', onSchemaChanged);
  window.addEventListener('database-restored', onSchemaChanged);
}
