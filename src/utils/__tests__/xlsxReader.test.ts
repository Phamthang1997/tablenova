import { describe, expect, it } from 'vitest';
import { buildXlsx, buildXlsxWorkbook } from '../xlsxWriter';
import { parseXlsx } from '../xlsxReader';

// Round-trip: xlsxWriter dựng file .xlsx thật -> xlsxReader đọc lại bằng parser XML tự viết.
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

describe('parseXlsx', () => {
  it('đọc lại đúng dữ liệu do xlsxWriter ghi ra', async () => {
    const rows = [
      { id: 1, name: 'Nguyễn Văn A', active: true },
      { id: 2, name: 'Trần Thị B', active: false },
    ];
    const parsed = await parseXlsx(toBuffer(buildXlsx('users', ['id', 'name', 'active'], rows)));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(1);
    expect(parsed[0].name).toBe('Nguyễn Văn A');
    expect(parsed[1].name).toBe('Trần Thị B');
  });

  it('giữ nguyên ký tự cần escape trong XML (& < > " \')', async () => {
    const rows = [{ v: `a & b < c > d " e ' f` }];
    const parsed = await parseXlsx(toBuffer(buildXlsx('t', ['v'], rows)));
    expect(parsed[0].v).toBe(`a & b < c > d " e ' f`);
  });

  it('không diễn giải nội dung ô như HTML', async () => {
    const rows = [{ payload: '<img src=x onerror=alert(1)>' }];
    const parsed = await parseXlsx(toBuffer(buildXlsx('t', ['payload'], rows)));
    expect(parsed[0].payload).toBe('<img src=x onerror=alert(1)>');
  });

  it('xử lý ô rỗng/null và bỏ hàng hoàn toàn rỗng', async () => {
    const rows = [{ a: 'x', b: null }, { a: null, b: null }, { a: 'y', b: 'z' }];
    const parsed = await parseXlsx(toBuffer(buildXlsx('t', ['a', 'b'], rows)));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ a: 'x', b: null });
    expect(parsed[1]).toEqual({ a: 'y', b: 'z' });
  });

  it('đọc sheet đầu tiên của workbook nhiều sheet (qua workbook.xml.rels)', async () => {
    const bytes = buildXlsxWorkbook([
      { name: 'first', colNames: ['c'], rows: [{ c: 'from-first' }] },
      { name: 'second', colNames: ['c'], rows: [{ c: 'from-second' }] },
    ]);
    const parsed = await parseXlsx(toBuffer(bytes));
    expect(parsed).toEqual([{ c: 'from-first' }]);
  });

  it('báo lỗi rõ ràng khi buffer không phải ZIP/XLSX', async () => {
    await expect(parseXlsx(new TextEncoder().encode('not a zip at all').slice().buffer as ArrayBuffer)).rejects.toThrow(
      /ZIP\/XLSX/
    );
  });
});
