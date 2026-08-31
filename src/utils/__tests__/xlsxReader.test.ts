import { describe, expect, it } from 'vitest';
import { buildXlsx, buildXlsxWorkbook } from '../xlsxWriter';
import { parseXlsx } from '../xlsxReader';

// A round trip: xlsxWriter builds a real .xlsx file -> xlsxReader reads it back with the hand-written XML parser.
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

describe('buildXlsx: freeze pane', () => {
  // Reads the sheet XML back out of the zip the writer produced, so the assertion is about the file
  // that actually ships rather than about a string the writer happened to build on the way there.
  function sheetXml(bytes: Uint8Array): string {
    // The writer builds a STORED (uncompressed) zip on purpose — see its header — so every part is
    // present verbatim and the sheet XML can be read straight out of the bytes. No unzip needed,
    // and nothing has to be exported from the reader just to be testable.
    const all = new TextDecoder().decode(bytes);
    const start = all.indexOf('<worksheet');
    return all.slice(start, all.indexOf('</worksheet>', start));
  }

  it('đóng băng dòng tiêu đề', () => {
    const xml = sheetXml(buildXlsx('S', ['a'], [{ a: 1 }]));
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('ySplit="1"');
    // `topLeftCell` must agree with `ySplit`, or Excel scrolls the frozen row out of sight.
    expect(xml).toContain('topLeftCell="A2"');
  });

  it('đóng băng cả khi không có dòng dữ liệu nào', () => {
    const xml = sheetXml(buildXlsx('S', ['a'], []));
    expect(xml).toContain('state="frozen"');
  });

  // The sheet schema is an xsd:sequence: an element out of order does not get ignored, Excel
  // reports the whole file as corrupt. This ordering is the part a future edit can silently break.
  it('sheetViews đứng trước sheetData', () => {
    const xml = sheetXml(buildXlsx('S', ['a'], [{ a: 1 }]));
    expect(xml.indexOf('<sheetViews>')).toBeGreaterThan(-1);
    expect(xml.indexOf('<sheetViews>')).toBeLessThan(xml.indexOf('<sheetData>'));
  });
});

describe('buildXlsx: styles', () => {
  function part(bytes: Uint8Array, open: string, close: string): string {
    const all = new TextDecoder().decode(bytes);
    const start = all.indexOf(open);
    return start < 0 ? '' : all.slice(start, all.indexOf(close, start) + close.length);
  }

  it('header dùng style đậm, ô dữ liệu thì không', () => {
    const all = new TextDecoder().decode(buildXlsx('S', ['a'], [{ a: 'x' }]));
    const sheet = all.slice(all.indexOf('<worksheet'), all.indexOf('</worksheet>'));
    expect(sheet).toContain('<c r="A1" s="1"');
    // A data cell carries no `s=` at all: style 0 is the default, and writing it out would be noise
    // on every cell of every export.
    expect(sheet).toMatch(/<c r="A2"(?! s=)/);
  });

  // Each of these is mandatory even though nothing refers to some of them; leaving one out makes
  // Excel report the workbook as needing repair rather than falling back to a default.
  it('styles.xml có đủ các phần bắt buộc', () => {
    const styles = part(buildXlsx('S', ['a'], []), '<styleSheet', '</styleSheet>');
    for (const tag of ['<fonts', '<fills', '<borders', '<cellStyleXfs', '<cellXfs']) {
      expect(styles).toContain(tag);
    }
    expect(styles).toContain('<b/>');
  });

  // The part can be present and listed and still be invisible to Excel: it is reachable only
  // through a relationship FROM the workbook.
  it('styles.xml được khai trong content types và trong workbook rels', () => {
    const all = new TextDecoder().decode(buildXlsx('S', ['a'], []));
    expect(all).toContain('/xl/styles.xml');
    expect(all).toContain('relationships/styles');
    expect(all).toContain('Target="styles.xml"');
  });
});
