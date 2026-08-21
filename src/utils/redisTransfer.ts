// Xuất / nhập một phần keyspace Redis theo prefix.
//
// Cùng đường ống với `dumpBuilder.ts` bên SQL: nội dung tệp được dựng Ở ĐÂY, còn truy cập database
// đi qua tham số `reader`/`writer` chứ không import `dbHelper`. Nhờ vậy module này không phụ thuộc
// `@tauri-apps/api` và phần dễ hỏng nhất — định dạng tệp và vòng lặp phân lô — kiểm chứng được bằng
// unit test (`__tests__/redisTransfer.test.ts`).
//
// ĐỊNH DẠNG: NDJSON, mỗi key một dòng.
//
//   {"tablenova":"redis-keys","version":1,"createdAt":"…","db":0,"pattern":"user:*"}
//   {"key":"user:1","type":"string","ttlMs":-1,"payload":"<base64 DUMP>"}
//   …
//   {"tablenova":"redis-keys-end","keys":123}
//
// Ba quyết định đứng sau nó:
//
//  1. **NDJSON chứ không một JSON lớn.** Bản xuất có thể là hàng trăm nghìn key; đọc theo dòng thì
//     báo được tiến độ và một tệp bị cắt giữa chừng chỉ mất phần đuôi thay vì không parse được gì.
//  2. **Dòng cuối là footer có số key.** Đó là cách duy nhất để biết một tệp bị cắt: thiếu footer
//     nghĩa là bản xuất chưa xong, và `parseRedisExport` nói ra điều đó thay vì im lặng nhập thiếu.
//  3. **Bản ghi dùng đúng tên trường mà `redis_dump_keys` trả về và `redis_restore_keys` nhận.**
//     Một hình dạng duy nhất từ Redis ra tệp rồi vào lại Redis: không có tầng đổi tên nào để lệch.
//
// `payload` là byte thô của DUMP, mã hoá base64 — xem chú thích ở `redis_dump_keys` trong
// `redis_db.rs` giải thích vì sao là DUMP/RESTORE chứ không phải một bộ tuần tự JSON đọc được, và
// vì sao tệp chỉ nhập lại được vào Redis cùng phiên bản hoặc mới hơn.

import { folderMatchPattern } from './redisKeyTree';

/** Nhãn nhận dạng ở dòng đầu. Sai nhãn = không phải tệp của tính năng này. */
export const TRANSFER_KIND = 'redis-keys';

/** Nhãn ở dòng cuối. Có nó nghĩa là bản xuất đã chạy xong. */
export const TRANSFER_END_KIND = 'redis-keys-end';

/** Phiên bản định dạng. Tăng khi hình dạng bản ghi đổi theo cách không đọc ngược được. */
export const TRANSFER_VERSION = 1;

/** SCAN COUNT mỗi vòng khi xuất. Lớn hơn của trình duyệt key vì ở đây không vẽ gì ra màn hình. */
export const EXPORT_SCAN_COUNT = 500;

/** Số key mỗi lượt DUMP. Nhỏ hơn `TRANSFER_BATCH_MAX` của Rust để một lô luôn vừa một message IPC. */
export const DUMP_BATCH = 200;

/** Số key mỗi lượt RESTORE. Rust chạy từng key một trong lô này (xem `redis_restore_keys`). */
export const RESTORE_BATCH = 200;

/**
 * Trần số key một bản xuất giữ trong bộ nhớ.
 *
 * Cùng lý lẽ với `KEY_CAP` của trình duyệt key: nội dung tệp được ghép trong RAM trước khi lưu, nên
 * một prefix khớp hai triệu key sẽ làm sập tab. Chạm trần thì DỪNG VÀ NÓI RA (`capped`), không bao
 * giờ cắt im lặng.
 */
export const EXPORT_KEY_CAP = 100_000;

/** Một bản ghi trong tệp — cũng chính là hình dạng `redis_dump_keys` trả về. */
export interface RedisDumpEntry {
  key: string;
  /** Kiểu Redis lúc xuất. Không cần cho RESTORE; có để lọc/thống kê mà không phải giải mã payload. */
  type: string;
  /** TTL còn lại theo milli giây. -1 = không có TTL (quy ước của PTTL). */
  ttlMs: number;
  /** Byte của DUMP, base64. */
  payload: string;
}

export interface TransferHeader {
  tablenova: string;
  version: number;
  createdAt: string;
  db: number;
  pattern: string;
}

/** Giai đoạn đang chạy. Trả về mã chứ không phải câu chữ — dialog mới là chỗ có `t()`. */
export type TransferPhase = 'scan' | 'dump' | 'restore';

export interface TransferProgress {
  phase: TransferPhase;
  /** Số key đã quét (pha `scan`) hoặc đã xử lý (pha `dump`/`restore`). */
  done: number;
  /** Tổng đã biết, nếu biết. Pha `scan` không biết trước — SCAN không nói còn bao nhiêu. */
  total?: number;
}

export interface RedisExportSpec {
  /** Glob gửi cho SCAN. Dựng từ prefix bằng `prefixPattern()`. */
  pattern: string;
  /** Db index, chỉ để ghi vào header. */
  db: number;
  /** Lọc theo kiểu ở phía client, y như trình duyệt key (SCAN TYPE là Redis 6.0+). */
  typeFilter?: string;
  /** Thời điểm ghi vào header. Tham số chứ không `new Date()` bên trong: test cần tất định. */
  createdAt: string;
  maxKeys?: number;
  onProgress?: (p: TransferProgress) => void;
  /** Người dùng bấm Dừng. Kiểm giữa hai lô, nên một lô đang chạy vẫn chạy hết. */
  shouldStop?: () => boolean;
}

/** Phần `dbHelper` mà việc xuất cần. `dbHelper` khớp sẵn hình dạng này. */
export interface RedisExportReader {
  scan(
    pattern: string,
    cursor: number,
    count: number,
  ): Promise<{ success: boolean; cursor: number; keys: { key: string; type: string }[]; error?: string }>;
  dump(
    keys: string[],
  ): Promise<{ success: boolean; entries: RedisDumpEntry[]; missing: string[]; error?: string }>;
}

export interface RedisExportResult {
  /** Nội dung tệp. Không khớp key nào thì vẫn có header — xem `keys` để biết nó có gì. */
  text: string;
  /** Số bản ghi đã ghi. */
  keys: number;
  /**
   * Key có trong kết quả SCAN nhưng DUMP trả nil — hết hạn hoặc bị xoá giữa hai lệnh. Không phải
   * lỗi, nhưng phải nói ra: nó là chênh lệch giữa "đã quét" và "đã ghi".
   */
  missing: string[];
  /** Bị `typeFilter` loại. */
  filtered: number;
  /** Chạm `maxKeys` -> bản xuất KHÔNG đầy đủ. */
  capped: boolean;
  /** Người dùng dừng giữa chừng -> cũng không đầy đủ. */
  stopped: boolean;
}

/**
 * Glob khớp mọi key dưới một prefix. Prefix rỗng -> `*` (toàn bộ db).
 *
 * Việc escape đi qua `folderMatchPattern` chứ không có một bản riêng ở đây: nó đã làm đúng việc đó
 * cho menu "xoá cả nhóm" của cây key, và hai bản escape song song là hai thứ phải giữ đồng bộ bằng
 * tay. Escape là bắt buộc chứ không phải cho gọn: prefix là chuỗi người dùng gõ (hoặc một nhánh của
 * cây) nên hoàn toàn có thể chứa `[`, `*`, `?`. Ghép thẳng `prefix + '*'` thì `log[1]:` không tìm
 * key bắt đầu bằng `log[1]:` mà tìm key bắt đầu bằng `log1:` — xuất sai tập key, không báo gì.
 */
export function prefixPattern(prefix: string): string {
  const p = prefix.trim();
  return p ? folderMatchPattern(p) : '*';
}

/**
 * Prefix suy ra từ một glob, chỉ để điền sẵn ô prefix của dialog. Trả về `''` khi không suy được.
 *
 * Ô tìm kiếm của trình duyệt key nhận một *pattern* (`user:*`), còn dialog nhận một *prefix*, nên
 * chỗ nối hai thứ phải bỏ dấu `*` ở cuối. Nhưng chỉ làm vậy khi phần thân KHÔNG còn ký tự đặc biệt:
 * `prefixPattern` sẽ escape lại lần nữa, nên `a\*b*` suy thành prefix `a\*b` rồi bị escape lần hai
 * thành một glob khác hẳn. Không đoán được thì để trống, người dùng tự gõ.
 */
export function patternToPrefix(pattern: string): string {
  const p = pattern.trim();
  if (!p || p === '*') return '';
  const body = p.endsWith('*') ? p.slice(0, -1) : p;
  return /[\\*?[\]]/.test(body) ? '' : body;
}

/** Base64 chuẩn, có padding — đúng thứ `base64::engine::general_purpose::STANDARD` sinh ra. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Một dòng đã parse có phải bản ghi dùng được không.
 *
 * Kiểm ở đây chứ không để Rust kiểm: một bản ghi khuyết là lỗi của TỆP, và thông báo về nó phải
 * bằng ngôn ngữ đang dùng — Rust chỉ có tiếng Việt và `failed[].error` không đi qua
 * `backendErrors.ts`. Kiểm cả base64 vì `RESTORE` với payload rác trả về lỗi driver khó hiểu hơn
 * nhiều so với "dòng thứ 12 của tệp không hợp lệ".
 */
export function isValidEntry(v: unknown): v is RedisDumpEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.key !== 'string' || e.key === '') return false;
  if (typeof e.payload !== 'string' || e.payload === '') return false;
  if (e.payload.length % 4 !== 0 || !BASE64_RE.test(e.payload)) return false;
  if (e.ttlMs != null && typeof e.ttlMs !== 'number') return false;
  return true;
}

/** Một bản ghi -> một dòng của tệp. */
function entryLine(e: RedisDumpEntry): string {
  return JSON.stringify({
    key: e.key,
    type: e.type ?? '',
    ttlMs: typeof e.ttlMs === 'number' ? e.ttlMs : -1,
    payload: e.payload,
  });
}

/**
 * Quét theo pattern rồi DUMP theo lô, trả về nội dung tệp NDJSON.
 *
 * Quét và dump XEN KẼ nhau chứ không quét hết rồi mới dump: một prefix khớp 100.000 key thì "quét
 * hết trước" nghĩa là giữ cả danh sách trong RAM và không báo được tiến độ thật trong suốt pha đầu.
 * Cách này cũng làm cửa sổ giữa SCAN và DUMP hẹp nhất có thể, tức là ít key hết hạn giữa hai lệnh.
 */
export async function buildRedisExport(
  spec: RedisExportSpec,
  reader: RedisExportReader,
): Promise<RedisExportResult> {
  const cap = spec.maxKeys ?? EXPORT_KEY_CAP;
  const wantType = (spec.typeFilter || '').trim();
  const lines: string[] = [
    JSON.stringify({
      tablenova: TRANSFER_KIND,
      version: TRANSFER_VERSION,
      createdAt: spec.createdAt,
      db: spec.db,
      pattern: spec.pattern,
    }),
  ];

  const missing: string[] = [];
  let written = 0;
  let filtered = 0;
  let scanned = 0;
  let capped = false;
  let stopped = false;
  let cursor = 0;
  let pending: string[] = [];

  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const batch = pending;
    pending = [];
    const res = await reader.dump(batch);
    if (!res.success) throw new Error(res.error || 'DUMP failed');
    for (const e of res.entries) {
      lines.push(entryLine(e));
      written += 1;
    }
    if (res.missing?.length) missing.push(...res.missing);
    spec.onProgress?.({ phase: 'dump', done: written, total: undefined });
    return true;
  };

  do {
    if (spec.shouldStop?.()) { stopped = true; break; }

    const page = await reader.scan(spec.pattern, cursor, EXPORT_SCAN_COUNT);
    if (!page.success) throw new Error(page.error || 'SCAN failed');
    cursor = page.cursor;
    scanned += page.keys.length;

    for (const item of page.keys) {
      if (wantType && item.type !== wantType) { filtered += 1; continue; }
      if (written + pending.length >= cap) { capped = true; break; }
      pending.push(item.key);
    }
    spec.onProgress?.({ phase: 'scan', done: scanned });

    if (pending.length >= DUMP_BATCH) await flush();
    if (capped) break;
  } while (cursor !== 0);

  await flush();

  // Footer chỉ ghi khi bản xuất ĐẦY ĐỦ. Dừng giữa chừng hoặc chạm trần thì tệp cố ý không có footer,
  // để lúc nhập lại nó hiện ra là "có thể thiếu" thay vì trông như một bản xuất trọn vẹn.
  const complete = !capped && !stopped;
  if (complete) {
    lines.push(JSON.stringify({ tablenova: TRANSFER_END_KIND, keys: written }));
  }

  return {
    // Luôn trả nội dung tệp, kể cả khi không khớp key nào (chỉ còn header): "có nên lưu một tệp
    // rỗng không" là quyết định của dialog, và nó đã có `keys` để biết.
    text: `${lines.join('\n')}\n`,
    keys: written,
    missing,
    filtered,
    capped,
    stopped,
  };
}

export interface ParsedExport {
  header: TransferHeader | null;
  entries: RedisDumpEntry[];
  /** Dòng không parse được hoặc không phải bản ghi dùng được, theo số dòng (1-based). */
  badLines: number[];
  /**
   * Không có dòng footer. Tệp bị cắt, hoặc là bản xuất đã dừng giữa chừng / chạm trần. Vẫn nhập
   * được phần đang có — chỉ là người dùng phải biết nó không đủ.
   */
  truncated: boolean;
  /** Số key footer khai báo, để đối chiếu với số bản ghi đọc được. */
  declaredKeys: number | null;
}

/**
 * Đọc một tệp NDJSON đã xuất. Thuần, không IO — đây là phần được test dày nhất của module.
 *
 * Một dòng hỏng KHÔNG làm cả tệp thất bại: nó vào `badLines` và những dòng còn lại vẫn nhập được.
 * Với 100.000 key thì "cả tệp vô hiệu vì dòng 4 bị lỗi" là kết cục tệ nhất có thể.
 */
export function parseRedisExport(text: string): ParsedExport {
  const out: ParsedExport = {
    header: null,
    entries: [],
    badLines: [],
    truncated: true,
    declaredKeys: null,
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      out.badLines.push(i + 1);
      continue;
    }

    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;

    if (obj.tablenova === TRANSFER_KIND) {
      out.header = {
        tablenova: String(obj.tablenova),
        version: typeof obj.version === 'number' ? obj.version : 0,
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
        db: typeof obj.db === 'number' ? obj.db : 0,
        pattern: typeof obj.pattern === 'string' ? obj.pattern : '',
      };
      continue;
    }
    if (obj.tablenova === TRANSFER_END_KIND) {
      out.truncated = false;
      out.declaredKeys = typeof obj.keys === 'number' ? obj.keys : null;
      continue;
    }
    if (isValidEntry(parsed)) {
      out.entries.push({
        key: parsed.key,
        type: typeof parsed.type === 'string' ? parsed.type : '',
        ttlMs: typeof parsed.ttlMs === 'number' ? parsed.ttlMs : -1,
        payload: parsed.payload,
      });
      continue;
    }
    out.badLines.push(i + 1);
  }

  return out;
}

/** Phần `dbHelper` mà việc nhập cần. */
export interface RedisImportWriter {
  restore(
    entries: RedisDumpEntry[],
    replace: boolean,
  ): Promise<{
    success: boolean;
    restored: number;
    skipped: number;
    failed: { key: string; error: string }[];
    error?: string;
  }>;
}

export interface RedisImportSpec {
  /** RESTORE … REPLACE: ghi đè key đã tồn tại. Tắt thì key đã có được đếm vào `skipped`. */
  replace: boolean;
  /** Chỉ nhập những kiểu này. Rỗng = mọi kiểu. */
  types?: string[];
  onProgress?: (p: TransferProgress) => void;
  shouldStop?: () => boolean;
}

export interface RedisImportResult {
  restored: number;
  /** Key đã tồn tại và không chọn ghi đè. */
  skipped: number;
  failed: { key: string; error: string }[];
  stopped: boolean;
}

/**
 * Nạp các bản ghi đã đọc vào Redis, theo lô.
 *
 * Lỗi của một lô không dừng cả lần nhập (`failed` gom lại và chạy tiếp) — trừ khi cả lệnh thất bại
 * (mất kết nối, chế độ chỉ đọc), lúc đó chạy tiếp chỉ là lặp lại đúng lỗi đó vài trăm lần.
 */
export async function applyRedisImport(
  entries: RedisDumpEntry[],
  writer: RedisImportWriter,
  spec: RedisImportSpec,
): Promise<RedisImportResult> {
  const want = new Set((spec.types || []).filter(Boolean));
  const list = want.size > 0 ? entries.filter((e) => want.has(e.type)) : entries;

  const out: RedisImportResult = { restored: 0, skipped: 0, failed: [], stopped: false };
  for (let i = 0; i < list.length; i += RESTORE_BATCH) {
    if (spec.shouldStop?.()) { out.stopped = true; break; }
    const batch = list.slice(i, i + RESTORE_BATCH);
    const res = await writer.restore(batch, spec.replace);
    if (!res.success) throw new Error(res.error || 'RESTORE failed');
    out.restored += res.restored;
    out.skipped += res.skipped;
    if (res.failed?.length) out.failed.push(...res.failed);
    spec.onProgress?.({
      phase: 'restore',
      done: Math.min(i + batch.length, list.length),
      total: list.length,
    });
  }
  return out;
}

/** Đếm bản ghi theo kiểu, cho phần tóm tắt của dialog nhập. */
export function countByType(entries: RedisDumpEntry[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.type || '?', (m.get(e.type || '?') ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
}

/**
 * Tên tệp gợi ý. Prefix đi vào tên nên phải bỏ ký tự không hợp lệ trên đường dẫn Windows
 * (`: * ? " < > |` — và `:` thì gần như mọi prefix Redis đều có).
 */
export function suggestExportFileName(db: number, prefix: string, createdAt: string): string {
  const slug = (prefix.trim() || 'all').replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '');
  const stamp = createdAt.replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `redis-db${db}-${slug || 'all'}-${stamp}.ndjson`;
}
