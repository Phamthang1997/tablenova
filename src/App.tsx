import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './components/TitleBar';
import { ConnectionManager } from './components/ConnectionManager';
import { Sidebar } from './components/Sidebar';
import { DatabaseInfoModal } from './components/DatabaseInfoModal';
import { TabManager } from './components/TabManager';
import type { TabInfo } from './components/TabManager';
import { DataGrid } from './components/DataGrid';
import { SqlEditor } from './components/SqlEditor';
import { AiAssistant } from './components/AiAssistant';
import { TerminalPanel } from './components/TerminalPanel';
import { SchemaMigration } from './components/SchemaMigration';
import { RedisBrowser } from './components/RedisBrowser';
import { ImportFilePicker } from './components/ImportFilePicker';
import { ExportTableDialog } from './components/ExportTableDialog';
import { ExportDatabaseDialog } from './components/ExportDatabaseDialog';
import type { DatabaseExportOptions } from './components/ExportDatabaseDialog';
import { ImportDatabaseDialog } from './components/ImportDatabaseDialog';
import { Bot, Lock, LockOpen, X } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './components/DbIcons';
import { dbHelper } from './utils/dbHelper';
import type { DbConnectionConfig } from './utils/dbHelper';
import { invalidateCatalog } from './sql/catalog';
import { parseXlsx } from './utils/xlsxReader';
import { collectColumns, inferColType } from './utils/importPreview';
import { addExistsHint } from './utils/dumpPreview';
import { ProgressBar, type ProgressState } from './components/ProgressBar';
import { buildDatabaseFile, buildSql } from './utils/exportHelper';
import { gzipText, openInFileManager, saveExportFile } from './utils/fileSave';
import { ConfirmDialog } from './components/ConfirmDialog';
import type { XlsxSheet } from './utils/xlsxWriter';
import appIcon from './assets/icon.png';

/** Số dòng mỗi lô khi nhập dữ liệu vào bảng có sẵn (để báo được tiến độ). */
const IMPORT_BATCH_SIZE = 500;
/** Số dòng mỗi lần đọc khi xuất nhiều bảng (để báo tiến độ và không giới hạn tổng số dòng). */
const EXPORT_PAGE_SIZE = 2000;

function parseCSV(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',' || char === '\t') {
        row.push(cell.trim());
        cell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        row.push(cell.trim());
        if (row.length > 1 || row[0] !== '') {
          result.push(row);
        }
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    result.push(row);
  }

  return result;
}

export const App: React.FC = () => {
  const [connection, setConnection] = useState<{
    dbName: string;
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  } | null>(null);
  // Cấu hình kết nối đang dùng (gồm cả SSH) để Terminal kế thừa -> mở shell vào đúng máy chủ/VM
  const [activeConnConfig, setActiveConnConfig] = useState<DbConnectionConfig | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [queryCount, setQueryCount] = useState(1);
  const [showAi, setShowAi] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [readOnly, setReadOnly] = useState(false); // Chế độ chỉ đọc: chặn mọi thao tác ghi
  const [dbReloadKey, setDbReloadKey] = useState(0);

  // Xuất/Nhập cả database (popup riêng, mở từ mục Công cụ ở Sidebar hoặc menu tiêu đề)
  const [showExportDbDialog, setShowExportDbDialog] = useState(false);
  const [showImportDbDialog, setShowImportDbDialog] = useState(false);
  // Xuất một bảng (mở từ menu chuột phải ở Sidebar) — cùng popup với nút Export dưới grid
  const [exportTableTarget, setExportTableTarget] = useState<string | null>(null);

  const [globalImportSqlMode, setGlobalImportSqlMode] = useState<'both' | 'structure' | 'data'>('both');

  const [showGlobalImportModal, setShowGlobalImportModal] = useState(false);
  const [globalImportFileName, setGlobalImportFileName] = useState('');
  const [globalImportTableName, setGlobalImportTableName] = useState('');
  const [globalImportFileType, setGlobalImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [globalImportPendingRows, setGlobalImportPendingRows] = useState<any[]>([]);
  const [globalImportSqlContent, setGlobalImportSqlContent] = useState('');
  const [globalImportLoading, setGlobalImportLoading] = useState(false);
  const [globalImportTargetTable, setGlobalImportTargetTable] = useState<string | null>(null);
  const [globalImportTab, setGlobalImportTab] = useState<'structure' | 'data'>('structure');
  const [globalImportProgress, setGlobalImportProgress] = useState<ProgressState | null>(null);
  // Kết quả xuất tệp: hiện hộp thoại có nút mở thư mục chứa tệp
  const [exportDone, setExportDone] = useState<
    { message: string; path?: string; dir?: string; viaDownload: boolean } | null
  >(null);
  // Cột có trong tệp (gộp key của mọi dòng vì CSV/JSON có thể thiếu cột ở một số dòng)
  const globalImportCols = React.useMemo(() => collectColumns(globalImportPendingRows), [globalImportPendingRows]);
  const [showDbInfoModal, setShowDbInfoModal] = useState(false);
  // Tab mở sẵn của DatabaseInfoModal: 'current' khi vào từ "Thông tin Database",
  // 'all' khi vào từ "Thống kê tất cả database" trong menu Databases.
  const [dbInfoTab, setDbInfoTab] = useState<'current' | 'all'>('current');
  const [showSchemaMigration, setShowSchemaMigration] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  // Lấy version thật từ tauri.conf.json thay vì hardcode trong JSX (dễ lệch khi
  // bump phiên bản). Chạy bằng vite-dev thuần thì không có backend -> giữ mặc định.
  const [appVersion, setAppVersion] = useState('0.1.0');
  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { });
  }, []);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [activeConnectionColor, setActiveConnectionColor] = useState<string | undefined>(undefined);

  const [showGlobalImportPicker, setShowGlobalImportPicker] = useState(false);

  const handleImportToTableTrigger = (tableName: string) => {
    setGlobalImportTargetTable(tableName);
    setShowGlobalImportPicker(true);
  };

  // Chuột phải > Xuất dữ liệu: mở đúng popup xuất-một-bảng như nút Export dưới grid.
  const handleExportTableTrigger = (tableName: string) => {
    setExportTableTarget(tableName);
  };

  // Nhận tệp từ ImportFilePicker (đã kiểm tra phần mở rộng ở đó) rồi parse để xem trước.
  const handleGlobalFileImport = async (file: File) => {
    setShowGlobalImportPicker(false);
    setGlobalImportTab('structure');
    setGlobalImportFileName(file.name);
    const guessedTableName = file.name.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    setGlobalImportTableName(guessedTableName);

    // XLSX là nhị phân -> đọc ArrayBuffer + parse riêng, không đi qua FileReader.readAsText.
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const rows = await parseXlsx(buf);
        if (rows.length === 0) throw new Error('File XLSX không có dữ liệu.');
        setGlobalImportFileType('json'); // dòng dạng object, đi chung nhánh ghi DB với CSV/JSON
        setGlobalImportPendingRows(rows);
        setShowGlobalImportModal(true);
      } catch (err: any) {
        alert('Lỗi đọc file: ' + err.message);
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        if (file.name.endsWith('.json')) {
          const parsedJson = JSON.parse(text);
          if (!Array.isArray(parsedJson)) {
            throw new Error('Định dạng JSON phải là một mảng các đối tượng.');
          }
          setGlobalImportFileType('json');
          setGlobalImportPendingRows(parsedJson);
          setShowGlobalImportModal(true);
        } else if (file.name.endsWith('.csv')) {
          let cleanText = text;
          if (cleanText.charCodeAt(0) === 0xFEFF) {
            cleanText = cleanText.substring(1);
          }
          const parsedCsv = parseCSV(cleanText);
          if (parsedCsv.length < 2) {
            throw new Error('File CSV không có dữ liệu.');
          }
          const headers = parsedCsv[0];
          const rowsToImport: any[] = [];
          for (let i = 1; i < parsedCsv.length; i++) {
            const values = parsedCsv[i];
            const row: any = {};
            headers.forEach((h, idx) => {
              const val = values[idx];
              row[h] = val === undefined || val === '' ? null : val;
            });
            rowsToImport.push(row);
          }
          setGlobalImportFileType('csv');
          setGlobalImportPendingRows(rowsToImport);
          setShowGlobalImportModal(true);
        } else if (file.name.endsWith('.sql')) {
          setGlobalImportFileType('sql');
          setGlobalImportSqlContent(text);
          setShowGlobalImportModal(true);
        } else {
          throw new Error('Chỉ hỗ trợ import tệp .csv, .json, .sql hoặc .xlsx');
        }
      } catch (err: any) {
        alert('Lỗi đọc file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  // Trả về true nếu xuất xong -> ExportDatabaseDialog tự đóng.
  const handleExportDatabase = async (opts: DatabaseExportOptions): Promise<boolean> => {
    const { onProgress } = opts;
    try {
      const totalTables = opts.tables.length;

      /**
       * Đọc hết dòng của một bảng theo trang.
       * Tiến độ: mức ngoài là số bảng đã xong (cộng phần trăm của bảng đang chạy),
       * dòng phụ là % dòng trong bảng đó.
       */
      const readTableRows = async (table: string, tableIndex: number): Promise<any[]> => {
        const rows: any[] = [];
        let page = 1;
        let totalRows = 0;
        for (;;) {
          const data = await dbHelper.getTableData(table, page, EXPORT_PAGE_SIZE);
          const batch = data.rows || [];
          rows.push(...batch);
          if (!totalRows && data.totalCount) totalRows = data.totalCount;
          const inner = totalRows ? Math.min(1, rows.length / totalRows) : 0;
          onProgress({
            label: `Bảng ${tableIndex + 1}/${totalTables}: ${table}`,
            current: tableIndex + inner,
            total: totalTables,
            detail: totalRows
              ? `${rows.length.toLocaleString()}/${totalRows.toLocaleString()} dòng (${Math.round(inner * 100)}%)`
              : `${rows.length.toLocaleString()} dòng`,
          });
          if (batch.length < EXPORT_PAGE_SIZE) break;
          if (totalRows && rows.length >= totalRows) break;
          page++;
        }
        return rows;
      };

      // Dữ liệu (XLSX/JSON/CSV): dựng file client-side.
      if (opts.format !== 'sql') {
        const sheets: XlsxSheet[] = [];
        for (let i = 0; i < opts.tables.length; i++) {
          const table = opts.tables[i];
          const schema = await dbHelper.getTableSchema(table);
          // Đọc theo trang: trước đây giới hạn 100.000 dòng nên bảng lớn bị xuất thiếu mà không báo.
          const rows = await readTableRows(table, i);
          const colNames = (schema.columns || []).map(c => c.name);
          const finalCols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
          sheets.push({ name: table, colNames: finalCols, rows });
        }
        onProgress({ label: `Đang dựng tệp ${opts.format.toUpperCase()}...` });
        const file = buildDatabaseFile(sheets, opts.format, opts.filename);
        onProgress({ label: 'Đang ghi tệp...' });
        const saved = await saveExportFile(opts.dir, file.name, file.data, file.mime);
        onProgress(null);
        setExportDone({
          message: `Đã xuất ${sheets.length} bảng (${opts.format.toUpperCase()}) ra tệp ${file.name}.`,
          path: saved.path,
          dir: saved.dir,
          viaDownload: saved.savedTo === 'download',
        });
        return true;
      }

      // SQL: dựng dump ngay ở frontend (dùng get_table_definition + get_table_data) để báo
      // được tiến độ từng bảng. Backend export_multi_tables làm tất cả trong một lần gọi
      // nên không báo được % — và nó ghi theo đường dẫn tương đối vào CWD của tiến trình.
      const q = connection?.dbType === 'mysql' ? '`' : '"';
      const parts: string[] = [
        '-- Database Backup generated by TableNova',
        `-- Date: ${new Date().toISOString()}`,
        '',
      ];

      for (let i = 0; i < opts.tables.length; i++) {
        const table = opts.tables[i];
        onProgress({
          label: `Bảng ${i + 1}/${totalTables}: ${table}`,
          current: i,
          total: totalTables,
          detail: 'đang đọc cấu trúc...',
        });

        if (opts.sqlOptions.dropTable) {
          parts.push(`DROP TABLE IF EXISTS ${q}${table}${q};`);
        }
        if (opts.sqlOptions.includeStructure) {
          const def = await dbHelper.getTableDefinition(table);
          if (def.success && def.sql) {
            parts.push(`-- Structure for table ${q}${table}${q}`);
            parts.push(def.sql.trim().endsWith(';') ? def.sql.trim() : def.sql.trim() + ';');
          } else {
            parts.push(`-- Không lấy được cấu trúc bảng ${q}${table}${q}: ${def.error || 'không rõ nguyên nhân'}`);
          }
          parts.push('');
        }
        if (opts.sqlOptions.includeContent) {
          const rows = await readTableRows(table, i);
          if (rows.length > 0) {
            const schema = await dbHelper.getTableSchema(table);
            const colNames = (schema.columns || []).map(c => c.name);
            const cols = colNames.length ? colNames : Object.keys(rows[0]);
            parts.push(`-- Data for table ${q}${table}${q} (${rows.length} dòng)`);
            parts.push(buildSql(table, cols, rows, connection?.dbType || 'sqlite'));
            parts.push('');
          }
        }
        onProgress({ label: `Bảng ${i + 1}/${totalTables}: ${table}`, current: i + 1, total: totalTables, detail: 'xong' });
      }

      const sqlText = parts.join('\n');
      const ext = opts.compressGzip ? '.sql.gz' : '.sql';
      const base = opts.filename.replace(/\.(sql|sql\.gz|gz)$/i, '');
      const fileName = base + ext;

      onProgress({ label: opts.compressGzip ? 'Đang nén tệp (gzip)...' : 'Đang ghi tệp...' });
      const payload = opts.compressGzip ? await gzipText(sqlText) : sqlText;
      const saved = await saveExportFile(
        opts.dir,
        fileName,
        payload,
        opts.compressGzip ? 'application/gzip' : 'text/plain;charset=utf-8'
      );
      onProgress(null);

      setExportDone({
        message: `Đã xuất ${opts.tables.length} bảng ra tệp SQL ${fileName}.`,
        path: saved.path,
        dir: saved.dir,
        viaDownload: saved.savedTo === 'download',
      });
      return true;
    } catch (err: any) {
      onProgress(null);
      alert('Lỗi xuất dữ liệu: ' + err.message);
      return false;
    }
  };

  const splitSqlQueries = (sqlStr: string): string[] => {
    const queries: string[] = [];
    let currentQuery = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    
    for (let i = 0; i < sqlStr.length; i++) {
      const char = sqlStr[i];
      if (char === "'" && !inDoubleQuote && !inBacktick) {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote && !inBacktick) {
        inDoubleQuote = !inDoubleQuote;
      } else if (char === '`' && !inSingleQuote && !inDoubleQuote) {
        inBacktick = !inBacktick;
      }
      
      if (char === ';' && !inSingleQuote && !inDoubleQuote && !inBacktick) {
        if (currentQuery.trim()) {
          queries.push(currentQuery.trim());
        }
        currentQuery = '';
      } else {
        currentQuery += char;
      }
    }
    if (currentQuery.trim()) {
      queries.push(currentQuery.trim());
    }
    return queries;
  };

  const extractTableNameFromSql = (sql: string): string | null => {
    const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (createMatch && createMatch[1]) return createMatch[1];
    
    const dropMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (dropMatch && dropMatch[1]) return dropMatch[1];

    return null;
  };

  const filterSqlQueries = (sqlText: string, mode: 'both' | 'structure' | 'data'): string => {
    if (mode === 'both') return sqlText;
    const queries = splitSqlQueries(sqlText);
    const filtered = queries.filter(q => {
      const trimmed = q.trim().toUpperCase();
      if (!trimmed) return false;
      const isStructure = trimmed.startsWith('CREATE TABLE') || 
                          trimmed.startsWith('DROP TABLE') || 
                          trimmed.startsWith('ALTER TABLE') || 
                          trimmed.startsWith('CREATE INDEX') || 
                          trimmed.startsWith('CREATE UNIQUE INDEX') || 
                          trimmed.startsWith('DROP INDEX');
      const isData = trimmed.startsWith('INSERT INTO') || 
                     trimmed.startsWith('UPDATE') || 
                     trimmed.startsWith('DELETE FROM') || 
                     trimmed.startsWith('TRUNCATE TABLE') || 
                     trimmed.startsWith('TRUNCATE') ||
                     trimmed.startsWith('INSERT');
      if (mode === 'structure') {
        return isStructure || (!isData && !trimmed.startsWith('REPLACE'));
      }
      if (mode === 'data') {
        return isData || (!isStructure && !trimmed.startsWith('CREATE') && !trimmed.startsWith('DROP') && !trimmed.startsWith('ALTER'));
      }
      return true;
    });
    return filtered.join(';\n');
  };

  const confirmGlobalImport = async () => {
    if (!globalImportTargetTable && !globalImportTableName.trim()) {
      alert('Vui lòng nhập tên bảng.');
      return;
    }

    setShowGlobalImportModal(false);
    setGlobalImportLoading(true);
    setGlobalImportProgress({
      label: globalImportFileType === 'sql'
        ? 'Đang chạy câu lệnh SQL...'
        : `Đang ghi ${globalImportPendingRows.length} dòng...`,
    });

    try {
      if (globalImportFileType === 'sql') {
        let filteredSql = filterSqlQueries(globalImportSqlContent, globalImportSqlMode);
        
        if (globalImportTargetTable) {
          const originalTable = extractTableNameFromSql(globalImportSqlContent);
          if (originalTable && originalTable !== globalImportTargetTable) {
            const escapedOrig = originalTable.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`([\\s\`"'])${escapedOrig}([\\s\`"';(])`, 'gi');
            filteredSql = filteredSql.replace(regex, `$1${globalImportTargetTable}$2`);
          }
        }

        const res = await dbHelper.executeQuery(filteredSql);
        if (res.success) {
          alert('Đã thực thi câu lệnh SQL import thành công!');
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert('Lỗi thực thi SQL: ' + res.error);
        }
      } else if (globalImportTargetTable) {
        // Bảng có sẵn: ghi theo lô để báo được tiến độ thật.
        const table = globalImportTargetTable;
        const total = globalImportPendingRows.length;
        let done = 0;
        let failed: string | null = null;
        for (let i = 0; i < total; i += IMPORT_BATCH_SIZE) {
          const batch = globalImportPendingRows.slice(i, i + IMPORT_BATCH_SIZE);
          const resData = await dbHelper.importTableData(table, batch);
          if (!resData.success) {
            failed = resData.error || 'Import thất bại.';
            break;
          }
          done += batch.length;
          setGlobalImportProgress({
            label: `Đang ghi vào bảng ${table}...`,
            current: done,
            total,
            detail: `${done.toLocaleString()}/${total.toLocaleString()} dòng`,
          });
        }
        if (failed) {
          alert(`Import thất bại: ${failed}${done > 0 ? ` (đã ghi ${done}/${total} dòng)` : ''}`);
        } else {
          alert(`Đã nhập ${done} dòng vào bảng "${table}".`);
        }
        window.dispatchEvent(new CustomEvent('database-restored'));
      } else {
        // Bảng mới: backend tạo bảng + chèn trong một lần gọi -> tiến độ vô định.
        const resData = await dbHelper.importNewTable(globalImportTableName, globalImportPendingRows);
        if (resData.success) {
          alert(`Đã tạo bảng "${globalImportTableName}" và nhập thành công bản ghi!`);
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert('Import thất bại: ' + resData.error);
        }
      }
    } catch (err: any) {
      alert('Lỗi kết nối: ' + err.message);
    } finally {
      setGlobalImportProgress(null);
      setGlobalImportLoading(false);
    }
  };

  // Trả về true nếu nhập xong -> ImportDatabaseDialog tự đóng.
  // targetDb: database đích lấy từ tệp hoặc do người dùng nhập; chưa tồn tại thì tạo mới.
  const handleImportDatabase = async (
    sqlText: string,
    tables: string[],
    targetDb: string,
    onProgress?: (msg: { type: string; done?: number; total?: number }) => void
  ): Promise<boolean> => {
    try {
      const wantDb = targetDb.trim();
      const canManageDb = !!connection && connection.dbType !== 'sqlite';

      if (canManageDb && wantDb && wantDb !== connection?.dbName) {
        const list = await dbHelper.listDatabases();
        const exists = (list.databases || []).some(d => d.toLowerCase() === wantDb.toLowerCase());

        if (!exists) {
          const created = await dbHelper.createDatabase({ name: wantDb });
          if (!created.success) {
            alert(`Không tạo được database "${wantDb}": ${created.error}`);
            return false;
          }
        }

        const switched = await dbHelper.switchDatabase(wantDb);
        if (!switched.success) {
          alert(`Không chuyển được sang database "${wantDb}": ${switched.error}`);
          return false;
        }
        setConnection(prev => prev ? { ...prev, dbName: switched.database || wantDb } : null);
        invalidateCatalog();
      }

      const resData = await dbHelper.restoreBackup(sqlText, tables, onProgress);
      if (resData.success) {
        alert(`Nhập cơ sở dữ liệu thành công! Đã chạy ${resData.statementsCount || 0} câu lệnh SQL.`);
        if (resData.activeDatabase) {
          const activeDb = resData.activeDatabase;
          setConnection(prev => prev ? { ...prev, dbName: activeDb } : null);
        }
        invalidateCatalog();
        window.dispatchEvent(new CustomEvent('database-restored'));
        return true;
      }
      alert('Nhập thất bại: ' + addExistsHint(resData.error || '', false));
      return false;
    } catch (e: any) {
      alert('Lỗi nhập dữ liệu: ' + e.message);
      return false;
    }
  };

  const handleTableRenamed = (oldName: string, newName: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.type === 'table' && t.name === oldName) {
          return { ...t, name: newName, label: newName };
        }
        return t;
      })
    );
  };

  const handleTableDropped = (tableName: string) => {
    setTabs((prev) => {
      const remaining = prev.filter((t) => !(t.type === 'table' && t.name === tableName));
      if (remaining.length === 0) {
        return [
          {
            id: 'query_1',
            type: 'query',
            name: 'SQL Query',
            label: 'Truy vấn 1',
          },
        ];
      }
      return remaining;
    });
  };

  React.useEffect(() => {
    const handleGlobalRename = (e: any) => {
      const { oldName, newName } = e.detail;
      handleTableRenamed(oldName, newName);
    };
    window.addEventListener('table-renamed', handleGlobalRename);
    return () => window.removeEventListener('table-renamed', handleGlobalRename);
  }, []);

  React.useEffect(() => {
    const handleGlobalReload = () => {
      setDbReloadKey((prev) => prev + 1);
    };
    window.addEventListener('database-restored', handleGlobalReload);
    return () => window.removeEventListener('database-restored', handleGlobalReload);
  }, []);

  React.useEffect(() => {
    const savedTheme = localStorage.getItem('tf_theme') as 'dark' | 'light';
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    // macOS không tự bo góc cửa sổ khi decorations = false, nên phải tự bo bằng
    // CSS cho khớp radius của lớp vibrancy (windowEffects.radius trong
    // tauri.conf.json). Windows 11 tự bo nên không cần.
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.documentElement.setAttribute('data-os', isMac ? 'macos' : 'other');
  }, []);

  const toggleTheme = () => {
    const nextTheme: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('tf_theme', nextTheme);
  };

  React.useEffect(() => {
    if (connection) {
      const storageKey = `tn_tabs_${connection.dbType}_${connection.dbName}`;
      // Không lưu tab terminal: phiên PTY không tồn tại sau khi reload
      const persistTabs = tabs.filter(t => t.type !== 'terminal');
      const persistActive = persistTabs.some(t => t.id === activeTabId) ? activeTabId : (persistTabs[0]?.id ?? null);
      localStorage.setItem(storageKey, JSON.stringify({ tabs: persistTabs, activeTabId: persistActive, queryCount }));
    }
  }, [tabs, activeTabId, connection, queryCount]);

  React.useEffect(() => {
    const applyWindowSize = async () => {
      try {
        if (connection) {
          // Đã kết nối CSDL: Bừng rộng cửa sổ ra 1280 x 800px
          await invoke('set_app_window_size', { width: 1280, height: 800 });
        } else {
          // Trang Quản lý kết nối: Thu gọn về 1060 x 680px
          await invoke('set_app_window_size', { width: 1060, height: 680 });
        }
      } catch (e) {
        console.warn('Lỗi thay đổi kích thước cửa sổ qua Rust:', e);
      }
    };

    applyWindowSize();
  }, [connection]);

  // Handle successful database connection
  const handleConnect = (dbName: string, dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', color?: string, config?: DbConnectionConfig) => {
    setConnection({ dbName, dbType });
    setActiveConnectionColor(color);
    setActiveConnConfig(config || null);

    // Đổi kết nối -> xoá cache bảng/cột để autocomplete & hover không còn dữ liệu của DB cũ
    invalidateCatalog();

    // Try to restore tabs from localStorage
    const storageKey = `tn_tabs_${dbType}_${dbName}`;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const { tabs: savedTabs, activeTabId: savedActiveId, queryCount: savedQueryCount } = JSON.parse(saved);
        if (Array.isArray(savedTabs) && savedTabs.length > 0) {
          setTabs(savedTabs);
          setActiveTabId(savedActiveId || savedTabs[0].id);
          setQueryCount(savedQueryCount || (savedTabs.length + 1));
          return;
        }
      } catch (e) {
        console.error('Lỗi phục hồi tab history:', e);
      }
    }

    // Open an initial SQL Query tab on connect
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: 'Truy vấn 1',
      },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  // Disconnect from database
  // Hỏi xác nhận nếu bảng đang mở còn thay đổi chưa lưu (cờ do DataGrid đặt: window.__gridDirty)
  const guardDirty = () =>
    !(window as any).__gridDirty || window.confirm('Bảng hiện tại còn thay đổi CHƯA LƯU. Bỏ các thay đổi đó và tiếp tục?');

  const handleSelectTab = (id: string) => {
    if (id !== activeTabId && !guardDirty()) return;
    setActiveTabId(id);
  };

  const handleDisconnect = async () => {
    if (!guardDirty()) return;
    await dbHelper.disconnect();
    setConnection(null);
    setTabs([]);
    setActiveTabId(null);
    setQueryCount(1);
    setShowSidebar(true);
  };

  // Sau khi đổi database đang dùng: cập nhật tên DB, đóng các tab (thuộc DB cũ), làm mới
  const handleDatabaseChanged = (newName: string) => {
    const nextConn = connection ? { ...connection, dbName: newName } : null;
    setConnection(nextConn);
    setDbReloadKey((k) => k + 1);

    if (nextConn) {
      const storageKey = `tn_tabs_${nextConn.dbType}_${newName}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const { tabs: savedTabs, activeTabId: savedActiveId, queryCount: savedQueryCount } = JSON.parse(saved);
          if (Array.isArray(savedTabs) && savedTabs.length > 0) {
            setTabs(savedTabs);
            setActiveTabId(savedActiveId || savedTabs[0].id);
            setQueryCount(savedQueryCount || (savedTabs.length + 1));
            return;
          }
        } catch (e) {
          console.error('Lỗi phục hồi tab history khi đổi db:', e);
        }
      }
    }

    // Fallback
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: 'Truy vấn 1',
      },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  // Open a specific table in a new or existing tab
  const handleSelectTable = (tableName: string, initialViewMode: 'data' | 'structure' = 'data') => {
    const tabId = `table_${tableName}`;
    if (tabId !== activeTabId && !guardDirty()) return;
    const exists = tabs.find((t) => t.id === tabId);

    if (!exists) {
      const newTab: TabInfo = {
        id: tabId,
        type: 'table',
        name: tableName,
        label: tableName,
        initialViewMode,
      } as any;
      setTabs([...tabs, newTab]);
    } else {
      if (initialViewMode) {
        setTabs(tabs.map(t => t.id === tabId ? { ...t, initialViewMode } as any : t));
      }
    }
    setActiveTabId(tabId);
  };

  // Ctrl+Click / F12 trên tên bảng trong SQL Editor -> mở tab bảng.
  // Dùng ref để listener (đăng ký 1 lần) luôn gọi bản handleSelectTable mới nhất.
  const selectTableRef = React.useRef(handleSelectTable);
  selectTableRef.current = handleSelectTable;
  React.useEffect(() => {
    const handleOpenTableTab = (e: any) => {
      const table = e.detail?.table;
      if (table) selectTableRef.current(table, e.detail?.viewMode || 'data');
    };
    window.addEventListener('open-table-tab', handleOpenTableTab);
    return () => window.removeEventListener('open-table-tab', handleOpenTableTab);
  }, []);

  // Create a new SQL Query tab
  const handleNewQueryTab = () => {
    const tabId = `query_${Date.now()}`;
    const newTab: TabInfo = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: `Truy vấn ${queryCount}`,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  };

  // Close tab
  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    // Đóng tab bảng đang sửa dở -> hỏi xác nhận
    if (id === activeTabId && !guardDirty()) return;
    const tabIndex = tabs.findIndex((t) => t.id === id);
    const newTabs = tabs.filter((t) => t.id !== id);

    setTabs(newTabs);

    // If closing active tab, switch to another
    if (activeTabId === id) {
      if (newTabs.length > 0) {
        // select next or previous tab
        const nextActiveIndex = Math.min(tabIndex, newTabs.length - 1);
        setActiveTabId(newTabs[nextActiveIndex].id);
      } else {
        setActiveTabId(null);
      }
    }
  };

  const handleCloseOthers = (id: string) => {
    const newTabs = tabs.filter((t) => t.id === id);
    setTabs(newTabs);
    setActiveTabId(id);
  };

  const handleCloseTabsToRight = (id: string) => {
    const tabIndex = tabs.findIndex((t) => t.id === id);
    if (tabIndex !== -1) {
      const newTabs = tabs.slice(0, tabIndex + 1);
      setTabs(newTabs);

      const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
      if (activeIndex > tabIndex) {
        setActiveTabId(id);
      }
    }
  };

  const handleCloseAll = () => {
    setTabs([]);
    setActiveTabId(null);
  };


  // Insert SQL generated by AI into current query editor
  const handleInsertSql = (sql: string) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);

    if (activeTab && activeTab.type === 'query') {
      // Update existing SQL tab
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id === activeTabId) {
            return { ...t, sql }; // Update initialSql prop
          }
          return t;
        })
      );
      
      // Force remount or change value by passing key to Monaco
      // We can append a timestamp or change tab ID, but simple update is fine.
    } else {
      // Create a new SQL query tab with the generated SQL
      const tabId = `query_${Date.now()}`;
      const newTab: TabInfo = {
        id: tabId,
        type: 'query',
        name: 'SQL Query',
        label: `Truy vấn ${queryCount}`,
      };
      // Pre-populate sql property
      (newTab as any).sql = sql;
      
      setTabs([...tabs, newTab]);
      setActiveTabId(tabId);
      setQueryCount(queryCount + 1);
    }
  };

  // Config cho Terminal: nếu kết nối hiện tại dùng SSH -> kế thừa để mở shell VÀO MÁY CHỦ/VM đó;
  // ngược lại mở shell máy cục bộ.
  const terminalConfig = (): DbConnectionConfig => {
    const c = activeConnConfig;
    if (c?.sshEnabled && c.sshHost) {
      return {
        type: connection?.dbType || 'sqlite',
        sshEnabled: true,
        sshHost: c.sshHost,
        sshPort: c.sshPort,
        sshUser: c.sshUser,
        sshAuthType: c.sshAuthType,
        sshPassword: c.sshPassword,
        sshKeyPath: c.sshKeyPath,
        sshKeyContent: c.sshKeyContent,
        sshPassphrase: c.sshPassphrase,
      };
    }
    return { type: connection?.dbType || 'sqlite' };
  };

  const handleOpenTerminal = () => {
    if (!connection) return;
    const id = `terminal_${Date.now()}`;
    const newTab: TabInfo = {
      id,
      type: 'terminal',
      name: 'Terminal',
      label: 'Terminal',
      config: terminalConfig(),
      floating: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  };

  const getActiveTab = () => {
    return tabs.find((t) => t.id === activeTabId) || null;
  };

  const activeTab = getActiveTab();
  const activeTable = activeTab?.type === 'table' ? activeTab.name : null;

  return (
    <>
      <TitleBar
        hasConnection={!!connection}
        onNewConnection={handleDisconnect}
        onDisconnect={handleDisconnect}
        onNewQuery={handleNewQueryTab}
        onExportDatabase={() => setShowExportDbDialog(true)}
        onImportDatabase={() => setShowImportDbDialog(true)}
        onToggleSidebar={() => setShowSidebar(prev => !prev)}
        onToggleTheme={toggleTheme}
        onShowShortcuts={() => setShowShortcuts(true)}
        onShowAbout={() => setShowAbout(true)}
      />

      {!connection ? (
        <ConnectionManager onConnect={handleConnect} />
      ) : connection.dbType === 'redis' ? (
        <div className="workspace-container" style={{ borderTop: activeConnectionColor ? `3px solid ${activeConnectionColor}` : 'none' }}>
          <RedisBrowser
            dbName={connection.dbName}
            initialDbIndex={activeConnConfig?.dbIndex ?? 0}
            onDisconnect={handleDisconnect}
          />
        </div>
      ) : (
        <div className="workspace-container" style={{ borderTop: activeConnectionColor ? `3px solid ${activeConnectionColor}` : 'none' }}>
          {showSidebar && (
            <Sidebar
              dbName={connection.dbName}
              dbType={connection.dbType}
              onSelectTable={handleSelectTable}
              onNewQuery={handleNewQueryTab}
              onOpenTerminal={handleOpenTerminal}
              terminalConfig={terminalConfig()}
              onDisconnect={handleDisconnect}
              activeTable={activeTable}
              onImportToTable={handleImportToTableTrigger}
              onExportTable={handleExportTableTrigger}
              onExportDatabase={() => setShowExportDbDialog(true)}
              onImportDatabase={() => setShowImportDbDialog(true)}
              onImportNewTable={() => { setGlobalImportTargetTable(null); setShowGlobalImportPicker(true); }}
              onOpenDbInfo={() => { setDbInfoTab('current'); setShowDbInfoModal(true); }}
              onOpenAllDbStats={() => { setDbInfoTab('all'); setShowDbInfoModal(true); }}
              onSchemaMigration={() => setShowSchemaMigration(true)}
              onTableRenamed={handleTableRenamed}
              onTableDropped={handleTableDropped}
              onDatabaseChanged={handleDatabaseChanged}
            />
          )}

          <div className="main-workspace-area">
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--win-bg-tab-bar)', paddingRight: '8px', borderBottom: '1px solid var(--win-border)', position: 'relative', zIndex: 100 }}>
              <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                <TabManager
                  tabs={tabs}
                  activeTabId={activeTabId}
                  onSelectTab={handleSelectTab}
                  onCloseTab={handleCloseTab}
                  onCloseOthers={handleCloseOthers}
                  onCloseTabsToRight={handleCloseTabsToRight}
                  onCloseAll={handleCloseAll}
                  onNewQueryTab={handleNewQueryTab}
                />
              </div>
              {/* Nút đổi sáng/tối đã bỏ khỏi thanh tab — vẫn dùng được ở
                  menu Hiển thị > Đổi giao diện sáng/tối trên title bar. */}
              <button
                className="tab-new-btn"
                onClick={() => setReadOnly(r => !r)}
                style={{
                  color: readOnly ? '#f59e0b' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', gap: '4px', width: 'auto', padding: '0 8px', fontSize: '11px', marginRight: '6px'
                }}
                title={readOnly ? 'Chế độ Chỉ đọc đang BẬT — nhấn để tắt' : 'Bật chế độ Chỉ đọc (chặn mọi thao tác ghi)'}
              >
                {readOnly ? <Lock size={14} /> : <LockOpen size={14} />}
                <span>{readOnly ? 'Chỉ đọc' : 'Ghi'}</span>
              </button>
              <button
                className="tab-new-btn"
                onClick={() => setShowAi(!showAi)}
                style={{ 
                  color: showAi ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '24px', padding: 0 
                }}
                title="Bật/Tắt AI Copilot"
              >
                <Bot size={14} />
              </button>
            </div>

            <div className="active-panel-container" style={{ position: 'relative' }}>
              {!activeTab ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                  Chọn một bảng từ Sidebar hoặc tạo Truy vấn SQL để bắt đầu làm việc.
                </div>
              ) : activeTab.type === 'terminal' ? (
                (activeTab as any).floating ? (
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    Terminal đang ở chế độ cửa sổ nổi — bấm nút ghim trên cửa sổ để đưa về tab.
                  </div>
                ) : null
              ) : (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  {activeTab.type === 'table' ? (
                    <DataGrid
                      key={activeTab.id + '_' + ((activeTab as any).initialViewMode || 'data') + '_' + dbReloadKey}
                      tableName={activeTab.name}
                      dbType={connection.dbType}
                      initialViewMode={(activeTab as any).initialViewMode || 'data'}
                      readOnly={readOnly}
                    />
                  ) : (
                    <SqlEditor
                      key={activeTab.id}
                      dbType={connection?.dbType}
                      initialSql={(activeTab as any).sql || ''}
                      initialSql2={(activeTab as any).sql2 || ''}
                      initialSplitMode={(activeTab as any).splitMode || 'none'}
                      theme={theme}
                      readOnly={readOnly}
                      onSqlChange={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, sql: val } as any) : t));
                      }}
                      onSql2Change={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, sql2: val } as any) : t));
                      }}
                      onSplitModeChange={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, splitMode: val } as any) : t));
                      }}
                    />
                  )}
                </div>
              )}

              {/* Terminal: mount thường trực (ẩn/hiện bằng CSS) để phiên PTY sống khi chuyển tab */}
              {tabs.filter(t => t.type === 'terminal').map(t => (
                <TerminalPanel
                  key={t.id}
                  config={((t as any).config || { type: connection.dbType }) as DbConnectionConfig}
                  profileName={t.label}
                  floating={!!(t as any).floating}
                  active={activeTabId === t.id}
                  onToggleFloat={() => setTabs(prev => prev.map(x => x.id === t.id ? ({ ...x, floating: !(x as any).floating } as any) : x))}
                  onClose={() => handleCloseTab(t.id)}
                  // Terminal ở đây là một tab -> đã có X trên tab, bỏ nút X trùng ở header
                  closable={false}
                />
              ))}

              {showAi && (
                <AiAssistant
                  onInsertSql={handleInsertSql}
                  tableNameContext={activeTable}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Popup chọn tệp: báo định dạng cho phép trước khi mở hộp thoại của hệ điều hành */}
      <ImportFilePicker
        open={showGlobalImportPicker}
        targetTable={globalImportTargetTable}
        onCancel={() => setShowGlobalImportPicker(false)}
        onConfirm={handleGlobalFileImport}
      />

      {/* Kết quả xuất tệp — cho mở luôn thư mục chứa tệp */}
      <ConfirmDialog
        open={!!exportDone}
        tone="success"
        title="Xuất dữ liệu xong"
        message={
          exportDone ? (
            <>
              {exportDone.message}
              {exportDone.path && (
                <div style={{ marginTop: '6px', fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--win-text-secondary)' }}>
                  {exportDone.path}
                </div>
              )}
            </>
          ) : null
        }
        note={exportDone?.viaDownload ? 'Tệp được tải qua WebView nên nằm ở thư mục tải xuống của hệ thống.' : undefined}
        confirmLabel={exportDone?.dir ? 'Mở thư mục' : 'Đóng'}
        cancelLabel="Đóng"
        onCancel={() => setExportDone(null)}
        onConfirm={() => {
          const dir = exportDone?.dir;
          setExportDone(null);
          if (dir) openInFileManager(dir);
        }}
      />

      {/* Tiến độ nhập dữ liệu vào bảng (modal xem trước đã đóng) */}
      {globalImportProgress && (
        <div style={{
          position: 'fixed',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10002,
          width: '420px',
          maxWidth: '90vw',
          display: 'flex',
          background: 'var(--win-bg-card)',
          border: '1px solid var(--win-border-strong, var(--win-border))',
          borderRadius: '6px',
          boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
          padding: '10px 12px'
        }}>
          <ProgressBar progress={globalImportProgress} />
        </div>
      )}

      {/* Xuất cả database (Export Database) */}
      <ExportDatabaseDialog
        open={showExportDbDialog}
        onClose={() => setShowExportDbDialog(false)}
        onSubmit={handleExportDatabase}
      />

      {/* Nhập cả database từ tệp dump (Import Database) */}
      <ImportDatabaseDialog
        open={showImportDbDialog}
        onClose={() => setShowImportDbDialog(false)}
        currentDb={connection?.dbName}
        canManageDatabases={!!connection && connection.dbType !== 'sqlite'}
        dbType={connection?.dbType}
        onSubmit={handleImportDatabase}
      />

      {/* Xuất một bảng — mở từ menu chuột phải ở Sidebar, cùng popup với nút Export dưới grid */}
      {exportTableTarget && connection && (
        <ExportTableDialog
          open
          tableName={exportTableTarget}
          dbType={connection.dbType}
          onClose={() => setExportTableTarget(null)}
          onSuccess={(msg) => alert(msg)}
          onError={(msg) => alert(msg)}
        />
      )}

      {/* Global Import Table Modal (Import New Table) */}
      {showGlobalImportModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.6)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            width: '640px',
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '6px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                {globalImportTargetTable 
                  ? `Nhập Dữ Liệu vào Bảng: ${globalImportTargetTable} - Tệp: ${globalImportFileName}`
                  : `Tạo Bảng Mới & Nhập Dữ Liệu - Tệp: ${globalImportFileName}`}
              </span>
              <button 
                onClick={() => setShowGlobalImportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group">
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                  {globalImportTargetTable ? 'Bảng đích (Nhập vào bảng hiện có)' : 'Tên bảng mới sẽ tạo'}
                </label>
                <input 
                  type="text" 
                  className="form-input"
                  value={globalImportTargetTable || globalImportTableName} 
                  onChange={(e) => !globalImportTargetTable && setGlobalImportTableName(e.target.value)}
                  disabled={!!globalImportTargetTable}
                  placeholder="nhap_ten_bang"
                  style={{ height: '30px', fontSize: '11px', background: globalImportTargetTable ? 'var(--win-bg-hover)' : undefined }}
                />
              </div>

              {globalImportFileType === 'sql' && (
                <div className="form-group">
                  <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', marginBottom: '6px', display: 'block' }}>
                    Chọn nội dung thực thi từ tệp SQL
                  </label>
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'both'} 
                        onChange={() => setGlobalImportSqlMode('both')} 
                      />
                      <span>Cấu trúc & Dữ liệu</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'structure'} 
                        onChange={() => setGlobalImportSqlMode('structure')} 
                      />
                      <span>Chỉ cấu trúc (Structure)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'data'} 
                        onChange={() => setGlobalImportSqlMode('data')} 
                      />
                      <span>Chỉ dữ liệu (Data)</span>
                    </label>
                  </div>
                </div>
              )}

              <div>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {globalImportFileType === 'sql' ? (
                    <span>SQL Script: Câu lệnh SQL sẽ chạy trực tiếp.</span>
                  ) : (
                    <span>
                      Định dạng {globalImportFileType.toUpperCase()}: phát hiện <b>{globalImportPendingRows.length} dòng</b>,
                      {' '}<b>{globalImportCols.length} cột</b>.
                    </span>
                  )}
                </span>
              </div>

              {/* Tab xem trước: cấu trúc (cột + kiểu suy ra) | dữ liệu (10 dòng đầu) */}
              {globalImportFileType !== 'sql' && (
                <div style={{ display: 'flex', gap: '4px' }}>
                  {([
                    { id: 'structure', label: `Cấu trúc (${globalImportCols.length} cột)` },
                    { id: 'data', label: `Dữ liệu (${globalImportPendingRows.length} dòng)` },
                  ] as const).map(t => (
                    <button
                      key={t.id}
                      onClick={() => setGlobalImportTab(t.id)}
                      style={{
                        padding: '4px 12px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: globalImportTab === t.id ? 'var(--win-accent)' : 'transparent',
                        color: globalImportTab === t.id ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              {globalImportFileType === 'sql' ? (
                <textarea
                  readOnly
                  value={globalImportSqlContent.slice(0, 5000)}
                  style={{
                    width: '100%',
                    height: '200px',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    padding: '10px',
                    borderRadius: '4px',
                    resize: 'none'
                  }}
                />
              ) : (
                <div style={{
                  height: '200px',
                  overflow: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)'
                }}>
                  {globalImportPendingRows.length === 0 ? null : globalImportTab === 'structure' ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {['Cột trong tệp', 'Kiểu suy ra', 'Ví dụ giá trị'].map(h => (
                            <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {globalImportCols.map(col => {
                          const sample = globalImportPendingRows.find(r => r?.[col] !== null && r?.[col] !== undefined && r?.[col] !== '');
                          return (
                            <tr key={col} style={{ borderBottom: '1px solid var(--win-border)' }}>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>{col}</td>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>{inferColType(globalImportPendingRows, col)}</td>
                              <td style={{ padding: '6px 8px', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '260px' }}>
                                {sample ? String(sample[col]) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {globalImportCols.map(col => (
                            <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {globalImportPendingRows.slice(0, 10).map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {globalImportCols.map(col => (
                              <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px' }}>
                                {row[col] === null || row[col] === undefined
                                  ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                  : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              padding: '12px 16px',
              borderTop: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowGlobalImportModal(false)}
                
              >
                Hủy
              </button>
              <button
                className="btn btn-primary"
                onClick={confirmGlobalImport}
                disabled={globalImportLoading || (!globalImportTableName.trim() && globalImportFileType !== 'sql')}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                {globalImportLoading ? 'Đang xử lý...' : 'Xác nhận Tạo & Nhập'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Database Info Modal */}
      <DatabaseInfoModal
        isOpen={showDbInfoModal}
        onClose={() => setShowDbInfoModal(false)}
        onSelectTable={(tableName) => handleSelectTable(tableName)}
        initialTab={dbInfoTab}
        onDatabaseChanged={handleDatabaseChanged}
      />

      {/* Diff Schema & Migration Modal */}
      {showSchemaMigration && connection && (
        <SchemaMigration
          dbType={connection.dbType}
          database={connection.dbName}
          onClose={() => setShowSchemaMigration(false)}
        />
      )}

      {/* About Modal */}
      {showAbout && (
        /* Bấm ra ngoài để đóng — trước đây chỉ đóng được bằng nút. */
        <div className="cm-modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="about-close" onClick={() => setShowAbout(false)} title="Đóng" aria-label="Đóng">
              <X size={15} />
            </button>

            <img className="about-logo" src={appIcon} alt="" />
            <div className="about-name">TableNova</div>
            <div className="about-version">Phiên bản {appVersion}</div>

            <p className="about-desc">
              Công cụ quản lý cơ sở dữ liệu nhẹ, nhanh và trực quan — kết nối, duyệt dữ liệu,
              chỉnh sửa cấu trúc và chạy truy vấn trong cùng một giao diện.
            </p>

            <div className="about-engines">
              <span className="about-engine" style={{ background: '#003B57' }}><SqliteIcon size={13} /> SQLite</span>
              <span className="about-engine" style={{ background: '#336791' }}><PostgresIcon size={13} /> PostgreSQL</span>
              <span className="about-engine" style={{ background: '#00758F' }}><MySqlIcon size={13} /> MySQL</span>
              <span className="about-engine" style={{ background: '#DC382D' }}><RedisIcon size={13} /> Redis</span>
            </div>

            <div className="about-author">
              Phát triển bởi <strong>MeoMeo</strong>
            </div>
            <div className="about-links">
              <button onClick={() => dbHelper.openUrl('mailto:pthang888@gmail.com')}>Email</button>
              <span className="about-link-sep">·</span>
              <button onClick={() => dbHelper.openUrl('https://www.linkedin.com/in/thangpx/')}>LinkedIn</button>
            </div>

            <div className="about-foot">
              <span className="about-copy">© 2026 MeoMeo · MIT License</span>
              <button className="cm-btn" onClick={() => setShowAbout(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* Shortcuts Modal */}
      {showShortcuts && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.6)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            width: '450px',
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '6px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                Phím tắt bàn phím (Keyboard Shortcuts)
              </span>
              <button 
                onClick={() => setShowShortcuts(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>
            
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '380px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Chung</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Tìm kiếm bảng/View</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + P / Ctrl + K</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Bảng Dữ liệu (Grid)</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Mở bộ lọc dữ liệu (Filter)</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + F</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Thêm dòng mới</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + I</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Lưu thay đổi xuống DB</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + S</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Xóa dòng đã chọn</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Delete / Backspace</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Trang tiếp theo</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + ]</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Trang trước đó</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + [</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Trình soạn thảo SQL</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Chạy truy vấn SQL</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Enter / F5</kbd>
                </div>
              </div>
            </div>
            
            <div style={{ borderTop: '1px solid var(--win-border)', padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.05))' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowShortcuts(false)}
                style={{ padding: '6px 20px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer' }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default App;
