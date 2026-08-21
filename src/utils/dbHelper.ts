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
  /** `redis` kể từ khi Redis dùng chung registry — rail vẽ cả hai từ một danh sách (§2.3). */
  dialect: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  serverId: string;
  schema: string | null;
  /** Số câu GHI đang chờ commit trên kết nối này — badge của rail (§4.2b). */
  pending: number;
  /** Kết nối đang từ chối mọi câu ghi. */
  readOnly: boolean;
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
 * Chỉ đặt `connId` khi có giá trị thật.
 *
 * Không viết thẳng `{ ...args, connId }` được: `invoke` ở trên merge `{ connId: currentConnId,
 * ...args }`, nên một `connId: undefined` tường minh sẽ **ghi đè** id ambient bằng `undefined` và
 * mọi lệnh mất kết nối. Đây là chỗ duy nhất biết luật đó.
 */
function withConnId(args: Record<string, unknown>, connId?: string): Record<string, unknown> {
  return connId ? { ...args, connId } : args;
}

// Message do backend đẩy qua Channel khi stream kết quả SQL (execute_query_stream).
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

// Message do backend đẩy qua Channel cho SSH Terminal (open_ssh_terminal).
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
   * Số giây tối đa cho MỘT câu lệnh người dùng chạy (SQL editor + đọc trang ở grid). `0`/vắng =
   * không giới hạn. Postgres/MySQL; SQLite bỏ qua (xem `stmt_timeout` trong `database.rs`).
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
 * Trạng thái phiên kết nối hiện tại (`get_connection_status`).
 *
 * Mọi trường mô tả phiên đều "best effort" phía Rust: server cũ hoặc tài khoản
 * thiếu quyền thì trả chuỗi rỗng chứ không báo lỗi, nên chỗ hiển thị phải tự
 * xử lý giá trị rỗng. `cipher`/`tlsVersion` rỗng nghĩa là phiên không mã hoá.
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
 * Trạng thái transaction thủ công. Rust là nguồn sự thật duy nhất: frontend KHÔNG phân tích SQL
 * để đoán transaction còn mở hay không — xem `src-tauri/src/tx_session.rs`. Mỗi lần trạng thái đổi,
 * backend phát sự kiện `tx-state-changed` kèm đúng object này.
 */
export interface TxStatus {
  autocommit: boolean;
  open: boolean;
  /** Postgres: một câu lỗi làm hỏng cả transaction, chỉ còn rollback được. */
  aborted: boolean;
  /** Số câu lệnh **ghi** trong transaction. Câu đọc (SELECT/SHOW/...) mở transaction nhưng
   *  không được đếm — con số này hứa "bấy nhiêu thay đổi đang chờ commit". */
  statements: number;
  /** SQL của đúng những câu đó, để hộp thoại "thay đổi đang chờ" hiển thị. */
  pendingSql: string[];
  /** Nhật ký đã chạm trần kích thước -> `pendingSql` ít hơn `statements`, phải nói ra. */
  sqlTruncated: boolean;
  sinceMs: number;
  isolation: string | null;
  readOnly: boolean;
  savepoints: string[];
  /** Câu lệnh vừa chạy đã tự commit (DDL trên MySQL) -> bộ đếm về 0 không phải do người dùng. */
  implicitCommit: boolean;
  /**
   * Kết nối mà trạng thái này thuộc về. Mỗi kết nối một phiên, và backend phát một
   * `tx-state-changed` cho từng phiên — `TxControl` lọc theo field này, nếu không thì event của
   * kết nối thứ hai sẽ ghi đè hiển thị của kết nối thứ nhất.
   *
   * Không bắt buộc: backend cũ hơn cửa sổ đang chạy sẽ không gửi nó (`tauri dev` giữ lại binary
   * build được gần nhất khi Rust lỗi biên dịch).
   */
  connId?: string;
}

export const TX_EVENT = 'tx-state-changed';

/** Mức cô lập theo từng dialect — twin của `isolation_allowed` trong tx_session.rs. */
export const TX_ISOLATION_LEVELS: Record<string, string[]> = {
  postgres: ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  mysql: ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'],
  // SQLite không có isolation level; thứ tương ứng là mức khoá của BEGIN.
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
   * Cột do database TỰ TÍNH (`GENERATED ALWAYS AS (...)`). Ghi vào là lỗi (MySQL 3105), nên
   * dump phải bỏ hẳn khỏi danh sách cột của INSERT.
   */
  generated?: boolean;
  /**
   * Postgres `GENERATED ALWAYS AS IDENTITY`. Khác `generated`: cột này VẪN phải nằm trong
   * INSERT (bỏ đi là đánh số lại toàn bộ và mọi khoá ngoại trỏ tới nó sai theo), chỉ là câu
   * lệnh cần thêm `OVERRIDING SYSTEM VALUE`.
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
  ttl: number; // -1 = không hết hạn, -2 = không tồn tại
}

export interface RedisValueDetail {
  success: boolean;
  key: string;
  type: string;
  ttl: number;
  memory: number | null;
  /** Số phần tử của collection (HLEN/LLEN/SCARD/ZCARD/XLEN); null với string. */
  length?: number | null;
  value: any; // shape tùy kind (xem redis_get_key backend)
  message?: string;
}

/** Kết quả của một lệnh sửa phần tử (hash/list/set/zset/stream). */
export interface RedisEditResult {
  success: boolean;
  error?: string;
}

/**
 * Một phần tử của collection. `binary` = giá trị gốc không phải UTF-8 hợp lệ, `value` đã bị
 * lossy-convert -> KHÔNG được ghi lại (sẽ thay bytes thật bằng U+FFFD). Xem `is_binary` trong
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
    /** Id kết nối vừa mint. Redis cũng trả về từ khi nó dùng chung registry (§2.3). */
    connId?: string;
  }> {
    // Redis đi qua bộ command redis_* riêng (không dùng connect_db của SQL).
    if (config.type === 'redis') {
      try {
        const res: any = await invoke('redis_connect', {
          config: {
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            dbIndex: config.dbIndex ?? 0,
            // TLS: `sslEnabled` là công tắc cũ (profile trước khi có tab SSL chỉ có nó),
            // `sslMode` mới là thứ quyết định mức kiểm tra chứng chỉ — xem redis_ssl_mode
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
        // Giới hạn thời gian câu lệnh lưu theo server ở localStorage (popover Safe Mode), không
        // nằm trong profile. Đọc ở đây để một kết nối vừa mở đã có đúng giới hạn ngay từ câu lệnh
        // đầu — `setStatementTimeout` chỉ dùng cho lần người dùng đổi giữa phiên.
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
   * Đóng một kết nối. Không truyền `connId` thì đóng kết nối đang active.
   *
   * Truyền tường minh là cách rail đóng một kết nối **không** phải cái đang xem — và khi đó
   * `currentConnId` phải giữ nguyên, vì kết nối đang xem không hề bị đụng tới.
   */
  async disconnect(connId?: string): Promise<{ success: boolean }> {
    const target = connId ?? currentConnId;
    try {
      const res: any = await invoke('disconnect_db', { connId: target });
      // Xoá SAU khi gọi, và chỉ khi đóng đúng cái đang active: lệnh cần id để biết xoá entry nào.
      // Id rỗng thì mọi lệnh sau đó fail bằng đúng lỗi "chưa kết nối" vì `acquire` không resolve
      // được — đó chính là câu trả lời đúng.
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

  // Lấy toàn bộ catalog (cột+kiểu+PK, FK theo bảng) trong ít truy vấn để warm cache completion.
  async getFullCatalog(connId: string, ): Promise<{ columns: Record<string, any[]>; foreignKeys: Record<string, any[]> }> {
    try {
      const res: any = await invoke('get_full_catalog', { connId });
      return { columns: res.columns || {}, foreignKeys: res.foreignKeys || {} };
    } catch {
      return { columns: {}, foreignKeys: {} };
    }
  },

  /**
   * Một trang dữ liệu của bảng, kèm tổng số dòng.
   *
   * `countMode` mặc định `'exact'` — mọi lời gọi cũ giữ nguyên hành vi. Đừng đổi mặc định này: các
   * đường xuất dữ liệu (`dumpBuilder`, `ExportTableDialog`) lặp cho tới khi `rows.length >=
   * totalCount`, nên một con số **thiếu** ở đó sẽ kết thúc vòng lặp sớm và ghi ra bản dump bị cắt
   * mà không báo lỗi. Chỉ có dòng trạng thái của grid — chỗ hiển thị được dấu `~` — mới xin
   * `'auto'`/`'skip'`.
   *
   * `totalCount` là `null` khi không đếm (`'skip'`) hoặc đếm thất bại; `0` chỉ có nghĩa là bảng
   * rỗng. `hasMore` tới từ một dòng đọc thừa ở backend nên đúng kể cả khi số đếm là ước lượng.
   *
   * `seekColumn` + `cursor` là keyset pagination: đưa `nextCursor` của trang trước vào `cursor` thì
   * backend seek thay vì `OFFSET`. Bỏ trống cả hai là quay về phân trang theo số trang. `cursor`
   * đối với frontend là **giá trị mờ** — đừng tự đọc khoá từ dòng dữ liệu để dựng nó: khoá i64 lớn
   * hơn 2^53 mất chữ số khi qua `JSON.parse`, còn `nextCursor` thì backend viết ra chính xác.
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
        // Một backend cũ không gửi trường này; coi như đếm chính xác, đúng như nó vẫn làm.
        countExact: res.countExact !== false,
        // Cũng vậy: không có `hasMore` thì suy ra từ việc trang có đầy hay không.
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
   * Đổi giới hạn thời gian câu lệnh của một kết nối đang mở.
   *
   * Có hiệu lực từ câu lệnh kế tiếp, không cần kết nối lại: backend đọc lại config ở mỗi lần chạy
   * (xem `stmt_timeout` trong `database.rs`). Nơi lưu lâu dài là localStorage theo server
   * (`stmtTimeout.ts`); lệnh này chỉ đồng bộ giá trị đó sang phiên đang chạy.
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
    /** MySQL scheduled event; luôn rỗng ở Postgres/SQLite (hai hệ này không có). */
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
      // Nuốt lỗi im lặng ở đây từng làm popup Xuất hiện ra một danh sách thiếu routine mà
      // không có dấu hiệu nào — log lại để còn dò được.
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
   * Mọi trigger của database hiện tại, kèm câu `CREATE TRIGGER` chạy lại được.
   *
   * Khác `getTableTriggers` (theo từng bảng, dùng cho tab Structure): bản này cho đường xuất
   * dump — một lần gọi cho cả database, và có tên bảng chủ vì Postgres không DROP được trigger
   * nếu thiếu `ON <table>`.
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
   * Những câu lệnh đi kèm một bảng nhưng không nằm trong CREATE TABLE của dialect đó
   * (index, FK/UNIQUE/CHECK, comment, sequence). Nhóm theo VỊ TRÍ phải chạy — xem
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

  // Chạy SQL và nhận kết quả theo từng batch qua Channel (streaming) thay vì đợi toàn bộ.
  // Promise resolve khi backend chạy xong (đã gửi message 'done' hoặc 'error').
  // queryId dùng để hủy giữa chừng qua cancelQuery.
  async executeQueryStream(connId: string, 
    sql: string,
    queryId: string,
    onMessage: (msg: QueryStreamMessage) => void,
    params?: any[]
  ): Promise<void> {
    const channel = new Channel<QueryStreamMessage>();
    channel.onmessage = onMessage;
    // params: mảng giá trị đã ép kiểu (number/bool/null/string) để backend bind ở tầng driver
    // (parameterized query, chống SQL injection). Bỏ qua nếu không dùng Tham số Truy vấn.
    await invoke('execute_query_stream', { connId, sql, queryId, channel, params: params ?? null });
  },

  // ---- Transaction thủ công ----
  // Lỗi được ném ra (không nuốt) vì mọi thao tác ở đây đều do người dùng bấm trực tiếp:
  // "Commit không thành công" mà im lặng là kiểu sai tệ nhất trong nhóm này.

  /**
   * Every connection the backend currently holds — what the left rail lists. The rail shows *open
   * connections*, not every database on the server, so this replaces the `list_databases` query it
   * used to run against the active connection.
   */
  /**
   * Bật/tắt chế độ chỉ đọc cho MỘT kết nối.
   *
   * Gate nằm ở backend, trong ba funnel SQL — không phải ở UI. SQL editor gửi text tuỳ ý, nên một
   * cái khoá trong WebView là khoá ở sai phía của biên IPC. Đây là đúng kết luận mà
   * `src-tauri/src/redis_db.rs` đã ghi cho console Redis.
   */
  async setConnectionReadOnly(connId: string, enabled: boolean): Promise<boolean> {
    const res = await invoke<{ readOnly: boolean }>('set_connection_read_only', { connId, enabled });
    return !!res.readOnly;
  },

  async listConnections(): Promise<OpenConnection[]> {
    const res = await invoke<{ connections: OpenConnection[] }>('list_connections');
    return res.connections || [];
  },

  /**
   * Latency của mọi kết nối đang mở, khoá theo `connId`.
   *
   * Riêng khỏi `getConnectionStatus`, cái đó hỏi thêm version/user/TLS nên tốn 3–5 round trip mỗi kết
   * nối — xem `ping_connections`. Trả về `Map` chứ không phải mảng vì mọi chỗ dùng đều tra theo id.
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

  // Yêu cầu dừng một truy vấn đang stream. Bỏ qua nếu queryId không còn chạy.
  async cancelQuery(queryId: string): Promise<void> {
    try {
      await invoke('cancel_query', { queryId });
    } catch {
      /* bỏ qua */
    }
  },

  // ---- Kho bí mật của HĐH ----
  // Mật khẩu DB, mật khẩu/passphrase/private key SSH, AWS secret key... nằm trong
  // Windows Credential Manager / Keychain / Secret Service chứ không trong localStorage.
  // Xem src-tauri/src/secret_store.rs và src/utils/secretFields.ts.

  // Đọc các bí mật của một profile. Field chưa từng lưu sẽ không có trong kết quả.
  async getSecrets(profileId: string, fields: string[]): Promise<Record<string, string>> {
    return await invoke('secret_get_many', { profileId, fields });
  },

  // Ghi các bí mật của một profile. Giá trị rỗng đồng nghĩa với xoá field đó.
  async setSecrets(profileId: string, values: Record<string, string>): Promise<void> {
    await invoke('secret_set_many', { profileId, values });
  },

  // Xoá bí mật của một profile (khi xoá profile).
  async deleteSecrets(profileId: string, fields: string[]): Promise<void> {
    await invoke('secret_delete_many', { profileId, fields });
  },

  // ---- SSH Terminal ----
  // Mở phiên SSH + PTY/shell. output server đẩy về qua Channel (onMessage).
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
      /* bỏ qua */
    }
  },

  async resizeSshTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_ssh_terminal', { sessionId, cols, rows });
    } catch {
      /* bỏ qua */
    }
  },

  async closeSshTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_ssh_terminal', { sessionId });
    } catch {
      /* bỏ qua */
    }
  },

  // ---- Local Terminal (shell cục bộ, không qua SSH) ----
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
      /* bỏ qua */
    }
  },

  async resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      await invoke('resize_local_terminal', { sessionId, cols, rows });
    } catch {
      /* bỏ qua */
    }
  },

  async closeLocalTerminal(sessionId: string): Promise<void> {
    try {
      await invoke('close_local_terminal', { sessionId });
    } catch {
      /* bỏ qua */
    }
  },

  // Dò đường dẫn file log của DB server bằng cách hỏi chính DB (chạy trên kết nối đang mở).
  // Trả về danh sách {label, path}. Rỗng nếu DB ghi log ra stderr/syslog/TABLE (không có file).
  // Dò đường dẫn file log của DB server.
  // Trả về cả `error` chứ KHÔNG nuốt lỗi: trước đây try/catch trả về mảng rỗng nên
  // mọi thất bại (mất kết nối, thiếu quyền, driver không hỗ trợ) đều hiện ra y như
  // "không có file log" — không thể biết vì sao tính năng không chạy.
  // Mỗi dialect chỉ dùng MỘT câu lệnh, không dựa vào multi-statement của driver.
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
          // MySQL trả 'stderr' khi log không ra file -> không có gì để tail
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

  // Bật ghi log ở phía DB server (chạy trên kết nối hiện tại). Cần quyền cao (SUPER/superuser).
  // kind: mysql 'general'|'slow'; postgres 'statements'|'collector'.
  // needsRestart = true nghĩa là phải khởi động lại server thủ công thì mới có tác dụng.
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

  // isView/cascade/ignoreFk là các tuỳ chọn của dialog Delete. Backend chạy cả cụm (tắt kiểm
  // tra khóa ngoại -> DROP -> bật lại) trên MỘT connection; đừng tự phát lệnh SET ở đây vì mỗi
  // executeQuery lấy một connection khác từ pool.
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
   * Mở một database khác trên **cùng server** thành một kết nối MỚI (§4.3).
   *
   * Khác `switchDatabase`: cái kia *thay* pool nên phải từ chối khi còn thay đổi chưa commit và
   * phải reset phiên transaction. Cái này *thêm* pool nên không đụng gì đang có — transaction đang
   * mở ở database hiện tại cứ chạy tiếp trong khi người dùng làm việc ở database khác.
   *
   * Idempotent: database đã mở rồi thì trả về kết nối đang giữ nó.
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

  // Xem ghi chú ở dropTable: restartIdentity/disableFk được backend xử lý trên một connection.
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

  // onProgress: nhận {type:'start'|'progress'|'done', done, total} do backend gửi qua Channel
  // sau mỗi ~20 câu lệnh, để UI vẽ thanh tiến độ thật thay vì thanh vô định.
  async restoreBackup(
    sqlContent: string,
    tables: string[],
    onProgress?: (msg: { type: string; done?: number; total?: number; statementsCount?: number }) => void,
    /** Gặp lệnh lỗi thì bỏ qua và chạy tiếp thay vì rollback toàn bộ (xem `restore_backup`). */
    continueOnError?: boolean,
    /** Kết nối đích, tường minh — cùng lý do với `generateData`: job nền có thể chờ trong hàng đợi. */
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
      // Luôn tạo kênh: tham số onProgress ở Rust là Channel bắt buộc (Channel không impl
      // Deserialize nên không dùng được Option<Channel>). Không có callback thì bỏ tin nhắn đi.
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

  async exportTable(name: string, format: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('export_table', { name, format });
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
    try { await invoke('redis_disconnect', { connId: target }); } catch { /* bỏ qua */ }
    forgetConnection(target);
    if (target === currentConnId) currentConnId = '';
  },

  /**
   * Đổi db index = **mở/chuyển sang một kết nối khác**, không phải đổi state của kết nối hiện tại
   * (`redis-ui-unification-plan.md` §2.1). Trả về `connId` của db đó — đã mở sẵn thì trả lại đúng
   * id cũ. Người gọi phải chuyển workspace sang id này; giữ id cũ nghĩa là vẫn đọc db cũ.
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

  // Stream danh sách key: nhận batch qua Channel.
  // Message: {type:'keys',keys[],cursor} | {type:'done',total,cancelled} | {type:'error',message}.
  // `cursor` đi kèm mỗi batch để UI dừng ở trần rồi nạp tiếp đúng chỗ (startCursor).
  // Dừng bằng cancelQuery(queryId).
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

  // Sửa từng phần tử của collection. Tách khỏi redisSetKey (ngữ nghĩa REPLACE: DEL rồi dựng lại,
  // mất TTL và ghi lại toàn bộ phần tử) — mỗi hàm dưới đây map tới đúng một lệnh Redis.
  // oldField/oldMember: đổi phần "định danh" của phần tử (ghi mới trước, xóa cũ sau).
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
   * Từ Giai đoạn 0, cờ này **là** cờ read-only của kết nối trong registry — cùng cờ mà nhãn
   * production và nút trên rail ghi. Người gọi phải truyền vào HOẶC của hai nguồn đó, chứ không
   * phải riêng công tắc toàn cục: ghi `false` khi tắt công tắc sẽ xoá luôn cờ chỉ-đọc của một kết
   * nối production.
   */
  async redisSetReadOnly(flag: boolean, connId?: string): Promise<void> {
    try {
      await invoke('redis_set_read_only', { flag, connId: connId ?? currentConnId });
    } catch { /* bỏ qua */ }
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

  // Xoá theo pattern: {type:'progress',scanned,deleted} | {type:'done',...} | {type:'error',message}.
  // Dừng bằng cancelQuery(queryId).
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

  // Pub/Sub trên một kết nối RIÊNG ở Rust: {type:'message',channel,pattern,payload,binary} | {type:'stopped',total}.
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

  // Profiler (MONITOR) — tự dừng theo giới hạn của backend: {type:'line',line} | {type:'stopped',reason,total}.
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

  /** Ghi giá trị string từ bytes thô — đường duy nhất sửa được giá trị nhị phân (HEX editor). */
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

  // Phân tích DB: lấy mẫu ≤10k key. Progress qua Channel, huỷ bằng cancelQuery(queryId).
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
  // Hai method này là `RedisExportReader.dump` và `RedisImportWriter.restore` — `redisTransfer`
  // nhận chúng qua tham số nên nó không import `@tauri-apps/api` và test được. Chúng KHÔNG nhận
  // `connId`: như mọi lệnh redis_* khác, `invoke` cục bộ đã ghép `currentConnId` vào.

  /** DUMP + PTTL + TYPE cho một lô key. `payload` là base64. */
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
   * RESTORE một lô bản ghi. `failed[].error` là câu chữ của chính Redis (tiếng Anh, ví dụ
   * "DUMP payload version or checksum are wrong") nên không đi qua `backendErrors.ts` — hiện
   * nguyên văn là đúng: đó là chẩn đoán của server, không phải câu của app.
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

  // ---- So sánh hai database (db_compare.rs) ----
  // Mỗi "phía" chỉ cần tên database / tệp SQLite: backend tự lấy cấu hình kết nối
  // (kể cả mật khẩu, SSH tunnel, token IAM) từ kết nối đang mở, nên frontend KHÔNG
  // phải giữ hay gửi lại thông tin đăng nhập.

  /** So cấu trúc hai database. Trả về diff theo bảng + script SQL đồng bộ (source -> target). */
  async compareSchemas(
    source: CompareSide,
    target: CompareSide,
    includeDrops = false,
  ): Promise<SchemaCompareResult> {
    return translateWarnings(
      await invoke<SchemaCompareResult>('compare_schemas', { source, target, includeDrops }),
    );
  },

  /** Đếm số dòng từng bảng ở hai phía để biết bảng nào đáng so chi tiết. */
  async compareDataOverview(
    source: CompareSide,
    target: CompareSide,
    tables?: string[],
  ): Promise<DataOverviewResult> {
    return await invoke<DataOverviewResult>('compare_data_overview', { source, target, tables });
  },

  /** So dữ liệu MỘT bảng theo khóa. `keyColumns` bỏ trống -> dùng khóa chính của nguồn. */
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

  // ---- Sinh dữ liệu test (data_generator.rs) ----
  // Mọi giá trị được sinh Ở RUST, kể cả bản xem trước — nên preview đúng bằng dữ liệu sẽ chèn.

  /** Bảng/cột có thể sinh dữ liệu + generator gợi ý cho từng cột + thứ tự chèn an toàn FK. */
  async getGenerationTargets(): Promise<GenTargets> {
    return translateWarnings(await invoke<GenTargets>('get_generation_targets'));
  },

  /** Sinh thử `limit` dòng của MỘT bảng, không ghi vào CSDL. */
  async previewGeneratedData(spec: GenSpec, table: string, limit = 100): Promise<GenPreview> {
    return translateWarnings(
      await invoke<GenPreview>('preview_generated_data', { spec, table, limit }),
    );
  },

  /**
   * Sinh và chèn thật. `onProgress` nhận {type:'start'|'table'|'progress'|'done'|'error', ...}.
   *
   * `connId` là tường minh vì lệnh này chạy như một **job nền**: một job có thể nằm trong hàng đợi
   * một lúc, và tới lượt nó thì `currentConnId` (ambient) đã là kết nối khác — nghĩa là sinh dữ
   * liệu vào đúng database mà người dùng không chọn. Bỏ trống thì vẫn về ambient như trước.
   */
  async generateData(
    spec: GenSpec,
    onProgress?: (msg: GenProgress) => void,
    connId?: string,
  ): Promise<GenResult> {
    // Luôn tạo kênh: tham số onProgress ở Rust là Channel bắt buộc (Channel không impl
    // Deserialize nên không dùng được Option<Channel>). Không có callback thì bỏ tin nhắn đi.
    const channel = new Channel<GenProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return translateWarnings(
      await invoke<GenResult>('generate_data', withConnId({ spec, onProgress: channel }, connId)),
    );
  },

  /** Đánh dấu lần sinh dữ liệu đang chạy cần dừng. Không lỗi nếu không có gì đang chạy. */
  async cancelDataGeneration(connId?: string): Promise<void> {
    try {
      // Cờ huỷ bên Rust khoá theo `conn_id`, nên huỷ phải nhắm đúng kết nối đang sinh dữ liệu.
      await invoke('cancel_data_generation', withConnId({}, connId));
    } catch {
      // Huỷ là thao tác "best effort": lỗi ở đây không có gì để người dùng làm.
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
  /** Chỉ có với SQLite: tên schema (`main` / tên đã ATTACH). */
  schema_name: string | null;
  is_system: boolean;
  is_current: boolean;
  /** null = chưa có số liệu (Postgres khi chưa quét sâu, hoặc DB lỗi). */
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
