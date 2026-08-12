// Xuất dữ liệu một bảng ra file phía client (CSV/JSON/SQL/XLSX) và tải xuống bằng <a download>.
// Đây là cơ chế lưu file đang chạy thật trong app (giống SqlEditor xuất kết quả query),
// không cần Tauri save dialog. XLSX được dựng bởi xlsxWriter tự chứa (không thư viện ngoài).

import { buildXlsx, buildXlsxWorkbook, buildZip, type XlsxSheet, type ZipEntry } from './xlsxWriter';
import i18n from '../i18n';

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

// Tải một Blob xuống với tên file cho trước.
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
  // BOM để Excel nhận UTF-8 đúng
  return '﻿' + header + (body ? '\r\n' + body : '');
}

// ---- JSON ----
export function buildJson(rows: any[]): string {
  return JSON.stringify(rows, null, 2);
}

// ---- SQL (INSERT) ----

/**
 * Cột này có phải kiểu nhị phân không (BLOB / bytea / VARBINARY / …).
 *
 * Cần biết vì backend giao ô nhị phân dưới dạng MẢNG BYTE (`json!(bytes)`), và một mảng số thì
 * không phân biệt được với cột JSON chứa `[1,2,3]` — nên phải nhìn KIỂU cột chứ không đoán từ
 * giá trị. Nhận diện sai ở đây nghĩa là ảnh/tệp trong database xuất ra thành chuỗi văn bản
 * `'[137,80,78,71,...]'` và vĩnh viễn không khôi phục lại được.
 */
export function isBinaryType(type: string | null | undefined, dbType: string): boolean {
  const t = (type || '').toLowerCase();
  if (!t) return false;
  if (dbType === 'postgres') return t.startsWith('bytea');
  // Kiểu không gian của MySQL cũng về dưới dạng byte thô (nội bộ là 4 byte SRID + WKB) và ghi
  // lại bằng literal hex là MySQL nhận. Sakila có `address.location GEOMETRY NOT NULL` — thiếu
  // dòng này thì nó thành chuỗi '[0,0,0,0,1,...]' và lần nhập lại chết vì sai kiểu.
  if (MYSQL_SPATIAL_TYPES.has(t.split('(')[0].trim())) return true;
  // MySQL: blob/tinyblob/mediumblob/longblob, binary(n), varbinary(n).
  // SQLite: kiểu tự do, nhưng quy tắc affinity của nó cũng chỉ nhìn chữ 'BLOB' trong tên kiểu.
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
  // Postgres: chuỗi '\xAB12' (standard_conforming_strings bật mặc định nên dấu \ là ký tự thật).
  if (dbType === 'postgres') return `'\\x${hex}'::bytea`;
  // MySQL và SQLite dùng chung cú pháp X'AB12'; chuỗi rỗng thì X'' hợp lệ ở cả hai.
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

// Số dòng gộp vào một câu INSERT, và trần độ dài của câu lệnh đó.
//
// Một INSERT cho mỗi dòng biến dump sakila thành ~50.000 câu lệnh, và `restore_backup` chạy
// từng câu một round-trip riêng -> gộp nhiều dòng giảm khoảng hai bậc số lần round-trip.
// Trần độ dài để câu lệnh không vượt `max_allowed_packet` của MySQL (mặc định 4MB ở 5.7).
const SQL_ROWS_PER_INSERT = 500;
const SQL_INSERT_MAX_CHARS = 200_000;

export function buildSql(
  tableName: string,
  colNames: string[],
  rows: any[],
  dbType: string,
  /** Tên cột kiểu nhị phân — giá trị của chúng ghi thành literal hex thay vì chuỗi. */
  binaryCols?: Set<string>,
  /**
   * Bảng có cột `GENERATED ALWAYS AS IDENTITY` (Postgres) -> câu INSERT phải có
   * `OVERRIDING SYSTEM VALUE`, nếu không Postgres từ chối giá trị id trong dump và tự đánh số
   * lại — lúc đó mọi khoá ngoại trỏ tới bảng này đều lệch.
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
    // Kiểm tra trần TRƯỚC khi thêm, và chỉ khi lô đã có dòng: một dòng dài hơn cả trần vẫn
    // phải đi một mình chứ không cắt đôi được.
    if (tuples.length > 0 && (tuples.length >= SQL_ROWS_PER_INSERT || chars + tuple.length > SQL_INSERT_MAX_CHARS)) {
      flush();
    }
    tuples.push(tuple);
    chars += tuple.length + 2; // +2 cho ",\n" nối giữa hai tuple
  }
  flush();
  return out.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Xếp view theo thứ tự phụ thuộc: view B đọc view A thì A phải được tạo trước.
 *
 * Danh sách đối tượng ở popup Xuất theo thứ tự alphabet, nên view `actor_info` từng được ghi
 * vào dump ở vị trí thứ hai — trước cả bảng `film` mà nó SELECT — và lần nhập lại lỗi ngay
 * (MySQL 1146 "Table doesn't exist"). Bảng luôn được xuất trước toàn bộ view; giữa các view
 * thì cần topo-sort này. Phụ thuộc được dò bằng cách tìm tên view khác trong thân DDL, so khớp
 * theo biên từ để `film_list` không khớp `nicer_but_slower_film_list`.
 *
 * Có vòng phụ thuộc thì vòng bị cắt tại chỗ phát hiện — không tồn tại thứ tự nào đúng, và
 * SQL hợp lệ không tạo được vòng view, nên đây chỉ là chốt chặn không lặp vô hạn.
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
 * View nào đang được chọn mà bảng nó đọc lại KHÔNG được chọn.
 *
 * `CREATE VIEW` được kiểm tra ngay lúc chạy, nên một dump có view mà thiếu bảng nguồn sẽ chết
 * lúc nhập (MySQL 1146) — và người dùng chỉ biết khi đã xuất xong, mang tệp đi chỗ khác. Ở đây
 * chỉ CẢNH BÁO chứ không tự tích thêm: xuất một phần là nhu cầu chính đáng, quyết định vẫn là
 * của người dùng.
 *
 * Dò bằng cách tìm tên bảng trong thân DDL theo biên từ — cùng cách `orderViewsByDependency`
 * xếp thứ tự view, nên hai chỗ không thể hiểu quan hệ khác nhau.
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

// ---- Preview cho modal (giới hạn số dòng) ----
// Với xlsx trả về HTML (modal render bằng dangerouslySetInnerHTML); còn lại trả về text thô.
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
  // xlsx -> bảng HTML
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

/** Tệp đã dựng xong trong bộ nhớ, chờ ghi ra thư mục hoặc tải xuống. */
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
 * Dựng nội dung tệp xuất của MỘT bảng (không tải xuống) để phía gọi tự quyết định
 * ghi vào thư mục người dùng chọn hay tải qua WebView.
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
 * Dựng nội dung tệp xuất NHIỀU bảng (không tải xuống): xlsx nhiều sheet, json theo bảng,
 * csv một bảng -> .csv / nhiều bảng -> .zip.
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

// ---- Điểm vào: xuất & tải file đầy đủ ----
// fileName: tên tệp tải xuống (không kèm đuôi). Bỏ trống -> dùng tên bảng.
// tableName vẫn dùng cho nội dung (INSERT INTO / tên sheet) nên không thay bằng fileName.
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

// Tạo Blob .xlsx từ bytes (sao chép sang ArrayBuffer sạch để đúng kiểu BlobPart).
function xlsxBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Xuất nhiều bảng vào một file .xlsx (mỗi bảng một sheet) và tải xuống.
 */
export function exportSheetsToXlsx(sheets: XlsxSheet[], filename: string): void {
  const bytes = buildXlsxWorkbook(sheets);
  const name = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  downloadBlob(xlsxBlob(bytes), name);
}

// Bỏ đuôi phần mở rộng khỏi tên file (nếu có) để ghép đuôi mới.
function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * Xuất nhiều bảng ra JSON: một object { tênBảng: mảng dòng }.
 */
export function exportTablesToJson(byTable: Record<string, any[]>, filename: string): void {
  const base = stripExt(filename) || 'export';
  downloadBlob(new Blob([JSON.stringify(byTable, null, 2)], { type: 'application/json' }), `${base}.json`);
}

/**
 * Xuất nhiều bảng ra CSV: 1 bảng -> tải thẳng .csv; nhiều bảng -> gói .zip (mỗi bảng một file .csv).
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
