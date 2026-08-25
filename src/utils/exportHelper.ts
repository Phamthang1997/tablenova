// Xuất dữ liệu một table ra file phía client (CSV/JSON/SQL/XLSX) and download xuống bằng <a download>.
// Đây is cơ chế save file currently run thật in app (giống SqlEditor xuất kết quả query),
// not cần Tauri save dialog. XLSX is build bati xlsxWriter tự chứa (not thư viện ngoài).

import { buildXlsx, buildXlsxWorkbook, buildZip, type XlsxSheet, type ZipEntry } from './xlsxWriter';
import i18n from '../i18n';

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

// download một Blob xuống with tên file for trước.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- CSV ----
function csvCell(v: any): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(colNames: string[], rows: any[]): string {
  const header = colNames.map(csvCell).join(',');
  const body = rows.map((r) => colNames.map((c) => csvCell(r?.[c])).join(',')).join('\r\n');
  // BOM to Excel receive UTF-8 đúng
  return '﻿' + header + (body ? '\r\n' + body : '');
}

// ---- JSON ----
export function buildJson(rows: any[]): string {
  return JSON.stringify(rows, null, 2);
}

// ---- SQL (INSERT) ----

/**
 * column này có must kiểu nhị phân not (BLOB / bytea / VARBINARY / …).
 *
 * Cần biết vì backend giao ô nhị phân under dạng MẢNG BYTE (`json!(bytes)`), and một mảng số thì
 * not phân biệt is with column JSON chứa `[1,2,3]` — nên must nhìn KIỂU column chứ not đoán from
 * giá trị. receive diện sai at đây nghĩa is ảnh/tệp in database xuất ra thành string văn bản
 * `'[137,80,78,71,...]'` and vĩnh viễn not khôi phục lại is.
 */
export function isBinaryType(type: string | null | undefined, dbType: string): boolean {
  const t = (type || '').toLowerCase();
  if (!t) return false;
  if (dbType === 'postgres') return t.startsWith('bytea');
  // Kiểu not gian of MySQL cũng về under dạng byte thô (nội bộ is 4 byte SRID + WKB) and write
  // lại bằng literal hex is MySQL receive. Sakila có `address.location GEOMETRY NOT NULL` — thiếu
  // row này thì nó thành string '[0,0,0,0,1,...]' and lần nhập lại chết vì sai kiểu.
  if (MYSQL_SPATIAL_TYPES.has(t.split('(')[0].trim())) return true;
  // MySQL: blob/tinyblob/mediumblob/longblob, binary(n), varbinary(n).
  // SQLite: kiểu tự do, nhưng quy tắc affinity of nó cũng chỉ nhìn chữ 'BLOB' in tên kiểu.
  return /\b(blob|binary)\b/.test(t) || t.includes('blob') || t.startsWith('binary') || t.startsWith('varbinary');
}

const MYSQL_SPATIAL_TYPES = new Set([
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

/** Mảng byte -> literal hex theo dialect. */
function binaryLiteral(bytes: number[], dbType: string): string {
  const hex = bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
  // Postgres: string '\xAB12' (standard_conforming_strings bật default nên dấu \ is character thật).
  if (dbType === 'postgres') return `'\\x${hex}'::bytea`;
  // MySQL and SQLite dùng chung cú pháp X'AB12'; string rỗng thì X'' valid at cả hai.
  return `X'${hex}'`;
}

function sqlValue(v: any, dbType: string, isBinary = false): string {
  if (v === null || v === undefined) return 'NULL';
  if (isBinary && Array.isArray(v)) return binaryLiteral(v, dbType);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

// Số row gộp ando một câu INSERT, and trần độ dài of statement đó.
//
// Một INSERT for mỗi row biến dump sakila thành ~50.000 statement, and `restore_backup` run
// fromng câu một round-trip riêng -> gộp nhiều row giảm khoảng hai bậc số lần round-trip.
// Trần độ dài to statement not vượt `max_allowed_packet` of MySQL (default 4MB at 5.7).
const SQL_ROWS_PER_INSERT = 500;
const SQL_INSERT_MAX_CHARS = 200_000;

export function buildSql(
  tableName: string,
  colNames: string[],
  rows: any[],
  dbType: string,
  /** Tên column kiểu nhị phân — giá trị of chúng write thành literal hex thay vì string. */
  binaryCols?: Set<string>,
  /**
   * table có column `GENERATED ALWAYS AS IDENTITY` (Postgres) -> câu INSERT must có
   * `OVERRIDING SYSTEM VALUE`, if not Postgres from chối giá trị id in dump and tự đánh số
   * lại — lúc đó mọi foreign key trỏ tới table này đều lệch.
   */
  overridingSystemValue = false
): string {
  const q = dbType === 'mysql' ? '`' : '"';
  const qi = (n: string) => `${q}${n}${q}`;
  const cols = colNames.map(qi).join(', ');
  if (rows.length === 0) return i18n.t('errors.sqlTableNoData', { table: qi(tableName) });

  const overriding = overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : '';
  const prefix = `INSERT INTO ${qi(tableName)} (${cols})${overriding} VALUES\n`;
  const out: string[] = [];
  let tuples: string[] = [];
  let chars = 0;
  const flush = () => {
    if (tuples.length === 0) return;
    out.push(prefix + tuples.join(',\n') + ';');
    tuples = [];
    chars = 0;
  };

  for (const r of rows) {
    const tuple = `(${colNames.map((c) => sqlValue(r?.[c], dbType, binaryCols?.has(c))).join(', ')})`;
    // check trần TRƯỚC when add, and chỉ when lô already có row: một row dài hơn cả trần vẫn
    // must đi một mình chứ not cắt đôi is.
    if (tuples.length > 0 && (tuples.length >= SQL_ROWS_PER_INSERT || chars + tuple.length > SQL_INSERT_MAX_CHARS)) {
      flush();
    }
    tuples.push(tuple);
    chars += tuple.length + 2; // +2 for ",\n" nối giữa hai tuple
  }
  flush();
  return out.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Xếp view theo thứ tự phụ thuộc: view B read view A thì A must is create trước.
 *
 * Danh sách đối tượng at popup Xuất theo thứ tự alphabet, nên view `actor_info` fromng is write
 * ando dump at position thứ hai — trước cả table `film` mà nó SELECT — and lần nhập lại error ngay
 * (MySQL 1146 "Table doesn't exist"). table luôn is xuất trước toàn bộ view; giữa các view
 * thì cần topo-sort này. Phụ thuộc is scan bằng cách find tên view khác in thân DDL, so khớp
 * theo biên from to `film_list` not khớp `nicer_but_slower_film_list`.
 *
 * Có vòng phụ thuộc thì vòng is cắt tại chỗ phát hiện — not tồn tại thứ tự nào đúng, and
 * SQL valid not create is vòng view, nên đây chỉ is chốt chặn not lặp vô hạn.
 */
export function orderViewsByDependency<T extends { name: string; sql: string }>(views: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const v of views) byKey.set(v.name.toLowerCase(), v);

  const deps = new Map<string, string[]>();
  for (const v of views) {
    const found: string[] = [];
    for (const other of views) {
      if (other === v) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(other.name)}([^A-Za-z0-9_]|$)`, 'i');
      if (re.test(v.sql)) found.push(other.name.toLowerCase());
    }
    deps.set(v.name.toLowerCase(), found);
  }

  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const d of deps.get(key) || []) visit(d);
    const v = byKey.get(key);
    if (v) out.push(v);
  };
  for (const v of views) visit(v.name.toLowerCase());
  return out;
}

/**
 * Remove the `DEFINER=user@host` clause MySQL puts in every `SHOW CREATE ...` output.
 *
 * A dump keeping it can only be restored by an account that may impersonate that definer:
 * anyone else gets error 1227 (`Access denied; you need SUPER privilege`), and the definer
 * often does not even exist on the target server. Dropping the clause makes MySQL default it
 * to whoever runs the restore, which is what a portable dump wants.
 *
 * `SQL SECURITY DEFINER` is deliberately kept — it is a different clause (no `=` after the
 * keyword, so the pattern cannot match it) and stays valid once the definer defaults.
 */
const DEFINER_RE =
  /\s*DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s@]+)@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/gi;

export function stripDefiner(ddl: string): string {
  return ddl.replace(DEFINER_RE, '');
}

/**
 * Wrap statements whose body contains `;` in a MySQL `DELIMITER` block.
 *
 * A procedure/function/trigger body ends every inner statement with `;`, so a dump that just
 * writes it out gets cut mid-body by any `;`-based splitter — the server then receives
 * `CREATE PROCEDURE p() BEGIN INSERT ...` as a complete statement and fails. `DELIMITER $$`
 * is a client-side command, understood by both splitters in this app (`splitStatements` here
 * and `split_sql_statements` in Rust) and by the mysql CLI.
 *
 * Only MySQL needs this: Postgres bodies are already quoted as `$$…$$` and SQLite triggers
 * end with `END;` which its own splitter handles.
 */
export function wrapMysqlDelimiter(statements: string[]): string[] {
  if (statements.length === 0) return [];
  const bodies = statements.map((s) => {
    const trimmed = s.trim();
    return (trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed) + '$$';
  });
  return ['DELIMITER $$', ...bodies, 'DELIMITER ;'];
}

/**
 * View nào currently is select mà table nó read lại not is select.
 *
 * `CREATE VIEW` is check ngay lúc run, nên một dump có view mà thiếu table nguồn will chết
 * lúc nhập (MySQL 1146) — and user chỉ biết when already xuất xong, mang tệp đi chỗ khác. at đây
 * chỉ warning chứ not tự tích add: xuất một phần is nhu cầu chính đáng, quyết định vẫn is
 * of user.
 *
 * scan bằng cách find tên table in thân DDL theo biên from — cùng cách `orderViewsByDependency`
 * xếp thứ tự view, nên hai chỗ not thể hiểu quan hệ khác nhau.
 */
export function missingViewDeps(
  selectedViews: { name: string; sql: string }[],
  allTableNames: string[],
  selectedNames: Set<string>
): { view: string; missing: string[] }[] {
  const out: { view: string; missing: string[] }[] = [];
  for (const v of selectedViews) {
    const missing: string[] = [];
    for (const table of allTableNames) {
      if (table.toLowerCase() === v.name.toLowerCase()) continue;
      if (selectedNames.has(table.toLowerCase())) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(table)}([^A-Za-z0-9_]|$)`, 'i');
      if (re.test(v.sql)) missing.push(table);
    }
    if (missing.length > 0) out.push({ view: v.name, missing });
  }
  return out;
}

// ---- Preview for modal (limit số row) ----
// with xlsx returns HTML (modal render bằng dangerouslySetInnerHTML); còn lại returns text thô.
function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPreview(
  format: ExportFormat,
  tableName: string,
  colNames: string[],
  rows: any[],
  dbType: string,
  limit = 10
): string {
  const sample = rows.slice(0, limit);
  if (format === 'csv') return buildCsv(colNames, sample);
  if (format === 'json') return buildJson(sample);
  if (format === 'sql') return buildSql(tableName, colNames, sample, dbType);
  // xlsx -> table HTML
  const head = colNames.map((c) => `<th style="border:1px solid var(--win-border);padding:2px 6px;text-align:left;">${htmlEsc(c)}</th>`).join('');
  const body = sample
    .map((r) => {
      const tds = colNames
        .map((c) => {
          const v = r?.[c];
          const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `<td style="border:1px solid var(--win-border);padding:2px 6px;">${htmlEsc(text)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;font-size:11px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Tệp already build xong in bộ nhớ, wait write ra thư mục or download xuống. */
export interface BuiltFile {
  name: string;
  data: Uint8Array | string;
  mime: string;
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  sql: 'text/plain;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * build nội dung tệp xuất of MỘT table (not download xuống) to phía gọi tự quyết định
 * write ando thư mục user select hay download qua WebView.
 */
export function buildTableFile(
  tableName: string,
  colNames: string[],
  rows: any[],
  format: ExportFormat,
  dbType: string,
  fileName?: string
): BuiltFile {
  const base = stripExt((fileName || '').trim()) || tableName;
  switch (format) {
    case 'csv':
      return { name: `${base}.csv`, data: buildCsv(colNames, rows), mime: MIME.csv };
    case 'json':
      return { name: `${base}.json`, data: buildJson(rows), mime: MIME.json };
    case 'sql':
      return { name: `${base}.sql`, data: buildSql(tableName, colNames, rows, dbType), mime: MIME.sql };
    case 'xlsx':
      return { name: `${base}.xlsx`, data: buildXlsx(tableName, colNames, rows), mime: MIME.xlsx };
  }
}

/**
 * build nội dung tệp xuất NHIỀU table (not download xuống): xlsx nhiều sheet, json theo table,
 * csv một table -> .csv / nhiều table -> .zip.
 */
export function buildDatabaseFile(
  sheets: XlsxSheet[],
  format: 'json' | 'csv' | 'xlsx',
  filename: string
): BuiltFile {
  const base = stripExt(filename) || 'export';
  if (format === 'xlsx') {
    return { name: `${base}.xlsx`, data: buildXlsxWorkbook(sheets), mime: MIME.xlsx };
  }
  if (format === 'json') {
    const byTable = Object.fromEntries(sheets.map((s) => [s.name, s.rows]));
    return { name: `${base}.json`, data: JSON.stringify(byTable, null, 2), mime: MIME.json };
  }
  if (sheets.length === 1) {
    const s = sheets[0];
    return { name: `${s.name || base}.csv`, data: buildCsv(s.colNames, s.rows), mime: MIME.csv };
  }
  const enc = new TextEncoder();
  const usedNames = new Set<string>();
  const entries: ZipEntry[] = sheets.map((s) => {
    const n = (s.name || 'table').replace(/[\\/:*?"<>|]/g, '_');
    let candidate = `${n}.csv`;
    let k = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${n}_${k++}.csv`;
    usedNames.add(candidate.toLowerCase());
    return { name: candidate, data: enc.encode(buildCsv(s.colNames, s.rows)) };
  });
  return { name: `${base}.zip`, data: buildZip(entries), mime: 'application/zip' };
}

// ---- Điểm ando: xuất & download file đầy đủ ----
// fileName: tên tệp download xuống (not kèm đuôi). Bỏ trống -> dùng tên table.
// tableName vẫn dùng for nội dung (INSERT INTO / tên sheet) nên not thay bằng fileName.
export function exportTableToFile(
  tableName: string,
  colNames: string[],
  rows: any[],
  format: ExportFormat,
  dbType: string,
  fileName?: string
): void {
  const base = stripExt((fileName || '').trim()) || tableName;
  switch (format) {
    case 'csv':
      downloadBlob(new Blob([buildCsv(colNames, rows)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
      break;
    case 'json':
      downloadBlob(new Blob([buildJson(rows)], { type: 'application/json' }), `${base}.json`);
      break;
    case 'sql':
      downloadBlob(new Blob([buildSql(tableName, colNames, rows, dbType)], { type: 'text/plain;charset=utf-8' }), `${base}.sql`);
      break;
    case 'xlsx': {
      const bytes = buildXlsx(tableName, colNames, rows);
      downloadBlob(xlsxBlob(bytes), `${base}.xlsx`);
      break;
    }
  }
}

// create Blob .xlsx from bytes (sao chép sang ArrayBuffer sạch to đúng kiểu BlobPart).
function xlsxBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Xuất nhiều table ando một file .xlsx (mỗi table một sheet) and download xuống.
 */
export function exportSheetsToXlsx(sheets: XlsxSheet[], filename: string): void {
  const bytes = buildXlsxWorkbook(sheets);
  const name = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  downloadBlob(xlsxBlob(bytes), name);
}

// Bỏ đuôi phần expand khỏi tên file (if có) to ghép đuôi mới.
function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * Xuất nhiều table ra JSON: một object { têntable: mảng row }.
 */
export function exportTablesToJson(byTable: Record<string, any[]>, filename: string): void {
  const base = stripExt(filename) || 'export';
  downloadBlob(new Blob([JSON.stringify(byTable, null, 2)], { type: 'application/json' }), `${base}.json`);
}

/**
 * Xuất nhiều table ra CSV: 1 table -> download thẳng .csv; nhiều table -> gói .zip (mỗi table một file .csv).
 */
export function exportTablesToCsv(sheets: XlsxSheet[], filename: string): void {
  const base = stripExt(filename) || 'export';
  if (sheets.length === 1) {
    const s = sheets[0];
    downloadBlob(new Blob([buildCsv(s.colNames, s.rows)], { type: 'text/csv;charset=utf-8' }), `${s.name || base}.csv`);
    return;
  }
  const enc = new TextEncoder();
  const usedNames = new Set<string>();
  const entries: ZipEntry[] = sheets.map((s) => {
    let n = (s.name || 'table').replace(/[\\/:*?"<>|]/g, '_');
    let candidate = `${n}.csv`;
    let k = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${n}_${k++}.csv`;
    usedNames.add(candidate.toLowerCase());
    return { name: candidate, data: enc.encode(buildCsv(s.colNames, s.rows)) };
  });
  downloadBlob(new Blob([buildZip(entries).slice().buffer], { type: 'application/zip' }), `${base}.zip`);
}

// ---- Tên tệp suggestion ----

/**
 * `20260812_213045` — sortable in time order, and no character Windows forbids in a file name.
 *
 * Lives here rather than next to a dialog because both the Export dialog and Connection Manager's
 * Backup screen suggest a name; two copies would drift the moment one of them changes format.
 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Bỏ character not đặt is in tên tệp (tên table/database can chứa whitespace, dấu chấm…). */
export function safeFileBase(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_') || 'database';
}

/**
 * Basename without extension — the label a SQLite path contributes to a suggested file name.
 * `C:\data\demo.db` -> `demo`, so the suggestion is `bk_demo_…` and not the whole escaped path.
 */
export function fileBaseFromPath(path: string): string {
  const leaf = path.trim().split(/[\\/]/).pop() || '';
  return leaf.replace(/\.[^.]+$/, '');
}
