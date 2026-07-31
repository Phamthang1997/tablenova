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

// ---- Điểm vào: xuất & tải file đầy đủ ----
export function exportTableToFile(
  tableName: string,
  colNames: string[],
  rows: any[],
  format: ExportFormat,
  dbType: string
): void {
  switch (format) {
    case 'csv':
      downloadBlob(new Blob([buildCsv(colNames, rows)], { type: 'text/csv;charset=utf-8' }), `${tableName}.csv`);
      break;
    case 'json':
      downloadBlob(new Blob([buildJson(rows)], { type: 'application/json' }), `${tableName}.json`);
      break;
    case 'sql':
      downloadBlob(new Blob([buildSql(tableName, colNames, rows, dbType)], { type: 'text/plain;charset=utf-8' }), `${tableName}.sql`);
      break;
    case 'xlsx': {
      const bytes = buildXlsx(tableName, colNames, rows);
      downloadBlob(xlsxBlob(bytes), `${tableName}.xlsx`);
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
