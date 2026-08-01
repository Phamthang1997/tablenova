/**
 * Helper cho phần "xem trước" của các luồng Import (DataGrid và Sidebar > Nhập dữ liệu).
 * Chỉ phục vụ hiển thị — không dùng để sinh DDL hay câu lệnh chạy thật.
 */

/** Gộp tên cột của mọi dòng (CSV/JSON có thể thiếu cột ở một số dòng). */
export function collectColumns(rows: any[], sample = 200): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, sample)) {
    for (const k of Object.keys(r || {})) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
}

/** Suy ra kiểu dữ liệu của một cột từ tối đa 100 dòng đầu, trả về nhãn tiếng Việt. */
export function inferColType(rows: any[], col: string): string {
  let seen = 0, num = 0, bool = 0, date = 0, json = 0, hasDecimal = false;
  for (const r of rows.slice(0, 100)) {
    const v = r?.[col];
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (typeof v === 'object') { json++; continue; }
    const s = String(v).trim();
    if (typeof v === 'boolean' || /^(true|false)$/i.test(s)) { bool++; continue; }
    if (/^-?\d+(\.\d+)?$/.test(s)) { num++; if (s.includes('.')) hasDecimal = true; continue; }
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(s)) { date++; continue; }
    if (/^[[{].*[\]}]$/.test(s)) { json++; continue; }
  }
  if (seen === 0) return 'trống (NULL)';
  if (num === seen) return hasDecimal ? 'số thực' : 'số nguyên';
  if (bool === seen) return 'boolean';
  if (date === seen) return 'ngày/giờ';
  if (json === seen) return 'JSON';
  return 'chuỗi';
}
