import { invoke as rawInvoke, Channel } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { translateBackendError, translateResultErrors } from './backendErrors';
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
 * Every backend call goes through here so the Vietnamese error text the Rust side
 * returns is mapped to the active UI language in ONE place — see `backendErrors.ts`.
 * Shadowing the imported name keeps all existing `await invoke(...)` call sites
 * unchanged; a message with no mapping is passed through untouched.
 */
async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return translateResultErrors(await rawInvoke<T>(cmd, args));
  } catch (err) {
    // A command that returns Err(String) surfaces here as a thrown *string*, and the
    // catch blocks below interpolate it directly (`${err}`). Rethrow a string, not an
    // Error, so the message does not gain an "Error: " prefix.
    throw typeof err === 'string' ? translateBackendError(err) : err;
  }
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
  async connect(config: DbConnectionConfig): Promise<{ success: boolean; message: string; database?: string }> {
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
            sslEnabled: config.sslEnabled,
          },
        });
        if (res.success) {
          return { success: true, message: i18n.t('db.redisConnected'), database: `db${res.dbIndex ?? config.dbIndex ?? 0}` };
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
        return { success: true, message: i18n.t('db.connected'), database: config.database || config.sqlitePath };
      }
      return { success: false, message: res.message || i18n.t('db.errConnect') };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errBackendUnreachable', { message: String(err) }) };
    }
  },

  async disconnect(): Promise<{ success: boolean }> {
    try {
      const res: any = await invoke('disconnect_db');
      return { success: !!res.success };
    } catch {
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

  async getTables(): Promise<TableItem[]> {
    try {
      const res: any = await invoke('get_tables');
      return res.tables || [];
    } catch {
      return [];
    }
  },

  // Lấy toàn bộ catalog (cột+kiểu+PK, FK theo bảng) trong ít truy vấn để warm cache completion.
  async getFullCatalog(): Promise<{ columns: Record<string, any[]>; foreignKeys: Record<string, any[]> }> {
    try {
      const res: any = await invoke('get_full_catalog');
      return { columns: res.columns || {}, foreignKeys: res.foreignKeys || {} };
    } catch {
      return { columns: {}, foreignKeys: {} };
    }
  },

  async getTableData(
    tableName: string,
    page: number = 1,
    pageSize: number = 100,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
    filter?: string
  ): Promise<{ rows: any[]; totalCount: number; primaryKey?: string }> {
    try {
      const res: any = await invoke('get_table_data', {
        name: tableName,
        page,
        limit: pageSize,
        sortBy: sortBy || null,
        sortDir: sortDir || null,
        filter: filter || null,
      });
      return {
        rows: res.data || [],
        totalCount: res.totalCount !== undefined ? res.totalCount : (res.data || []).length,
        primaryKey: res.primaryKey,
      };
    } catch (err) {
      console.error(err);
      return { rows: [], totalCount: 0 };
    }
  },

  async getDatabaseObjects(): Promise<{ tables: string[]; views: string[]; functions: string[]; procedures: string[] }> {
    try {
      const res: any = await invoke('get_database_objects');
      return {
        tables: res.tables || [],
        views: res.views || [],
        functions: res.functions || [],
        procedures: res.procedures || [],
      };
    } catch {
      return { tables: [], views: [], functions: [], procedures: [] };
    }
  },



  async getObjectDefinition(name: string, kind: 'view' | 'function' | 'procedure' | 'table'): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_object_definition', { name, kind });
      return { success: !!res.success, sql: res.sql, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTableTriggers(tableName: string): Promise<TriggerInfo[]> {
    try {
      const res: any = await invoke('get_table_triggers', { tableName });
      return res.triggers || [];
    } catch {
      return [];
    }
  },

  async saveTrigger(statementSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_trigger', { statementSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropTrigger(triggerName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_trigger', { triggerName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async saveRoutineDefinition(routineSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('save_routine_definition', { routineSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getSequences(): Promise<SequenceInfo[]> {
    try {
      const res: any = await invoke('get_sequences');
      return res.sequences || [];
    } catch {
      return [];
    }
  },

  async alterSequence(sequenceSql: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('alter_sequence', { sequenceSql });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async dropSequence(sequenceName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_sequence', { sequenceName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getTablePartitions(tableName: string): Promise<PartitionInfo[]> {
    try {
      const res: any = await invoke('get_table_partitions', { tableName });
      return res.partitions || [];
    } catch {
      return [];
    }
  },

  async getCheckConstraints(tableName: string): Promise<CheckConstraintInfo[]> {
    try {
      const res: any = await invoke('get_check_constraints', { tableName });
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

  async getTableSchema(tableName: string): Promise<SchemaInfo> {
    try {
      const res: any = await invoke('get_table_schema', { name: tableName });
      return {
        columns: res.columns || [],
        indexes: res.indexes || [],
        foreignKeys: res.foreignKeys || [],
      };
    } catch {
      return { columns: [], indexes: [], foreignKeys: [] };
    }
  },

  async executeQuery(sql: string, params?: any[]): Promise<{ success: boolean; data?: any[]; columns?: string[]; affectedRows?: number; executionTime?: number; error?: string; results?: any[] }> {
    try {
      const res: any = await invoke('execute_query', { sql, params: params ?? null });
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

  async executeQueryMulti(sql: string): Promise<{ success: boolean; results: { query: string; columns: string[]; data: any[] }[]; error?: string }> {
    try {
      const res: any = await invoke('execute_multi_query', { sql });
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
  async executeQueryStream(
    sql: string,
    queryId: string,
    onMessage: (msg: QueryStreamMessage) => void,
    params?: any[]
  ): Promise<void> {
    const channel = new Channel<QueryStreamMessage>();
    channel.onmessage = onMessage;
    // params: mảng giá trị đã ép kiểu (number/bool/null/string) để backend bind ở tầng driver
    // (parameterized query, chống SQL injection). Bỏ qua nếu không dùng Tham số Truy vấn.
    await invoke('execute_query_stream', { sql, queryId, channel, params: params ?? null });
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
  async detectLogPaths(
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis'
  ): Promise<{ paths: { label: string; path: string }[]; error?: string }> {
    const isAbs = (s: string) => /^([/~]|[A-Za-z]:[\\/])/.test(s);
    const paths: { label: string; path: string }[] = [];
    const pick = (row: any, key: string) =>
      String(row?.[key] ?? row?.[key.toLowerCase()] ?? '').trim();

    try {
      if (dbType === 'mysql') {
        const res = await this.executeQuery(
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
  async enableLogging(
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
    const res = await this.executeQueryMulti(sql);
    return { success: res.success, message: res.error || '', needsRestart };
  },

  async disableLogging(dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', kind: string): Promise<{ success: boolean; message: string }> {
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
    const res = await this.executeQueryMulti(sql);
    return { success: res.success, message: res.error || '' };
  },

  async commitChanges(
    tableName: string,
    changes: GridChange[],
    primaryKey?: string,
    preview?: boolean
  ): Promise<{ success: boolean; message?: string; sqls?: string[] }> {
    try {
      const res: any = await invoke('commit_changes', { payload: { tableName, changes, primaryKey, preview: !!preview } });
      return { success: !!res.success, sqls: res.sqls, message: res.message };
    } catch (err: any) {
      return { success: false, message: i18n.t('db.errCommitChanges', { message: String(err) }) };
    }
  },

  async alterTableSchema(
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
      const res: any = await invoke('alter_table_schema', { name: tableName, payload: changes });
      return { success: !!res.success };
    } catch (err: any) {
      return { success: false, error: i18n.t('db.errConnection', { message: String(err) }) };
    }
  },

  async previewAlterTableSchema(
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
      const res: any = await invoke('preview_alter_schema', { name: tableName, payload: changes });
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

  async renameTable(oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_table', { oldName, newName });
      return { success: !!res.success, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // isView/cascade/ignoreFk là các tuỳ chọn của dialog Delete. Backend chạy cả cụm (tắt kiểm
  // tra khóa ngoại -> DROP -> bật lại) trên MỘT connection; đừng tự phát lệnh SET ở đây vì mỗi
  // executeQuery lấy một connection khác từ pool.
  async dropTable(
    name: string,
    opts?: { isView?: boolean; cascade?: boolean; ignoreFk?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_table', {
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

  async listDatabases(): Promise<{ success: boolean; databases: string[]; error?: string }> {
    try {
      const res: any = await invoke('list_databases');
      return { success: !!res.success, databases: res.databases || [], error: res.message };
    } catch (err: any) {
      return { success: false, databases: [], error: err.toString() };
    }
  },

  async switchDatabase(name: string): Promise<{ success: boolean; database?: string; error?: string }> {
    try {
      const res: any = await invoke('switch_database', { name });
      return { success: !!res.success, database: res.database, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async createDatabase(payload: { name: string; encoding?: string; collation?: string }): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('create_database', { payload });
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

  async renameDatabase(oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('rename_database', { oldName, newName });
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
  async truncateTable(
    name: string,
    opts?: { restartIdentity?: boolean; disableFk?: boolean; cascade?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('truncate_table', {
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

  async getTableDefinition(name: string): Promise<{ success: boolean; sql?: string; error?: string }> {
    try {
      const res: any = await invoke('get_table_definition', { name });
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

  async parseBackupTables(filePath: string): Promise<{ success: boolean; tables: string[]; error?: string }> {
    try {
      const res: any = await invoke('parse_backup_tables', { filePath });
      return { success: !!res.success, tables: res.tables || [], error: res.message };
    } catch (err: any) {
      return { success: false, tables: [], error: err.toString() };
    }
  },

  async exportMultiTables(payload: any): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('export_multi_tables', { payload });
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
    onProgress?: (msg: { type: string; done?: number; total?: number; statementsCount?: number }) => void
  ): Promise<{ success: boolean; statementsCount?: number; activeDatabase?: string; error?: string }> {
    try {
      // Luôn tạo kênh: tham số onProgress ở Rust là Channel bắt buộc (Channel không impl
      // Deserialize nên không dùng được Option<Channel>). Không có callback thì bỏ tin nhắn đi.
      const channel = new Channel<any>();
      if (onProgress) channel.onmessage = onProgress;
      const res: any = await invoke('restore_backup', { sqlContent, tables, onProgress: channel });
      return { success: !!res.success, statementsCount: res.statementsCount, activeDatabase: res.activeDatabase, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async importTableData(name: string, rows: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('import_table_data', { name, rows });
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
  async redisDisconnect(): Promise<void> {
    try { await invoke('redis_disconnect'); } catch { /* bỏ qua */ }
  },

  async redisSelectDb(index: number): Promise<{ success: boolean; dbIndex?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_select_db', { index });
      return { success: !!res.success, dbIndex: res.dbIndex };
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

  // `selectedDb` is set when the command was a `SELECT n`: the backend routed it through the
  // same path as the database dropdown, so the UI must follow instead of drifting.
  async redisExecuteCmd(
    command: string
  ): Promise<{ success: boolean; result?: any; selectedDb?: number; error?: string }> {
    try {
      const res: any = await invoke('redis_execute_cmd', { command });
      return { success: !!res.success, result: res.result, selectedDb: res.selectedDb, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  /** Mirrors the app's read-only toggle into the backend, which is where writes are refused. */
  async redisSetReadOnly(flag: boolean): Promise<void> {
    try { await invoke('redis_set_read_only', { flag }); } catch { /* bỏ qua */ }
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

  async getDatabaseStats(): Promise<{ success: boolean; stats?: DatabaseStats; error?: string }> {
    try {
      const res: any = await invoke('get_database_stats');
      return { success: true, stats: res };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  async getExactTableRowCount(tableName: string): Promise<{ success: boolean; exact_rows?: number; error?: string }> {
    try {
      const res: any = await invoke('get_exact_table_row_count', { tableName });
      return { success: true, exact_rows: res.exact_rows };
    } catch (err: any) {
      return { success: false, error: err.toString() };
    }
  },

  // deep = true: với Postgres sẽ mở kết nối tạm tới TỪNG database để đếm bảng/số dòng
  // (chậm hơn nhiều), mặc định chỉ lấy dung lượng bằng một truy vấn duy nhất.
  async getAllDatabasesStats(deep = false): Promise<{ success: boolean; stats?: AllDatabasesStats; error?: string }> {
    try {
      const res: any = await invoke('get_all_databases_stats', { deep });
      return { success: true, stats: res };
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

  /** Sinh và chèn thật. `onProgress` nhận {type:'start'|'table'|'progress'|'done'|'error', ...}. */
  async generateData(spec: GenSpec, onProgress?: (msg: GenProgress) => void): Promise<GenResult> {
    // Luôn tạo kênh: tham số onProgress ở Rust là Channel bắt buộc (Channel không impl
    // Deserialize nên không dùng được Option<Channel>). Không có callback thì bỏ tin nhắn đi.
    const channel = new Channel<GenProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return translateWarnings(
      await invoke<GenResult>('generate_data', { spec, onProgress: channel }),
    );
  },

  /** Đánh dấu lần sinh dữ liệu đang chạy cần dừng. Không lỗi nếu không có gì đang chạy. */
  async cancelDataGeneration(): Promise<void> {
    try {
      await invoke('cancel_data_generation');
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

export interface AllDatabasesStats {
  db_type: string;
  current_db: string;
  /** Kết quả này đã có số bảng/số dòng cho mọi database hay chưa. */
  deep: boolean;
  /** Có nút "Quét sâu" hay không (chỉ Postgres cần). */
  supports_deep_scan: boolean;
  rows_are_exact: boolean;
  databases: AllDatabasesStatsItem[];
}
