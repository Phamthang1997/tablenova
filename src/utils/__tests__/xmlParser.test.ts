import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, parseXml, XmlParseError } from '../xmlParser';

describe('decodeXmlEntities', () => {
  it('giải mã 5 entity dựng sẵn', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(`a & b <c> "d" 'e'`);
  });

  it('giải mã tham chiếu ký tự thập phân và hex', () => {
    expect(decodeXmlEntities('&#65;&#x42;&#x1F600;')).toBe('AB😀');
  });

  it('giữ nguyên entity tự định nghĩa (không phân giải entity ngoài)', () => {
    expect(decodeXmlEntities('&xxe; &#0; &#x110000;')).toBe('&xxe; &#0; &#x110000;');
  });

  it('trả lại nguyên chuỗi khi không có &', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
  });
});

describe('parseXml', () => {
  it('đọc phần tử, thuộc tính và văn bản', () => {
    const doc = parseXml(`<root a="1" b='2'><child>hello</child></root>`);
    const root = doc.getElementsByTagName('root')[0];
    expect(root.getAttribute('a')).toBe('1');
    expect(root.getAttribute('b')).toBe('2');
    expect(root.getAttribute('missing')).toBeNull();
    expect(doc.getElementsByTagName('child')[0].textContent).toBe('hello');
  });

  it('textContent nối văn bản của hậu duệ theo thứ tự tài liệu', () => {
    const doc = parseXml('<si><t>Xin </t><r><t>chào</t></r><t> bạn</t></si>');
    expect(doc.getElementsByTagName('si')[0].textContent).toBe('Xin chào bạn');
  });

  it('getElementsByTagName trả về hậu duệ theo thứ tự tài liệu', () => {
    const doc = parseXml('<a><b id="1"/><c><b id="2"/></c><b id="3"/></a>');
    expect(doc.getElementsByTagName('b').map((e) => e.getAttribute('id'))).toEqual(['1', '2', '3']);
  });

  it('xử lý thẻ tự đóng và thẻ rỗng', () => {
    const doc = parseXml('<row><c r="A1"/><c r="B1"></c></row>');
    const cells = doc.getElementsByTagName('c');
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe('');
    expect(cells[1].getAttribute('r')).toBe('B1');
  });

  it('bỏ qua khai báo XML, chú thích và DOCTYPE', () => {
    const doc = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE root [<!ENTITY x "boom">]><!-- ghi chú --><root>ok</root>`
    );
    expect(doc.getElementsByTagName('root')[0].textContent).toBe('ok');
  });

  it('không phân giải entity khai báo trong DOCTYPE (chặn XXE)', () => {
    const doc = parseXml(
      `<!DOCTYPE r [<!ENTITY secret SYSTEM "file:///etc/passwd">]><r>&secret;</r>`
    );
    expect(doc.getElementsByTagName('r')[0].textContent).toBe('&secret;');
  });

  it('giữ nguyên nội dung CDATA, không giải mã entity bên trong', () => {
    const doc = parseXml('<t><![CDATA[<b>&amp;</b>]]></t>');
    expect(doc.getElementsByTagName('t')[0].textContent).toBe('<b>&amp;</b>');
  });

  it('giải mã entity trong văn bản và trong giá trị thuộc tính', () => {
    const doc = parseXml('<t v="a&amp;b">x &lt; y</t>');
    const t = doc.getElementsByTagName('t')[0];
    expect(t.getAttribute('v')).toBe('a&b');
    expect(t.textContent).toBe('x < y');
  });

  it('không nhầm dấu > nằm trong giá trị thuộc tính là kết thúc thẻ', () => {
    const doc = parseXml('<numFmt formatCode="[&gt;0]yyyy-mm-dd" numFmtId="164"/>');
    const el = doc.getElementsByTagName('numFmt')[0];
    expect(el.getAttribute('numFmtId')).toBe('164');
    expect(el.getAttribute('formatCode')).toBe('[>0]yyyy-mm-dd');
  });

  it('khớp được thẻ và thuộc tính có prefix namespace', () => {
    const doc = parseXml('<x:sheets xmlns:x="urn:a"><x:sheet r:id="rId1" name="S1"/></x:sheets>');
    const sheet = doc.getElementsByTagName('sheet')[0];
    expect(sheet.getAttribute('r:id')).toBe('rId1');
    expect(sheet.getAttribute('name')).toBe('S1');
  });

  it('ném XmlParseError khi thẻ chưa đóng', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError);
    expect(() => parseXml('<a><b>')).toThrow(XmlParseError);
    expect(() => parseXml('<a')).toThrow(XmlParseError);
  });

  it('không tạo node DOM — kết quả là dữ liệu thuần', () => {
    const doc = parseXml('<t><script>alert(1)</script></t>');
    const script = doc.getElementsByTagName('script')[0];
    expect(script.textContent).toBe('alert(1)');
    expect(typeof (script as any).appendChild).toBe('undefined');
  });
});
