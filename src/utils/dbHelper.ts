import { invoke as rawInvoke, Channel } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { translateBackendError, translateResultErrors } from './backendErrors';
import {
  approveCommand,
  forgetConnection,
  inheritConnection,
  registerConnection,
} from './safeMode';
import { getStmtTimeoutForConfig } from './stmtTimeout';
import type {
  CompareSide,
  DataCompareResult,
  DataOverviewResult,
  SchemaCompareResult,
} from './compareHelper';
import type {
  GenPreview,
  GenProgress,
  GenResult,
  GenSpec,
  GenTargets,
} from './dataGenHelper';

/**
 * Which backend connection commands act on. Set from `connect()`'s response, cleared by
 * `disconnect()`.
 *
 * **A migration shim, not the design.** `docs/multi-connection-plan.md` §4.1 rules out an ambient
 * "active connection" precisely because a module-level value read here is the race it describes:
 * with two tabs on two connections, whichever one wrote last decides where the other one's query
 * goes. It is safe only while Phase 1 keeps the backend at exactly one connection, and Phase 2's
 * exit condition is that nothing reads it — each tab passes the `connId` it owns instead.
 */
let currentConnId = '';

/** Returns the minted id so `App.tsx` can hand it to the tab that owns the connection (Phase 2). */
export function activeConnId(): string {
  return currentConnId;
}

/**
 * Point every later command at a different open connection. The rail calls this when the user
 * switches; `connect()` sets it for a brand-new connection.
 *
 * Still the ambient shim §4.1 rules out as a *design* — it is honest only while the UI shows one
 * connection at a time. Phase 3 replaces it with each tab passing the `connId` it owns.
 */
export function setActiveConnId(id: string): void {
  currentConnId = id;
}

/** One entry of the backend's connection registry — see `list_connections`. */
export interface OpenConnection {
  connId: string;
  db: string;
  /** `redis` kể from when Redis dùng chung registry — rail vẽ cả hai from một danh sách (§2.3). */
  dialect: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  serverId: string;
  schema: string | null;
  /** Số câu write currently wait commit on kết nối này — badge of rail (§4.2b). */
  pending: number;
  /** Kết nối currently from chối mọi câu write. */
  readOnly: boolean;
  /** Is this connection visible to AI clients through the built-in MCP server? Default false. */
  mcpExposed: boolean;
}

/** State of the built-in MCP server. `url` is empty while stopped, so no one copies a dead address. */
export interface McpStatus {
  running: boolean;
  port: number;
  url: string;
}

/** One request an AI client made. Mirrors `mcp/audit.rs`. */
export interface McpAuditEntry {
  /** Monotonic within one app run — a stable React key for a list that grows at the front. */
  id: number;
  at: string;
  tool: string;
  connId: string | null;
  sql: string | null;
  sqlTruncated: boolean;
  ms: number;
  ok: boolean;
  /** Absent when `ok`. */
  denial?: 'notShared' | 'notReadOnly' | 'manualTransaction' | 'failed';
  /** Which defence layer refused; `0` when the database itself failed. */
  layer?: number;
  message?: string;
}

/**
 * Every backend call goes through here so the Vietnamese error text the Rust side
 * returns is mapped to the active UI language in ONE place — see `backendErrors.ts`.
 * Shadowing the imported name keeps all existing `await invoke(...)` call sites
 * unchanged; a message with no mapping is passed through untouched.
 *
 * The same trick now also supplies `connId` to every connection-bound command, so adding that
 * argument on the Rust side cost zero of the 210 `dbHelper.*` call sites. A command that does not
 * declare it simply ignores the extra field — Tauri deserializes by name.
 */
async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const merged = { connId: currentConnId, ...args };
  // Safe Mode asks here, in front of every command, because this is the single funnel every
  // `dbHelper.*` call passes through — see `safeMode.ts` for why the gate is not in Rust and why a
  // command missing from its table counts as a write. Declining throws, like a backend error would,
  // so the surrounding `catch` in each method turns it into the usual `{ success: false, error }`.
  if (!(await approveCommand(cmd, merged))) throw i18n.t('safeMode.cancelled');
  try {
    return translateResultErrors(await rawInvoke<T>(cmd, merged));
  } catch (err) {
    // A command that returns Err(String) surfaces here as a thrown *string*, and the
    // catch blocks below interpolate it directly (`${err}`). Rethrow a string, not an
    // Error, so the message does not gain an "Error: " prefix.
    throw typeof err === 'string' ? translateBackendError(err) : err;
  }
}

/**
 * Chỉ đặt `connId` when có giá trị thật.
 *
 * not viết thẳng `{ ...args, connId }` is: `invoke` at on merge `{ connId: currentConnId,
 * ...args }`, nên một `connId: undefined` tường minh will **write đè** id ambient bằng `undefined` and
 * mọi lệnh mất kết nối. Đây is chỗ unique biết luật đó.
 */
function withConnId(args: Record<string, unknown>, connId?: string): Record<string, unknown> {
  return connId ? { ...args, connId } : args;
}

// Message do backend đẩy qua Channel when stream kết quả SQL (execute_query_stream).
export interface QueryStreamMessage {
  type: 'columns' | 'rows' | 'affected' | 'done' | 'error';
  stmtIndex?: number;
  query?: string;
  columns?: string[];
  rows?: any[];
  affected?: number;
  stmtCount?: number;
  cancelled?: boolean;
  message?: string;
}

// Message do backend đẩy qua Channel for SSH Terminal (open_ssh_terminal).
export interface SshTerminalMessage {
  type: 'data' | 'exit' | 'closed';
  bytes?: number[];
  code?: number;
}

export interface TriggerInfo {
  name: string;
  timing: string;
  event: string;
  statement: string;
}

export interface SequenceInfo {
  name: string;
  dataType: string;
  startValue: string;
  minVal: string;
  maxVal: string;
  incrementBy: string;
  cycle: boolean;
}

export interface PartitionInfo {
  name: string;
  method: string;
  expression: string;
  description: string;
  tableRows: number;
  dataLength: number;
}

export interface CheckConstraintInfo {
  name: string;
  expression: string;
  enforced: boolean;
}

export interface DbConnectionConfig {
  type: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  sqlitePath?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  dbIndex?: number; // Redis: chỉ số database 0-15
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshPassword?: string;
  sshKeyPath?: string;
  sshKeyContent?: string;
  sshPassphrase?: string;
  sslEnabled?: boolean;
  sslMode?: string;
  sslKeyPath?: string;
  sslCertPath?: string;
  sslCaPath?: string;
  /**
   * Số giây tối đa for MỘT statement user run (SQL editor + read trang at grid). `0`/vắng =
   * not limit. Postgres/MySQL; SQLite skip (xem `stmt_timeout` in `database.rs`).
   */
  statementTimeoutSecs?: number;
  // AWS IAM authentication (RDS/Aurora)
  authMethod?: 'password' | 'aws_iam';
  awsAuthType?: 'access_key' | 'profile';
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsProfile?: string;
  awsRegion?: string;
}

/**
 * status phiên current connection (`get_connection_status`).
 *
 * Mọi trường mô tả phiên đều "best effort" phía Rust: server cũ or tài khoản
 * thiếu quyền thì trả string rỗng chứ not báo error, nên chỗ display must tự
 * handle giá trị rỗng. `cipher`/`tlsVersion` rỗng nghĩa is phiên not mã hoá.
 */
export interface ConnectionStatus {
  isConnected: boolean;
  dbType: string;
  connType: 'loc' | 'ssh' | 'ssl' | 'rem';
  host: string;
  latencyMs: number;
  serverVersion: string;
  user: string;
  database: string;
  port: number;
  cipher: string;
  tlsVersion: string;
}

/**
 * status transaction manual. Rust is nguồn sự thật unique: frontend not phân tích SQL
 * to đoán transaction còn open hay not — xem `src-tauri/src/tx_session.rs`. Mỗi lần status đổi,
 * backend phát sự kiện `tx-state-changed` kèm đúng object này.
 */
export interface TxStatus {
  autocommit: boolean;
  open: boolean;
  /** Postgres: một câu error ism hỏng cả transaction, chỉ còn rollback is. */
  aborted: boolean;
  /** Số statement **write** in transaction. Câu read (SELECT/SHOW/...) open transaction nhưng
   *  not is đếm — con số này hứa "bấy nhiêu change currently wait commit". */
  statements: number;
  /** SQL of đúng những câu đó, to hộp thoại "change currently wait" display. */
  pendingSql: string[];
  /** Nhật ký already chạm trần size -> `pendingSql` ít hơn `statements`, must nói ra. */
  sqlTruncated: boolean;
  sinceMs: number;
  isolation: string | null;
  readOnly: boolean;
  savepoints: string[];
  /** statement vừa run already tự commit (DDL on MySQL) -> bộ đếm về 0 not must do user. */
  implicitCommit: boolean;
  /**
   * Kết nối mà status này thuộc về. Mỗi kết nối một phiên, and backend phát một
   * `tx-state-changed` for fromng phiên — `TxControl` filter theo field này, if not thì event of
   * kết nối thứ hai will write đè display of kết nối thứ nhất.
   *
   * not bắt buộc: backend cũ hơn window currently run will not send nó (`tauri dev` giữ lại binary
   * build is gần nhất when Rust error biên dịch).
   */
  connId?: string;
}

export const TX_EVENT = 'tx-state-changed';

/** Mức cô lập theo fromng dialect — twin of `isolation_allowed` in tx_session.rs. */
export const TX_ISOLATION_LEVELS: Record<string, string[]> = {
  postgres: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  mysql: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  // SQLite not có isolation level; thứ tương ứng is mức key of BEGIN.
  sqlite: ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'],
};

export interface TableItem {
  name: string;
  type: 'table' | 'view';
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue: string | null;
  autoIncrement?: boolean;
  comment?: string | null;
  extra?: string | null;
  /**
   * column do database TỰ TÍNH (`GENERATED ALWAYS AS (...)`). write ando is error (MySQL 3105), nên
   * dump must bỏ hẳn khỏi danh sách column of INSERT.
   */
  generated?: boolean;
  /**
   * Postgres `GENERATED ALWAYS AS IDENTITY`. Khác `generated`: column này VẪN must nằm in
   * INSERT (bỏ đi is đánh số lại toàn bộ and mọi foreign key trỏ tới nó sai theo), chỉ is câu
   * lệnh cần add `OVERRIDING SYSTEM VALUE`.
   */
  identityAlways?: boolean;
  characterSet?: string | null;
  collation?: string | null;
}

export interface SchemaInfo {
  columns: ColumnInfo[];
  indexes: { name: string; columns: string; unique: boolean }[];
  foreignKeys: { name?: string; column: string; refTable: string; refColumn: string }[];
}

export interface GridChange {
  type: 'insert' | 'update' | 'delete';
  rowId: any;
  originalData?: any;
  newData?: any;
}

// ---- Redis types ----
export interface RedisKeyItem {
  key: string;
  type: string; // string | hash | list | set | zset | stream
  ttl: number; // -1 = not hết hạn, -2 = not tồn tại
}

export interface RedisValueDetail {
  success: boolean;
  key: string;
  type: string;
  ttl: number;
  memory: number | null;
  /** Số phần tử of collection (HLEN/LLEN/SCARD/ZCARD/XLEN); null with string. */
  length?: number | null;
  value: any; // shape tùy kind (xem redis_get_key backend)
  message?: string;
}

/** Kết quả of một lệnh edit phần tử (hash/list/set/zset/stream). */
export interface RedisEditResult {
  success: boolean;
  error?: string;
}

/**
 * Một phần tử of collection. `binary` = giá trị gốc not must UTF-8 valid, `value` already is
 * lossy-convert -> not is write lại (will thay bytes thật bằng U+FFFD). Xem `is_binary` in
 * `redis_db.rs`.
 */
export interface RedisElement {
  value: string;
  binary?: boolean;
  /** Identity of the element is itself binary (hash field, set/zset member) -> delete is unsafe too. */
  binaryKey?: boolean;
}

/** What the connected server supports, probed once at connect (see `RedisCaps` in Rust). */
export interface RedisCaps {
  version: string;
  major: number;
  minor: number;
  /** Lowercased module names; empty when `MODULE LIST` was refused by ACL. */
  modules: string[];
}

/**
 * One page of a collection. `nextCursor` is **opaque** — its meaning differs per type
 * (SCAN cursor / rank / index / stream id) and only `redis_db.rs` knows which; pass it back
 * unchanged.
 */
export interface RedisElementsPage {
  success: boolean;
  kind: string;
  elements: any[];
  nextCursor: string;
  done: boolean;
  error?: string;
}

export interface RedisSlowLogEntry {
  id: number;
  timestamp: number;
  durationUs: number;
  args: string[];
  clientAddr: string;
  clientName: string;
}

export interface RedisAnalysis {
  success: boolean;
  dbsize: number;
  sampled: number;
  sampledBytes: number;
  estimatedBytes: number | null;
  byType: { name: string; count: number; bytes: number }[];
  byNamespace: { name: string; count: number; bytes: number }[];
  ttlBuckets: { noExpiry: number; under1h: number; under1d: number; under7d: number; over7d: number };
  topKeys: { key: string; bytes: number; type: string }[];
  warnings?: string[];
  cancelled?: boolean;
  error?: string;
}

/**
 * `translateResultErrors` only covers the `message`/`error` fields. The comparison
 * commands also return a `warnings` array of backend strings, so run those through the
 * same table — otherwise an English UI would show Vietnamese notes.
 */
function translateWarnings<T extends { warnings?: string[] }>(res: T): T {
  if (Array.isArray(res?.warnings)) {
    res.warnings = res.warnings.map((w) => (typeof w === 'string' ? translateBackendError(w) : w));
  }
  return res;
}

export const dbHelper = {
  async connect(
    config: DbConnectionConfig,
  ): Promise<{
    success: boolean;
    message: string;
    database?: string;
    schema?: string | null;
    /** Id kết nối vừa mint. Redis cũng returns from when nó dùng chung registry (§2.3). */
    connId?: string;
  }> {
    // Redis đi qua bộ command redis_* riêng (not dùng connect_db of SQL).
    if (config.type === 'redis') {
      try {
        const res: any = await invoke('redis_connect', {
          config: {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            dbIndex: config.dbIndex ?? 0,
            // TLS: `sslEnabled` is công tắc cũ (profile trước when có tab SSL chỉ có nó),
            // `sslMode` mới is thứ quyết định mức check chứng chỉ — xem redis_ssl_mode
            // trong redis_db.rs.
            sslEnabled: config.sslEnabled,
            sslMode: config.sslMode,
            sslKeyPath: config.sslKeyPath,
            sslCertPath: config.sslCertPath,
            sslCaPath: config.sslCaPath,
            useSsh: config.sshEnabled,
            sshHost: config.sshHost,
            sshPort: config.sshPort,
            sshUser: config.sshUser,
            sshAuthType: config.sshAuthType,
            sshPassword: config.sshPassword,
            sshKeyPath: config.sshKeyPath,
            sshKeyContent: config.sshKeyContent,
            sshPassphrase: config.sshPassphrase,
          },
        });
        if (res.success) {
          // Redis is a registry entry like any other now (`redis-ui-unification-plan.md` §2.3), so
          // it mints a `connId` the same way and every later `redis_*` command carries it through
          // the shim above. Setting it BEFORE `registerConnection` matters: Safe Mode keys the
          // server by this id, and that is what replaced the Redis-only key it used to keep.
          currentConnId = res.connId ?? '';
          registerConnection(currentConnId, config);
          return {
            success: true,
            message: i18n.t('db.redisConnected'),
            database: `db${res.dbIndex ?? config.dbIndex ?? 0}`,
            connId: currentConnId,
          };
        }
        return { success: false, message: res.message || i18n.t('db.errRedisConnect') };
      } catch (err: any) {
        return { success: false, message: i18n.t('db.errRedisConnectDetail', { message: String(err) }) };
      }
    }
    try {
      const mappedConfig = {
        dbType: config.type,
        filePath: config.sqlitePath,
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        useSsh: config.sshEnabled,
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        sshAuthType: config.sshAuthType,
        sshPassword: config.sshPassword,
        sshKeyPath: config.sshKeyPath,
        sshKeyContent: config.sshKeyContent,
        sshPassphrase: config.sshPassphrase,
        sslEnabled: config.sslEnabled,
        sslMode: config.sslMode,
        sslKeyPath: config.sslKeyPath,
        sslCertPath: config.sslCertPath,
        sslCaPath: config.sslCaPath,
        // limit time statement save theo server at localStorage (popover Safe Mode), not
        // nằm in profile. read at đây to một kết nối vừa open already có đúng limit ngay from statement
        // đầu — `setStatementTimeout` chỉ dùng for lần user đổi giữa phiên.
        statementTimeoutSecs: getStmtTimeoutForConfig(config),
        authMethod: config.authMethod,
        awsAuthType: config.awsAuthType,
        awsAccessKeyId: config.awsAccessKeyId,
        awsSecretAccessKey: config.awsSecretAccessKey,
        awsSessionToken: config.awsSessionToken,
        awsProfile: config.awsProfile,
        awsRegion: config.awsRegion,
      };

      const res: any = await invoke('connect_db', { config: mappedConfig });
      if (res.success) {
        // The backend mints the id and hands it back; it is never derived from `config`, which
        // carries credentials (multi-connection-plan §4.3). Every later command carries it.
        currentConnId = res.connId ?? '';
        // Safe Mode is stored per server (`connKey`), and the backend never hands the config back,
        // so the id→server mapping has to be recorded at the one place that has both.
        registerConnection(currentConnId, config);
        // `schema` is the schema the connection actually landed in (Postgres `current_schema()`),
        // null on MySQL/SQLite. Callers key per-connection storage on it — see connKey.ts.
        return {
          success: true,
          message: i18n.t('db.connected'),
          database: config.database || config.sqlitePath,
          schema: res.schema ?? null,
          // Handed back like the Redis branch does. A caller that opens a connection of its own
          // (Connection Manager's Backup screen) must address it by this id: reading the ambient
          // `currentConnId` instead is exactly the race §4.1 rules out, and passing the id of the
          // connection the workspace has open would dump the wrong database.
          connId: currentConnId,
        };
      }
      return { success: false, message: res.message || i18n.t('db.errConnect') };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errBackendUnreachable', { message: String(err) }) };
    }
  },

  /**
   * close một kết nối. not truyền `connId` thì close kết nối currently active.
   *
   * Truyền tường minh is cách rail close một kết nối **not** must cái currently xem — and when đó
   * `currentConnId` must preserve, vì kết nối currently xem not hề is đụng tới.
   */
  async disconnect(connId?: string): Promise<{ success: boolean }> {
    const target = connId ?? currentConnId;
    try {
      const res: any = await invoke('disconnect_db', { connId: target });
      // delete SAU when gọi, and chỉ when close đúng cái currently active: lệnh cần id to biết delete entry nào.
      // Id rỗng thì mọi lệnh sau đó fail bằng đúng error "chưa kết nối" vì `acquire` not resolve
      // is — đó chính is câu trả lời đúng.
      if (target === currentConnId) currentConnId = '';
      forgetConnection(target);
      return { success: !!res.success };
    } catch {
      if (target === currentConnId) currentConnId = '';
      forgetConnection(target);
      return { success: false };
    }
  },

  async getConnectionStatus(): Promise<ConnectionStatus> {
    try {
      const res: any = await invoke('get_connection_status');
      return {
        isConnected: !!res.is_connected,
        dbType: res.db_type || '',
        connType: res.conn_type || 'loc',
        host: res.host || '',
        latencyMs: res.latency_ms || 0,
        serverVersion: res.server_version || '',
        user: res.user || '',
        database: res.database || '',
        port: res.port || 0,
        cipher: res.cipher || '',
        tlsVersion: res.tls_version || '',
      };
    } catch {
      return {
        isConnected: false,
        dbType: '',
        connType: 'loc',
        host: '',
        latencyMs: 0,
        serverVersion: '',
        user: '',
        database: '',
        port: 0,
        cipher: '',
        tlsVersion: '',
      };
    }
  },

  async getTables(connId: string, ): Promise<TableItem[]> {
    try {
      const res: any = await invoke('get_tables', { connId });
      return res.tables || [];
    } catch {
      return [];
    }
  },

  // Lấy toàn bộ catalog (column+kiểu+PK, FK theo table) in ít query to warm cache completion.
  async getFullCatalog(connId: string, ): Promise<{ columns: Record<string, any[]>; foreignKeys: Record<string, any[]> }> {
    try {
      const res: any = await invoke('get_full_catalog', { connId });
      return { columns: res.columns || {}, foreignKeys: res.foreignKeys || {} };
    } catch {
      return { columns: {}, foreignKeys: {} };
    }
  },

  /**
   * Một trang dữ liệu of table, kèm total row count.
   *
   * `countMode` default `'exact'` — mọi lời gọi cũ preserve hành vi. Đừng đổi default này: các
   * đường xuất dữ liệu (`dumpBuilder`, `ExportTableDialog`) lặp for tới when `rows.length >=
   * totalCount`, nên một con số **thiếu** at đó will kết thúc vòng lặp sớm and write ra bản dump is cắt
   * mà not báo error. Chỉ có row status of grid — chỗ display is dấu `~` — mới xin
   * `'auto'`/`'skip'`.
   *
   * `totalCount` is `null` when not đếm (`'skip'`) or đếm failed; `0` chỉ có nghĩa is table
   * rỗng. `hasMore` tới from một row read thừa at backend nên đúng kể cả when số đếm is ước lượng.
   *
   * `seekColumn` + `cursor` is keyset pagination: đưa `nextCursor` of trang trước ando `cursor` thì
   * backend seek thay vì `OFFSET`. Bỏ trống cả hai is quay về phân trang theo số trang. `cursor`
   * đối with frontend is **giá trị mờ** — đừng tự read key from row dữ liệu to build nó: key i64 lớn
   * hơn 2^53 mất chữ số when qua `JSON.parse`, còn `nextCursor` thì backend viết ra chính xác.
   */
  async getTableData(connId: string,
    tableName: string,
    page: number = 1,
    pageSize: number = 100,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
    filter?: string,
    opts: {
      countMode?: 'exact' | 'auto' | 'skip';
      seekColumn?: string | null;
      cursor?: string | null;
    } = {}
  ): Promise<{
    rows: any[];
    totalCount: number | null;
    countExact: boolean;
    hasMore: boolean;
    nextCursor: string | null;
    primaryKey?: string;
  }> {
    try {
      const res: any = await invoke('get_table_data', {
        connId,
        name: tableName,
        page,
        limit: pageSize,
        sortBy: sortBy || null,
        sortDir: sortDir || null,
        filter: filter || null,
        countMode: opts.countMode || 'exact',
        seekColumn: opts.seekColumn || null,
        cursor: opts.cursor || null,
      });
      const rows = res.data || [];
      return {
        rows,
        totalCount: typeof res.totalCount === 'number' ? res.totalCount : null,
        // Một backend cũ not send trường này; coi như đếm chính xác, đúng như nó vẫn ism.
        countExact: res.countExact !== false,
        // Cũng vậy: not có `hasMore` thì suy ra from việc trang có đầy hay not.
        hasMore: typeof res.hasMore === 'boolean' ? res.hasMore : rows.length >= pageSize,
        nextCursor: typeof res.nextCursor === 'string' ? res.nextCursor : null,
        primaryKey: res.primaryKey,
      };
    } catch (err) {
      console.error(err);
      return { rows: [], totalCount: null, countExact: true, hasMore: false, nextCursor: null };
    }
  },

  /**
   * Đổi limit time statement of một kết nối currently open.
   *
   * Có hiệu lực from statement kế tiếp, not cần kết nối lại: backend read lại config at mỗi lần run
   * (xem `stmt_timeout` in `database.rs`). Nơi save lâu dài is localStorage theo server
   * (`stmtTimeout.ts`); lệnh này chỉ sync giá trị đó sang phiên currently run.
   */
  async setStatementTimeout(connId: string, secs: number): Promise<boolean> {
    try {
      await invoke('set_statement_timeout', { connId, secs });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  },

  async getDatabaseObjects(connId: string, ): Promise<{
    tables: string[];
    views: string[];
    functions: string[];
    procedures: string[];
    /** MySQL scheduled event; luôn rỗng at Postgres/SQLite (hai hệ này not có). */
    events: string[];
  }> {
    try {
      const res: any = await invoke('get_database_objects', { connId });
      return {
        tables: res.tables || [],
        views: res.views || [],
        functions: res.functions || [],
        procedures: res.procedures || [],
        events: res.events || [],
      };
    } catch (err) {
      // Nuốt error im lặng at đây fromng ism popup Xuất hiện ra một danh sách thiếu routine mà
      // not có dấu hiệu nào — log lại to còn scan is.
      console.warn('[dbHelper] get_database_objects failed:', err);
      return { tables: [], views: [], functions: [], procedures: [], events: [] };
    }
  },



  async getObjectDefinition(connId: string, name: string, kind: 'view' | 'function' | 'procedure' | 'table' | 'event'): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_object_definition', { connId, name, kind });
      return { success: !!res.success, sql: res.sql, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableTriggers(connId: string, tableName: string): Promise<TriggerInfo[]> {
    try {
      const res: any = await invoke('get_table_triggers', { connId, tableName });
      return res.triggers || [];
    } catch {
      return [];
    }
  },

  /**
   * Mọi trigger of database hiện tại, kèm câu `CREATE TRIGGER` run lại is.
   *
   * Khác `getTableTriggers` (theo fromng table, dùng for tab Structure): bản này for đường xuất
   * dump — một lần gọi for cả database, and có tên table chủ vì Postgres not DROP is trigger
   * if thiếu `ON <table>`.
   */
  async getAllTriggers(connId: string): Promise<{ name: string; table: string; statement: string }[]> {
    try {
      const res: any = await invoke('get_all_triggers', { connId });
      return res.triggers || [];
    } catch (err) {
      console.warn('[dbHelper] get_all_triggers failed:', err);
      return [];
    }
  },

  /**
   * Những statement đi kèm một table nhưng not nằm in CREATE TABLE of dialect đó
   * (index, FK/UNIQUE/CHECK, comment, sequence). Nhóm theo position must run — xem
   * `get_table_ddl_extras` bên Rust.
   */
  async getTableDdlExtras(connId: string, tableName: string): Promise<{
    sequences: string[];
    indexes: string[];
    constraints: string[];
    comments: string[];
    sequenceValues: string[];
  }> {
    const empty = { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
    try {
      const res: any = await invoke('get_table_ddl_extras', { connId, tableName });
      return {
        sequences: res.sequences || [],
        indexes: res.indexes || [],
        constraints: res.constraints || [],
        comments: res.comments || [],
        sequenceValues: res.sequenceValues || [],
      };
    } catch (err) {
      console.warn('[dbHelper] get_table_ddl_extras failed:', err);
      return empty;
    }
  },

  async saveTrigger(connId: string, statementSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_trigger', { connId, statementSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropTrigger(connId: string, triggerName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_trigger', { connId, triggerName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async saveRoutineDefinition(connId: string, routineSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_routine_definition', { connId, routineSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getSequences(connId: string): Promise<SequenceInfo[]> {
    try {
      const res: any = await invoke('get_sequences', { connId });
      return res.sequences || [];
    } catch {
      return [];
    }
  },

  async alterSequence(connId: string, sequenceSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('alter_sequence', { connId, sequenceSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropSequence(connId: string, sequenceName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_sequence', { connId, sequenceName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTablePartitions(connId: string, tableName: string): Promise<PartitionInfo[]> {
    try {
      const res: any = await invoke('get_table_partitions', { connId, tableName });
      return res.partitions || [];
    } catch {
      return [];
    }
  },

  async getCheckConstraints(connId: string, tableName: string): Promise<CheckConstraintInfo[]> {
    try {
      const res: any = await invoke('get_check_constraints', { connId, tableName });
      return res.constraints || [];
    } catch {
      return [];
    }
  },

  async saveViewDefinition(viewSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_view_definition', { viewSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableSchema(connId: string, tableName: string): Promise<SchemaInfo> {
    try {
      const res: any = await invoke('get_table_schema', { connId, name: tableName });
      return {
        columns: res.columns || [],
        indexes: res.indexes || [],
        foreignKeys: res.foreignKeys || [],
      };
    } catch {
      return { columns: [], indexes: [], foreignKeys: [] };
    }
  },

  async executeQuery(connId: string, sql: string, params?: any[]): Promise<{ success: boolean; data?: any[]; columns?: string[]; affectedRows?: number; executionTime?: number; error?: string; results?: any[] }> {
    try {
      const res: any = await invoke('execute_query', { connId, sql, params: params ?? null });
      if (res.success && res.results && res.results.length > 0) {
        return {
          success: true,
          data: res.results[0].data || [],
          columns: res.results[0].columns || [],
        };
      }
      return { success: false, error: i18n.t('db.errNoQueryData') };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errQuery', { message: String(err) }) };
    }
  },

  async executeQueryMulti(connId: string, sql: string): Promise<{ success: boolean; results: { query: string; columns: string[]; data: any[] }[]; error?: string }> {
    try {
      const res: any = await invoke('execute_multi_query', { connId, sql });
      return {
        success: !!res.success,
        results: (res.results || []).map((r: any) => ({
          query: r.query || '',
          columns: r.columns || [],
          data: r.data || [],
        })),
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, results: [], error: i18n.t('db.errQuery', { message: String(err) }) };
    }
  },

  // run SQL and receive kết quả theo fromng batch qua Channel (streaming) thay vì đợi toàn bộ.
  // Promise resolve when backend run xong (already send message 'done' or 'error').
  // queryId dùng to cancel giữa chừng qua cancelQuery.
  async executeQueryStream(connId: string, 
    sql: string,
    queryId: string,
    onMessage: (msg: QueryStreamMessage) => void,
    params?: any[]
  ): Promise<void> {
    const channel = new Channel<QueryStreamMessage>();
    channel.onmessage = onMessage;
    // params: mảng giá trị already ép kiểu (number/bool/null/string) to backend bind at tầng driver
    // (parameterized query, chống SQL injection). skip if not dùng Tham số query.
    await invoke('execute_query_stream', { connId, sql, queryId, channel, params: params ?? null });
  },

  // ---- Transaction manual ----
  // error is ném ra (not nuốt) vì mọi thao tác at đây đều do user bấm trực tiếp:
  // "Commit not successful" mà im lặng is kiểu sai tệ nhất in nhóm này.

  /**
   * Every connection the backend currently holds — what the left rail lists. The rail shows *open
   * connections*, not every database on the server, so this replaces the `list_databases` query it
   * used to run against the active connection.
   */
  /**
   * Bật/tắt read-only mode for MỘT kết nối.
   *
   * Gate nằm at backend, in ba funnel SQL — not must at UI. SQL editor send text tuỳ ý, nên một
   * cái key in WebView is key at sai phía of biên IPC. Đây is đúng kết luận mà
   * `src-tauri/src/redis_db.rs` already write for console Redis.
   */
  async setConnectionReadOnly(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ readOnly: boolean }>('set_connection_read_only', { connId, enabled });
    return !!res.readOnly;
  },

  /**
   * Show one connection to AI clients, or hide it again.
   *
   * Separate from `setConnectionReadOnly` even though the shape matches: "may this be written to"
   * and "may an AI client see it at all" are different questions, and a connection can sensibly be
   * read-only and hidden, or writable and shared.
   */
  async setConnectionMcpExposed(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ mcpExposed: boolean }>('set_connection_mcp_exposed', { connId, enabled });
    return !!res.mcpExposed;
  },

  async mcpStatus(): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_status');
  },

  async mcpStart(port?: number): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_start', { port });
  },

  async mcpStop(): Promise<McpStatus> {
    return invoke<McpStatus>('mcp_stop');
  },

  async mcpGetToken(): Promise<string> {
    return invoke<string>('mcp_get_token');
  },

  /** Mints a new token. The server restarts if it was running, so every client on the old token stops. */
  async mcpRegenerateToken(): Promise<string> {
    return invoke<string>('mcp_regenerate_token');
  },

  /** Newest first. In memory on the Rust side — it does not survive closing the app. */
  async mcpAuditLog(): Promise<McpAuditEntry[]> {
    return invoke<McpAuditEntry[]>('mcp_audit_log');
  },

  async mcpAuditClear(): Promise<void> {
    await invoke<void>('mcp_audit_clear');
  },

  async listConnections(): Promise<OpenConnection[]> {
    const res = await invoke<{ connections: OpenConnection[] }>('list_connections');
    return res.connections || [];
  },

  /**
   * Latency of mọi kết nối currently open, key theo `connId`.
   *
   * Riêng khỏi `getConnectionStatus`, cái đó hỏi add version/user/TLS nên tốn 3–5 round trip mỗi kết
   * nối — xem `ping_connections`. returns `Map` chứ not must mảng vì mọi chỗ dùng đều tra theo id.
   */
  async pingConnections(): Promise<Map<string, { ok: boolean; latencyMs: number }>> {
    const res = await invoke<{ pings: { connId: string; ok: boolean; latencyMs: number }[] }>(
      'ping_connections',
    );
    return new Map((res.pings || []).map((p) => [p.connId, { ok: p.ok, latencyMs: p.latencyMs }]));
  },

  async txStatus(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_status');
  },

  /**
   * Is any connection holding uncommitted changes? The window-close guard asks this instead of
   * reading the shown connection's status — closing the window ends every session, so a per-
   * connection answer would silently discard another tab's transaction.
   */
  async txAnyPending(): Promise<boolean> {
    const res = await invoke<{ anyPending: boolean }>('tx_any_pending');
    return !!res.anyPending;
  },

  async txSetAutocommit(enabled: boolean): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_set_autocommit', { enabled });
  },

  async txSetIsolation(level: string | null, readOnly?: boolean): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_set_isolation', { level, readOnly: readOnly ?? null });
  },

  async txCommit(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_commit');
  },

  async txRollback(): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_rollback');
  },

  async txSavepoint(name: string): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_savepoint', { name });
  },

  async txRollbackTo(name: string): Promise<TxStatus> {
    return await invoke<TxStatus>('tx_rollback_to', { name });
  },

  // Yêu cầu stop một query currently stream. skip if queryId not còn run.
  async cancelQuery(queryId: string): Promise<void> {
    try {
      await invoke('cancel_query', { queryId });
    } catch {
      /* skip */
    }
  },

  // ---- Kho bí mật of HĐH ----
  // Mật khẩu DB, mật khẩu/passphrase/private key SSH, AWS secret key... nằm in
  // Windows Credential Manager / Keychain / Secret Service chứ not in localStorage.
  // Xem src-tauri/src/secret_store.rs and src/utils/secretFields.ts.

  // read các bí mật of một profile. Field chưa fromng save will not có in kết quả.
  async getSecrets(profileId: string, fields: string[]): Promise<Record<string, string>> {
    return await invoke('secret_get_many', { profileId, fields });
  },

  // write các bí mật of một profile. Giá trị rỗng đồng nghĩa with delete field đó.
  async setSecrets(profileId: string, values: Record<string, string>): Promise<void> {
    await invoke('secret_set_many', { profileId, values });
  },

  // delete bí mật of một profile (when delete profile).
  async deleteSecrets(profileId: string, fields: string[]): Promise<void> {
    await invoke('secret_delete_many', { profileId, fields });
  },

  // ---- SSH Terminal ----
  // open phiên SSH + PTY/shell. output server đẩy về qua Channel (onMessage).
  async openSshTerminal(
    profileConfig: DbConnectionConfig,
    sessionId: string,
    cols: number,
    rows: number,
    onMessage: (msg: SshTerminalMessage) => void
  ): Promise<void> {
    const channel = new Channel<SshTerminalMessage>();
    channel.onmessage = onMessage;
    await invoke('open_ssh_terminal', {
      profileConfig: {
        sshHost: profileConfig.sshHost,
        sshPort: profileConfig.sshPort,
        sshUser: profileConfig.sshUser,
        sshAuthType: profileConfig.sshAuthType,
        sshPassword: profileConfig.sshPassword,
        sshKeyPath: profileConfig.sshKeyPath,
        sshKeyContent: profileConfig.sshKeyContent,
        sshPassphrase: profileConfig.sshPassphrase,
      },
      sessionId,
      cols,
      rows,
      channel,
    });
  },

  async sendSshInput(sessionId: string, data: string): Promise<void> {
    try {
      await invoke('send_ssh_input', { sessionId, data });
    } catch {
      /* skip */
    }
  },

  async resizeSshTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_ssh_terminal', { sessionId, cols, rows });
    } catch {
      /* skip */
    }
  },

  async closeSshTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_ssh_terminal', { sessionId });
    } catch {
      /* skip */
    }
  },

  // ---- Local Terminal (shell cục bộ, not qua SSH) ----
  async openLocalTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    onMessage: (msg: SshTerminalMessage) => void
  ): Promise<void> {
    const channel = new Channel<SshTerminalMessage>();
    channel.onmessage = onMessage;
    await invoke('open_local_terminal', { sessionId, cols, rows, channel });
  },

  async sendLocalInput(sessionId: string, data: string): Promise<void> {
    try {
      await invoke('send_local_input', { sessionId, data });
    } catch {
      /* skip */
    }
  },

  async resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_local_terminal', { sessionId, cols, rows });
    } catch {
      /* skip */
    }
  },

  async closeLocalTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_local_terminal', { sessionId });
    } catch {
      /* skip */
    }
  },

  // scan đường dẫn file log of DB server bằng cách hỏi chính DB (run on kết nối currently open).
  // returns danh sách {label, path}. Rỗng if DB write log ra stderr/syslog/TABLE (not có file).
  // scan đường dẫn file log of DB server.
  // returns cả `error` chứ not nuốt error: trước đây try/catch returns mảng rỗng nên
  // mọi failed (mất kết nối, thiếu quyền, driver unsupported) đều hiện ra y như
  // "not có file log" — not thể biết vì sao tính năng not run.
  // Mỗi dialect chỉ dùng MỘT statement, not dựa ando multi-statement of driver.
  async detectLogPaths(connId: string, 
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis'
  ): Promise<{ paths: { label: string; path: string }[]; error?: string }> {
    const isAbs = (s: string) => /^([/~]|[A-Za-z]:[\\/])/.test(s);
    const paths: { label: string; path: string }[] = [];
    const pick = (row: any, key: string) =>
      String(row?.[key] ?? row?.[key.toLowerCase()] ?? '').trim();

    try {
      if (dbType === 'mysql') {
        const res = await this.executeQuery(
          connId,
          "SHOW VARIABLES WHERE Variable_name IN ('log_error','slow_query_log_file','general_log_file','datadir')"
        );
        if (!res.success) return { paths, error: res.error || i18n.t('db.errShowVariables') };
        for (const row of res.data || []) {
          const name = pick(row, 'Variable_name');
          const val = pick(row, 'Value');
          // MySQL trả 'stderr' when log not ra file -> not có gì to tail
          if (name && val && val.toLowerCase() !== 'stderr') {
            paths.push({ label: name, path: val });
          }
        }
      } else if (dbType === 'postgres') {
        const res = await this.executeQuery(
          connId,
          `SELECT 'current_logfile' AS name, pg_current_logfile() AS setting
           UNION ALL
           SELECT name, setting FROM pg_settings
           WHERE name IN ('data_directory','log_directory','log_filename')`
        );
        if (!res.success) return { paths, error: res.error || i18n.t('db.errPgSettings') };
        const map: Record<string, string> = {};
        for (const row of res.data || []) {
          map[pick(row, 'name')] = pick(row, 'setting');
        }
        const dataDir = map['data_directory'] || '';
        const cur = map['current_logfile'];
        const logDir = map['log_directory'];
        if (cur) paths.push({ label: 'current_logfile', path: isAbs(cur) ? cur : `${dataDir}/${cur}` });
        if (logDir) paths.push({ label: 'log_directory', path: isAbs(logDir) ? logDir : `${dataDir}/${logDir}` });
      } else {
        return { paths, error: i18n.t('db.errNoServerLog', { dbType }) };
      }
    } catch (e: any) {
      return { paths, error: String(e?.message || e) };
    }
    return { paths };
  },

  // Bật write log at phía DB server (run on current connection). Cần quyền cao (SUPER/superuser).
  // kind: mysql 'general'|'slow'; postgres 'statements'|'collector'.
  // needsRestart = true nghĩa is must khati động lại server manual thì mới có tác dụng.
  async enableLogging(connId: string, 
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    kind: string
  ): Promise<{ success: boolean; message: string; needsRestart: boolean }> {
    let sql = '';
    let needsRestart = false;
    if (dbType === 'mysql') {
      if (kind === 'general') sql = "SET GLOBAL log_output='FILE'; SET GLOBAL general_log='ON';";
      else sql = "SET GLOBAL slow_query_log='ON'; SET GLOBAL long_query_time=1;";
    } else if (dbType === 'postgres') {
      if (kind === 'collector') { sql = "ALTER SYSTEM SET logging_collector='on';"; needsRestart = true; }
      else sql = "ALTER SYSTEM SET log_statement='all'; SELECT pg_reload_conf();";
    } else {
      return { success: false, message: i18n.t('db.errSqliteNoServerLog'), needsRestart: false };
    }
    const res = await this.executeQueryMulti(connId, sql);
    return { success: res.success, message: res.error || '', needsRestart };
  },

  async disableLogging(connId: string, dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', kind: string): Promise<{ success: boolean; message: string }> {
    let sql = '';
    if (dbType === 'mysql') {
      sql = kind === 'general' ? "SET GLOBAL general_log='OFF';" : "SET GLOBAL slow_query_log='OFF';";
    } else if (dbType === 'postgres') {
      sql = kind === 'collector'
        ? 'ALTER SYSTEM RESET logging_collector;'
        : 'ALTER SYSTEM RESET log_statement; SELECT pg_reload_conf();';
    } else {
      return { success: false, message: i18n.t('db.errNotForSqlite') };
    }
    const res = await this.executeQueryMulti(connId, sql);
    return { success: res.success, message: res.error || '' };
  },

  async commitChanges(connId: string, 
    tableName: string,
    changes: GridChange[],
    primaryKey?: string,
    preview?: boolean
  ): Promise<{ success: boolean; message?: string; sqls?: string[] }> {
    try {
      const res: any = await invoke('commit_changes', { connId, payload: { tableName, changes, primaryKey, preview: !!preview } });
      return { success: !!res.success, sqls: res.sqls, message: res.message };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errCommitChanges', { message: String(err) }) };
    }
  },

  async alterTableSchema(connId: string, 
    tableName: string, 
    changes: { 
      added: any[]; 
      dropped: string[]; 
      renamed: any[]; 
      modified: any[];
      addedIndexes?: any[];
      droppedIndexes?: string[];
      addedFKs?: any[];
      droppedFKs?: any[];
    }
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const res: any = await invoke('alter_table_schema', { connId, name: tableName, payload: changes });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errConnection', { message: String(err) }) };
    }
  },

  async previewAlterTableSchema(connId: string, 
    tableName: string, 
    changes: { 
      added: any[]; 
      dropped: string[]; 
      renamed: any[]; 
      modified: any[];
      addedIndexes?: any[];
      droppedIndexes?: string[];
      addedFKs?: any[];
      droppedFKs?: any[];
    }
  ): Promise<{ success: boolean; sqls?: string[]; error?: string }> {
    try {
      const res: any = await invoke('preview_alter_schema', { connId, name: tableName, payload: changes });
      return {
        success: !!res.success,
        sqls: res.sql ? [res.sql] : [],
      };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errConnection', { message: String(err) }) };
    }
  },

  async askAi(prompt: string, _schemaContext: string): Promise<{ response: string }> {
    try {
      const res: any = await invoke('ai_chat', { message: prompt });
      return { response: res.reply || '' };
    } catch {
      return { response: i18n.t('db.errAiUnreachable') };
    }
  },

  async importNewTable(tableName: string, rows: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('import_new_table', { tableName, rows });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async renameTable(connId: string, oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_table', { connId, oldName, newName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // isView/cascade/ignoreFk is các option of dialog Delete. Backend run cả cụm (tắt kiểm
  // tra foreign key -> DROP -> bật lại) on MỘT connection; đừng tự phát lệnh SET at đây vì mỗi
  // executeQuery lấy một connection khác from pool.
  async dropTable(connId: string, 
    name: string,
    opts?: { isView?: boolean; cascade?: boolean; ignoreFk?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_table', {
        connId,
        name,
        isView: opts?.isView ?? false,
        cascade: opts?.cascade ?? false,
        ignoreFk: opts?.ignoreFk ?? false,
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async listDatabases(connId: string, ): Promise<{ success: boolean; databases: string[]; error?: string }> {
    try {
      const res: any = await invoke('list_databases', { connId });
      return { success: !!res.success, databases: res.databases || [], error: res.message };
    } catch (err: any) {
      return { success: false, databases: [], error: err.toString() };
    }
  },

  /**
   * open một database khác on **cùng server** thành một kết nối MỚI (§4.3).
   *
   * Khác `switchDatabase`: cái kia *thay* pool nên must from chối when còn change chưa commit and
   * must reset phiên transaction. Cái này *add* pool nên not đụng gì currently có — transaction currently
   * open at database hiện tại cứ run tiếp in when user ism việc at database khác.
   *
   * Idempotent: database already open rồi thì returns kết nối currently giữ nó.
   */
  async openDatabase(
    connId: string,
    name: string,
  ): Promise<{ success: boolean; connId?: string; database?: string; schema?: string | null; error?: string }> {
    try {
      const res: any = await invoke('open_database', { connId, name });
      // Another database on the SAME server, so it inherits that server's Safe Mode.
      if (res.connId) inheritConnection(connId, res.connId);
      return { success: !!res.success, connId: res.connId, database: res.database, schema: res.schema ?? null };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Schemas of the current Postgres connection. Empty on MySQL/SQLite — which is how the caller
   * decides whether to show a schema picker at all.
   *
   * `current` is what the backend will actually use; read it from here rather than from local
   * picker state, since on a fresh connection the user has not chosen anything yet.
   */
  async listSchemas(connId: string, ): Promise<{ success: boolean; schemas: string[]; current?: string | null; error?: string }> {
    try {
      const res: any = await invoke('list_schemas', { connId });
      return {
        success: !!res.success,
        schemas: res.schemas || [],
        current: res.current ?? null,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, schemas: [], error: err.toString() };
    }
  },

  /** Selects the schema every later command reads and writes through (Postgres only). */
  async setSchema(connId: string, name: string): Promise<{ success: boolean; schema?: string; error?: string }> {
    try {
      const res: any = await invoke('set_current_schema', { connId, name });
      return { success: !!res.success, schema: res.schema, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async createDatabase(connId: string, payload: { name: string; encoding?: string; collation?: string }): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('create_database', { connId, payload });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropDatabase(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_database', { name });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async renameDatabase(connId: string, oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_database', { connId, oldName, newName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getDbCharsets(): Promise<{ success: boolean; encodings: string[]; collations?: string[]; collationsByEncoding?: Record<string, string[]>; error?: string }> {
    try {
      const res: any = await invoke('get_db_charsets');
      return {
        success: !!res.success,
        encodings: res.encodings || [],
        collations: res.collations,
        collationsByEncoding: res.collationsByEncoding,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, encodings: [], error: err.toString() };
    }
  },

  // Xem write chú at dropTable: restartIdentity/disableFk is backend handle on một connection.
  async truncateTable(connId: string, 
    name: string,
    opts?: { restartIdentity?: boolean; disableFk?: boolean; cascade?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('truncate_table', {
        connId,
        name,
        restartIdentity: opts?.restartIdentity ?? false,
        disableFk: opts?.disableFk ?? false,
        cascade: opts?.cascade ?? false,
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableDefinition(connId: string, name: string): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_table_definition', { connId, name });
      return { success: !!res.success, sql: res.sql, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async createTable(
    tableName: string,
    columns?: any[],
    indexes?: any[],
    foreignKeys?: any[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('create_table', {
        payload: { tableName, columns, indexes, foreignKeys },
      });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // onProgress: receive {type:'start'|'progress'|'done', done, total} do backend send qua Channel
  // sau mỗi ~20 statement, to UI vẽ thanh tiến độ thật thay vì thanh vô định.
  async restoreBackup(
    sqlContent: string,
    tables: string[],
    onProgress?: (msg: { type: string; done?: number; total?: number; statementsCount?: number }) => void,
    /** Gặp lệnh error thì skip and run tiếp thay vì rollback toàn bộ (xem `restore_backup`). */
    continueOnError?: boolean,
    /** Kết nối đích, tường minh — cùng lý do with `generateData`: job nền can wait in row đợi. */
    connId?: string,
  ): Promise<{
    success: boolean;
    statementsCount?: number;
    activeDatabase?: string;
    error?: string;
    failedCount?: number;
    failedSamples?: { sql: string; error: string }[];
  }> {
    try {
      // Luôn create kênh: tham số onProgress at Rust is Channel bắt buộc (Channel not impl
      // Deserialize nên not dùng is Option<Channel>). not có callback thì bỏ tin nhắn đi.
      const channel = new Channel<any>();
      if (onProgress) channel.onmessage = onProgress;
      const res: any = await invoke('restore_backup', withConnId({
        sqlContent,
        tables,
        onProgress: channel,
        continueOnError: !!continueOnError,
      }, connId));
      return {
        success: !!res.success,
        statementsCount: res.statementsCount,
        activeDatabase: res.activeDatabase,
        error: res.message,
        failedCount: res.failedCount || 0,
        failedSamples: res.failedSamples || [],
      };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async importTableData(connId: string, name: string, rows: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('import_table_data', { connId, name, rows });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getDatabasesList(config: DbConnectionConfig): Promise<{ success: boolean; databases: string[]; error?: string }> {
    try {
      const mappedConfig = {
        dbType: config.type,
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database || '',
        sslEnabled: config.sslEnabled,
        sslMode: config.sslMode,
        sslKeyPath: config.sslKeyPath,
        sslCertPath: config.sslCertPath,
        sslCaPath: config.sslCaPath,
        useSsh: config.sshEnabled,
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        sshAuthType: config.sshAuthType,
        sshPassword: config.sshPassword,
        sshKeyPath: config.sshKeyPath,
        sshKeyContent: config.sshKeyContent,
        sshPassphrase: config.sshPassphrase,
      };
      const res: any = await invoke('get_databases_list', { config: mappedConfig });
      return { success: !!res.success, databases: res.databases || [], error: res.message };
    } catch (err: any) {
      return { success: false, databases: [], error: err.toString() };
    }
  },

  async openUrl(url: string): Promise<void> {
    try {
      await invoke('open_url', { url });
    } catch (err) {
      console.error('Failed to open url:', err);
    }
  },

  // ---- Redis ----
  async redisDisconnect(connId?: string): Promise<void> {
    const target = connId ?? currentConnId;
    try { await invoke('redis_disconnect', { connId: target }); } catch { /* skip */ }
    forgetConnection(target);
    if (target === currentConnId) currentConnId = '';
  },

  /**
   * Đổi db index = **open/chuyển sang một kết nối khác**, not must đổi state of current connection
   * (`redis-ui-unification-plan.md` §2.1). returns `connId` of db đó — already open sẵn thì trả lại đúng
   * id cũ. Người gọi must chuyển workspace sang id này; giữ id cũ nghĩa is vẫn read db cũ.
   */
  async redisSelectDb(
    index: number,
  ): Promise<{ success: boolean; dbIndex?: number; connId?: string; error?: string }> {
    try {
      const res: any = await invoke('redis_select_db', { index });
      return { success: !!res.success, dbIndex: res.dbIndex, connId: res.connId };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisScanKeys(
    pattern: string,
    cursor: number,
    count: number,
    typeFilter?: string
  ): Promise<{ success: boolean; cursor: number; keys: RedisKeyItem[]; error?: string }> {
    try {
      const res: any = await invoke('redis_scan_keys', { pattern, cursor, count, typeFilter: typeFilter || null });
      return { success: !!res.success, cursor: res.cursor ?? 0, keys: res.keys || [] };
    } catch (err: any) {
      return { success: false, cursor: 0, keys: [], error: err.toString() };
    }
  },

  // Stream danh sách key: receive batch qua Channel.
  // Message: {type:'keys',keys[],cursor} | {type:'done',total,cancelled} | {type:'error',message}.
  // `cursor` đi kèm mỗi batch to UI stop at trần rồi load tiếp đúng chỗ (startCursor).
  // stop bằng cancelQuery(queryId).
  async redisScanStream(
    pattern: string,
    count: number,
    queryId: string,
    onMessage: (msg: any) => void,
    startCursor?: number
  ): Promise<void> {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    await invoke('redis_scan_stream', { pattern, count, queryId, channel, startCursor: startCursor ?? null });
  },

  async redisGetKey(key: string): Promise<RedisValueDetail> {
    try {
      const res: any = await invoke('redis_get_key', { key });
      return res as RedisValueDetail;
    } catch (err: any) {
      return { success: false, key, type: '', ttl: -1, memory: null, value: null, message: err.toString() };
    }
  },

  async redisSetKey(payload: any): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_set_key', { payload });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // edit fromng phần tử of collection. Tách khỏi redisSetKey (ngữ nghĩa REPLACE: DEL rồi build lại,
  // mất TTL and write lại toàn bộ phần tử) — mỗi hàm under đây map tới đúng một lệnh Redis.
  // oldField/oldMember: đổi phần "định danh" of phần tử (write mới trước, delete cũ sau).
  async redisHashSet(key: string, field: string, value: string, oldField?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_hash_set', { key, field, value, oldField: oldField ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisHashDel(key: string, field: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_hash_del', { key, field });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListSet(key: string, index: number, value: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_set', { key, index, value });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListPush(key: string, value: string, atHead = false): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_push', { key, value, atHead });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisListDel(key: string, index: number): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_list_del', { key, index });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetMember(key: string, member: string, oldMember?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_member', { key, member, oldMember: oldMember ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetDelMember(key: string, member: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_del_member', { key, member });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisZsetAdd(key: string, member: string, score: number, oldMember?: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_zset_add', { key, member, score, oldMember: oldMember ?? null });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisZsetDel(key: string, member: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_zset_del', { key, member });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // id rỗng = '*' (server tự sinh id kế tiếp).
  async redisStreamAdd(
    key: string,
    id: string,
    fields: { field: string; value: string }[]
  ): Promise<RedisEditResult & { id?: string }> {
    try {
      const res: any = await invoke('redis_stream_add', { key, id, fields });
      return { success: !!res.success, id: res.id };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamDel(key: string, id: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_del', { key, id });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisDeleteKeys(keys: string[]): Promise<{ success: boolean; deleted?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_delete_keys', { keys });
      return { success: !!res.success, deleted: res.deleted };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSetTtl(key: string, ttl: number): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_set_ttl', { key, ttl });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisRenameKey(oldKey: string, newKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_rename_key', { oldKey, newKey });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisFlushDb(): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_flush_db');
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisInfo(): Promise<{ success: boolean; info?: any; raw?: string; error?: string }> {
    try {
      const res: any = await invoke('redis_info');
      return { success: !!res.success, info: res.info, raw: res.raw };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // `switchDb` is set when the command was a `SELECT n`. The backend does **not** move this
  // connection to that database — one `conn_id` is one db index (§2.1) — it resolves the
  // connection FOR that index and reports it. The caller must switch the workspace to
  // `switchDb.connId`; ignoring it leaves the console showing a db it is not talking to.
  // `selectedDb` is kept alongside for the console's own status line.
  async redisExecuteCmd(command: string): Promise<{
    success: boolean;
    result?: any;
    selectedDb?: number;
    switchDb?: { dbIndex: number; connId: string };
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_execute_cmd', { command });
      return {
        success: !!res.success,
        result: res.result,
        selectedDb: res.selectedDb,
        switchDb: res.switchDb ?? undefined,
        error: res.message,
      };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /**
   * Mirrors the app's read-only toggle into the backend, which is where writes are refused.
   *
   * from Giai đoạn 0, cờ này **is** cờ read-only of kết nối in registry — cùng cờ mà nhãn
   * production and nút on rail write. Người gọi must truyền ando or of hai nguồn đó, chứ not
   * must riêng công tắc toàn cục: write `false` when tắt công tắc will delete luôn cờ chỉ-read of một kết
   * nối production.
   */
  async redisSetReadOnly(flag: boolean, connId?: string): Promise<void> {
    try {
      await invoke('redis_set_read_only', { flag, connId: connId ?? currentConnId });
    } catch { /* skip */ }
  },

  async redisGetElements(
    key: string,
    kind: string,
    cursor: string,
    count?: number,
    filter?: string
  ): Promise<RedisElementsPage> {
    try {
      const res: any = await invoke('redis_get_elements', {
        key, kind, cursor, count: count ?? null, filter: filter || null,
      });
      return {
        success: !!res.success,
        kind: res.kind ?? kind,
        elements: res.elements || [],
        nextCursor: res.nextCursor ?? '',
        done: !!res.done,
      };
    } catch (err: any) {
      return { success: false, kind, elements: [], nextCursor: cursor, done: true, error: err.toString() };
    }
  },

  // delete theo pattern: {type:'progress',scanned,deleted} | {type:'done',...} | {type:'error',message}.
  // stop bằng cancelQuery(queryId).
  async redisDeleteByPattern(
    pattern: string,
    typeFilter: string | undefined,
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<void> {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    await invoke('redis_delete_by_pattern', {
      pattern, typeFilter: typeFilter || null, queryId, channel,
    });
  },

  async redisSlowlogGet(count?: number): Promise<{
    success: boolean;
    entries: RedisSlowLogEntry[];
    len: number;
    thresholdUs?: string | null;
    maxLen?: string | null;
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_slowlog_get', { count: count ?? null });
      return {
        success: !!res.success,
        entries: res.entries || [],
        len: res.len ?? 0,
        thresholdUs: res.thresholdUs,
        maxLen: res.maxLen,
      };
    } catch (err: any) {
      return { success: false, entries: [], len: 0, error: err.toString() };
    }
  },

  async redisSlowlogReset(): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_slowlog_reset');
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisSlowlogConfig(
    thresholdUs?: number,
    maxLen?: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('redis_slowlog_config', {
        thresholdUs: thresholdUs ?? null, maxLen: maxLen ?? null,
      });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Pub/Sub on một kết nối RIÊNG at Rust: {type:'message',channel,pattern,payload,binary} | {type:'stopped',total}.
  async redisPubsubStart(
    channels: string[],
    patterns: string[],
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      await invoke('redis_pubsub_start', { channels, patterns, queryId, channel });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisPublish(
    channelName: string,
    payload: string
  ): Promise<{ success: boolean; receivers?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_publish', { channelName, payload });
      return { success: !!res.success, receivers: res.receivers };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Profiler (MONITOR) — tự stop theo limit of backend: {type:'line',line} | {type:'stopped',reason,total}.
  async redisMonitorStart(
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<{ success: boolean; maxLines?: number; maxSecs?: number; error?: string }> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      const res: any = await invoke('redis_monitor_start', { queryId, channel });
      return { success: true, maxLines: res?.maxLines, maxSecs: res?.maxSecs };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonGet(
    key: string,
    path?: string
  ): Promise<{ success: boolean; path?: string; json?: string | null; error?: string }> {
    try {
      const res: any = await invoke('redis_json_get', { key, path: path || null });
      return { success: !!res.success, path: res.path, json: res.json };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonSet(key: string, path: string, value: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_json_set', { key, path, value });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisJsonDel(key: string, path: string): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_json_del', { key, path });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /** write giá trị string from bytes thô — đường unique edit is giá trị nhị phân (HEX editor). */
  async redisSetKeyBytes(key: string, bytes: number[]): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_set_key_bytes', { key, bytes });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamGroups(key: string): Promise<{ success: boolean; groups: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_groups', { key });
      return { success: !!res.success, groups: res.groups || [] };
    } catch (err: any) {
      return { success: false, groups: [], error: err.toString() };
    }
  },

  async redisStreamConsumers(
    key: string,
    group: string
  ): Promise<{ success: boolean; consumers: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_consumers', { key, group });
      return { success: !!res.success, consumers: res.consumers || [] };
    } catch (err: any) {
      return { success: false, consumers: [], error: err.toString() };
    }
  },

  async redisStreamPending(
    key: string,
    group: string,
    count?: number
  ): Promise<{ success: boolean; pending: any[]; error?: string }> {
    try {
      const res: any = await invoke('redis_stream_pending', { key, group, count: count ?? null });
      return { success: !!res.success, pending: res.pending || [] };
    } catch (err: any) {
      return { success: false, pending: [], error: err.toString() };
    }
  },

  async redisStreamAck(key: string, group: string, ids: string[]): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_ack', { key, group, ids });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async redisStreamClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    ids: string[]
  ): Promise<RedisEditResult> {
    try {
      const res: any = await invoke('redis_stream_claim', { key, group, consumer, minIdleMs, ids });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Phân tích DB: lấy mẫu ≤10k key. Progress qua Channel, cancel bằng cancelQuery(queryId).
  async redisAnalyzeDb(
    sample: number | undefined,
    queryId: string,
    onMessage: (msg: any) => void
  ): Promise<RedisAnalysis> {
    try {
      const channel = new Channel<any>();
      channel.onmessage = onMessage;
      const res: any = await invoke('redis_analyze_db', { sample: sample ?? null, queryId, channel });
      return res as RedisAnalysis;
    } catch (err: any) {
      return {
        success: false,
        dbsize: 0,
        sampled: 0,
        sampledBytes: 0,
        estimatedBytes: null,
        byType: [],
        byNamespace: [],
        ttlBuckets: { noExpiry: 0, under1h: 0, under1d: 0, under7d: 0, over7d: 0 },
        topKeys: [],
        error: err.toString(),
      };
    }
  },

  // ---- Xuất / nhập keyspace (xem `utils/redisTransfer.ts`) ----
  //
  // Hai method này is `RedisExportReader.dump` and `RedisImportWriter.restore` — `redisTransfer`
  // receive chúng qua tham số nên nó not import `@tauri-apps/api` and test is. Chúng not receive
  // `connId`: như mọi lệnh redis_* khác, `invoke` cục bộ already ghép `currentConnId` ando.

  /** DUMP + PTTL + TYPE for một lô key. `payload` is base64. */
  async redisDumpKeys(keys: string[]): Promise<{
    success: boolean;
    entries: { key: string; type: string; ttlMs: number; payload: string }[];
    missing: string[];
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_dump_keys', { keys });
      return { success: !!res.success, entries: res.entries || [], missing: res.missing || [] };
    } catch (err: any) {
      return { success: false, entries: [], missing: [], error: err.toString() };
    }
  },

  /**
   * RESTORE một lô bản write. `failed[].error` is câu chữ of chính Redis (tiếng Anh, ví dụ
   * "DUMP payload version or checksum are wrong") nên not đi qua `backendErrors.ts` — hiện
   * nguyên văn is đúng: đó is chhide đoán of server, not must câu of app.
   */
  async redisRestoreKeys(
    entries: { key: string; type: string; ttlMs: number; payload: string }[],
    replace: boolean,
  ): Promise<{
    success: boolean;
    restored: number;
    skipped: number;
    failed: { key: string; error: string }[];
    error?: string;
  }> {
    try {
      const res: any = await invoke('redis_restore_keys', { entries, replace });
      return {
        success: !!res.success,
        restored: res.restored ?? 0,
        skipped: res.skipped ?? 0,
        failed: res.failed || [],
      };
    } catch (err: any) {
      return { success: false, restored: 0, skipped: 0, failed: [], error: err.toString() };
    }
  },

  // Explicit connId (§4.1): the statistics modal receives its connection as a prop, so it
  // has to ask about that one — not whichever is active — or the figures belong to another tab.
  async getDatabaseStats(connId: string): Promise<{ success: boolean; stats?: DatabaseStats; error?: string }> {
    try {
      const res: any = await invoke('get_database_stats', { connId });
      return { success: true, stats: res };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getExactTableRowCount(
    connId: string,
    tableName: string
  ): Promise<{ success: boolean; exact_rows?: number; error?: string }> {
    try {
      const res: any = await invoke('get_exact_table_row_count', { connId, tableName });
      return { success: true, exact_rows: res.exact_rows };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Phase 1: only what the data dictionary gives (names, charset, cheap sizes), so it comes
  // back almost instantly. Whatever sizes/row counts are missing arrive via phase 2 below.
  async getAllDatabasesStats(connId: string): Promise<{ success: boolean; stats?: AllDatabasesStats; error?: string }> {
    try {
      const res: any = await invoke('get_all_databases_stats', { connId });
      return { success: true, stats: res };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // Phase 2: the expensive part (MySQL opens every table for DATA_LENGTH/TABLE_ROWS, SQLite
  // has to COUNT(*) each table, Postgres has to connect to each database). Called after
  // phase 1 and merged into it, so the list never waits on this.
  async getAllDatabasesSizes(
    connId: string,
    includeSystem = false
  ): Promise<{ success: boolean; items?: AllDatabasesSizeItem[]; error?: string }> {
    try {
      const res: any = await invoke('get_all_databases_sizes', { connId, includeSystem });
      return { success: true, items: res.databases };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // ---- compare hai database (db_compare.rs) ----
  // Mỗi "phía" chỉ cần tên database / tệp SQLite: backend tự lấy configuration kết nối
  // (kể cả mật khẩu, SSH tunnel, token IAM) from kết nối currently open, nên frontend not
  // must giữ hay send lại thông tin đăng nhập.

  /** So cấu trúc hai database. returns diff theo table + script SQL sync (source -> target). */
  async compareSchemas(
    source: CompareSide,
    target: CompareSide,
    includeDrops = false,
  ): Promise<SchemaCompareResult> {
    return translateWarnings(
      await invoke<SchemaCompareResult>('compare_schemas', { source, target, includeDrops }),
    );
  },

  /** Đếm số row fromng table at hai phía to biết table nào đáng so chi tiết. */
  async compareDataOverview(
    source: CompareSide,
    target: CompareSide,
    tables?: string[],
  ): Promise<DataOverviewResult> {
    return await invoke<DataOverviewResult>('compare_data_overview', { source, target, tables });
  },

  /** So dữ liệu MỘT table theo key. `keyColumns` bỏ trống -> dùng primary key of nguồn. */
  async compareTableData(
    source: CompareSide,
    target: CompareSide,
    table: string,
    opts?: { keyColumns?: string[]; limit?: number; maxDiffRows?: number; includeDrops?: boolean },
  ): Promise<DataCompareResult> {
    return translateWarnings(
      await invoke<DataCompareResult>('compare_table_data', {
        source,
        target,
        table,
        keyColumns: opts?.keyColumns,
        limit: opts?.limit,
        maxDiffRows: opts?.maxDiffRows,
        includeDrops: opts?.includeDrops ?? false,
      }),
    );
  },

  // ---- generate data test (data_generator.rs) ----
  // Mọi giá trị is sinh at RUST, kể cả bản preview — nên preview đúng bằng dữ liệu will chèn.

  /** table/column can generate data + generator suggestion for fromng column + thứ tự chèn an toàn FK. */
  async getGenerationTargets(): Promise<GenTargets> {
    return translateWarnings(await invoke<GenTargets>('get_generation_targets'));
  },

  /** Sinh thử `limit` row of MỘT table, not write ando DB. */
  async previewGeneratedData(spec: GenSpec, table: string, limit = 100): Promise<GenPreview> {
    return translateWarnings(
      await invoke<GenPreview>('preview_generated_data', { spec, table, limit }),
    );
  },

  /**
   * Sinh and chèn thật. `onProgress` receive {type:'start'|'table'|'progress'|'done'|'error', ...}.
   *
   * `connId` is tường minh vì lệnh này run như một **job nền**: một job can nằm in row đợi
   * một lúc, and tới lượt nó thì `currentConnId` (ambient) already is kết nối khác — nghĩa is sinh dữ
   * liệu ando đúng database mà user not select. Bỏ trống thì vẫn về ambient như trước.
   */
  async generateData(
    spec: GenSpec,
    onProgress?: (msg: GenProgress) => void,
    connId?: string,
  ): Promise<GenResult> {
    // Luôn create kênh: tham số onProgress at Rust is Channel bắt buộc (Channel not impl
    // Deserialize nên not dùng is Option<Channel>). not có callback thì bỏ tin nhắn đi.
    const channel = new Channel<GenProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return translateWarnings(
      await invoke<GenResult>('generate_data', withConnId({ spec, onProgress: channel }, connId)),
    );
  },

  /** Đánh dấu lần generate data currently run cần stop. not error if not có gì currently run. */
  async cancelDataGeneration(connId?: string): Promise<void> {
    try {
      // Cờ cancel bên Rust key theo `conn_id`, nên cancel must nhắm đúng kết nối currently generate data.
      await invoke('cancel_data_generation', withConnId({}, connId));
    } catch {
      // cancel is thao tác "best effort": error at đây not có gì to user ism.
    }
  },
};

export interface TableStatItem {
  table_name: string;
  rows: number;
  is_exact: boolean;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  engine: string;
  collation: string | null;
}

export interface DatabaseStats {
  db_name: string;
  db_type: string;
  total_size_bytes: number;
  total_tables: number;
  total_rows: number;
  tables: TableStatItem[];
}

export interface AllDatabasesStatsItem {
  db_name: string;
  /** Chỉ có with SQLite: tên schema (`main` / tên already ATTACH). */
  schema_name: string | null;
  is_system: boolean;
  is_current: boolean;
  /** null = chưa có số liệu (Postgres when chưa quét sâu, or DB error). */
  total_tables: number | null;
  total_rows: number | null;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  charset: string | null;
  collation: string | null;
  error: string | null;
}

/**
 * One row of phase 2 (`getAllDatabasesSizes`). Only the fields the backend actually measured
 * carry a value, the rest are `null` so merging cannot erase phase 1's numbers. Rows match on
 * `schema_name` first, then `db_name` (SQLite can only be matched by schema).
 */
export interface AllDatabasesSizeItem {
  db_name: string | null;
  schema_name: string | null;
  total_tables: number | null;
  total_rows: number | null;
  data_size_bytes: number | null;
  index_size_bytes: number | null;
  total_size_bytes: number | null;
  error: string | null;
}

export interface AllDatabasesStats {
  db_type: string;
  current_db: string;
  /** Whether phase 2 (`getAllDatabasesSizes`) still has numbers to add. */
  metrics_pending: boolean;
  /**
   * Whether phase 2 can start on its own. Counting tables/rows of another Postgres database
   * needs a NEW connection to it, so there it waits for the user's "deep scan"; on
   * MySQL/SQLite it runs in the background right away.
   */
  metrics_manual: boolean;
  rows_are_exact: boolean;
  databases: AllDatabasesStatsItem[];
}
