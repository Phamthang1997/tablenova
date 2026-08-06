/**
 * Sinh gợi ý điều kiện `JOIN ... ON` từ metadata bảng.
 *
 * Ở module riêng, **không import monaco**: cùng lý do với `statements.ts` — logic này là
 * hàm thuần trên dữ liệu schema nên phải test được trong môi trường node.
 */

/** Chỉ phần schema mà hàm dưới đây cần (không phụ thuộc SchemaInfo đầy đủ của dbHelper). */
export interface JoinSchema {
  columns: { name: string }[];
  foreignKeys?: { column: string; refTable: string; refColumn: string }[];
}

/** Cột trông giống khoá -> dùng cho fallback khi hai bảng không khai báo FK. */
const KEY_LIKE = /(^id$|_id$|number$|code$)/i;

/**
 * Điều kiện JOIN giữa bảng được JOIN **sau cùng** và từng bảng trước đó.
 * Ưu tiên foreign key (cả hai chiều); nếu không có FK thì lấy cột trùng tên trông giống khoá.
 *
 * `scopeTables` phải theo thứ tự xuất hiện trong câu lệnh — phần tử cuối được coi là bảng
 * vừa JOIN, tức bảng mà người dùng đang viết điều kiện cho nó.
 */
export async function buildJoinConditions(
  scopeTables: string[],
  aliasByTable: Map<string, string>,
  getSchema: (table: string) => Promise<JoinSchema | null>
): Promise<string[]> {
  const uniq: string[] = [];
  for (const t of scopeTables) {
    if (!uniq.some(u => u.toLowerCase() === t.toLowerCase())) uniq.push(t);
  }
  if (uniq.length < 2) return [];

  const last = uniq[uniq.length - 1];
  const others = uniq.slice(0, -1);
  const pfx = (t: string) => aliasByTable.get(t) || t;

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (a: string, ac: string, b: string, bc: string) => {
    if (!ac || !bc) return;
    const s = `${pfx(a)}.${ac} = ${pfx(b)}.${bc}`;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };

  const lastSchema = await getSchema(last);
  for (const other of others) {
    const otherSchema = await getSchema(other);
    const before = out.length;

    // FK: bảng vừa JOIN -> bảng trước đó
    for (const fk of lastSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === other.toLowerCase()) {
        add(last, fk.column, other, fk.refColumn);
      }
    }
    // FK: bảng trước đó -> bảng vừa JOIN
    for (const fk of otherSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === last.toLowerCase()) {
        add(other, fk.column, last, fk.refColumn);
      }
    }

    // Fallback theo cột trùng tên — xét RIÊNG cho từng cặp bảng. Trước đây điều kiện là
    // `out.length === 0`, nên chỉ cần một cặp bảng có FK là mọi cặp còn lại mất fallback.
    if (out.length === before) {
      const lastCols = lastSchema?.columns || [];
      const lastByLower = new Map(lastCols.map(c => [c.name.toLowerCase(), c.name]));
      for (const col of otherSchema?.columns || []) {
        const n = col.name.toLowerCase();
        const match = lastByLower.get(n);
        if (match && KEY_LIKE.test(n)) add(other, col.name, last, match);
      }
    }
  }
  return out;
}
