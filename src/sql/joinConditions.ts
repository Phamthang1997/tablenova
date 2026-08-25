/**
 * Generates `JOIN ... ON` suggestions based on table schema metadata.
 *
 * Placed in dedicated module without Monaco dependency for node-based unit testing.
 
 */

/** Minimal schema subset needed for JOIN condition inference. */
export interface JoinSchema {
  columns: { name: string }[];
  foreignKeys?: { column: string; refTable: string; refColumn: string }[];
}

/** Key-like column candidates used for fallback when tables lack explicit FK definitions. */
const KEY_LIKE = /(^id$|_id$|number$|code$)/i;

/**
 * Suggests JOIN conditions between the **most recently joined table** and preceding tables.
 * Prioritizes foreign keys (bidirectional); falls back to matching key-like column names.
 *
 * `scopeTables` reflects statement appearance order — last element is target JOIN table.
 
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

    // FK: recently joined table -> previous table
    for (const fk of lastSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === other.toLowerCase()) {
        add(last, fk.column, other, fk.refColumn);
      }
    }
    // FK: previous table -> recently joined table
    for (const fk of otherSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === last.toLowerCase()) {
        add(other, fk.column, last, fk.refColumn);
      }
    }

    // Fallback by matching column names evaluated per table pair independently.
    
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
