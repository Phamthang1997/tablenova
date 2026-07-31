import { invoke, Channel } from '@tauri-apps/api/core';

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
  value: any; // shape tùy kind (xem redis_get_key backend)
  message?: string;
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
          return { success: true, message: 'Kết nối Redis thành công', database: `db${res.dbIndex ?? config.dbIndex ?? 0}` };
        }
        return { success: false, message: res.message || 'Lỗi kết nối Redis' };
      } catch (err: any) {
        return { success: false, message: `Không thể kết nối Redis: ${err}` };
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
        return { success: true, message: 'Kết nối thành công', database: config.database || config.sqlitePath };
      }
      return { success: false, message: res.message || 'Lỗi kết nối' };
    } catch (err: any) {
      return { success: false, message: `Không thể kết nối đến backend Rust: ${err}` };
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
      return { success: false, error: 'Không nhận được dữ liệu truy vấn' };
    } catch (err: any) {
      return { success: false, error: `Lỗi truy vấn: ${err}` };
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
      return { success: false, results: [], error: `Lỗi truy vấn: ${err}` };
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
        if (!res.success) return { paths, error: res.error || 'Không đọc được SHOW VARIABLES' };
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
        if (!res.success) return { paths, error: res.error || 'Không đọc được pg_settings' };
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
        return { paths, error: `${dbType} không có log file phía server để dò.` };
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
      return { success: false, message: 'SQLite không có server log để bật.', needsRestart: false };
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
      return { success: false, message: 'Không áp dụng cho SQLite.' };
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
      return { success: false, message: `Lỗi đồng bộ thay đổi: ${err}` };
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
      return { success: false, error: `Lỗi kết nối: ${err}` };
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
      return { success: false, error: `Lỗi kết nối: ${err}` };
    }
  },

  async askAi(prompt: string, _schemaContext: string): Promise<{ response: string }> {
    try {
      const res: any = await invoke('ai_chat', { message: prompt });
      return { response: res.reply || '' };
    } catch {
      return { response: 'Lỗi: Không thể kết nối với máy chủ AI Rust.' };
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

  async dropTable(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('drop_table', { name });
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

  async truncateTable(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res: any = await invoke('truncate_table', { name });
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

  async restoreBackup(sqlContent: string, tables: string[]): Promise<{ success: boolean; statementsCount?: number; activeDatabase?: string; error?: string }> {
    try {
      const res: any = await invoke('restore_backup', { sqlContent, tables });
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

  // Stream danh sách key: nhận batch qua Channel. Message: {type:'keys',keys[]} | {type:'done',total,cancelled} | {type:'error',message}.
  // Dừng bằng cancelQuery(queryId).
  async redisScanStream(pattern: string, count: number, queryId: string, onMessage: (msg: any) => void): Promise<void> {
    const channel = new Channel<any>();
    channel.onmessage = onMessage;
    await invoke('redis_scan_stream', { pattern, count, queryId, channel });
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

  async redisExecuteCmd(command: string): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      const res: any = await invoke('redis_execute_cmd', { command });
      return { success: !!res.success, result: res.result, error: res.message };
    } catch (err: any) {
      return { success: false, error: err.toString() };
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
  }
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
