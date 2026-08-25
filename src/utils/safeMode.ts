// Safe Mode — a per-server policy that asks the user to confirm before a command reaches the
// database. TablePlus-style, minus its two password modes (see docs note at the bottom).
//
// Why the gate lives on the frontend and not in Rust: it needs a dialog. A Rust-side gate would
// have to park the command, emit an event, wait for an answer over a channel and re-enter — a lot
// of machinery for a check that has exactly one natural home, `dbHelper`'s single local `invoke()`
// through which every one of its call sites already passes.
//
// The trap this file is built around: **not every write sends SQL text from the frontend.**
// `commit_changes` (the grid's Save), `drop_table`, `alter_table_schema`, `restore_backup`,
// `generate_data` and friends build their SQL inside Rust from a payload. So the gate classifies
// *commands*, not just SQL, and an unlisted command counts as a write — forgetting to classify a
// new one costs a needless prompt instead of a silent bypass. `__tests__/safeMode.test.ts` reads
// `dbHelper.ts` and fails when a command it invokes is missing from the table below, the same way
// `locales.test.ts` and `backendErrors.test.ts` keep their twins honest.

import { findUnsafeStatements, maskForSplit, splitStatements, type UnsafeStatementKind } from '../sql/statements';
import i18n from '../i18n';
import { connKey } from './connKey';
import type { DbConnectionConfig } from './dbHelper';

export type SafeMode = 'silent' | 'writes' | 'all';

/** Ordered from permissive to strict — the control renders them in this order. */
export const SAFE_MODES: readonly SafeMode[] = ['silent', 'writes', 'all'] as const;

const STRICTNESS: Record<SafeMode, number> = { silent: 0, writes: 1, all: 2 };

/**
 * How a command relates to Safe Mode.
 *
 *  - `internal`: never prompts. Introspection, connection lifecycle, terminal I/O, the OS keychain,
 *    the transaction controls. These are not statements the user typed: gating `get_tables` would
 *    prompt when the sidebar loads, and gating `tx_commit` would double up on the pending-changes
 *    dialog that already lists every statement about to be committed.
 *  - `write`: prompts in every mode except `silent`.
 *  - `sql`: carries a `sql` argument, so the decision comes from the text — `writes` prompts only
 *    when a statement in it is not a plain read, `all` prompts either way.
 */
export type CommandKind = 'internal' | 'write' | 'sql';

/**
 * Every command `dbHelper` invokes. Unlisted ⇒ `write`, so the failure mode of forgetting one is a
 * prompt too many. Keep in mind while editing: `internal` is not "harmless", it is "not a statement
 * the user issued" — that is the line being drawn.
 */
export const COMMAND_KINDS: Record<string, CommandKind> = {
  // --- SQL carried from the frontend ---
  execute_query: 'sql',
  execute_multi_query: 'sql',
  execute_query_stream: 'sql',

  // --- Writes whose SQL is built in Rust from a payload ---
  alter_sequence: 'write',
  alter_table_schema: 'write',
  commit_changes: 'write',
  create_database: 'write',
  create_table: 'write',
  drop_database: 'write',
  drop_sequence: 'write',
  drop_table: 'write',
  drop_trigger: 'write',
  generate_data: 'write',
  import_new_table: 'write',
  import_table_data: 'write',
  rename_database: 'write',
  rename_table: 'write',
  restore_backup: 'write',
  save_routine_definition: 'write',
  save_trigger: 'write',
  save_view_definition: 'write',
  truncate_table: 'write',

  // --- Redis writes ---
  redis_delete_by_pattern: 'write',
  redis_delete_keys: 'write',
  // Nhập keyspace: RESTORE write cả một lô key, đúng thứ Safe Mode tồn tại to hỏi trước.
  redis_restore_keys: 'write',
  // Arbitrary command text, so it can be anything: a write by default.
  redis_execute_cmd: 'write',
  redis_flush_db: 'write',
  redis_hash_del: 'write',
  redis_hash_set: 'write',
  redis_json_del: 'write',
  redis_json_set: 'write',
  redis_list_del: 'write',
  redis_list_push: 'write',
  redis_list_set: 'write',
  redis_publish: 'write',
  redis_rename_key: 'write',
  redis_set_del_member: 'write',
  redis_set_key: 'write',
  redis_set_key_bytes: 'write',
  redis_set_member: 'write',
  redis_set_ttl: 'write',
  redis_slowlog_config: 'write',
  redis_stream_ack: 'write',
  redis_stream_add: 'write',
  redis_stream_claim: 'write',
  redis_stream_del: 'write',
  redis_zset_add: 'write',
  redis_zset_del: 'write',

  // --- Introspection / metadata ---
  get_all_databases_sizes: 'internal',
  get_all_databases_stats: 'internal',
  get_all_triggers: 'internal',
  get_check_constraints: 'internal',
  get_connection_status: 'internal',
  ping_connections: 'internal',
  get_database_objects: 'internal',
  get_database_stats: 'internal',
  get_databases_list: 'internal',
  get_db_charsets: 'internal',
  get_exact_table_row_count: 'internal',
  get_full_catalog: 'internal',
  get_generation_targets: 'internal',
  get_object_definition: 'internal',
  get_sequences: 'internal',
  get_table_data: 'internal',
  get_table_ddl_extras: 'internal',
  get_table_definition: 'internal',
  get_table_partitions: 'internal',
  get_table_schema: 'internal',
  get_table_triggers: 'internal',
  get_tables: 'internal',
  list_connections: 'internal',
  list_databases: 'internal',
  list_schemas: 'internal',
  // Both return SQL text without running it.
  preview_alter_schema: 'internal',
  preview_generated_data: 'internal',
  compare_data_overview: 'internal',
  compare_schemas: 'internal',
  compare_table_data: 'internal',

  // --- Connection lifecycle. `connect_db` must stay open: the connection has to exist before
  //     there is a server whose mode could be read. ---
  connect_db: 'internal',
  disconnect_db: 'internal',
  open_database: 'internal',
  set_connection_read_only: 'internal',
  set_current_schema: 'internal',
  // Đặt limit time for statement: một cài đặt of phiên, not must statement user
  // run. Hỏi lại at đây thì Safe Mode 'all' will bật hộp thoại ngay giữa lúc user currently cố
  // build một row rào an toàn.
  set_statement_timeout: 'internal',
  cancel_query: 'internal',
  cancel_data_generation: 'internal',

  // --- Manual transaction. The pending-changes dialog is itself the confirmation. ---
  tx_any_pending: 'internal',
  tx_commit: 'internal',
  tx_rollback: 'internal',
  tx_rollback_to: 'internal',
  tx_savepoint: 'internal',
  tx_set_autocommit: 'internal',
  tx_set_isolation: 'internal',
  tx_status: 'internal',

  // --- Terminal. A PTY is not a SQL path and the user is typing into it directly; prompting per
  //     keystroke would be absurd. Out of Safe Mode's scope by nature, not because it is safe. ---
  close_local_terminal: 'internal',
  close_ssh_terminal: 'internal',
  open_local_terminal: 'internal',
  open_ssh_terminal: 'internal',
  resize_local_terminal: 'internal',
  resize_ssh_terminal: 'internal',
  send_local_input: 'internal',
  send_ssh_input: 'internal',

  // --- Redis reads / session-level ---
  redis_analyze_db: 'internal',
  redis_connect: 'internal',
  redis_disconnect: 'internal',
  redis_get_elements: 'internal',
  redis_get_key: 'internal',
  // DUMP read-only — cùng hạng with redis_get_key, not must một lệnh user gõ.
  redis_dump_keys: 'internal',
  redis_info: 'internal',
  redis_json_get: 'internal',
  redis_monitor_start: 'internal',
  redis_pubsub_start: 'internal',
  redis_scan_keys: 'internal',
  redis_scan_stream: 'internal',
  redis_select_db: 'internal',
  redis_set_read_only: 'internal',
  redis_slowlog_get: 'internal',
  redis_slowlog_reset: 'internal',
  redis_stream_consumers: 'internal',
  redis_stream_groups: 'internal',
  redis_stream_pending: 'internal',

  // --- Not database access at all ---
  // The OS keychain, written while saving a connection profile.
  secret_delete_many: 'internal',
  secret_get_many: 'internal',
  secret_set_many: 'internal',
  ai_chat: 'internal',
  open_url: 'internal',
};

export function commandKind(cmd: string): CommandKind {
  return COMMAND_KINDS[cmd] ?? 'write';
}

/** `payload.preview === true`, tức lời gọi này chỉ build SQL chứ not run. */
function isDryRunPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { preview?: unknown }).preview === true
  );
}

// ===== Statement classification =====

/**
 * Statement heads that only read. Everything else counts as a write, including `WITH` (Postgres
 * allows `WITH … DELETE`) and anything unrecognised — the same conservative direction as
 * `is_write_stmt()` in `tx_session.rs`, where over-reporting costs a prompt and under-reporting
 * loses data.
 */
const READ_HEADS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']);

/** First keyword of a statement, uppercased. Reads the masked text so a leading comment or a
 *  quoted identifier cannot be mistaken for a keyword. */
export function statementHead(statement: string): string {
  const masked = maskForSplit(statement);
  // `(SELECT …) UNION …` is still a read; strip the wrapping parens first.
  const m = /^[\s(]*([A-Za-z_]+)/.exec(masked);
  return m ? m[1].toUpperCase() : '';
}

export function isReadStatement(statement: string): boolean {
  return READ_HEADS.has(statementHead(statement));
}

/** True when at least one statement in the text is not a plain read. */
export function sqlHasWrite(sql: string): boolean {
  return splitStatements(sql).some((s) => !isReadStatement(s.text));
}

/** How many statements of the dialog's list are shown before it stops listing them. */
export const STATEMENT_PREVIEW_CAP = 20;

export interface SqlSummary {
  /** Statement texts, capped at `STATEMENT_PREVIEW_CAP`. */
  preview: string[];
  /** Total number of statements — exact, even when `preview` is capped. */
  total: number;
  /** Count per leading keyword, e.g. `{ UPDATE: 12, DELETE: 3 }`. Exact. */
  counts: Record<string, number>;
  /** Shapes that look like a typo rather than an intent, from the SQL editor's own detector. */
  unsafe: { kind: UnsafeStatementKind; text: string }[];
}

export function summarizeSql(sql: string): SqlSummary {
  const statements = splitStatements(sql);
  const counts: Record<string, number> = {};
  for (const s of statements) {
    const head = statementHead(s.text) || '?';
    counts[head] = (counts[head] ?? 0) + 1;
  }
  return {
    preview: statements.slice(0, STATEMENT_PREVIEW_CAP).map((s) => s.text),
    total: statements.length,
    counts,
    unsafe: findUnsafeStatements(sql),
  };
}

// ===== Which server a command lands on =====

// `conn_id -> connKey`. The backend mints connection ids and deliberately never hands the config
// back (it carries credentials), so the mapping is recorded here by `dbHelper` as it connects.
const keyByConn = new Map<string, string>();

export function registerConnection(connId: string, config?: DbConnectionConfig | null): void {
  const key = connKey(config);
  if (connId && key) keyByConn.set(connId, key);
}

/** `open_database` mints a new id on the SAME server, so the mode carries over. */
export function inheritConnection(fromConnId: string, toConnId: string): void {
  const key = keyByConn.get(fromConnId);
  if (key && toConnId) keyByConn.set(toConnId, key);
}

export function forgetConnection(connId: string): void {
  keyByConn.delete(connId);
}

/**
 * Test seam. Both the id→server registry and the parsed-mode cache are module state, so clearing
 * `localStorage` alone would leave a test reading the previous one's values.
 */
export function resetSafeModeState(): void {
  keyByConn.clear();
  cache = null;
  // Một cửa `runApproved` còn open sau when reset is một hành động already duyệt is mang sang cảnh khác —
  // vô hại in app (reset chỉ run lúc disconnect) nhưng is rò rỉ giữa hai test.
  openBatches.clear();
}

/**
 * Which server's policy applies to a command.
 *
 * Redis used to need a prefix special case here, because `RedisState` in Rust was one global
 * connection and `redis_*` carried no `connId`. It is a registry entry with an id like any other
 * now (`redis-ui-unification-plan.md` §2.3), so it resolves through the same map — which is also
 * what makes two Redis servers with different policies possible at all.
 */
function keyForCommand(_cmd: string, connId: string): string {
  return keyByConn.get(connId) ?? '';
}

/**
 * `connKey` of một `connId`, or `''` when chưa biết.
 *
 * for những chỗ chỉ có id in tay (component receive `connId` qua props) mà cần danh tính **server**
 * to read một thiết lập save theo server. Bản đồ này already tồn tại vì cổng Safe Mode cần nó; open ra at đây
 * to not ai must build bản thứ hai and ism hai bên lệch nhau.
 */
export function connKeyOfConn(connId: string): string {
  return keyByConn.get(connId) ?? '';
}

// ===== Stored modes =====

// One record of `connKey(config) -> SafeMode`, i.e. keyed by SERVER, per `connKey.ts`: the policy
// belongs to "prod.db:5432", not to a database name (`database || sqlitePath` would collide across
// servers) and not to a connection id (which is minted fresh on every connect).
const STORAGE_KEY = 'tf_safe_mode';
export const SAFE_MODE_CHANGED_EVENT = 'safe-mode-changed';

/**
 * Parsed modes, memoised. The gate runs in front of *every* backend command, so an unconditional
 * `localStorage.getItem` + `JSON.parse` here would put synchronous storage I/O on the hot path of a
 * feature that is off by default. Invalidated by our own writes and by another window's (the
 * standalone terminal window shares this storage).
 */
let cache: Record<string, SafeMode> | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === STORAGE_KEY) cache = null;
  });
}

function readAll(): Record<string, SafeMode> {
  if (cache) return cache;
  try {
    if (typeof localStorage === 'undefined') return (cache = {});
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return (cache = {});
    const parsed = JSON.parse(raw);
    return (cache = parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    return (cache = {});
  }
}

/**
 * The mode stored for one server (`connKey`). This is the primitive: the control reads and writes by
 * key, because the frontend has the config in hand and does not need the id indirection at all.
 *
 * An empty key — a command whose server could not be resolved — falls back to the **strictest** mode
 * any server is configured with: an unrouted call must not end up less protected than the
 * connections the user did configure.
 */
export function getSafeModeForKey(key: string): SafeMode {
  const all = readAll();
  if (key) return all[key] ?? 'silent';

  let strictest: SafeMode = 'silent';
  for (const mode of Object.values(all)) {
    if (STRICTNESS[mode] > STRICTNESS[strictest]) strictest = mode;
  }
  return strictest;
}

/** The mode in force for an open SQL connection id. */
export function getSafeMode(connId: string): SafeMode {
  return getSafeModeForKey(keyByConn.get(connId) ?? '');
}

export function setSafeModeForKey(key: string, mode: SafeMode): void {
  if (!key) return;
  const all = { ...readAll() };
  if (mode === 'silent') delete all[key];
  else all[key] = mode;
  cache = all;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A full quota must not make the control look broken; the mode simply does not persist.
  }
  // Under Vitest's node environment there is no `window` — the same reason the i18n language
  // detector no-ops there. Guard rather than crash the module on import.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SAFE_MODE_CHANGED_EVENT));
  }
}

// ===== The gate =====

export interface SafeModeRequest {
  connId: string;
  mode: SafeMode;
  /** The Tauri command about to run — shown verbatim, it is the most precise label there is. */
  command: string;
  /**
   * Điều hành động này sắp ism, bằng câu chữ already dịch, do chỗ gọi `runApproved()` cung cấp.
   *
   * Tên command một mình đủ chính xác for một lệnh lẻ, nhưng not nói is "10.000 key, có write
   * đè" — mà with một hành động chỉ is hỏi ĐÚNG MỘT LẦN for cả lần run thì đó chính is thứ
   * user cần biết to trả lời.
   */
  detail?: string;
  /** Present only for `sql` commands. */
  sql?: SqlSummary;
  /** Đối tượng cụ thể mà lệnh này nhắm ando, rút ra from chính tham số of nó. */
  target?: CommandTarget;
}

/**
 * "Việc này sắp ism gì, with cái gì" — rút ra from args of lệnh.
 *
 * not có gì is đoán: mọi trường at đây is thứ chỗ gọi already send xuống backend. Trước when có nó, hộp
 * thoại nói "việc này write ando DB" rồi in tên hàm Rust — đúng nhưng user not trả lời is,
 * vì câu hỏi thật of họ is "write mấy row, ando table nào".
 */
export interface CommandTarget {
  /** Tên table / database / key / pattern mà lệnh nhắm ando. */
  name?: string;
  /** Số change theo loại — chỉ `commit_changes` có. */
  changes?: { inserts: number; updates: number; deletes: number };
  /** Số phần tử when lệnh receive một mảng (row import, key Redis…). */
  count?: number;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/**
 * read args of một lệnh thành thứ display is. returns object rỗng when not rút is gì — hộp
 * thoại lúc đó lùi về đúng những gì nó vẫn hiện, chứ not isa ra một cái tên.
 *
 * Cố tình not must một table tra theo fromng tên lệnh: tham số of các lệnh này already đặt tên theo cùng
 * quy ước (`name`/`tableName`/`keys`/`pattern`), nên read theo quy ước phủ is cả những lệnh add
 * sau mà not ai must nhớ cập nhật table. add một lệnh with tham số tên khác thì mất phần ngữ cảnh
 * — not must hiện sai.
 */
export function describeCommand(cmd: string, args: Record<string, unknown>): CommandTarget {
  const payload = (typeof args.payload === 'object' && args.payload !== null
    ? args.payload
    : {}) as Record<string, unknown>;

  const out: CommandTarget = {};
  out.name =
    str(args.name) ?? str(args.tableName) ?? str(payload.tableName) ?? str(args.pattern) ?? str(args.key);

  const changes = arr(payload.changes) ?? arr(args.changes);
  if (cmd === 'commit_changes' && changes) {
    out.changes = {
      inserts: changes.filter((c) => (c as { type?: string })?.type === 'insert').length,
      updates: changes.filter((c) => (c as { type?: string })?.type === 'update').length,
      deletes: changes.filter((c) => (c as { type?: string })?.type === 'delete').length,
    };
  } else {
    const list = arr(args.keys) ?? arr(args.rows) ?? changes;
    if (list) out.count = list.length;
  }
  return out;
}

type Confirmer = (req: SafeModeRequest) => Promise<boolean>;

let confirmer: Confirmer | null = null;

/** `SafeModeGate` registers the dialog here on mount. */
export function setSafeModeConfirmer(fn: Confirmer | null): void {
  confirmer = fn;
}

// ===== Một hành động, một lần hỏi =====
//
// `SafeModeGate` already write rõ nguyên tắc of nó: "One prompt per *action*, never per statement" —
// run một tệp 500 statement thì hỏi một lần. Nhưng nguyên tắc đó chỉ tự đúng when một hành động is
// MỘT lệnh backend, còn `approveCommand` thì run trước fromng `invoke`.
//
// Nhập keyspace Redis is hành động đầu tiên in app phá vỡ điều đó: nó gọi `redis_restore_keys`
// theo fromng lô (`RESTORE_BATCH` = 200), nên 10.000 key is 50 lần hỏi. not ai trả lời 50 hộp
// thoại — họ tắt Safe Mode, tức is cái giá for một tính năng lại is mất hẳn cổng bảo vệ.
//
// `runApproved()` hỏi một lần for cả vòng lặp rồi open một "cửa" in lúc run. Cửa đó hẹp có chủ ý:
//
//  - key theo **đúng tên command + đúng connId**. Một lần nhập already duyệt not thể for
//    `redis_flush_db`, hay cùng lệnh đó on một connection khác, đi kèm qua cổng.
//  - close in `finally`, nên một lần run error giữa đường not to cửa open lại sau lưng.
//  - Đếm theo tầng (`Map` giá trị số) chứ not must một cờ bật/tắt: hai lần run lồng nhau or
//    song song on cùng command thì lần kết thúc trước not close cửa of lần còn currently run.
//
// Cái nó not ism: nhớ câu trả lời sau when hành động kết thúc. not có "đừng hỏi lại nữa" — lần
// nhập sau vẫn hỏi.
const openBatches = new Map<string, number>();

const batchKey = (cmd: string, connId: string) => `${cmd} @ ${connId}`;

/**
 * run `run()` như MỘT hành động under mắt Safe Mode: hỏi một lần trước, rồi mọi lệnh `cmd` on
 * `connId` phát ra bên in đó not is hỏi lại.
 *
 * `detail` is câu mô tả already dịch dành for hộp thoại ("Nhập 10.000 key ando db0, write đè key already có") —
 * chỗ gọi có `t()`, còn module này thì not nên tự build câu.
 *
 * user from chối thì hàm **throw** đúng string mà `dbHelper` throw when một lệnh lẻ is from chối,
 * nên chỗ gọi not cần biết cổng already chặn at tầng nào.
 */
export async function runApproved<T>(
  cmd: string,
  connId: string,
  detail: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = batchKey(cmd, connId);
  const mode = getSafeModeForKey(keyForCommand(cmd, connId));
  const wouldAsk = mode !== 'silent' && commandKind(cmd) !== 'internal' && !openBatches.has(key);

  // Cửa này che luôn cả lần warning mà `approveCommand` in ra when hộp thoại chưa mount, nên nó
  // must tự in — not thì một confirmer null trat thành im lặng hoàn toàn.
  if (wouldAsk && !confirmer) {
    console.warn(`[safe-mode] no confirmer registered; ${cmd} ran without asking`);
  }
  if (wouldAsk && confirmer && !(await confirmer({ connId, mode, command: cmd, detail }))) {
    throw i18n.t('safeMode.cancelled');
  }

  openBatches.set(key, (openBatches.get(key) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (openBatches.get(key) ?? 1) - 1;
    if (left > 0) openBatches.set(key, left);
    else openBatches.delete(key);
  }
}

/**
 * Would Safe Mode ask about this SQL? Used by `SqlEditor` so its own "this will wipe data" prompt
 * does not stack a second dialog on top of this one for the same run.
 */
export function willPromptForSql(connId: string, sql: string): boolean {
  const mode = getSafeMode(connId);
  if (mode === 'all') return true;
  if (mode === 'writes') return sqlHasWrite(sql);
  return false;
}

/**
 * Decides whether `cmd` may run, asking the user when the mode says so. Returns false only when the
 * user actually declined.
 */
export async function approveCommand(cmd: string, args: Record<string, unknown>): Promise<boolean> {
  const connId = typeof args.connId === 'string' ? args.connId : '';
  // currently at in một hành động mà user already duyệt for cả lần run (`runApproved`) -> not hỏi
  // lại. key gồm cả `connId`, nên cửa này not open for cùng lệnh đó on connection khác.
  if (openBatches.has(batchKey(cmd, connId))) return true;

  const mode = getSafeModeForKey(keyForCommand(cmd, connId));
  if (mode === 'silent') return true;

  // run thử thì not hỏi. `commit_changes` is MỘT command ism hai việc: `preview: true` chỉ build
  // SQL rồi returns (xem `database.rs`), còn not có cờ đó mới is write thật — nên cái categorize theo
  // tên lệnh not tách is hai đường này. Grid gọi cả hai for một lần Save (một lần to hiện danh
  // sách preview, một lần to write), nên if not có nhánh này thì user must trả lời hai hộp
  // thoại giống nhau and cái thứ nhất hỏi về một việc not write gì cả.
  //
  // Điều kiện chặt: đúng `=== true`. Thiếu cờ, cờ sai kiểu, hay payload lạ đều rơi về "hỏi", cùng
  // hướng an toàn with việc một command chưa categorize is tính is `write`.
  if (cmd === 'commit_changes' && isDryRunPayload(args.payload)) return true;

  const kind = commandKind(cmd);
  if (kind === 'internal') return true;

  let sql: SqlSummary | undefined;
  if (kind === 'sql') {
    const text = typeof args.sql === 'string' ? args.sql : '';
    if (mode === 'writes' && !sqlHasWrite(text)) return true;
    sql = summarizeSql(text);
  }

  if (!confirmer) {
    // Reached only if the gate component is not mounted. Blocking here would make the app look
    // broken with no explanation anywhere, so the call goes through and says why in the console.
    console.warn(`[safe-mode] no confirmer registered; ${cmd} ran without asking`);
    return true;
  }
  return confirmer({ connId, mode, command: cmd, sql, target: describeCommand(cmd, args) });
}
