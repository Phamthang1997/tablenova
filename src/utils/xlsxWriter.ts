// Minimalist, self-contained XLSX generator (zero external dependencies).
// XLSX files are ZIP packages containing structured XML files. Here we:
//   - Build STORED uncompressed ZIP -> requires only CRC32, no deflate. Natively compatible with Excel/LibreOffice.
//   - Single sheet using inline strings for text and <v> for numbers/booleans.
// Optimized for table data exports; omits styles/sharedStrings to maintain minimal spec compliance.

// ---- CRC32 (PKZIP standard) ----
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Byte utilities ----
const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// Builds STORED ZIP archive from file list.
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 0x21; // 1980-01-01 (0<<9 | 1<<5 | 1) — valid DOS timestamp avoiding warnings

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = concat([
      u32(0x04034b50), // signature local file header
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method = stored
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra len
      nameBytes,
      e.data,
    ]);
    locals.push(local);

    const central = concat([
      u32(0x02014b50), // signature central dir header
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra len
      u16(0), // comment len
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // offset of local header
      nameBytes,
    ]);
    centrals.push(central);

    offset += local.length;
  }

  const centralData = concat(centrals);
  const eocd = concat([
    u32(0x06054b50), // EOCD signature
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length),
    u16(entries.length),
    u32(centralData.length),
    u32(offset), // offset of central dir
    u16(0), // comment len
  ]);

  return concat([...locals, centralData, eocd]);
}

// ---- XML helpers ----
function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strips control characters invalid in XML 1.0 (preserves tab \t, newlines \n, \r).
    // Explicitly matching control characters is intentional to prevent corrupt Excel workbooks.
    
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// 0-based column index -> Excel column letters (0->A, 25->Z, 26->AA...).
function colLetter(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Valid sheet names: strips forbidden characters, max 31 characters.
function sanitizeSheetName(name: string): string {
  const cleaned = (name || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
  return cleaned || 'Sheet1';
}

function cellXml(ref: string, value: any): string {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}

// Constructs worksheet XML from column names and row values.
function buildSheetXml(colNames: string[], rows: any[]): string {
  const rowXmls: string[] = [];
  const headerCells = colNames.map((c, i) => cellXml(`${colLetter(i)}1`, c)).join('');
  rowXmls.push(`<row r="1">${headerCells}</row>`);
  for (let r = 0; r < rows.length; r++) {
    const rowNum = r + 2;
    const row = rows[r] || {};
    const cells = colNames.map((c, i) => cellXml(`${colLetter(i)}${rowNum}`, row[c])).join('');
    rowXmls.push(`<row r="${rowNum}">${cells}</row>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXmls.join('')}</sheetData></worksheet>`
  );
}

export interface XlsxSheet {
  name: string;
  colNames: string[];
  rows: any[];
}

/**
 * Builds multi-sheet .xlsx workbook with sanitized, unique sheet names.
 */
export function buildXlsxWorkbook(sheets: XlsxSheet[]): Uint8Array {
  const enc = new TextEncoder();
  const list = sheets.length ? sheets : [{ name: 'Sheet1', colNames: [], rows: [] }];

  const used = new Set<string>();
  const sheetFiles: ZipEntry[] = [];
  const overrides: string[] = [];
  const wbSheets: string[] = [];
  const wbRels: string[] = [];

  list.forEach((s, i) => {
    const idx = i + 1;
    // ensures unique sheet names
    let nm = sanitizeSheetName(s.name);
    if (used.has(nm.toLowerCase())) {
      const base = nm.slice(0, 27);
      let k = 2;
      while (used.has(`${base}_${k}`.toLowerCase())) k++;
      nm = `${base}_${k}`;
    }
    used.add(nm.toLowerCase());

    sheetFiles.push({ name: `xl/worksheets/sheet${idx}.xml`, data: enc.encode(buildSheetXml(s.colNames, s.rows)) });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbSheets.push(`<sheet name="${xmlEsc(nm)}" sheetId="${idx}" r:id="rId${idx}"/>`);
    wbRels.push(`<Relationship Id="rId${idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx}.xml"/>`);
  });

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    overrides.join('') +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${wbSheets.join('')}</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    wbRels.join('') +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    ...sheetFiles,
  ];

  return buildZip(entries);
}

/**
 * Builds single-sheet .xlsx workbook (optimized for single table export).
 */
export function buildXlsx(sheetName: string, colNames: string[], rows: any[]): Uint8Array {
  return buildXlsxWorkbook([{ name: sheetName, colNames, rows }]);
}
