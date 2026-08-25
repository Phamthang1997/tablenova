// Exporting / importing part of a Redis keyspace by prefix.
//
// The same pipeline as `dumpBuilder.ts` on the SQL side: the file contents are assembled HERE, while
// database access comes in through the `reader`/`writer` parameters rather than importing
// `dbHelper`. That keeps this module free of `@tauri-apps/api` and makes the most fragile part — the
// file format and the batching loop — checkable by unit test (`__tests__/redisTransfer.test.ts`).
//
// FORMAT: NDJSON, one key per line.
//
//   {"tablenova":"redis-keys","version":1,"createdAt":"…","db":0,"pattern":"user:*"}
//   {"key":"user:1","type":"string","ttlMs":-1,"payload":"<base64 DUMP>"}
//   …
//   {"tablenova":"redis-keys-end","keys":123}
//
// Three decisions behind it:
//
//  1. **NDJSON, not one big JSON.** An export can be hundreds of thousands of keys; read line by
//     line it can report progress, and a file cut off midway loses only its tail instead of failing
//     to parse at all.
//  2. **The last line is a footer carrying the key count.** That is the only way to tell a truncated
//     file: a missing footer means the export never finished, and `parseRedisExport` says so instead
//     of silently importing less.
//  3. **A record uses exactly the field names `redis_dump_keys` returns and `redis_restore_keys`
//     accepts.** One shape from Redis to the file and back into Redis: no renaming layer to drift.
//
// `payload` is DUMP's raw bytes, base64-encoded — the note on `redis_dump_keys` in `redis_db.rs`
// explains why DUMP/RESTORE rather than a readable JSON serializer, and why the file only restores
// into a Redis of the same version or newer.

import { folderMatchPattern } from './redisKeyTree';

/** The marker on the first line. A different one means this is not a file from this feature. */
export const TRANSFER_KIND = 'redis-keys';

/** The marker on the last line. Its presence means the export ran to completion. */
export const TRANSFER_END_KIND = 'redis-keys-end';

/** Format version. Bumped when the record shape changes in a way older readers cannot handle. */
export const TRANSFER_VERSION = 1;

/** SCAN COUNT per round while exporting. Higher than the key browser's, because nothing is drawn here. */
export const EXPORT_SCAN_COUNT = 500;

/** Keys per DUMP round. Below Rust's `TRANSFER_BATCH_MAX` so one batch always fits a single IPC message. */
export const DUMP_BATCH = 200;

/** Keys per RESTORE round. Rust runs them one at a time within the batch (see `redis_restore_keys`). */
export const RESTORE_BATCH = 200;

/**
 * The cap on how many keys one export holds in memory.
 *
 * The same reasoning as the key browser's `KEY_CAP`: the file contents are assembled in RAM before
 * being saved, so a prefix matching two million keys would take the tab down. On hitting the cap it
 * STOPS AND SAYS SO (`capped`), never truncating silently.
 */
export const EXPORT_KEY_CAP = 100_000;

/** One record in the file — also exactly the shape `redis_dump_keys` returns. */
export interface RedisDumpEntry {
  key: string;
  /** The Redis type at export time. Not needed by RESTORE; it is here so filtering and counting need not decode the payload. */
  type: string;
  /** Remaining TTL in milliseconds. -1 = no TTL (PTTL's convention). */
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

/** The phase currently running. A code, not a sentence — the dialog is the place with `t()`. */
export type TransferPhase = 'scan' | 'dump' | 'restore';

export interface TransferProgress {
  phase: TransferPhase;
  /** Keys scanned (the `scan` phase) or processed (the `dump`/`restore` phases). */
  done: number;
  /** The known total, when there is one. The `scan` phase has none — SCAN does not say how many are left. */
  total?: number;
}

export interface RedisExportSpec {
  /** The glob handed to SCAN. Built from the prefix by `prefixPattern()`. */
  pattern: string;
  /** The db index, only ever written into the header. */
  db: number;
  /** Type filtering on the client side, exactly as the key browser does (SCAN TYPE is Redis 6.0+). */
  typeFilter?: string;
  /** The timestamp written into the header. A parameter rather than `new Date()` inside: tests need determinism. */
  createdAt: string;
  maxKeys?: number;
  onProgress?: (p: TransferProgress) => void;
  /** The user pressed Stop. Checked between batches, so a batch already running finishes. */
  shouldStop?: () => boolean;
}

/** The part of `dbHelper` an export needs. `dbHelper` already matches this shape. */
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
  /** The file contents. With no key matched there is still a header — read `keys` to see what is in it. */
  text: string;
  /** How many records were written. */
  keys: number;
  /**
   * Keys that SCAN returned but DUMP answered nil for — expired or deleted between the two commands.
   * Not an error, but it has to be said: it is the gap between "scanned" and "written".
   */
  missing: string[];
  /** Dropped by `typeFilter`. */
  filtered: number;
  /** Hit `maxKeys` -> the export is NOT complete. */
  capped: boolean;
  /** The user stopped midway -> also incomplete. */
  stopped: boolean;
}

/**
 * A glob matching every key under a prefix. An empty prefix -> `*` (the whole db).
 *
 * Escaping is delegated to `folderMatchPattern` rather than copied here: it already does exactly
 * this for the key tree's "delete this folder" menu, and two parallel escapers are two things to
 * keep in sync by hand. Escaping is required, not tidiness: the prefix is a string the user typed
 * (or a branch of the tree) and can perfectly well contain `[`, `*`, `?`. Concatenating
 * `prefix + '*'` makes `log[1]:` search not for keys starting with `log[1]:` but for keys starting
 * with `log1:` — the wrong set of keys exported, with nothing said.
 */
export function prefixPattern(prefix: string): string {
  const p = prefix.trim();
  return p ? folderMatchPattern(p) : '*';
}

/**
 * The prefix inferred from a glob, only ever used to pre-fill the dialog's prefix field. Returns
 * `''` when nothing can be inferred.
 *
 * The key browser's search box takes a *pattern* (`user:*`) while the dialog takes a *prefix*, so
 * whatever joins them has to drop the trailing `*`. But only when the body holds NO glob
 * metacharacters left: `prefixPattern` will escape it again, so `a\*b*` would infer the prefix
 * `a\*b`, get escaped a second time, and become a quite different glob. When it cannot be inferred,
 * leave it empty and let the user type.
 */
export function patternToPrefix(pattern: string): string {
  const p = pattern.trim();
  if (!p || p === '*') return '';
  const body = p.endsWith('*') ? p.slice(0, -1) : p;
  return /[\\*?[\]]/.test(body) ? '' : body;
}

/** Standard base64, padded — exactly what `base64::engine::general_purpose::STANDARD` produces. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Whether a parsed line is a usable record.
 *
 * Checked here rather than left to Rust: a malformed record is a fault of the FILE, and the message
 * about it has to be in the active language — Rust has only Vietnamese, and `failed[].error` does
 * not go through `backendErrors.ts`. The base64 is checked too, because `RESTORE` with a garbage
 * payload returns a driver error far harder to read than "line 12 of the file is invalid".
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

/** One record -> one line of the file. */
function entryLine(e: RedisDumpEntry): string {
  return JSON.stringify({
    key: e.key,
    type: e.type ?? '',
    ttlMs: typeof e.ttlMs === 'number' ? e.ttlMs : -1,
    payload: e.payload,
  });
}

/**
 * Scans by pattern and DUMPs in batches, returning the NDJSON file contents.
 *
 * Scanning and dumping are INTERLEAVED rather than scan-everything-then-dump: for a prefix matching
 * 100,000 keys, "scan it all first" means holding the whole list in RAM and reporting no real
 * progress through the entire first phase. Interleaving also keeps the window between SCAN and DUMP
 * as narrow as possible, so fewer keys expire between the two commands.
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

  // The footer is written only for a COMPLETE export. Stopped midway or capped, the file deliberately
  // has none, so that on import it shows up as "possibly incomplete" rather than looking whole.
  const complete = !capped && !stopped;
  if (complete) {
    lines.push(JSON.stringify({ tablenova: TRANSFER_END_KIND, keys: written }));
  }

  return {
    // Always return the file contents, even with no key matched (header only): whether an empty file
    // is worth saving is the dialog's decision, and it already has `keys` to decide with.
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
  /** Lines that would not parse, or are not usable records, by line number (1-based). */
  badLines: number[];
  /**
   * There is no footer line. Either the file was truncated, or the export stopped midway / hit its
   * cap. What is there still imports — the user simply has to know it is not everything.
   */
  truncated: boolean;
  /** The key count the footer declares, to check against the records actually read. */
  declaredKeys: number | null;
}

/**
 * Reads an exported NDJSON file. Pure, no IO — the most heavily tested part of this module.
 *
 * A bad line does NOT fail the whole file: it goes into `badLines` and the rest still imports. With
 * 100,000 keys, "the entire file is void because line 4 is broken" is the worst outcome available.
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

/** The part of `dbHelper` an import needs. */
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
  /** RESTORE … REPLACE: overwrite an existing key. With it off, existing keys count into `skipped`. */
  replace: boolean;
  /** Import only these types. Empty = every type. */
  types?: string[];
  onProgress?: (p: TransferProgress) => void;
  shouldStop?: () => boolean;
}

export interface RedisImportResult {
  restored: number;
  /** The key already existed and overwriting was not chosen. */
  skipped: number;
  failed: { key: string; error: string }[];
  stopped: boolean;
}

/**
 * Loads the records already read into Redis, batch by batch.
 *
 * One batch failing does not stop the import (`failed` collects them and it carries on) — unless the
 * whole command fails (connection lost, read-only mode), where carrying on would only repeat the
 * same error a few hundred times.
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

/** Counts records by type, for the import dialog's summary. */
export function countByType(entries: RedisDumpEntry[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.type || '?', (m.get(e.type || '?') ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
}

/**
 * The suggested file name. The prefix goes into it, so characters Windows paths reject have to go
 * (`: * ? " < > |` — and nearly every Redis prefix contains `:`).
 */
export function suggestExportFileName(db: number, prefix: string, createdAt: string): string {
  const slug = (prefix.trim() || 'all').replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '');
  const stamp = createdAt.replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `redis-db${db}-${slug || 'all'}-${stamp}.ndjson`;
}
