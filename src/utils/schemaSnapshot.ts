// Snapshot & Diff schema -> sinh migration SQL.
// Chụp toàn bộ cấu trúc DB hiện tại thành "ảnh chụp" (lưu localStorage / xuất file JSON),
// so sánh ảnh chụp (baseline) với schema hiện tại (current), sinh script migration.
// Tái dùng backend previewAlterTableSchema để sinh ALTER cho bảng thay đổi.

import { dbHelper, type SchemaInfo, type ColumnInfo } from './dbHelper';

export interface TableSnapshot {
  schema: SchemaInfo;
  ddl: string; // CREATE TABLE gốc, dùng để sinh migration cho bảng mới
}

export interface SchemaSnapshot {
  name: string;
  createdAt: string; // ISO
  dbType: string;
  database?: string;
  tables: Record<string, TableSnapshot>;
}

const STORAGE_KEY = 'schema_snapshots';

export function listSnapshots(): SchemaSnapshot[] {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(list: SchemaSnapshot[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function saveSnapshot(snap: SchemaSnapshot): void {
  const list = listSnapshots().filter((s) => s.name !== snap.name);
  list.unshift(snap);
  persist(list);
}

export function deleteSnapshot(name: string): void {
  persist(listSnapshots().filter((s) => s.name !== name));
}

// Chụp schema hiện tại: duyệt các bảng, lấy cấu trúc + DDL từng bảng.
export async function captureCurrentSchema(name: string, dbType: string, database?: string): Promise<SchemaSnapshot> {
  const items = await dbHelper.getTables();
  const tables: Record<string, TableSnapshot> = {};
  for (const it of items) {
    if (it.type !== 'table') continue; // chỉ bảng (bỏ view) cho migration
    const schema = await dbHelper.getTableSchema(it.name);
    const def = await dbHelper.getTableDefinition(it.name);
    tables[it.name] = { schema, ddl: def.sql || '' };
  }
  return { name, createdAt: new Date().toISOString(), dbType, database, tables };
}

// ---- Diff ----
export interface TableAlterPayload {
  added: ColumnInfo[];
  dropped: string[];
  renamed: any[];
  modified: ColumnInfo[];
  addedIndexes: any[];
  droppedIndexes: string[];
  addedFKs: any[];
  droppedFKs: any[];
}

export interface TableChange {
  table: string;
  payload: TableAlterPayload;
  summary: string[];
}

export interface SchemaDiff {
  addedTables: string[]; // có ở current, không ở baseline -> CREATE
  droppedTables: string[]; // có ở baseline, không ở current -> DROP
  changedTables: TableChange[];
  identical: boolean;
}

function fkKey(fk: { column: string; refTable: string; refColumn: string }): string {
  return `${fk.column}->${fk.refTable}.${fk.refColumn}`;
}

// Diff một bảng: dựng payload để biến baseline (b) thành current (c).
function diffTable(b: SchemaInfo, c: SchemaInfo): TableAlterPayload {
  const bCols = new Map((b.columns || []).map((col) => [col.name, col]));
  const cCols = new Map((c.columns || []).map((col) => [col.name, col]));

  const added = (c.columns || []).filter((col) => !bCols.has(col.name));
  const dropped = (b.columns || []).filter((col) => !cCols.has(col.name)).map((col) => col.name);
  const modified = (c.columns || []).filter((col) => {
    const old = bCols.get(col.name);
    if (!old) return false;
    return (old.type || '') !== (col.type || '') || !!old.nullable !== !!col.nullable;
  });

  const bIdx = new Map((b.indexes || []).map((i) => [i.name, i]));
  const cIdx = new Map((c.indexes || []).map((i) => [i.name, i]));
  const addedIndexes = (c.indexes || []).filter((i) => !bIdx.has(i.name));
  const droppedIndexes = (b.indexes || []).filter((i) => !cIdx.has(i.name)).map((i) => i.name);

  const bFk = new Map((b.foreignKeys || []).map((f) => [fkKey(f), f]));
  const cFk = new Map((c.foreignKeys || []).map((f) => [fkKey(f), f]));
  const addedFKs = (c.foreignKeys || []).filter((f) => !bFk.has(fkKey(f)));
  const droppedFKs = (b.foreignKeys || []).filter((f) => !cFk.has(fkKey(f)));

  return { added, dropped, renamed: [], modified, addedIndexes, droppedIndexes, addedFKs, droppedFKs };
}

function summarize(p: TableAlterPayload): string[] {
  const out: string[] = [];
  if (p.added.length) out.push(`+${p.added.length} cột`);
  if (p.dropped.length) out.push(`-${p.dropped.length} cột`);
  if (p.modified.length) out.push(`~${p.modified.length} cột`);
  if (p.addedIndexes.length) out.push(`+${p.addedIndexes.length} index`);
  if (p.droppedIndexes.length) out.push(`-${p.droppedIndexes.length} index`);
  if (p.addedFKs.length) out.push(`+${p.addedFKs.length} FK`);
  if (p.droppedFKs.length) out.push(`-${p.droppedFKs.length} FK`);
  return out;
}

// So sánh baseline (ảnh chụp cũ) với current (hiện tại). Migration biến baseline -> current.
export function diffSchemas(baseline: SchemaSnapshot, current: SchemaSnapshot): SchemaDiff {
  const bNames = Object.keys(baseline.tables);
  const cNames = Object.keys(current.tables);
  const addedTables = cNames.filter((t) => !baseline.tables[t]);
  const droppedTables = bNames.filter((t) => !current.tables[t]);

  const changedTables: TableChange[] = [];
  for (const t of cNames) {
    if (!baseline.tables[t]) continue;
    const payload = diffTable(baseline.tables[t].schema, current.tables[t].schema);
    const summary = summarize(payload);
    if (summary.length) changedTables.push({ table: t, payload, summary });
  }

  const identical = !addedTables.length && !droppedTables.length && !changedTables.length;
  return { addedTables, droppedTables, changedTables, identical };
}

// Sinh script migration từ diff. Bảng mới dùng DDL đã lưu; bảng xóa -> DROP; bảng đổi -> ALTER (qua backend).
export async function buildMigrationSql(
  diff: SchemaDiff,
  current: SchemaSnapshot,
  baseline: SchemaSnapshot,
  dbType: string
): Promise<string> {
  const q = dbType === 'mysql' ? '`' : '"';
  const qi = (n: string) => `${q}${n}${q}`;
  const lines: string[] = [];
  lines.push(`-- Migration sinh bởi TableNova`);
  lines.push(`-- Baseline: "${baseline.name}" (${baseline.createdAt}) -> Hiện tại (${current.createdAt})`);
  lines.push('');

  for (const t of diff.addedTables) {
    lines.push(`-- [+] Bảng mới: ${t}`);
    let ddl = (current.tables[t]?.ddl || '').trim();
    if (ddl) {
      if (!ddl.endsWith(';')) ddl += ';';
      lines.push(ddl);
    } else {
      lines.push(`-- (không có DDL cho bảng ${t})`);
    }
    lines.push('');
  }

  for (const t of diff.droppedTables) {
    lines.push(`-- [-] Bảng bị xóa: ${t}`);
    lines.push(`DROP TABLE IF EXISTS ${qi(t)};`);
    lines.push('');
  }

  for (const ch of diff.changedTables) {
    lines.push(`-- [~] Thay đổi bảng: ${ch.table} (${ch.summary.join(', ')})`);
    const res = await dbHelper.previewAlterTableSchema(ch.table, ch.payload);
    const body = (res.sqls || []).join('\n').trim();
    if (body) {
      lines.push(body.endsWith(';') ? body : body + ';');
    } else {
      lines.push(`-- (không sinh được ALTER cho ${ch.table} — có thể dialect không hỗ trợ)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
