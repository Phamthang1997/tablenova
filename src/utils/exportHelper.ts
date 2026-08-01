// Xuất dữ liệu một bảng ra file phía client (CSV/JSON/SQL/XLSX) và tải xuống bằng <a download>.
// Đây là cơ chế lưu file đang chạy thật trong app (giống SqlEditor xuất kết quả query),
// không cần Tauri save dialog. XLSX được dựng bởi xlsxWriter tự chứa (không thư viện ngoài).

import { buildXlsx, buildXlsxWorkbook, buildZip, type XlsxSheet, type ZipEntry } from './xlsxWriter';

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
function sqlValue(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

export function buildSql(tableName: string, colNames: string[], rows: any[], dbType: string): string {
  const q = dbType === 'mysql' ? '`' : '"';
  const qi = (n: string) => `${q}${n}${q}`;
  const cols = colNames.map(qi).join(', ');
  if (rows.length === 0) return `-- Bảng ${qi(tableName)} không có dữ liệu\n`;
  return rows
    .map((r) => `INSERT INTO ${qi(tableName)} (${cols}) VALUES (${colNames.map((c) => sqlValue(r?.[c])).join(', ')});`)
    .join('\n');
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
