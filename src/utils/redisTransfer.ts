// Xuất / nhập một phần keyspace Redis theo prefix.
//
// Cùng đường ống with `dumpBuilder.ts` bên SQL: nội dung tệp is build at ĐÂY, còn truy cập database
// đi qua tham số `reader`/`writer` chứ not import `dbHelper`. Nhờ vậy module này not phụ thuộc
// `@tauri-apps/api` and phần dễ hỏng nhất — định dạng tệp and vòng lặp phân lô — kiểm chứng is bằng
// unit test (`__tests__/redisTransfer.test.ts`).
//
// ĐỊNH DẠNG: NDJSON, mỗi key một row.
//
//   {"tablenova":"redis-keys","version":1,"createdAt":"…","db":0,"pattern":"user:*"}
//   {"key":"user:1","type":"string","ttlMs":-1,"payload":"<base64 DUMP>"}
//   …
//   {"tablenova":"redis-keys-end","keys":123}
//
// Ba quyết định đứng sau nó:
//
//  1. **NDJSON chứ not một JSON lớn.** Bản xuất can is row trăm nghìn key; read theo row thì
//     báo is tiến độ and một tệp is cắt giữa chừng chỉ mất phần đuôi thay vì not parse is gì.
//  2. **row cuối is footer có số key.** Đó is cách unique to biết một tệp is cắt: thiếu footer
//     nghĩa is bản xuất chưa xong, and `parseRedisExport` nói ra điều đó thay vì im lặng nhập thiếu.
//  3. **Bản write dùng đúng tên trường mà `redis_dump_keys` returns and `redis_restore_keys` receive.**
//     Một hình dạng unique from Redis ra tệp rồi ando lại Redis: not có tầng rename nào to lệch.
//
// `payload` is byte thô of DUMP, mã hoá base64 — xem chú thích at `redis_dump_keys` in
// `redis_db.rs` giải thích vì sao is DUMP/RESTORE chứ not must một bộ tuần tự JSON read is, and
// vì sao tệp chỉ nhập lại is ando Redis cùng phiên bản or mới hơn.

import { folderMatchPattern } from './redisKeyTree';

/** Nhãn receive dạng at row đầu. Sai nhãn = not must tệp of tính năng này. */
export const TRANSFER_KIND = 'redis-keys';

/** Nhãn at row cuối. Có nó nghĩa is bản xuất already run xong. */
export const TRANSFER_END_KIND = 'redis-keys-end';

/** Phiên bản định dạng. Tăng when hình dạng bản write đổi theo cách not read ngược is. */
export const TRANSFER_VERSION = 1;

/** SCAN COUNT mỗi vòng when xuất. Lớn hơn of trình duyệt key vì at đây not vẽ gì ra màn hình. */
export const EXPORT_SCAN_COUNT = 500;

/** Số key mỗi lượt DUMP. Nhỏ hơn `TRANSFER_BATCH_MAX` of Rust to một lô luôn vừa một message IPC. */
export const DUMP_BATCH = 200;

/** Số key mỗi lượt RESTORE. Rust run fromng key một in lô này (xem `redis_restore_keys`). */
export const RESTORE_BATCH = 200;

/**
 * Trần số key một bản xuất giữ in bộ nhớ.
 *
 * Cùng lý lẽ with `KEY_CAP` of trình duyệt key: nội dung tệp is ghép in RAM trước when save, nên
 * một prefix khớp hai triệu key will ism sập tab. Chạm trần thì stop and NÓI RA (`capped`), not bao
 * giờ cắt im lặng.
 */
export const EXPORT_KEY_CAP = 100_000;

/** Một bản write in tệp — cũng chính is hình dạng `redis_dump_keys` returns. */
export interface RedisDumpEntry {
  key: string;
  /** Kiểu Redis lúc xuất. not cần for RESTORE; có to filter/thống kê mà not must giải mã payload. */
  type: string;
  /** TTL còn lại theo milli giây. -1 = not có TTL (quy ước of PTTL). */
  ttlMs: number;
  /** Byte of DUMP, base64. */
  payload: string;
}

export interface TransferHeader {
  tablenova: string;
  version: number;
  createdAt: string;
  db: number;
  pattern: string;
}

/** Giai đoạn currently run. returns mã chứ not must câu chữ — dialog mới is chỗ có `t()`. */
export type TransferPhase = 'scan' | 'dump' | 'restore';

export interface TransferProgress {
  phase: TransferPhase;
  /** Số key already quét (pha `scan`) or already handle (pha `dump`/`restore`). */
  done: number;
  /** Tổng already biết, if biết. Pha `scan` not biết trước — SCAN not nói còn bao nhiêu. */
  total?: number;
}

export interface RedisExportSpec {
  /** Glob send for SCAN. build from prefix bằng `prefixPattern()`. */
  pattern: string;
  /** Db index, chỉ to write ando header. */
  db: number;
  /** filter theo kiểu at phía client, y như trình duyệt key (SCAN TYPE is Redis 6.0+). */
  typeFilter?: string;
  /** Thời điểm write ando header. Tham số chứ not `new Date()` bên in: test cần tất định. */
  createdAt: string;
  maxKeys?: number;
  onProgress?: (p: TransferProgress) => void;
  /** user bấm stop. Kiểm giữa hai lô, nên một lô currently run vẫn run hết. */
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
  /** Nội dung tệp. not khớp key nào thì vẫn có header — xem `keys` to biết nó có gì. */
  text: string;
  /** Số bản write already write. */
  keys: number;
  /**
   * Key có in kết quả SCAN nhưng DUMP trả nil — hết hạn or is delete giữa hai lệnh. not must
   * error, nhưng must nói ra: nó is chênh lệch giữa "already quét" and "already write".
   */
  missing: string[];
  /** is `typeFilter` loại. */
  filtered: number;
  /** Chạm `maxKeys` -> bản xuất not đầy đủ. */
  capped: boolean;
  /** user stop giữa chừng -> cũng not đầy đủ. */
  stopped: boolean;
}

/**
 * Glob khớp mọi key under một prefix. Prefix rỗng -> `*` (toàn bộ db).
 *
 * Việc escape đi qua `folderMatchPattern` chứ not có một bản riêng at đây: nó already ism đúng việc đó
 * for menu "delete cả nhóm" of cây key, and hai bản escape song song is hai thứ must giữ sync bằng
 * tay. Escape is bắt buộc chứ not must for gọn: prefix is string user gõ (or một nhánh of
 * cây) nên hoàn toàn can chứa `[`, `*`, `?`. Ghép thẳng `prefix + '*'` thì `log[1]:` not find
 * key bắt đầu bằng `log[1]:` mà find key bắt đầu bằng `log1:` — xuất sai tập key, not báo gì.
 */
export function prefixPattern(prefix: string): string {
  const p = prefix.trim();
  return p ? folderMatchPattern(p) : '*';
}

/**
 * Prefix suy ra from một glob, chỉ to điền sẵn ô prefix of dialog. returns `''` when not suy is.
 *
 * Ô search of trình duyệt key receive một *pattern* (`user:*`), còn dialog receive một *prefix*, nên
 * chỗ nối hai thứ must bỏ dấu `*` at cuối. Nhưng chỉ ism vậy when phần thân not còn character đặc biệt:
 * `prefixPattern` will escape lại lần nữa, nên `a\*b*` suy thành prefix `a\*b` rồi is escape lần hai
 * thành một glob khác hẳn. not đoán is thì to trống, user tự gõ.
 */
export function patternToPrefix(pattern: string): string {
  const p = pattern.trim();
  if (!p || p === '*') return '';
  const body = p.endsWith('*') ? p.slice(0, -1) : p;
  return /[\\*?[\]]/.test(body) ? '' : body;
}

/** Base64 chuhide, có padding — đúng thứ `base64::engine::general_purpose::STANDARD` sinh ra. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Một row already parse có must bản write dùng is not.
 *
 * Kiểm at đây chứ not to Rust kiểm: một bản write khuyết is error of TỆP, and thông báo về nó must
 * bằng ngôn ngữ currently dùng — Rust chỉ có tiếng Việt and `failed[].error` not đi qua
 * `backendErrors.ts`. Kiểm cả base64 vì `RESTORE` with payload rác returns error driver khó hiểu hơn
 * nhiều so with "row thứ 12 of tệp not valid".
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

/** Một bản write -> một row of tệp. */
function entryLine(e: RedisDumpEntry): string {
  return JSON.stringify({
    key: e.key,
    type: e.type ?? '',
    ttlMs: typeof e.ttlMs === 'number' ? e.ttlMs : -1,
    payload: e.payload,
  });
}

/**
 * Quét theo pattern rồi DUMP theo lô, returns nội dung tệp NDJSON.
 *
 * Quét and dump XEN KẼ nhau chứ not quét hết rồi mới dump: một prefix khớp 100.000 key thì "quét
 * hết trước" nghĩa is giữ cả danh sách in RAM and not báo is tiến độ thật in suốt pha đầu.
 * Cách này cũng ism window giữa SCAN and DUMP hẹp nhất can, tức is ít key hết hạn giữa hai lệnh.
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

  // Footer chỉ write when bản xuất ĐẦY ĐỦ. stop giữa chừng or chạm trần thì tệp cố ý not có footer,
  // to lúc nhập lại nó hiện ra is "can thiếu" thay vì trông như một bản xuất trọn vẹn.
  const complete = !capped && !stopped;
  if (complete) {
    lines.push(JSON.stringify({ tablenova: TRANSFER_END_KIND, keys: written }));
  }

  return {
    // Luôn trả nội dung tệp, kể cả when not khớp key nào (chỉ còn header): "có nên save một tệp
    // rỗng not" is quyết định of dialog, and nó already có `keys` to biết.
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
  /** row not parse is or not must bản write dùng is, theo số row (1-based). */
  badLines: number[];
  /**
   * not có row footer. Tệp is cắt, or is bản xuất already stop giữa chừng / chạm trần. Vẫn nhập
   * is phần currently có — chỉ is user must biết nó not đủ.
   */
  truncated: boolean;
  /** Số key footer khai báo, to đối chiếu with số bản write read is. */
  declaredKeys: number | null;
}

/**
 * read một tệp NDJSON already xuất. Thuần, not IO — đây is phần is test dày nhất of module.
 *
 * Một row hỏng not ism cả tệp failed: nó ando `badLines` and những row còn lại vẫn nhập is.
 * with 100.000 key thì "cả tệp vô hiệu vì row 4 is error" is kết cục tệ nhất can.
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
  /** RESTORE … REPLACE: write đè key already tồn tại. Tắt thì key already có is đếm ando `skipped`. */
  replace: boolean;
  /** Chỉ nhập những kiểu này. Rỗng = mọi kiểu. */
  types?: string[];
  onProgress?: (p: TransferProgress) => void;
  shouldStop?: () => boolean;
}

export interface RedisImportResult {
  restored: number;
  /** Key already tồn tại and not select write đè. */
  skipped: number;
  failed: { key: string; error: string }[];
  stopped: boolean;
}

/**
 * load các bản write already read ando Redis, theo lô.
 *
 * error of một lô not stop cả lần nhập (`failed` gom lại and run tiếp) — trừ when cả lệnh failed
 * (mất kết nối, read-only mode), lúc đó run tiếp chỉ is lặp lại đúng error đó andi trăm lần.
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

/** Đếm bản write theo kiểu, for phần tóm tắt of dialog nhập. */
export function countByType(entries: RedisDumpEntry[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.type || '?', (m.get(e.type || '?') ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
}

/**
 * Tên tệp suggestion. Prefix đi ando tên nên must bỏ character not valid on đường dẫn Windows
 * (`: * ? " < > |` — and `:` thì gần như mọi prefix Redis đều có).
 */
export function suggestExportFileName(db: number, prefix: string, createdAt: string): string {
  const slug = (prefix.trim() || 'all').replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '');
  const stamp = createdAt.replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `redis-db${db}-${slug || 'all'}-${stamp}.ndjson`;
}
