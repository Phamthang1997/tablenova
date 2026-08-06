import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
import { DbCompareDialog } from './components/DbCompareDialog';
import { DataGeneratorDialog } from './components/DataGeneratorDialog';
import { RedisBrowser } from './components/RedisBrowser';
import { ImportFilePicker } from './components/ImportFilePicker';
import { ExportTableDialog } from './components/ExportTableDialog';
import { ExportDatabaseDialog } from './components/ExportDatabaseDialog';
import type { DatabaseExportOptions } from './components/ExportDatabaseDialog';
import { ImportDatabaseDialog } from './components/ImportDatabaseDialog';
import { DbConnectionStatusPill } from './components/DbConnectionStatusPill';
import { Bot, Lock, LockOpen, X } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './components/DbIcons';
import { dbHelper } from './utils/dbHelper';
import type { DbConnectionConfig } from './utils/dbHelper';
import { invalidateCatalog } from './sql/catalog';
import { connKey, legacyTabsStorageKey, tabsStorageKey } from './utils/connKey';
import { parseXlsx } from './utils/xlsxReader';
import { collectColumns, inferColType } from './utils/importPreview';
import { addExistsHint } from './utils/dumpPreview';
import { ProgressBar, type ProgressState } from './components/ProgressBar';
import { buildDatabaseFile, buildSql } from './utils/exportHelper';
import { gzipText, openInFileManager, saveExportFile } from './utils/fileSave';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './components/Modal';
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
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const fmtNum = (n: number) => n.toLocaleString(locale);

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
  // Chế độ chỉ đọc: chặn mọi thao tác ghi. Nhớ qua các lần mở app (quy ước tf_*) — một công tắc
  // an toàn mà reset về "cho phép ghi" mỗi lần khởi động thì gần như vô dụng.
  const [readOnly, setReadOnly] = useState(() => localStorage.getItem('tf_readonly') === '1');
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
  const [showDbCompare, setShowDbCompare] = useState(false);
  // Data Generator: bảng mở sẵn khi vào từ menu ngữ cảnh của một bảng.
  const [showDataGen, setShowDataGen] = useState(false);
  const [dataGenTable, setDataGenTable] = useState<string | null>(null);
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
        if (rows.length === 0) throw new Error(t('dataGrid.errXlsxEmpty'));
        setGlobalImportFileType('json'); // dòng dạng object, đi chung nhánh ghi DB với CSV/JSON
        setGlobalImportPendingRows(rows);
        setShowGlobalImportModal(true);
      } catch (err: any) {
        alert(t('dataGrid.errReadFile', { message: err.message }));
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
            throw new Error(t('dataGrid.errJsonArray'));
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
            throw new Error(t('dataGrid.errCsvEmpty'));
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
          throw new Error(t('dataGrid.errUnsupportedFile'));
        }
      } catch (err: any) {
        alert(t('dataGrid.errReadFile', { message: err.message }));
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
            label: t('app.exportTableProgress', { i: tableIndex + 1, total: totalTables, table }),
            current: tableIndex + inner,
            total: totalTables,
            detail: totalRows
              ? t('app.exportRowsPct', { rows: fmtNum(rows.length), total: fmtNum(totalRows), pct: Math.round(inner * 100) })
              : t('app.exportRows', { rows: fmtNum(rows.length) }),
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
        onProgress({ label: t('app.exportBuilding', { format: opts.format.toUpperCase() }) });
        const file = buildDatabaseFile(sheets, opts.format, opts.filename);
        onProgress({ label: t('app.exportWriting') });
        const saved = await saveExportFile(opts.dir, file.name, file.data, file.mime);
        onProgress(null);
        setExportDone({
          message: t('app.exportedSheets', { n: sheets.length, format: opts.format.toUpperCase(), file: file.name }),
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
          label: t('app.exportTableProgress', { i: i + 1, total: totalTables, table }),
          current: i,
          total: totalTables,
          detail: t('app.exportReadingSchema'),
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
            parts.push(t('app.exportSchemaFailed', {
              table: `${q}${table}${q}`,
              message: def.error || t('app.exportUnknownReason'),
            }));
          }
          parts.push('');
        }
        if (opts.sqlOptions.includeContent) {
          const rows = await readTableRows(table, i);
          if (rows.length > 0) {
            const schema = await dbHelper.getTableSchema(table);
            const colNames = (schema.columns || []).map(c => c.name);
            const cols = colNames.length ? colNames : Object.keys(rows[0]);
            parts.push(t('app.exportDataComment', { table: `${q}${table}${q}`, rows: rows.length }));
            parts.push(buildSql(table, cols, rows, connection?.dbType || 'sqlite'));
            parts.push('');
          }
        }
        onProgress({
          label: t('app.exportTableProgress', { i: i + 1, total: totalTables, table }),
          current: i + 1,
          total: totalTables,
          detail: t('app.exportTableDone'),
        });
      }

      const sqlText = parts.join('\n');
      const ext = opts.compressGzip ? '.sql.gz' : '.sql';
      const base = opts.filename.replace(/\.(sql|sql\.gz|gz)$/i, '');
      const fileName = base + ext;

      onProgress({ label: opts.compressGzip ? t('app.exportCompressing') : t('app.exportWriting') });
      const payload = opts.compressGzip ? await gzipText(sqlText) : sqlText;
      const saved = await saveExportFile(
        opts.dir,
        fileName,
        payload,
        opts.compressGzip ? 'application/gzip' : 'text/plain;charset=utf-8'
      );
      onProgress(null);

      setExportDone({
        message: t('app.exportedSql', { n: opts.tables.length, file: fileName }),
        path: saved.path,
        dir: saved.dir,
        viaDownload: saved.savedTo === 'download',
      });
      return true;
    } catch (err: any) {
      onProgress(null);
      alert(t('app.errExport', { message: err.message }));
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
      alert(t('app.errNoTableName'));
      return;
    }

    setShowGlobalImportModal(false);
    setGlobalImportLoading(true);
    setGlobalImportProgress({
      label: globalImportFileType === 'sql'
        ? t('app.importRunningSql')
        : t('app.importWritingRows', { n: globalImportPendingRows.length }),
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
          alert(t('app.importSqlSuccess'));
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert(t('app.errImportSql', { message: res.error }));
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
            failed = resData.error || t('app.errImportFailed');
            break;
          }
          done += batch.length;
          setGlobalImportProgress({
            label: t('app.importWritingTable', { table }),
            current: done,
            total,
            detail: t('app.importRowsDetail', { done: fmtNum(done), total: fmtNum(total) }),
          });
        }
        if (failed) {
          alert(done > 0
            ? t('app.errImportWithProgress', { message: failed, done, total })
            : t('app.errImport', { message: failed }));
        } else {
          alert(t('app.importedRows', { n: done, table }));
        }
        window.dispatchEvent(new CustomEvent('database-restored'));
      } else {
        // Bảng mới: backend tạo bảng + chèn trong một lần gọi -> tiến độ vô định.
        const resData = await dbHelper.importNewTable(globalImportTableName, globalImportPendingRows);
        if (resData.success) {
          alert(t('app.createdAndImported', { table: globalImportTableName }));
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert(t('app.errImport', { message: resData.error }));
        }
      }
    } catch (err: any) {
      alert(t('common.connectionError', { message: err.message }));
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
            alert(t('app.errCreateDatabase', { name: wantDb, message: created.error }));
            return false;
          }
        }

        const switched = await dbHelper.switchDatabase(wantDb);
        if (!switched.success) {
          alert(t('app.errSwitchDatabase', { name: wantDb, message: switched.error }));
          return false;
        }
        setConnection(prev => prev ? { ...prev, dbName: switched.database || wantDb } : null);
        invalidateCatalog();
      }

      const resData = await dbHelper.restoreBackup(sqlText, tables, onProgress);
      if (resData.success) {
        alert(t('app.importDbSuccess', { n: resData.statementsCount || 0 }));
        if (resData.activeDatabase) {
          const activeDb = resData.activeDatabase;
          setConnection(prev => prev ? { ...prev, dbName: activeDb } : null);
        }
        invalidateCatalog();
        window.dispatchEvent(new CustomEvent('database-restored'));
        return true;
      }
      alert(t('app.errImport', { message: addExistsHint(resData.error || '', false) }));
      return false;
    } catch (e: any) {
      alert(t('app.errImport', { message: e.message }));
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
            label: t('app.queryTabLabel', { n: 1 }),
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

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    localStorage.setItem('tf_readonly', next ? '1' : '0');
  };

  React.useEffect(() => {
    if (connection) {
      const storageKey = tabsStorageKey(activeConnConfig, connection.dbType, connection.dbName);
      // Không lưu tab terminal: phiên PTY không tồn tại sau khi reload
      const persistTabs = tabs.filter(t => t.type !== 'terminal');
      const persistActive = persistTabs.some(t => t.id === activeTabId) ? activeTabId : (persistTabs[0]?.id ?? null);
      const payload = { tabs: persistTabs, activeTabId: persistActive, queryCount };
      try {
        localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // Hết quota (SQL nháp dài x nhiều tab x nhiều DB dùng chung ~5MB với lịch sử,
        // profile, snapshot). Bỏ nội dung nháp của các tab không hoạt động để vẫn giữ
        // được danh sách tab và nháp của tab đang mở, thay vì mất sạch lần lưu này.
        const trimmed = persistTabs.map(tab =>
          tab.id === persistActive ? tab : ({ ...tab, sql: undefined, sql2: undefined } as TabInfo)
        );
        try {
          localStorage.setItem(storageKey, JSON.stringify({ ...payload, tabs: trimmed }));
        } catch (e) {
          console.warn('Không lưu được danh sách tab (localStorage đã đầy):', e);
        }
      }
    }
  }, [tabs, activeTabId, connection, activeConnConfig, queryCount]);

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

  // Khôi phục tab (kèm SQL nháp trong tab) của một database. Khoá mới gồm cả
  // host:port nên không lẫn giữa hai máy chủ có database cùng tên; khoá cũ chỉ
  // được ĐỌC, một lần, khi khoá mới còn trống — để không ai mất tab đang mở.
  const restoreTabs = (
    config: DbConnectionConfig | null | undefined,
    dbType: string,
    dbName: string,
  ): boolean => {
    const storageKey = tabsStorageKey(config, dbType, dbName);
    const legacyKey = legacyTabsStorageKey(dbType, dbName);
    const saved = localStorage.getItem(storageKey)
      ?? (storageKey === legacyKey ? null : localStorage.getItem(legacyKey));
    if (!saved) return false;
    try {
      const { tabs: savedTabs, activeTabId: savedActiveId, queryCount: savedQueryCount } = JSON.parse(saved);
      if (Array.isArray(savedTabs) && savedTabs.length > 0) {
        setTabs(savedTabs);
        setActiveTabId(savedActiveId || savedTabs[0].id);
        setQueryCount(savedQueryCount || (savedTabs.length + 1));
        return true;
      }
    } catch (e) {
      console.error('Lỗi phục hồi tab history:', e);
    }
    return false;
  };

  // Handle successful database connection
  const handleConnect = (dbName: string, dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', color?: string, config?: DbConnectionConfig) => {
    setConnection({ dbName, dbType });
    setActiveConnectionColor(color);
    setActiveConnConfig(config || null);

    // Đổi kết nối -> xoá cache bảng/cột để autocomplete & hover không còn dữ liệu của DB cũ
    invalidateCatalog();

    // Try to restore tabs from localStorage
    if (restoreTabs(config, dbType, dbName)) return;

    // Open an initial SQL Query tab on connect
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: t('app.queryTabLabel', { n: 1 }),
      },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  // Disconnect from database
  // Hỏi xác nhận nếu bảng đang mở còn thay đổi chưa lưu (cờ do DataGrid đặt: window.__gridDirty)
  const guardDirty = () =>
    !(window as any).__gridDirty || window.confirm(t('app.confirmDiscardGridChanges'));

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

    if (nextConn && restoreTabs(activeConnConfig, nextConn.dbType, newName)) return;

    // Fallback
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: t('app.queryTabLabel', { n: 1 }),
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
      label: t('app.queryTabLabel', { n: queryCount }),
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  };

  // Mở tab SQL với nội dung có sẵn (script đồng bộ từ hộp thoại So sánh 2 database).
  // Không gộp vào handleNewQueryTab vì hàm đó được truyền thẳng làm onClick -> tham số
  // đầu tiên sẽ là MouseEvent.
  const openQueryTabWithSql = (sql: string) => {
    const tabId = `query_${Date.now()}`;
    const newTab = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: t('app.queryTabLabel', { n: queryCount }),
      sql,
    } as TabInfo;
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
        label: t('app.queryTabLabel', { n: queryCount }),
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
            readOnly={readOnly}
          />
        </div>
      ) : (
        <div className="workspace-container" style={{ borderTop: activeConnectionColor ? `3px solid ${activeConnectionColor}` : 'none' }}>
          {showSidebar && (
            <Sidebar
              dbName={connection.dbName}
              dbType={connection.dbType}
              readOnly={readOnly}
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
              onCompareDatabases={() => setShowDbCompare(true)}
              onGenerateData={(tableName) => {
                setDataGenTable(tableName ?? null);
                setShowDataGen(true);
              }}
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
                onClick={toggleReadOnly}
                style={{
                  color: readOnly ? '#f59e0b' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', gap: '4px', width: 'auto', padding: '0 8px', fontSize: '11px', marginRight: '6px'
                }}
                title={readOnly ? t('app.readOnlyOnTitle') : t('app.readOnlyOffTitle')}
              >
                {readOnly ? <Lock size={14} /> : <LockOpen size={14} />}
                <span>{readOnly ? t('app.readOnlyOn') : t('app.readOnlyOff')}</span>
              </button>
              <button
                className="tab-new-btn"
                onClick={() => setShowAi(!showAi)}
                style={{ 
                  color: showAi ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '24px', padding: 0 
                }}
                title={t('app.toggleAiCopilot')}
              >
                <Bot size={14} />
              </button>
            </div>

            <div className="active-panel-container" style={{ position: 'relative' }}>
              {!activeTab ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                  {t('app.emptyWorkspace')}
                </div>
              ) : activeTab.type === 'terminal' ? (
                (activeTab as any).floating ? (
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    {t('app.terminalFloating')}
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
                      connKey={connKey(activeConnConfig)}
                      dbName={connection.dbName}
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
        title={t('app.exportDoneTitle')}
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
        note={exportDone?.viaDownload ? t('app.exportDoneNoteWebView') : undefined}
        confirmLabel={exportDone?.dir ? t('app.openFolder') : t('common.close')}
        cancelLabel={t('common.close')}
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
        <Modal
          title={globalImportTargetTable
            ? t('app.importModalTitleExisting', { table: globalImportTargetTable, file: globalImportFileName })
            : t('app.importModalTitleNew', { file: globalImportFileName })}
          onClose={() => setShowGlobalImportModal(false)}
          width="640px"
          zIndex={9999}
        >
            <ModalBody>
              <div className="form-group">
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                  {globalImportTargetTable ? t('app.importTargetExisting') : t('app.importTargetNew')}
                </label>
                <input 
                  type="text" 
                  className="form-input"
                  value={globalImportTargetTable || globalImportTableName} 
                  onChange={(e) => !globalImportTargetTable && setGlobalImportTableName(e.target.value)}
                  disabled={!!globalImportTargetTable}
                  placeholder={t('createTable.tableNamePlaceholder')}
                  style={{ height: '30px', fontSize: '11px', background: globalImportTargetTable ? 'var(--win-bg-hover)' : undefined }}
                />
              </div>

              {globalImportFileType === 'sql' && (
                <div className="form-group">
                  <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', marginBottom: '6px', display: 'block' }}>
                    {t('app.importSqlPick')}
                  </label>
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'both'} 
                        onChange={() => setGlobalImportSqlMode('both')} 
                      />
                      <span>{t('app.importSqlBoth')}</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'structure'} 
                        onChange={() => setGlobalImportSqlMode('structure')} 
                      />
                      <span>{t('app.importSqlStructure')}</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'data'} 
                        onChange={() => setGlobalImportSqlMode('data')} 
                      />
                      <span>{t('app.importSqlData')}</span>
                    </label>
                  </div>
                </div>
              )}

              <div>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {globalImportFileType === 'sql' ? (
                    <span>{t('app.importSqlNote')}</span>
                  ) : (
                    <span>
                      <Trans
                        i18nKey="app.importSummary"
                        values={{
                          format: globalImportFileType.toUpperCase(),
                          rows: globalImportPendingRows.length,
                          cols: globalImportCols.length,
                        }}
                        components={{ strong: <b /> }}
                      />
                    </span>
                  )}
                </span>
              </div>

              {/* Tab xem trước: cấu trúc (cột + kiểu suy ra) | dữ liệu (10 dòng đầu) */}
              {globalImportFileType !== 'sql' && (
                <div style={{ display: 'flex', gap: '4px' }}>
                  {([
                    { id: 'structure', label: t('app.importTabStructure', { n: globalImportCols.length }) },
                    { id: 'data', label: t('app.importTabData', { n: globalImportPendingRows.length }) },
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
                          {[t('app.colInFile'), t('app.colInferredType'), t('app.colSampleValue')].map(h => (
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
            </ModalBody>

            <ModalFooter>
              <button
                className="btn btn-secondary"
                onClick={() => setShowGlobalImportModal(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={confirmGlobalImport}
                disabled={globalImportLoading || (!globalImportTableName.trim() && globalImportFileType !== 'sql')}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                {globalImportLoading ? t('app.importProcessing') : t('app.importConfirm')}
              </button>
            </ModalFooter>
        </Modal>
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

      {/* So sánh 2 database (cấu trúc + dữ liệu) */}
      {showDbCompare && connection && (
        <DbCompareDialog
          dbType={connection.dbType}
          currentDb={connection.dbName}
          onClose={() => setShowDbCompare(false)}
          onOpenInSqlEditor={openQueryTabWithSql}
        />
      )}

      {/* Sinh dữ liệu test hàng loạt */}
      {showDataGen && connection && (
        <DataGeneratorDialog
          dbName={connection.dbName}
          initialTable={dataGenTable}
          onClose={() => {
            setShowDataGen(false);
            setDataGenTable(null);
            // Số dòng của các bảng đã đổi -> Sidebar/DataGrid nạp lại. Dùng lại event sẵn có
            // thay vì thêm event mới (schema không đổi nên KHÔNG cần invalidateCatalog).
            window.dispatchEvent(new CustomEvent('database-restored'));
          }}
        />
      )}

      {/* About Modal */}
      {showAbout && (
        /* Bấm ra ngoài để đóng — trước đây chỉ đóng được bằng nút. */
        <div className="cm-modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="about-close" onClick={() => setShowAbout(false)} title={t('common.close')} aria-label={t('common.close')}>
              <X size={15} />
            </button>

            <img className="about-logo" src={appIcon} alt="" />
            <div className="about-name">TableNova</div>
            <div className="about-version">{t('app.aboutVersion', { version: appVersion })}</div>

            <p className="about-desc">{t('app.aboutDesc')}</p>

            <div className="about-engines">
              <span className="about-engine" style={{ background: '#003B57' }}><SqliteIcon size={13} /> SQLite</span>
              <span className="about-engine" style={{ background: '#336791' }}><PostgresIcon size={13} /> PostgreSQL</span>
              <span className="about-engine" style={{ background: '#00758F' }}><MySqlIcon size={13} /> MySQL</span>
              <span className="about-engine" style={{ background: '#DC382D' }}><RedisIcon size={13} /> Redis</span>
            </div>

            <div className="about-author">
              <Trans i18nKey="app.aboutAuthor" components={{ strong: <strong /> }} />
            </div>
            <div className="about-links">
              <button onClick={() => dbHelper.openUrl('mailto:pthang888@gmail.com')}>Email</button>
              <span className="about-link-sep">·</span>
              <button onClick={() => dbHelper.openUrl('https://www.linkedin.com/in/thangpx/')}>LinkedIn</button>
            </div>

            <div className="about-foot">
              <span className="about-copy">© 2026 MeoMeo · MIT License</span>
              <button className="cm-btn" onClick={() => setShowAbout(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Floating DB Connection Speed & Status Pill (TablePlus style) */}
      {connection && (
        <div
          style={{
            position: 'fixed',
            bottom: '6px',
            right: '12px',
            zIndex: 900,
            pointerEvents: 'auto',
          }}
        >
          <DbConnectionStatusPill hasConnection={!!connection} />
        </div>
      )}

      {/* Shortcuts Modal */}
      {showShortcuts && (
        <Modal
          title={t('app.shortcutsTitle')}
          onClose={() => setShowShortcuts(false)}
          width="450px"
          zIndex={9999}
        >
            <ModalBody style={{ gap: '12px', maxHeight: '380px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsGeneral')}</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutSearchTables')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + P / Ctrl + K</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsGrid')}</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutOpenFilter')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + F</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutAddRow')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + I</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutSaveToDb')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + S</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutDeleteRow')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Delete / Backspace</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutNextPage')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + ]</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutPrevPage')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + [</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>{t('app.shortcutsSqlEditor')}</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutRunQuery')}</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Enter / F5</kbd>
                </div>
              </div>
            </ModalBody>

            <ModalFooter>
              <button
                className="btn btn-secondary"
                onClick={() => setShowShortcuts(false)}
                style={{ padding: '6px 20px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer' }}
              >
                {t('common.close')}
              </button>
            </ModalFooter>
        </Modal>
      )}
    </>
  );
};

export default App;
