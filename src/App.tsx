import React, { Suspense, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './components/TitleBar';
import { SafeModeGate } from './components/SafeModeGate';
import { ConnectionManager } from './components/ConnectionManager';
import { Sidebar } from './components/Sidebar';
import { DbRail } from './components/DbRail';
import { DatabaseInfoModal } from './components/DatabaseInfoModal';
import { TabManager } from './components/TabManager';
import type { TabInfo } from './components/TabManager';
import { TAB_GROUP_COLORS, moveGroup, moveTabIntoGroup, reorderTabs, type TabGroup } from './utils/tabGroups';
import { DataGrid } from './components/DataGrid';
// Lazy: `SqlEditor` is the app's only static edge to `monaco-editor`, and pulling it into the
// entry chunk made the webview parse ~4.5MB (Monaco + the SQL vendor bundle) and run the
// completion/hover/theme registrations before the first frame — even for a session that never
// opens a query tab. Fetched on the first query tab instead; later mounts resolve synchronously.
// The Redis console is lazied the same way in `RedisToolTab`; both edges have to stay lazy or
// Monaco is back in the entry chunk and neither one buys anything.
const SqlEditor = React.lazy(() =>
  import('./components/SqlEditor').then((m) => ({ default: m.SqlEditor })));
import { LazyEditorFallback } from './components/LazyEditorFallback';
import { AiAssistant } from './components/AiAssistant';
import { TerminalPanel } from './components/TerminalPanel';
import { RoutineEditorModal } from './components/RoutineEditorModal';
import { ViewEditorModal } from './components/ViewEditorModal';
import { SchemaMigration } from './components/SchemaMigration';
import { DbCompareDialog } from './components/DbCompareDialog';
import { DataGeneratorDialog } from './components/DataGeneratorDialog';
import { RedisSidebarView } from './components/redis/RedisSidebarView';
import { RedisKeyTab } from './components/redis/RedisKeyTab';
import { RedisToolTab } from './components/redis/RedisToolTab';
import {
  REDIS_TOOL_TABS,
  redisKeyTabId,
  redisToolTabId,
  redisToolTabLabel,
  type RedisTabType,
} from './components/redis/redisTabs';

/** Six Redis tool tab types for quick lookup in render branch. */
const REDIS_TOOL_TAB_TYPES = new Set<string>(REDIS_TOOL_TABS);
import { ImportFilePicker } from './components/ImportFilePicker';
import { ExportTableDialog } from './components/ExportTableDialog';
import { ExportDatabaseDialog } from './components/ExportDatabaseDialog';
import type { DatabaseExportOptions } from './components/ExportDatabaseDialog';
import { ImportDatabaseDialog } from './components/ImportDatabaseDialog';
import { DocViewerModal } from './components/DocViewerModal';
import { WhatsNewModal, WHATS_NEW_STORAGE_KEY, WHATS_NEW_AUTO_SHOW_KEY } from './components/WhatsNewModal';
import { X } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './components/DbIcons';
import { dbHelper, activeConnId, setActiveConnId } from './utils/dbHelper';
import { installCloseGuard } from './utils/closeGuard';
import { startJob } from './utils/jobs';
import { makeRestoreReporter } from './utils/restoreProgress';
import { isProduction, normalizeEnv, type ConnEnv } from './utils/connEnv';
import type { DbConnectionConfig } from './utils/dbHelper';
import { invalidateCatalog } from './sql/catalog';
import { splitStatements } from './sql/statements';
import { connKey, scopeKey, tabsStorageKey, tabsStorageKeyCandidates } from './utils/connKey';
import { connectSavedProfile } from './utils/connectProfile';
import type { SavedProfile } from './components/ConnectionManager';
import { updateProfileDisplay } from './utils/connectionProfiles';
import { applyProgressStyle, getProgressStyle } from './utils/progressStyle';
import { parseXlsx } from './utils/xlsxReader';
import { collectColumns, inferColType } from './utils/importPreview';
import { addExistsHint } from './utils/dumpPreview';
import { ProgressBar, type ProgressState } from './components/ProgressBar';
import { buildDatabaseFile } from './utils/exportHelper';
import { buildDump, readTableRows, dumpReaderFor } from './utils/dumpBuilder';
import { gzipText, saveExportFile } from './utils/fileSave';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './components/Modal';
import type { XlsxSheet } from './utils/xlsxWriter';
import appIcon from './assets/icon.png';

/**
 * One query tab, wrapped so it can stay mounted while another tab is on screen — a `SqlEditor`
 * that unmounts loses everything the run produced (results, columns, EXPLAIN plan, paging,
 * Monaco's undo stack); only the SQL text survives, because that one is lifted into `tabs[].sql`.
 *
 * Memoized, and the write path is a single stable `onPatch` rather than three inline closures:
 * every mounted tab would otherwise re-render on each debounced keystroke of the active one.
 * `tab` is a fresh object only for the tab being edited (`tabs.map` keeps the others), so this
 * narrows the re-render down to the tab the user is actually typing in.
 */
interface QueryTabPanelProps {
  tab: TabInfo;
  active: boolean;
  dbType?: string;
  connKey: string;
  /** Kết nối mà tab này run on. Xem §4.1 — not read id ambient. */
  connId: string;
  /** Kết nối gắn nhãn production. */
  isProdConn?: boolean;
  /** Kết nối này currently read-only (cờ backend), khác `readOnly` is công tắc toàn cục. */
  connReadOnly?: boolean;
  dbName: string;
  theme: 'dark' | 'light';
  readOnly: boolean;
  onPatch: (id: string, patch: Partial<TabInfo>) => void;
}

const QueryTabPanel = React.memo(function QueryTabPanel(props: QueryTabPanelProps) {
  const { tab, active, onPatch } = props;
  return (
    // hide bằng visibility + position:absolute chứ not must display:none như TerminalPanel:
    // display:none destroys layout box, resetting result grid scrollTop to 0 and forcing
    // Monaco đo is 0x0 rồi must bố trí lại lúc hiện ra. Cách này preserve size and vị
    // absolute prevents hidden tabs from taking flex space in .active-panel-container
    // (already is position:relative).
    <div
      style={
        active
          ? { flex: 1, display: 'flex', overflow: 'hidden' }
          : {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          }
      }
    >
      <Suspense fallback={<LazyEditorFallback />}>
        <SqlEditor
          connId={props.connId}
          isProdConn={props.isProdConn}
          connReadOnly={props.connReadOnly}
          dbType={props.dbType}
          connKey={props.connKey}
          dbName={props.dbName}
          initialSql={(tab as any).sql || ''}
          initialSql2={(tab as any).sql2 || ''}
          initialSplitMode={(tab as any).splitMode || 'none'}
          initialEditorHeight={(tab as any).customEditorHeight}
          theme={props.theme}
          readOnly={props.readOnly}
          onSqlChange={(val) => onPatch(tab.id, { sql: val } as any)}
          onSql2Change={(val) => onPatch(tab.id, { sql2: val } as any)}
          onSplitModeChange={(val) => onPatch(tab.id, { splitMode: val } as any)}
          onEditorHeightChange={(val) => onPatch(tab.id, { customEditorHeight: val } as any)}
        />
      </Suspense>
    </div>
  );
});

/** Số row mỗi lô when nhập dữ liệu ando table có sẵn (to báo is tiến độ). */
const IMPORT_BATCH_SIZE = 500;

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
    /**
     * Which connection this describes.
     *
     * Carried inside the object rather than only in `activeConnIdState` because the two are set from
     * different places and, on one path, at different times: `selectConnection` sets the id first and
     * the name only after an `await`. The tab-saving effect keys the storage slot off `dbName` but
     * picks the tabs off `activeConnIdState`, so that gap made it write connection A's tabs into
     * connection B's slot — reopening B then restored A's tabs. Pairing them in one value is what
     * lets the effect notice and skip that render. Never write one without the other.
     */
    connId: string;
    dbName: string;
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
    // Postgres only: the schema every command reads and writes through. Comes from the backend
    // (`current_schema()` on connect, the picker afterwards), never guessed here — it is part of
    // the localStorage scope, so a value the backend disagrees with would key tabs wrongly.
    schema?: string | null;
  } | null>(null);
  // configuration kết nối currently dùng (gồm cả SSH) to Terminal kế thừa -> open shell ando đúng máy chủ/VM
  const [activeConnConfig, setActiveConnConfig] = useState<DbConnectionConfig | null>(null);
  /** `conn_id` of kết nối currently display. Backend sinh, `dbHelper` bắt is from `connect()`. */
  const [activeConnIdState, setActiveConnIdState] = useState('');
  /**
   * currently open Connection Manager to **add** một kết nối nữa (nút `+` of rail).
   *
   * Khác with đường cũ: "kết nối mới" trước đây is `handleDisconnect` — ngắt cái currently có rồi hiện
   * lại màn hình quản lý. Giờ backend giữ is nhiều kết nối nên add is add, not must thay.
   */
  const [addingConn, setAddingConn] = useState(false);
  // Bumped whenever the rail must refetch `list_connections`. A counter, not `openConns.length`:
  // toggling read-only changes what the rail draws without changing how many connections there are.
  const [railReloadKey, setRailReloadKey] = useState(0);
  // Read by the window-level listeners below, which register once: putting the id in their deps
  // would tear them down and re-register on every connection switch.
  const activeConnIdRef = React.useRef(activeConnIdState);
  React.useEffect(() => {
    activeConnIdRef.current = activeConnIdState;
  }, [activeConnIdState]);
  /**
   * Mọi kết nối currently open, kèm config already dùng to open nó.
   *
   * Backend cố ý not trả config về (nó mang credential), nhưng chuyển giữa các kết nối cần config
   * to key tab of kết nối đó (`tabsStorageKey`) and to hiện tên/màu profile. Đây is bản đồ
   * `conn_id -> những gì chỉ frontend biết`; phần "kết nối nào currently open" vẫn is backend nói
   * (`list_connections`).
   */
  const [openConns, setOpenConns] = useState<
    {
      connId: string;
      config: DbConnectionConfig | null;
      dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis';
      profileName: string;
      /** Nhãn màu, thuần trang trí. */
      color: string;
      /** environment, trường riêng of profile — not suy from `color` (xem `utils/connEnv.ts`). */
      env: ConnEnv;
      readOnly?: boolean;
    }[]
  >([]);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  /**
   * Tabs of the connection on screen.
   *
   * `tabs` holds every open connection's tabs so switching back to one is instant and its unsaved
   * SQL survives (§4.5). The strip shows one connection at a time — the rail is what switches — so
   * everything downstream renders from this, not from `tabs`. **Every "is this tab already open?"
   * lookup must use this too**: tab ids are unique per connection only (`table_users` exists on all
   * of them), so a match in `tabs` can name a tab belonging to a connection that is not on screen,
   * and selecting it leaves the pane empty instead of opening anything.
   *
   * Declared here, above every handler that reads it, rather than next to the render: it closes over
   * nothing but state declared above, and a `const` used before its line is a runtime TDZ error that
   * `tsc` does not catch.
   *
   * A tab with no `connId` came from a workspace saved before tabs carried one; treat it as the
   * active connection's rather than hiding it, or an upgrading user opens the app to an empty strip.
   */
  const visibleTabs = tabs.filter((tb) => (tb.connId ?? activeConnIdState) === activeConnIdState);

  const [queryCount, setQueryCount] = useState(1);
  const [showAi, setShowAi] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('tf_theme') as 'dark' | 'light') || 'dark');
  // mode read-only: chặn mọi thao tác write. Nhớ qua các lần open app (quy ước tf_*) — một công tắc
  // an toàn mà reset về "allows write" mỗi lần khati động thì gần như vô dụng.
  const [readOnly, setReadOnly] = useState(() => localStorage.getItem('tf_readonly') === '1');
  // Tab table còn edit đổi chưa commit (do DataGrid báo lên). Xem guardDirty bên under.
  const [dirtyTabId, setDirtyTabId] = useState<string | null>(null);
  /** Action waiting for the user to agree to discard unsaved edits — see guardDirty. */
  const [discardPrompt, setDiscardPrompt] = useState<(() => void) | null>(null);
  // Tab query already fromng is open -> mount thường trực to giữ kết quả. Mount lười chứ not
  // mount hết `tabs`: khôi phục 10 tab from localStorage mà build luôn 10 Monaco thì phí.
  const [mountedQueryTabs, setMountedQueryTabs] = useState<Set<string>>(() => new Set());
  // tab group (kiểu Chrome). save cùng chỗ with danh sách tab, xem restoreTabs.
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  const [dbReloadKey, setDbReloadKey] = useState(0);

  // Xuất/Nhập cả database (popup riêng, open from mục Công cụ at Sidebar or menu tiêu đề)
  const [showExportDbDialog, setShowExportDbDialog] = useState(false);
  const [showImportDbDialog, setShowImportDbDialog] = useState(false);
  // Xuất một table (open from menu right click / context menu at Sidebar) — cùng popup with nút Export under grid
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
  // column có in tệp (gộp key of mọi row vì CSV/JSON can thiếu column at một số row)
  const globalImportCols = React.useMemo(() => collectColumns(globalImportPendingRows), [globalImportPendingRows]);
  const [showDbInfoModal, setShowDbInfoModal] = useState(false);
  // Tab open sẵn of DatabaseInfoModal: 'current' when ando from "Thông tin Database",
  // 'all' when ando from "Thống kê all database" in menu Databases.
  const [dbInfoTab, setDbInfoTab] = useState<'current' | 'all'>('current');
  const [showSchemaMigration, setShowSchemaMigration] = useState(false);
  const [showDbCompare, setShowDbCompare] = useState(false);
  // Data Generator: table open sẵn when ando from menu ngữ cảnh of một table.
  const [showDataGen, setShowDataGen] = useState(false);
  const [dataGenTable, setDataGenTable] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  // Lấy version thật from tauri.conf.json thay vì hardcode in JSX (dễ lệch when
  // bump phiên bản). run bằng vite-dev thuần thì not có backend -> giữ default.
  const [appVersion, setAppVersion] = useState('0.1.0');
  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { });
  }, []);

  // MỘT listener `onCloseRequested` for cả app; ai muốn chặn thì đăng ký blocker (transaction chưa
  // commit, việc run nền). Hai listener độc lập thì cái nào resolve trước will `destroy()` and giết
  // luôn hộp thoại of cái kia — xem utils/closeGuard.ts.
  React.useEffect(() => installCloseGuard(), []);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showDocModal, setShowDocModal] = useState(false);
  const [docQuery] = useState('');
  const [showWhatsNew, setShowWhatsNew] = useState<boolean>(() => {
    const autoShow = localStorage.getItem(WHATS_NEW_AUTO_SHOW_KEY);
    if (autoShow === 'false') return false;
    const seen = localStorage.getItem(WHATS_NEW_STORAGE_KEY);
    return !seen;
  });

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setShowDocModal(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  // Profile currently kết nối: id to write ngược tên/màu xuống tf_connection_profiles,
  // tên + màu to popover chi tiết kết nối display and edit tại chỗ. Kết nối not
  // đi qua profile nào (chưa save) thì id rỗng -> popover vẫn xem is, chỉ not save.
  const [activeProfile, setActiveProfile] = useState<{ id: string; name: string; color: string }>({
    id: '',
    name: '',
    color: '',
  });

  const [showGlobalImportPicker, setShowGlobalImportPicker] = useState(false);

  const handleImportToTableTrigger = (tableName: string) => {
    setGlobalImportTargetTable(tableName);
    setShowGlobalImportPicker(true);
  };

  // Chuột must > Xuất dữ liệu: open đúng popup xuất-một-table như nút Export under grid.
  const handleExportTableTrigger = (tableName: string) => {
    setExportTableTarget(tableName);
  };

  // receive tệp from ImportFilePicker (already check phần expand at đó) rồi parse to preview.
  const handleGlobalFileImport = async (file: File) => {
    setShowGlobalImportPicker(false);
    setGlobalImportTab('structure');
    setGlobalImportFileName(file.name);
    const guessedTableName = file.name.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    setGlobalImportTableName(guessedTableName);

    // XLSX is nhị phân -> read ArrayBuffer + parse riêng, not đi qua FileReader.readAsText.
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const rows = await parseXlsx(buf);
        if (rows.length === 0) throw new Error(t('dataGrid.errXlsxEmpty'));
        setGlobalImportFileType('json'); // row dạng object, đi chung nhánh write DB with CSV/JSON
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

  /**
   * Xuất cả database. run **nền**: hàm này chỉ xếp một job rồi trả `true` to dialog close ngay,
   * còn tiến độ / kết quả / error nằm at `JobsTray`. Trước đây tiến độ is state of dialog, nên
   * close dialog is mất tiến độ and app đứng wait suốt lần xuất — xem docs/background-jobs-plan.md.
   *
   * Kết quả đi qua `JobResult` chứ not bật add một hộp thoại: một modal tự nhảy ra sau mười phút,
   * lúc user currently gõ query khác, đúng is thứ mode nền này sinh ra to bỏ.
   */
  const handleExportDatabase = async (opts: DatabaseExportOptions): Promise<boolean> => {
    // Chốt ngay lúc submit: user đổi kết nối in lúc job run thì job vẫn read đúng chỗ nó
    // is giao. `connId` already is (server, database) nên nó cũng is key độc quyền — xem jobs.ts.
    const jobConnId = activeConnIdState;
    const dbType = connection?.dbType || 'sqlite';
    const schema = connection?.schema;
    const dbLabel = connection?.dbName || opts.filename;

    startJob({
      kind: 'dump',
      title: t('jobs.titleExport', { n: dbLabel }),
      db: connection?.dbName || '',
      lockKey: `${jobConnId}|${connection?.dbName || ''}`,
      run: async (ctx) => {
        const report = (p: ProgressState | null) => ctx.report(p);
        const totalTables = opts.tables.length;

        // Dữ liệu (XLSX/JSON/CSV): build file client-side.
        if (opts.format !== 'sql') {
          const sheets: XlsxSheet[] = [];
          for (let i = 0; i < opts.tables.length; i++) {
            ctx.throwIfCancelled();
            const table = opts.tables[i];
            const schemaInfo = await dbHelper.getTableSchema(jobConnId, table);
            const rows = await readTableRows(dumpReaderFor(dbHelper, jobConnId), table, i, totalTables, report);
            const colNames = (schemaInfo.columns || []).map(c => c.name);
            const finalCols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
            sheets.push({ name: table, colNames: finalCols, rows });
          }
          report({ label: t('app.exportBuilding', { format: opts.format.toUpperCase() }) });
          const file = buildDatabaseFile(sheets, opts.format, opts.filename);
          report({ label: t('app.exportWriting') });
          const saved = await saveExportFile(opts.dir, file.name, file.data, file.mime);
          return {
            message: t('app.exportedSheets', { n: sheets.length, format: opts.format.toUpperCase(), file: file.name }),
            path: saved.path,
            dir: saved.dir,
            viaDownload: saved.savedTo === 'download',
          };
        }

        // SQL: dump is build at dumpBuilder.ts — dùng chung with nút Backup of Connection
        // Manager, to mọi change về thứ tự statement chỉ must edit at MỘT chỗ.
        const sqlText = await buildDump({
          dbType,
          tables: opts.tables,
          views: opts.views,
          routines: opts.routines,
          triggers: opts.triggers,
          sqlOptions: opts.sqlOptions,
          // Dump is read ra from schema currently select, nên header must nói ra schema đó — if not,
          // nhập lại at máy khác thì mọi thứ chui ando schema đầu search_path of máy đó.
          schema,
          onProgress: report,
        }, dumpReaderFor(dbHelper, jobConnId));
        ctx.throwIfCancelled();

        const ext = opts.compressGzip ? '.sql.gz' : '.sql';
        const base = opts.filename.replace(/\.(sql|sql\.gz|gz)$/i, '');
        const fileName = base + ext;

        report({ label: opts.compressGzip ? t('app.exportCompressing') : t('app.exportWriting') });
        const payload = opts.compressGzip ? await gzipText(sqlText) : sqlText;
        const saved = await saveExportFile(
          opts.dir,
          fileName,
          payload,
          opts.compressGzip ? 'application/gzip' : 'text/plain;charset=utf-8'
        );

        return {
          message: t('app.exportedSql', { n: opts.tables.length, file: fileName }),
          path: saved.path,
          dir: saved.dir,
          viaDownload: saved.savedTo === 'download',
        };
      },
    });

    return true;
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
    // splitStatements: cùng bộ tách with SQL editor and with split_sql_statements bên Rust
    // (biết string, comment, khối $$...$$). Trước đây đây is một bộ tách tự chế thứ ba,
    // chỉ đếm quotes nên comment chứa ';' is cắt sai.
    const queries = splitStatements(sqlText).map((s) => s.text);
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

        // executeQueryMulti, not must executeQuery: execute_query send nguyên string xuống
        // driver như MỘT statement. Một tệp .sql nhiều statement will error cú pháp ngay at câu thứ
        // hai on MySQL/Postgres, còn SQLite chỉ run câu đầu rồi báo successful (mất dữ liệu
        // im lặng). executeQueryMulti tách statement bằng split_sql_statements rồi run lần lượt.
        const res = await dbHelper.executeQueryMulti(activeConnIdState, filteredSql);
        if (res.success) {
          alert(t('app.importSqlSuccess'));
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
        } else {
          alert(t('app.errImportSql', { message: res.error }));
        }
      } else if (globalImportTargetTable) {
        // table có sẵn: write theo lô to báo is tiến độ thật.
        const table = globalImportTargetTable;
        const total = globalImportPendingRows.length;
        let done = 0;
        let failed: string | null = null;
        for (let i = 0; i < total; i += IMPORT_BATCH_SIZE) {
          const batch = globalImportPendingRows.slice(i, i + IMPORT_BATCH_SIZE);
          const resData = await dbHelper.importTableData(activeConnIdState, table, batch);
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
        window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
      } else {
        // table mới: backend create table + chèn in một lần gọi -> tiến độ vô định.
        const resData = await dbHelper.importNewTable(globalImportTableName, globalImportPendingRows);
        if (resData.success) {
          alert(t('app.createdAndImported', { table: globalImportTableName }));
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
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

  // returns true if nhập xong -> ImportDatabaseDialog tự close.
  // targetDb: database đích lấy from tệp or do user nhập; chưa tồn tại thì create mới.
  const handleImportDatabase = async (
    sqlText: string,
    tables: string[],
    targetDb: string,
    continueOnError = false
  ): Promise<boolean> => {
    try {
      const wantDb = targetDb.trim();
      const canManageDb = !!connection && connection.dbType !== 'sqlite';

      // The connection the restore actually runs on, passed explicitly to `restoreBackup`. A local
      // rather than `activeConnIdState`, which is React state and still holds the OLD id inside this
      // closure when the import opens a database of its own — that would also mis-address the
      // `database-restored` event at the end.
      let targetConnId = activeConnIdState;

      if (canManageDb && wantDb && wantDb !== connection?.dbName) {
        const list = await dbHelper.listDatabases(activeConnIdState);
        const exists = (list.databases || []).some(d => d.toLowerCase() === wantDb.toLowerCase());

        if (!exists) {
          const created = await dbHelper.createDatabase(activeConnIdState, { name: wantDb });
          if (!created.success) {
            alert(t('app.errCreateDatabase', { name: wantDb, message: created.error }));
            return false;
          }
        }

        // OPEN the target rather than switching this connection onto it. Switching replaced the pool,
        // so importing into another database refused outright whenever the current one had
        // uncommitted work — and when it succeeded it left every open tab pointing at tables of a
        // database the connection no longer served. Opening leaves the old one intact and gives the
        // import its own connection.
        const opened = await dbHelper.openDatabase(activeConnIdState, wantDb);
        if (!opened.success || !opened.connId) {
          alert(t('sidebar.errOpenDb', { message: opened.error || '' }));
          return false;
        }
        targetConnId = opened.connId;
        // Points the app — and `dbHelper`'s ambient id, which the restore reads — at the new
        // connection, and gives it its own tab list.
        handleDatabaseOpened(opened.connId, opened.database || wantDb, opened.schema);
        invalidateCatalog();
      }

      // Phần chuhide is at on (create/open database đích) run **in** dialog: nó cần trả lời is
      // "not create is database" ngay lúc user còn đứng đó. Chỉ bản thân lần restore mới
      // run nền — nó is phần dài, and is phần not cần ai ngồi nhìn.
      const restoreConnId = targetConnId;
      startJob({
        kind: 'restore',
        title: t('jobs.titleRestore', { n: wantDb || connection?.dbName || '' }),
        db: wantDb || connection?.dbName || '',
        write: true,
        lockKey: `${restoreConnId}|${wantDb || connection?.dbName || ''}`,
        run: async (ctx) => {
          const toProgress = makeRestoreReporter(t);
          const resData = await dbHelper.restoreBackup(
            sqlText,
            tables,
            (msg) => ctx.report(toProgress(msg)),
            continueOnError,
            restoreConnId,
          );
          if (!resData.success) throw new Error(addExistsHint(resData.error || '', false));

          // `USE <db>` in tệp dump đổi database of kết nối này, nên nhãn on title bar
          // must đổi theo — nhưng CHỈ when user vẫn currently xem đúng kết nối đó. Job run nền,
          // nên lúc nó xong user can already sang kết nối khác, and write đè nhãn of kết nối ấy
          // is hiện tên một database nó not hề open.
          if (resData.activeDatabase && activeConnIdRef.current === restoreConnId) {
            const activeDb = resData.activeDatabase;
            setConnection(prev => prev ? { ...prev, dbName: activeDb } : null);
          }
          invalidateCatalog();
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: restoreConnId } }));

          // Có statement is skip thì must nói ra: báo "successful" trơn in when thiếu andi chục
          // câu is to user tin nhầm rằng database already đầy đủ.
          if (resData.failedCount) {
            return {
              message: t('app.importDbPartial', {
                n: resData.statementsCount || 0,
                failed: resData.failedCount,
              }),
              warning: (resData.failedSamples || []).map((f) => `• ${f.error}`).join('\n'),
            };
          }
          return { message: t('app.importDbSuccess', { n: resData.statementsCount || 0 }) };
        },
      });
      return true;
    } catch (e: any) {
      alert(t('app.errImport', { message: e.message }));
      return false;
    }
  };

  /**
   * A table was renamed on `connId` — retitle only THAT connection's tabs for it.
   *
   * `tabs` now holds every open connection's tabs, and table names repeat across connections
   * (`sakila` and `sakila2` both have `film`). Without the id check, renaming `film` on one
   * connection silently relabels the other connection's `film` tab to a table it does not have.
   */
  const handleTableRenamed = (connId: string, oldName: string, newName: string) => {
    setTabs((prev) =>
      prev.map((tb) => {
        if (tb.type === 'table' && tb.name === oldName && (tb.connId ?? connId) === connId) {
          return { ...tb, name: newName, label: newName };
        }
        return tb;
      })
    );
  };

  const handleTableDropped = (tableName: string) => {
    const connId = activeConnIdState;
    setTabs((prev) => {
      // Scoped both ways. Dropping `users` on one connection used to close a tab named `users` on
      // every other one, and when the array happened to empty out it was REPLACED by a single new
      // tab — throwing away every other connection's tabs, unsaved SQL included.
      const remaining = prev.filter(
        (tb) => !(tb.type === 'table' && tb.name === tableName && (tb.connId ?? connId) === connId),
      );
      const mine = remaining.filter((tb) => (tb.connId ?? connId) === connId);
      if (mine.length === 0) {
        return [
          ...remaining,
          {
            id: 'query_1',
            connId,
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
      const { connId, oldName, newName } = e.detail || {};
      handleTableRenamed(connId ?? activeConnIdRef.current, oldName, newName);
    };
    window.addEventListener('table-renamed', handleGlobalRename);
    return () => window.removeEventListener('table-renamed', handleGlobalRename);
  }, []);

  React.useEffect(() => {
    // `dbReloadKey` is one counter for the whole workspace, and only the active connection's
    // components are mounted — so bumping it for a change on another connection would make the
    // panels on screen refetch for something that did not touch them.
    const handleGlobalReload = (e: Event) => {
      const from = (e as CustomEvent<{ connId?: string }>).detail?.connId;
      if (from && from !== activeConnIdRef.current) return;
      setDbReloadKey((prev) => prev + 1);
    };
    window.addEventListener('database-restored', handleGlobalReload);
    return () => window.removeEventListener('database-restored', handleGlobalReload);
  }, []);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  React.useEffect(() => {

    // Kiểu thanh tiến độ cũng đặt on <html> như theme, xem utils/progressStyle.ts
    applyProgressStyle(getProgressStyle());

    // macOS not tự bo góc window when decorations = false, nên must tự bo bằng
    // CSS for khớp radius of lớp vibrancy (windowEffects.radius in
    // tauri.conf.json). Windows 11 tự bo nên not cần.
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.documentElement.setAttribute('data-os', isMac ? 'macos' : 'other');
  }, []);

  const applyTheme = (nextTheme: 'dark' | 'light') => {
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('tf_theme', nextTheme);
  };

  const toggleTheme = () => applyTheme(theme === 'dark' ? 'light' : 'dark');

  // rename/màu/environment kết nối from popover chi tiết. Phần display luôn đổi ngay; việc
  // write xuống profile chỉ xảy ra when kết nối này thực sự đến from một profile already save.
  const handleProfileChange = (patch: { name?: string; color?: string; env?: ConnEnv }) => {
    setActiveProfile((prev) => ({
      ...prev,
      name: patch.name ?? prev.name,
      color: patch.color ?? prev.color,
    }));
    updateProfileDisplay(activeProfile.id, patch);

    if (!activeConnIdState) return;
    setOpenConns((prev) =>
      prev.map((c) =>
        c.connId === activeConnIdState
          ? { ...c, color: patch.color ?? c.color, env: patch.env ?? c.env }
          : c,
      ),
    );
    // Đánh dấu production *bây giờ* thì must có hiệu lực *bây giờ*. if wait tới lần kết nối sau,
    // lớp bảo vệ already bật nhưng not bảo vệ gì in suốt phiên currently open.
    if (isProduction(patch.env)) {
      void dbHelper.setConnectionReadOnly(activeConnIdState, true);
      setOpenConns((prev) =>
        prev.map((c) => (c.connId === activeConnIdState ? { ...c, readOnly: true } : c)),
      );
    }
    setRailReloadKey((k) => k + 1);
  };

  // open lại phiên bằng đúng configuration currently dùng: hữu ích when server close kết nối
  // nhàn rỗi. preserve tab currently open — chỉ phiên phía Rust is build lại — nhưng
  // clear cache catalog vì server can already đổi schema in lúc mất kết nối.
  const handleReconnect = async (): Promise<{ success: boolean; message?: string }> => {
    if (!activeConnConfig) return { success: false };
    const oldId = activeConnIdState;
    await dbHelper.disconnect();
    const res = await dbHelper.connect(activeConnConfig);
    if (!res.success) return { success: false, message: res.message };
    // Reconnect mints a NEW conn_id — the old entry is gone from the registry. Without this the
    // rail would keep drawing a dead connection and, worse, `TxControl` would filter out every
    // `tx-state-changed` event because it is still comparing against the old id.
    const newId = activeConnId();
    setActiveConnIdState(newId);
    setOpenConns((prev) =>
      prev.map((c) => (c.connId === oldId ? { ...c, connId: newId } : c)),
    );
    // The tabs have to move to the new id as well. Remapping only `openConns` left every tab
    // stamped with the dead one, so `visibleTabs` matched none of them: the strip emptied on
    // reconnect and the save effect — which writes the tabs of the active connection — then
    // persisted that empty list over the workspace.
    setTabs((prev) =>
      prev.map((tb) => ((tb.connId ?? oldId) === oldId ? { ...tb, connId: newId } : tb)),
    );
    invalidateCatalog();
    setDbReloadKey((prev) => prev + 1);
    return { success: true };
  };

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    localStorage.setItem('tf_readonly', next ? '1' : '0');
  };

  /**
   * Đẩy công tắc chỉ-read toàn cục xuống backend for kết nối Redis.
   *
   * Chốt thật must at Rust: CLI Console send lệnh dạng văn bản tự do, nên vô hiệu hoá nút bấm at
   * WebView not chặn is một `FLUSHALL` gõ tay. `RedisBrowser` fromng giữ effect này; nó is delete
   * when Redis chuyển sang dùng tab, nên effect về đây.
   *
   * write or of hai nguồn, not must riêng công tắc: from Giai đoạn 0 cờ at backend is cờ of KẾT
   * NỐI — cũng is cờ mà nhãn production write — nên tắt công tắc mà write thẳng `false` will open key write
   * for một kết nối production.
   */
  React.useEffect(() => {
    if (connection?.dbType !== 'redis' || !activeConnIdState) return;
    const own = openConns.find((c) => c.connId === activeConnIdState)?.readOnly ?? false;
    void dbHelper.redisSetReadOnly(readOnly || own, activeConnIdState);
  }, [readOnly, connection?.dbType, activeConnIdState, openConns]);

  React.useEffect(() => {
    // Skip the renders where the two disagree — see `connection.connId`. Writing then would put the
    // tabs of the connection named by `activeConnIdState` into the slot named by `dbName`.
    if (connection && connection.connId === activeConnIdState) {
      const storageKey = tabsStorageKey(
        activeConnConfig,
        connection.dbType,
        connection.dbName,
        connection.schema,
      );
      // Chỉ write tab of active connection, under đúng key scope of nó. `tabs` giờ chứa tab of
      // MỌI kết nối currently open, nên write cả mảng ando một key is nhét tab of kết nối này sang chỗ of
      // kết nối khác. not cần write hộ các kết nối kia: nội dung tab chỉ đổi when kết nối of nó
      // currently is select (tab of kết nối khác not mount), and lần select trước already write rồi.
      //
      // not save tab terminal: phiên PTY not tồn tại sau when reload
      const persistTabs = tabs.filter(tb => tb.type !== 'terminal' && tb.connId === activeConnIdState);
      const persistActive = persistTabs.some(t => t.id === activeTabId) ? activeTabId : (persistTabs[0]?.id ?? null);
      const payload = { tabs: persistTabs, activeTabId: persistActive, queryCount, groups: tabGroups };
      try {
        localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // Hết quota (SQL nháp dài x nhiều tab x nhiều DB dùng chung ~5MB with lịch sử,
        // profile, snapshot). Bỏ nội dung nháp of các tab not hoạt động to vẫn giữ
        // is danh sách tab and nháp of tab currently open, thay vì mất sạch lần save này.
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
  }, [tabs, activeTabId, connection, activeConnConfig, activeConnIdState, queryCount, tabGroups]);

  React.useEffect(() => {
    const applyWindowSize = async () => {
      try {
        if (connection) {
          // already kết nối DB: Bừng rộng window ra 1280 x 800px
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

  // Khôi phục tab (kèm SQL nháp in tab) of một database. key mới gồm cả
  // host:port nên not lẫn giữa hai máy chủ có database cùng tên; key cũ chỉ
  // is read, một lần, when key mới còn trống — to not ai mất tab currently open.
  /**
   * A connection with nothing saved gets one empty SQL tab.
   *
   * MERGES like `restoreTabs` does, for the same reason: `tabs` now holds every open connection's
   * tabs, so replacing the array would throw away the other connections' work. The id is per
   * connection (`query_1` on each), which is exactly why the React keys in the render splice the
   * scope in — see the note there.
   */
  /**
   * Tab đầu tiên of một kết nối chưa có bộ tab already save.
   *
   * `dbType` is tham số tường minh chứ not read from `connection`: mọi chỗ gọi đều currently at giữa lúc
   * đổi kết nối, and `connection` when đó can còn is kết nối cũ.
   */
  const openInitialTab = (connId: string, dbType?: string) => {
    // Redis not có "SQL Query" to open. CLI Console is tab công cụ unique dùng is ngay when
    // chưa select key nào, and một workspace trống thì not nói for user biết ism gì tiếp.
    if (dbType === 'redis') {
      const tabId = redisToolTabId(connId, 'redis-console');
      const label = redisToolTabLabel('redis-console', t);
      setTabs((prev) => [
        ...prev.filter((tb) => tb.connId !== connId),
        { id: tabId, connId, type: 'redis-console', name: label, label },
      ]);
      setActiveTabId(tabId);
      return;
    }
    const initialTabId = 'query_1';
    setTabs((prev) => [
      ...prev.filter((tb) => tb.connId !== connId),
      { id: initialTabId, connId, type: 'query', name: 'SQL Query', label: t('app.queryTabLabel', { n: 1 }) },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  const restoreTabs = (
    connId: string,
    config: DbConnectionConfig | null | undefined,
    dbType: string,
    dbName: string,
    schema?: string | null,
  ): boolean => {
    // Newest key first, then the older spellings (no schema level, then pre-connKey). Only the
    // first is ever written back, so this migrates a workspace forward without duplicating it.
    const saved = tabsStorageKeyCandidates(config, dbType, dbName, schema)
      .map((key) => localStorage.getItem(key))
      .find((v) => v != null);
    if (!saved) return false;
    try {
      const {
        tabs: savedTabs,
        activeTabId: savedActiveId,
        queryCount: savedQueryCount,
        groups: savedGroups,
      } = JSON.parse(saved);
      if (Array.isArray(savedTabs) && savedTabs.length > 0) {
        // Stamp the connection onto every restored tab: what was saved is one connection's tabs, and
        // from here on a tab carries its own connection rather than inheriting the active one.
        const owned: TabInfo[] = savedTabs.map((tb: TabInfo) => ({ ...tb, connId }));
        // MERGE, do not replace. Tabs of other connections stay in state so switching back to them
        // is instant and their unsaved SQL survives — that is the whole point of §4.5. Any tabs
        // already held for *this* connection are dropped first, so a re-restore cannot duplicate.
        setTabs((prev) => [...prev.filter((tb) => tb.connId !== connId), ...owned]);
        // Bản save trước when có nhóm not có trường này -> mọi tab thành tab rời.
        setTabGroups(Array.isArray(savedGroups) ? savedGroups : []);
        setActiveTabId(savedActiveId || owned[0].id);
        setQueryCount(savedQueryCount || (savedTabs.length + 1));
        return true;
      }
    } catch (e) {
      console.error('Lỗi phục hồi tab history:', e);
    }
    return false;
  };

  // Handle successful database connection
  const handleConnect = (
    dbName: string,
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    color?: string,
    config?: DbConnectionConfig,
    profile?: { id: string; name: string; env?: ConnEnv },
    schema?: string | null,
  ) => {
    // Remember which config produced which `conn_id`. The backend deliberately does not hand the
    // config back — it carries credentials — but switching between open connections needs it, both
    // to key that connection's tabs (`tabsStorageKey`) and to label it. Keyed by the id the backend
    // just minted, which `dbHelper` captured from `connect()`.
    const id = activeConnId();
    const env = normalizeEnv(profile?.env);
    setConnection({ connId: id, dbName, dbType, schema: schema ?? null });
    setActiveProfile({ id: profile?.id || '', name: profile?.name || dbName, color: color || '' });
    setActiveConnConfig(config || null);
    setActiveConnIdState(id);
    // Marking a connection production is already the whole statement of intent; making the user also
    // find a menu item is how read-only ends up off on exactly the connection it mattered for.
    if (id && isProduction(env)) {
      void dbHelper.setConnectionReadOnly(id, true);
    }
    if (id) {
      setOpenConns((prev) => [
        ...prev.filter((c) => c.connId !== id),
        { connId: id, config: config || null, dbType, profileName: profile?.name || dbName, color: color || '', env, readOnly: isProduction(env) },
      ]);
    }

    // Đổi kết nối -> clear cache table/column to autocomplete & hover not còn dữ liệu of DB cũ
    invalidateCatalog();

    // Try to restore tabs from localStorage
    if (restoreTabs(id, config, dbType, dbName, schema)) return;

    // Open an initial SQL Query tab on connect
    openInitialTab(id, dbType);
  };

  /**
   * open một kết nối from profile already save, select in Quick Switcher.
   *
   * Đi qua `connectSavedProfile` (dùng chung with Connection Manager) rồi `handleConnect` — **cùng một
   * đường** with màn hình kết nối, not must một bản sao. Bản sao thứ hai of đường kết nối will mang
   * theo SSH, SSL, IAM and merge bí mật; hai bản will lệch, and lệch at đây thì biểu hiện is "profile này
   * kết nối is at màn kia mà not is at đây".
   */
  const handleConnectSavedProfile = async (profile: SavedProfile) => {
    const res = await connectSavedProfile(profile);
    if (!res.success) {
      alert(res.message || t('db.errConnect'));
      return;
    }
    handleConnect(
      res.database || profile.name,
      profile.type,
      profile.color,
      res.config,
      // `env` đi kèm at đây cũng vì lý do đó: thiếu nó thì open prod from switcher will not bật read-only,
      // in when open đúng profile ấy from Connection Manager thì có.
      { id: profile.id, name: profile.name, env: normalizeEnv(profile.env) },
      res.schema,
    );
  };

  // Hỏi confirm if table currently open còn change chưa save.
  //
  // Trước đây cờ này is biến toàn cục `window.__gridDirty` do DataGrid đặt. Đổi
  // sang state vì tab bar cần chấm dấu "chưa save", mà write biến toàn cục thì
  // not kéo theo render nào. Chỉ có một tab *table* is mount tại một thời điểm
  // (xem active-panel-container bên under — tab query and terminal thì mount thường
  // trực) nên nhiều nhất một tab bhide cùng lúc.
  // This question cannot use window.confirm: inside the Tauri webview it calls
  // `plugin:dialog|confirm`, a command the dialog plugin does not ship, so the call throws
  // and returns undefined — meaning every attempt to leave a half-edited tab was silently
  // blocked. The app's dialog is asynchronous, so guardDirty takes the ACTION and runs it
  // itself instead of returning true/false the way it used to.
  const guardDirty = (action: () => void) => {
    if (!dirtyTabId) {
      action();
      return;
    }
    // setState given a function reads it as an updater -> wrap it to store the function.
    setDiscardPrompt(() => action);
  };

  // Cả hai hàm dời tab đều nằm at utils/tabGroups.ts: chúng thuần and is nơi giữ
  // bất biến "tab cùng nhóm nằm liền nhau", nên at đó mới test is.
  const handleReorderTabs = (from: number, to: number, groupId: string | undefined) =>
    setTabs((prev) => reorderTabs(prev, from, to, groupId));

  const handleCreateTabGroup = (tabId: string) => {
    const id = `group_${Date.now()}`;
    const color = TAB_GROUP_COLORS[tabGroups.length % TAB_GROUP_COLORS.length];
    setTabGroups((prev) => [...prev, { id, name: t('tabs.defaultGroupName', { n: prev.length + 1 }), color }]);
    setTabs((prev) => moveTabIntoGroup(prev, tabId, id));
  };

  const handleAssignTabGroup = (tabId: string, groupId: string) =>
    setTabs((prev) => moveTabIntoGroup(prev, tabId, groupId));

  const handleRemoveTabFromGroup = (tabId: string) =>
    setTabs((prev) => moveTabIntoGroup(prev, tabId, undefined));

  const handleRenameTabGroup = (groupId: string, name: string) =>
    setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name } : g)));

  const handleSetTabGroupColor = (groupId: string, color: string) =>
    setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, color } : g)));

  // Thu gọn một nhóm currently CHỨA tab is xem thì must chuyển sang xem tab khác
  // trước, đúng như Chrome. if not, phần render will tự open nhóm ra (nó not
  // bao giờ giấu tab currently display nội dung) and bấm ando tên nhóm trông như
  // not có tác dụng gì — đây chính is lý do nút collapse "not ăn".
  const handleToggleTabGroup = (groupId: string) => {
    const group = tabGroups.find((g) => g.id === groupId);
    if (!group) return;

    const collapsing = !group.collapsed;
    const applyCollapse = () =>
      setTabGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: collapsing } : g)));

    if (collapsing && tabs.some((tab) => tab.id === activeTabId && tab.groupId === groupId)) {
      const outside = tabs.filter((tab) => tab.groupId !== groupId);
      // Cả window chỉ có mỗi nhóm này: collapse thì not còn gì to display.
      if (outside.length === 0) return;
      guardDirty(() => {
        const at = tabs.findIndex((tab) => tab.id === activeTabId);
        const after = tabs.slice(at + 1).find((tab) => tab.groupId !== groupId);
        const before = tabs.slice(0, at).reverse().find((tab) => tab.groupId !== groupId);
        setActiveTabId((after ?? before ?? outside[0]).id);
        applyCollapse();
      });
      return;
    }

    applyCollapse();
  };

  const handleMoveTabGroup = (groupId: string, targetIndex: number) =>
    setTabs((prev) => moveGroup(prev, groupId, targetIndex));

  const handleCloseTabGroup = (groupId: string) => {
    guardDirty(() => {
      const remaining = tabs.filter((tab) => tab.groupId !== groupId);
      setTabs(remaining);
      if (!remaining.some((tab) => tab.id === activeTabId)) {
        setActiveTabId(remaining[remaining.length - 1]?.id ?? null);
      }
    });
  };

  // Nhóm rỗng thì bỏ đi. run tập trung at đây thay vì rải ando fromng chỗ close tab:
  // tab is close at rất nhiều đường (nút X, chuột giữa, close tab khác, close bên
  // must, close all), sót một đường is còn lại một nhóm ma in bản save.
  React.useEffect(() => {
    queueMicrotask(() => {
      setTabGroups((prev) => {
        const used = new Set(tabs.map((tab) => tab.groupId).filter(Boolean));
        const next = prev.filter((g) => used.has(g.id));
        return next.length === prev.length ? prev : next;
      });
    });
  }, [tabs]);

  const handleSelectTab = (id: string) => {
    if (id === activeTabId) return;
    guardDirty(() => setActiveTabId(id));
  };

  const handleDisconnect = () => {
    guardDirty(async () => {
      const gone = activeConnId();
      await dbHelper.disconnect();
      const rest = openConns.filter((c) => c.connId !== gone);
      setOpenConns(rest);
      // Drop that connection's tabs too — they are invisible once it is gone, but leaving them in
      // state means a later connection reusing the id would inherit them.
      setTabs((prev) => prev.filter((tb) => tb.connId !== gone));
      // Disconnecting one of several connections leaves the app connected — fall through to
      // whichever is left instead of dropping the user back to the connection manager.
      const next = rest[rest.length - 1];
      if (next) {
        selectConnection(next.connId);
        return;
      }
      setActiveConnIdState('');
      setConnection(null);
      setActiveProfile({ id: '', name: '', color: '' });
      setTabs([]);
      setActiveTabId(null);
      setQueryCount(1);
      setShowSidebar(true);
    });
  };

  const handleNewConnection = () => setAddingConn(true);

  /**
   * Close one connection from the rail.
   *
   * Closing the one on screen falls through to whichever is left rather than dropping the user back
   * to the connection manager — same rule as `handleDisconnect`. Closing one that is NOT on screen
   * touches nothing else: the workspace, its tabs and its transaction all stay where they are, which
   * is the whole reason each connection has its own session.
   */
  const closeConnection = (connId: string) => {
    const isActive = connId === activeConnIdState;
    const finish = async () => {
      // `connId`, not `activeConnIdState`: "Close connection" on a cell that is not the one on
      // screen used to close the one on screen instead — the backend dropped the wrong entry while
      // the cell the user clicked stayed in the rail, looking unclosable.
      await dbHelper.disconnect(connId);
      const rest = openConns.filter((c) => c.connId !== connId);
      setOpenConns(rest);
      setTabs((prev) => prev.filter((tb) => tb.connId !== connId));
      if (!isActive) return;
      const next = rest[rest.length - 1];
      if (next) {
        selectConnection(next.connId);
        return;
      }
      setActiveConnIdState('');
      setConnection(null);
      setActiveProfile({ id: '', name: '', color: '' });
      setTabs([]);
      setActiveTabId(null);
      setQueryCount(1);
      setShowSidebar(true);
    };
    // Only guard when the tabs about to be swapped are the ones with unsaved edits in them.
    if (isActive) guardDirty(finish);
    else void finish();
  };

  /**
   * Flip one connection's read-only flag.
   *
   * The flag is enforced in the backend's SQL funnels, but it is **also** read on the frontend —
   * `QueryTabPanel`'s `connReadOnly` comes from `openConns`, so the editor can refuse a write
   * without a round trip. That mirror exists, so this has to write it: flipping only the backend
   * left the editor refusing every write while the rail already showed the padlock off, and the
   * one instruction the error gave the user did nothing.
   *
   * The value written is the one the **backend returns**, not `!cur.readOnly` — that keeps the
   * mirror a copy of the authority rather than a second opinion about it.
   */
  const toggleConnectionReadOnly = (connId: string) => {
    void (async () => {
      const list = await dbHelper.listConnections().catch(() => []);
      const cur = list.find((c) => c.connId === connId);
      if (!cur) return;
      const now = await dbHelper.setConnectionReadOnly(connId, !cur.readOnly);
      setOpenConns((prev) => prev.map((c) => (c.connId === connId ? { ...c, readOnly: now } : c)));
      // The rail redraws from `list_connections`; bumping this is what makes it refetch.
      setRailReloadKey((k) => k + 1);
    })();
  };

  const closeOtherConnections = (keepId: string) => {
    const doomed = openConns.filter((c) => c.connId !== keepId);
    if (!doomed.length) return;
    const run = async () => {
      for (const c of doomed) await dbHelper.disconnect(c.connId);
      setOpenConns((prev) => prev.filter((c) => c.connId === keepId));
      // Already on the survivor: nothing to reload. Otherwise the workspace has to move to it,
      // because the connection it was showing no longer exists.
      if (keepId !== activeConnIdState) selectConnection(keepId);
    };
    if (keepId !== activeConnIdState) guardDirty(run);
    else void run();
  };

  /**
   * A database picked from the title bar was **opened as another connection**, sharing the server
   * of the one it was picked from (same tunnel, same credentials). Register it and switch to it.
   *
   * It inherits that connection's `config` because it is the same server; only the database differs,
   * and `tabsStorageKey` already keys on `(config, database, schema)` — so the two get separate tab
   * lists without any extra bookkeeping.
   *
   * It also inherits `env` and `readOnly`, and those two must travel together: the backend copies
   * the read-only flag onto the new entry, so leaving `env` behind would draw a padlock with no
   * environment edge — two signals about the same connection disagreeing on screen. Another database
   * on the production server is still the production server.
   */
  const handleDatabaseOpened = (newId: string, dbName: string, schema?: string | null) => {
    const from = openConns.find((c) => c.connId === activeConnIdState);
    setOpenConns((prev) => [
      ...prev.filter((c) => c.connId !== newId),
      {
        connId: newId,
        config: from?.config ? { ...from.config, database: dbName } : null,
        dbType: from?.dbType ?? 'mysql',
        profileName: dbName,
        color: from?.color ?? '',
        env: from?.env ?? 'none',
        readOnly: from?.readOnly,
      },
    ]);
    // `selectConnection` reads `openConns`, which this render has not committed yet — point the
    // workspace at the new connection directly instead of racing the state update.
    setActiveConnId(newId);
    setActiveConnIdState(newId);
    setActiveConnConfig(from?.config ? { ...from.config, database: dbName } : null);
    setConnection((prev) => (prev ? { ...prev, connId: newId, dbName, schema: schema ?? null } : prev));
    invalidateCatalog();
    setDbReloadKey((k) => k + 1);
    if (from && restoreTabs(newId, { ...(from.config as DbConnectionConfig), database: dbName }, from.dbType, dbName, schema)) return;
    openInitialTab(newId, from?.dbType);
  };

  /**
   * Point the whole workspace at another open connection.
   *
   * Phase 2 keeps the "one connection on screen at a time" model: switching swaps the tab list the
   * way changing database already does. Tabs from different connections coexisting is Phase 3
   * (§4.5), and it is the step that also removes the ambient id `setActiveConnId` writes here.
   */
  const selectConnection = (connId: string) => {
    const entry = openConns.find((c) => c.connId === connId);
    if (!entry) return;
    // No `guardDirty` any more: switching no longer throws a tab list away. This connection's tabs
    // stay in `tabs` exactly as they were — unsaved grid edits included — and come back untouched
    // when the user switches back. Asking "discard changes?" for something nothing discards would be
    // a prompt that lies.
    setActiveConnId(connId);
    setActiveConnIdState(connId);
    void (async () => {
      const list = await dbHelper.listConnections().catch(() => []);
      const info = list.find((c) => c.connId === connId);
      if (!info) return;
      setConnection({ connId, dbName: info.db, dbType: entry.dbType, schema: info.schema });
      setActiveConnConfig(entry.config);
      setActiveProfile({ id: '', name: entry.profileName, color: entry.color });
      setDbReloadKey((k) => k + 1);
      // Only load from storage the FIRST time a connection is shown. After that its tabs are
      // already in memory, and re-reading would overwrite whatever the user has typed since.
      if (tabs.some((tb) => tb.connId === connId)) {
        const own = tabs.filter((tb) => tb.connId === connId);
        setActiveTabId(own[own.length - 1]?.id ?? null);
        return;
      }
      if (restoreTabs(connId, entry.config, entry.dbType, info.db, info.schema)) return;
      openInitialTab(connId, entry.dbType);
    })();
  };

  // Sau when đổi schema (chỉ Postgres): backend already receive schema mới rồi mới gọi ando đây.
  //
  // Đổi schema is đổi hẳn tập table, nên must ism đúng những việc of đổi database: clear cache
  // catalog (completion/hover còn giữ table of schema cũ), bắt Sidebar/DataGrid load lại, and đổi
  // key localStorage of tab — tab currently open trỏ ando table of schema cũ.
  const handleSchemaChanged = (newSchema: string) => {
    const nextConn = connection ? { ...connection, schema: newSchema } : null;
    setConnection(nextConn);
    invalidateCatalog();
    setDbReloadKey((k) => k + 1);

    if (nextConn && restoreTabs(activeConnIdState, activeConnConfig, nextConn.dbType, nextConn.dbName, newSchema)) return;

    openInitialTab(activeConnIdState, nextConn?.dbType);
  };

  // Open a specific table in a new or existing tab
  const handleSelectTable = (
    tableName: string,
    initialViewMode: 'data' | 'structure' = 'data',
    initialFilter?: { column: string; value: any }
  ) => {
    const tabId = `table_${tableName}`;
    const open = () => {
      // `visibleTabs`: a table of the same name open on another connection is a different tab. The
      // global lookup found it, skipped creating this connection's, and selected an id this
      // connection has none of — the empty pane, not an error.
      const exists = visibleTabs.find((tab) => tab.id === tabId);

      if (!exists) {
        const newTab: TabInfo = {
          id: tabId,
          type: 'table',
          name: tableName,
          label: tableName,
          initialViewMode,
          initialFilter,
        } as any;
        setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
      } else {
        setTabs(tabs.map(tab => tab.id === tabId ? { ...tab, initialViewMode, initialFilter } as any : tab));
      }
      setActiveTabId(tabId);
    };

    if (tabId === activeTabId) open();
    else guardDirty(open);
  };

  // Ctrl+Click / F12 on tên table or click FK link -> open tab table kèm bộ filter.
  // Dùng ref to listener (đăng ký 1 lần) luôn gọi bản handleSelectTable mới nhất.
  const selectTableRef = React.useRef(handleSelectTable);
  React.useEffect(() => {
    selectTableRef.current = handleSelectTable;
  });
  React.useEffect(() => {
    const handleOpenTableTab = (e: any) => {
      const table = e.detail?.table;
      if (table) selectTableRef.current(table, e.detail?.viewMode || 'data', e.detail?.initialFilter);
    };
    window.addEventListener('open-table-tab', handleOpenTableTab);
    return () => window.removeEventListener('open-table-tab', handleOpenTableTab);
  }, []);

  // ---- Tab Redis ----
  //
  // Ba handler under đây ism đúng việc mà `handleSelectTable` ism for table: open tab if chưa có, focus
  // if already có. Tách riêng chứ not nhồi ando `handleSelectTable` vì loại tab, nhãn and điều kiện
  // "already open" đều khác, and gộp lại will thành một hàm receive cờ to select nhánh.

  /** Db index of kết nối Redis currently xem. Nguồn is tên database (`db3`), not must state riêng. */
  const redisDbIndex = React.useMemo(() => {
    if (connection?.dbType !== 'redis') return 0;
    const n = parseInt((connection.dbName || '').replace(/^db/, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }, [connection?.dbType, connection?.dbName]);

  const handleOpenRedisKey = (key: string) => {
    const tabId = redisKeyTabId(activeConnIdState, key);
    if (!visibleTabs.some((tab) => tab.id === tabId)) {
      setTabs([
        ...tabs,
        {
          id: tabId,
          connId: activeConnIdState,
          type: 'redis-key',
          name: key,
          label: key,
          redisKeyInfo: { keyName: key },
        },
      ]);
    }
    setActiveTabId(tabId);
  };

  const handleOpenRedisTool = React.useCallback((type: RedisTabType) => {
    if (type === 'redis-key') return;
    const tabId = redisToolTabId(activeConnIdState, type);
    if (!visibleTabs.some((tab) => tab.id === tabId)) {
      const label = redisToolTabLabel(type, t);
      setTabs([
        ...tabs,
        { id: tabId, connId: activeConnIdState, type, name: label, label },
      ]);
    }
    setActiveTabId(tabId);
  }, [activeConnIdState, visibleTabs, t, tabs]);

  /**
   * Đổi db index of một kết nối Redis.
   *
   * Đây **not** must đổi state of current connection — backend mint/find một `conn_id` khác for
   * `(server, dbN)` (§2.1) — nên việc at đây giống hệt bấm sang một kết nối khác on `DbRail`: trỏ
   * `connId` sang id mới rồi to `selectConnection` khôi phục bộ tab of nó. Tab of db cũ at nguyên
   * in state, đúng như tab of một kết nối khác.
   */
  const handleRedisSelectDb = async (index: number, knownConnId?: string) => {
    let target = knownConnId;
    if (!target) {
      const res = await dbHelper.redisSelectDb(index);
      if (!res.success || !res.connId) {
        alert(res.error || t('redis.errSelectDb'));
        return;
      }
      target = res.connId;
    }
    if (target === activeConnIdState) return;
    const cfg = activeConnConfig;
    const dbName = `db${index}`;
    setOpenConns((prev) => [
      ...prev.filter((c) => c.connId !== target),
      {
        connId: target,
        config: cfg,
        dbType: 'redis',
        profileName: activeProfile.name || dbName,
        color: activeProfile.color || '',
        env: openConns.find((c) => c.connId === activeConnIdState)?.env ?? 'none',
        readOnly,
      },
    ]);
    setActiveConnId(target);
    setActiveConnIdState(target);
    setConnection({ connId: target, dbName, dbType: 'redis', schema: null });
    if (!restoreTabs(target, cfg, 'redis', dbName, null)) {
      // not có tab already save: open CLI Console ism tab đầu. Redis not có "SQL Query" to open như
      // `openInitialTab` ism, and một workspace trống not nói for user biết ism gì tiếp.
      const tabId = redisToolTabId(target, 'redis-console');
      const label = redisToolTabLabel('redis-console', t);
      setTabs((prev) => [
        ...prev.filter((tb) => tb.connId !== target),
        { id: tabId, connId: target, type: 'redis-console', name: label, label },
      ]);
      setActiveTabId(tabId);
    }
  };

  // Create a new SQL Query tab
  const handleNewQueryTab = React.useCallback(() => {
    if (connection?.dbType === 'redis') {
      handleOpenRedisTool('redis-console');
      return;
    }
    const tabId = `query_${Date.now()}`;
    const newTab: TabInfo = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: t('app.queryTabLabel', { n: queryCount }),
    };
    setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  }, [connection?.dbType, handleOpenRedisTool, t, queryCount, tabs, activeConnIdState]);

  // Open SQL tab with existing content (e.g. sync script from DB compare dialog)
  const openQueryTabWithSql = React.useCallback((sql: string) => {
    const tabId = `query_${Date.now()}`;
    const newTab = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: t('app.queryTabLabel', { n: queryCount }),
      sql,
    } as TabInfo;
    setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  }, [t, queryCount, tabs, activeConnIdState]);

  // Close tab
  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const close = () => {
      const tabIndex = tabs.findIndex((tab) => tab.id === id);
      const newTabs = tabs.filter((tab) => tab.id !== id);

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

    // close tab table currently edit dat -> hỏi confirm
    if (id === activeTabId) guardDirty(close);
    else close();
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
    // Only the tabs the user can actually see. Other connections' tabs are held in the same array
    // but are not on screen, so wiping them would be closing something the user never asked about.
    setTabs((prev) => prev.filter((tb) => tb.connId !== activeConnIdState));
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

      setTabs([...tabs, { ...newTab, connId: activeConnIdState }]);
      setActiveTabId(tabId);
      setQueryCount(queryCount + 1);
    }
  };

  const handleRunAiSql = (sql: string) => {
    handleInsertSql(sql);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('execute-active-query'));
    }, 150);
  };

  // Config for Terminal: if current connection dùng SSH -> kế thừa to open shell andO MÁY CHỦ/VM đó;
  // ngược lại open shell máy cục bộ.
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
      connId: activeConnIdState,
      type: 'terminal',
      name: 'Terminal',
      label: 'Terminal',
      config: terminalConfig(),
      floating: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  };

  const handleOpenRoutineTab = async (name: string, kind: 'procedure' | 'function') => {
    const tabId = `routine_${kind}_${name}`;
    // `visibleTabs`, not `tabs`: ids are unique per connection only, so a procedure of the same name
    // on another connection matched here and the function returned having done nothing but select an
    // id that this connection has no tab for — which renders as an empty pane, not as an error.
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const res = await dbHelper.getObjectDefinition(activeConnIdState, name, kind);
    const sql = res.success && res.sql ? res.sql : '';
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'routine',
      name: name,
      label: `${kind === 'procedure' ? 'Proc' : 'Func'}: ${name}`,
      routineInfo: { name, kind, sql },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  const handleOpenViewTab = async (name: string) => {
    const tabId = `view_${name}`;
    const existing = visibleTabs.find((tb) => tb.id === tabId);
    if (existing) {
      setActiveTabId(tabId);
      return;
    }
    const res = await dbHelper.getObjectDefinition(activeConnIdState, name, 'view');
    const sql = res.success && res.sql ? res.sql : '';
    const newTab: TabInfo = {
      id: tabId,
      connId: activeConnIdState,
      type: 'view',
      name: name,
      label: `View: ${name}`,
      viewInfo: { name, sql },
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
  };

  /**
   * The tab whose panel is on screen — looked up in `visibleTabs`, not `tabs`.
   *
   * Tab ids are only unique per connection (`query_1` exists on every one), so searching the whole
   * array could return a tab belonging to a connection that is not on screen. Narrowing first makes
   * that impossible rather than unlikely.
   */
  const getActiveTab = () => {
    return visibleTabs.find((tb) => tb.id === activeTabId) || null;
  };

  const activeTab = getActiveTab();

  /** Key of tab currently xem — sidebar tô sáng row tương ứng. */
  const activeRedisKey =
    activeTab?.type === 'redis-key' ? activeTab.redisKeyInfo?.keyName ?? null : null;
  const activeTable = activeTab?.type === 'table' ? activeTab.name : null;

  /** Cập nhật một tab. must ổn định: QueryTabPanel memo hoá theo props (xem đó). */
  const patchTab = React.useCallback((id: string, patch: Partial<TabInfo>) => {
    setTabs(prev => prev.map(tb => (tb.id === id ? { ...tb, ...patch } : tb)));
  }, []);

  // write receive tab query vừa is open, đồng thời bỏ những tab already close. run sau mỗi lần
  // `tabs` đổi (tức mỗi lần gõ phím already debounce) nhưng returns đúng Set cũ when not có gì
  // change, nên not kéo theo render thừa.
  React.useEffect(() => {
    queueMicrotask(() => {
      setMountedQueryTabs(prev => {
        const live = new Set(tabs.filter(tb => tb.type === 'query').map(tb => tb.id));
        const next = new Set<string>();
        for (const id of prev) if (live.has(id)) next.add(id);
        if (activeTabId && live.has(activeTabId)) next.add(activeTabId);
        if (next.size === prev.size && [...next].every(id => prev.has(id))) return prev;
        return next;
      });
    });
  }, [tabs, activeTabId]);

  // Scope of danh sách tab hiện tại, dùng ism tiền tố for key of QueryTabPanel.
  const tabScope = scopeKey(activeConnConfig, connection?.dbName, connection?.schema);

  // build sẵn thành biến vì title bar nằm at hai position khác nhau in cây:
  // at màn kết nối nó nằm *in* .cm-screen to cùng chịu lớp aurora of màn đó,
  // còn at workspace nó is con trực tiếp of #root như cũ.
  const titleBar = (
    <TitleBar
      // Safe Mode save theo server, and chỉ frontend có config to suy ra key đó (backend cố ý not
      // trả config về vì nó mang credential).
      connKey={connKey(activeConnConfig)}
      hasConnection={!!connection}
      connId={activeConnIdState}
      readOnly={readOnly}
      onToggleReadOnly={toggleReadOnly}
      // version/tls not còn at đây: TitleBar read số thật from get_connection_status,
      // các trường này chỉ is giá trị lùi for nhịp trước when lần ping đầu về.
      activeConnectionInfo={{
        host: activeConnConfig?.host || 'LOCAL',
        dbType: connection?.dbType?.toUpperCase() || 'MYSQL',
        dbName: connection?.dbName,
      }}
      activeProfileName={activeProfile.name}
      activeProfileColor={activeProfile.color}
      // Read straight from the open connection rather than mirroring into `activeProfile`: the rail,
      // the SQL editor's confirmation and the read-only default all read it from there, and a fourth
      // copy is a fourth thing that can disagree.
      activeProfileEnv={openConns.find((c) => c.connId === activeConnIdState)?.env ?? 'none'}
      // `db` not nằm in `openConns` (at đó database is một phần of `config`), nên suy ra at đây.
      // Kết nối currently xem ưu tiên `connection.dbName`: sau một `USE` in restore, backend is bên
      // biết database thật, còn `config` chỉ is thứ already dùng to open.
      openConns={openConns.map((c) => ({
        ...c,
        env: c.env ?? 'none',
        db:
          (c.connId === activeConnIdState ? connection?.dbName : undefined) ||
          c.config?.database ||
          c.config?.sqlitePath ||
          '',
      }))}
      onSelectConnection={selectConnection}
      onConnectSavedProfile={handleConnectSavedProfile}
      onProfileChange={handleProfileChange}
      theme={theme}
      onThemeChange={applyTheme}
      onReconnect={handleReconnect}
      activeTableName={activeTable}
      onNewConnection={handleNewConnection}
      onDisconnect={handleDisconnect}
      onNewQuery={handleNewQueryTab}
      onExportDatabase={() => setShowExportDbDialog(true)}
      onImportDatabase={() => setShowImportDbDialog(true)}
      onToggleSidebar={() => setShowSidebar(prev => !prev)}
      onToggleTheme={toggleTheme}
      onShowShortcuts={() => setShowShortcuts(true)}
      onShowAbout={() => setShowAbout(true)}
      onShowWhatsNew={() => setShowWhatsNew(true)}
      onOpenCompare={() => setShowDbCompare(true)}
      onToggleTerminal={handleOpenTerminal}
      aiOpen={showAi}
      onToggleAiAssistant={() => setShowAi(prev => !prev)}
      onDatabaseOpened={handleDatabaseOpened}
      onOpenAllDbStats={() => { setDbInfoTab('all'); setShowDbInfoModal(true); }}
      onOpenDocs={() => setShowDocModal(true)}
    />
  );

  return (
    <>
      {/* Safe Mode hỏi qua component này. Mount một lần at gốc: `utils/safeMode.ts` not có React
          nên nó giữ một confirmer is đăng ký, and dialog must sống ngoài mọi tab to câu hỏi vẫn
          hiện dù lệnh phát ra from đâu. */}
      <SafeModeGate />

      {/* add một kết nối nữa in when vẫn currently kết nối (nút `+` of rail). Dùng lại nguyên
          `ConnectionManager` chứ not viết màn hình thứ hai; `handleConnect` already ism đúng việc
          (đẩy ando `openConns` rồi chuyển workspace sang kết nối mới). */}
      {addingConn && connection && (
        <Modal
          title={t('titlebar.newConnection')}
          onClose={() => setAddingConn(false)}
          zIndex={10000}
          width="min(1100px, 94vw)"
        >
          {/* `ModalBody` default is padding 16 + gap 14 + tự cuộn: đúng for một form, sai for một
              màn hình hai panel. with default đó container cao theo nội dung, nên row nút
              save/check/Kết nối is đẩy xuống under đáy and must cuộn mới thấy, còn hai panel thì
              not cuộn riêng như at màn chính. writem height and giao việc cuộn lại for chúng.
              Dùng prop `style` chứ not class: đó is API of ModalBody and style inline of nó thắng
              mọi rule in CSS — xem hộp keyboard shortcut bên under, cùng cách. */}
          <ModalBody style={{ padding: 0, gap: 0, overflow: 'hidden', height: 'min(74vh, 660px)' }}>
            <ConnectionManager
              connId={activeConnIdState}
              embedded
              onConnect={(...args) => {
                setAddingConn(false);
                handleConnect(...args);
              }}
            />
          </ModalBody>
        </Modal>
      )}

      {!connection ? (
        // App title bar: database switcher, environment, safe mode, transaction control.
        // is ::before of shell nên chỉ phủ is những gì shell chứa. Đứng
        // ngoài thì mép under title bar luôn is một đường ranh màu.
        <div className="cm-screen">
          {titleBar}
          <ConnectionManager connId={activeConnIdState} onConnect={handleConnect} />
        </div>
      ) : (
        <>
          {titleBar}
          <div className="workspace-container">
            {/* Connection column left of the sidebar. Tied to the sidebar (Ctrl+P is about
                reclaiming space, hiding half of it makes no sense) and only shown from 2
                connections up — with one there is nothing to switch between and the title bar
                already carries its state. It lists what is OPEN, not every database on the
                server; see DbRail.tsx. */}
            {showSidebar && (
              <DbRail
                activeConnId={activeConnIdState}
                onSelect={(c) => selectConnection(c.connId)}
                onClose={closeConnection}
                onCloseOthers={closeOtherConnections}
                onToggleReadOnly={toggleConnectionReadOnly}
                envOf={(id) => openConns.find((c) => c.connId === id)?.env ?? 'none'}
                colorOf={(id) => openConns.find((c) => c.connId === id)?.color ?? ''}
                reloadKey={openConns.length + railReloadKey}
              />
            )}

            {/* Redis dùng chung khung sidebar nhưng thân khác hẳn: danh sách key thay for cây
                table/view/routine. is một component anh em chứ not must một mode bên in
                `Sidebar.tsx` — file đó already 2762 row and not có row nào nói về Redis
                (docs/redis-ui-unification-plan.md §3). */}
            {showSidebar && connection.dbType === 'redis' && (
              <RedisSidebarView
                connId={activeConnIdState}
                dbName={connection.dbName}
                dbIndex={redisDbIndex}
                storageScope={connKey(activeConnConfig) || 'redis'}
                readOnly={readOnly}
                activeKey={activeRedisKey}
                onOpenKey={handleOpenRedisKey}
                onOpenTool={handleOpenRedisTool}
                onSelectDb={(idx) => { void handleRedisSelectDb(idx); }}
              />
            )}

            {showSidebar && connection.dbType !== 'redis' && (
              <Sidebar
              connId={activeConnIdState}
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
                onTableRenamed={(oldName, newName) => handleTableRenamed(activeConnIdState, oldName, newName)}
                onTableDropped={handleTableDropped}
                onDatabaseOpened={handleDatabaseOpened}
                schema={connection.schema}
                onSchemaChanged={handleSchemaChanged}
                onOpenQueryWithSql={openQueryTabWithSql}
                onOpenRoutineTab={handleOpenRoutineTab}
                onOpenViewTab={handleOpenViewTab}
              />
            )}

            <div className="main-workspace-area">
              {/* Nút bật/tắt AI Copilot already chuyển lên title bar (TitleBar) —
                  tab bar giờ chỉ còn tab and cụm nút of chính nó. */}
              <div style={{ display: 'flex', alignItems: 'center', background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', position: 'relative', zIndex: 100 }}>
                <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <TabManager
                    tabs={visibleTabs}
                    activeTabId={activeTabId}
                    dirtyTabId={dirtyTabId}
                    onSelectTab={handleSelectTab}
                    onCloseTab={handleCloseTab}
                    onCloseOthers={handleCloseOthers}
                    onCloseTabsToRight={handleCloseTabsToRight}
                    onCloseAll={handleCloseAll}
                    onReorderTabs={handleReorderTabs}
                    onNewQueryTab={handleNewQueryTab}
                    groups={tabGroups}
                    onCreateGroup={handleCreateTabGroup}
                    onAssignGroup={handleAssignTabGroup}
                    onRemoveFromGroup={handleRemoveTabFromGroup}
                    onRenameGroup={handleRenameTabGroup}
                    onSetGroupColor={handleSetTabGroupColor}
                    onToggleGroup={handleToggleTabGroup}
                    onMoveGroup={handleMoveTabGroup}
                    onCloseGroup={handleCloseTabGroup}
                  />
                </div>
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
                ) : activeTab.type === 'query' || REDIS_TOOL_TAB_TYPES.has(activeTab.type) ? (
                  // Tab query and sáu tab công cụ Redis đều mount thường trực bên under (giống
                  // terminal) nên at đây not render gì — if render, tab will is build lại and mất kết
                  // quả mỗi lần chuyển.
                  //
                  // Thiếu vế Redis at đây is một hộp `flex: 1` RỖNG is build cạnh tab thật, and vì cả
                  // hai cùng `flex: 1` nên chúng chia đôi chiều ngang — nửa trái trắng trơn.
                  null
                ) : (
                  <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                    {/* `&& !== 'redis'`: một kết nối Redis not có tab `table` nào, and nói
                        điều đó ra at đây is cách to `dbType` thu hẹp về ba dialect SQL mà DataGrid
                        receive. Trước đây nhánh Redis return sớm nên kiểu tự hẹp. */}
                    {activeTab.type === 'table' && connection.dbType !== 'redis' ? (
                      <DataGrid
              connId={activeConnIdState}
                        key={activeTab.id + '_' + ((activeTab as any).initialViewMode || 'data') + '_' + ((activeTab as any).initialFilter ? JSON.stringify((activeTab as any).initialFilter) : '') + '_' + dbReloadKey}
                        tableName={activeTab.name}
                        dbType={connection.dbType}
                        initialViewMode={(activeTab as any).initialViewMode || 'data'}
                        initialFilter={(activeTab as any).initialFilter}
                        readOnly={readOnly}
                        // Chỉ gắn cờ for tab currently mount; hàm dọn dẹp of DataGrid
                        // luôn báo false nên delete cờ chứ not to lại dấu sai tab.
                        onDirtyChange={(dirty) => setDirtyTabId(dirty ? activeTab.id : null)}
                      />
                    ) : activeTab.type === 'routine' ? (
                      <RoutineEditorModal
              connId={activeConnIdState}
                        key={activeTab.id}
                        name={activeTab.routineInfo?.name || activeTab.name}
                        kind={activeTab.routineInfo?.kind || 'procedure'}
                        initialSql={activeTab.routineInfo?.sql || ''}
                        onClose={() => handleCloseTab(activeTab.id)}
                        embedded={true}
                      />
                    ) : activeTab.type === 'view' ? (
                      <ViewEditorModal
              connId={activeConnIdState}
                        key={activeTab.id}
                        name={activeTab.viewInfo?.name || activeTab.name}
                        initialSql={activeTab.viewInfo?.sql || ''}
                        onClose={() => handleCloseTab(activeTab.id)}
                        embedded={true}
                      />
                    ) : activeTab.type === 'redis-key' ? (
                      <RedisKeyTab
                        // Cả connId in key: cùng một tên key on db0 and db3 is hai key khác
                        // nhau, and React will dùng lại instance if key trùng.
                        key={activeConnIdState + '|' + activeTab.id}
                        connId={activeConnIdState}
                        keyName={activeTab.redisKeyInfo?.keyName || activeTab.name}
                        storageScope={connKey(activeConnConfig) || 'redis'}
                        readOnly={readOnly}
                        onRenamed={(next) => setTabs((prev) => prev.map((tb) => (
                          tb.id === activeTab.id
                            ? { ...tb, name: next, label: next, redisKeyInfo: { keyName: next } }
                            : tb
                        )))}
                        onClose={() => handleCloseTab(activeTab.id)}
                      />
                    ) : null}
                  </div>
                )}

                {/* Tab query: mount thường trực (hide/hiện bằng CSS) to kết quả sống when chuyển tab.
                    Chỉ mount tab already fromng is open — xem mountedQueryTabs. */}
                {visibleTabs.filter(qt => qt.type === 'query' && mountedQueryTabs.has(qt.id)).map(qt => (
                  <QueryTabPanel
                    // Gắn cả scope ando key: id tab is `query_<timestamp>` nên hai database khác
                    // nhau vẫn can trùng id, and when đó React will dùng lại instance cũ.
                    key={tabScope + '|' + qt.id}
                    tab={qt}
                    active={activeTabId === qt.id}
                    dbType={connection?.dbType}
                    connId={qt.connId || activeConnIdState}
          isProdConn={isProduction(openConns.find((c) => c.connId === (qt.connId || activeConnIdState))?.env)}
          connReadOnly={!!openConns.find((c) => c.connId === (qt.connId || activeConnIdState))?.readOnly}
          connKey={connKey(activeConnConfig)}
                    dbName={connection.dbName}
                    theme={theme}
                    readOnly={readOnly}
                    onPatch={patchTab}
                  />
                ))}

                {/* Tab công cụ Redis: mount thường trực, cùng lý do with tab query and terminal.
                    Console giữ log lệnh already run, Pub/Sub and Profiler currently giữ một socket riêng read
                    liên tục, Dashboard giữ string số liệu theo time — tháo ra when chuyển tab is
                    mất hết, and with Pub/Sub thì còn is bỏ lỡ message in lúc tab is hide.
                    hide bằng visibility như QueryTabPanel chứ not display:none, to lưới and biểu đồ
                    preserve position cuộn. */}
                {visibleTabs
                  .filter((tb) => tb.type.startsWith('redis-') && tb.type !== 'redis-key')
                  .map((tb) => (
                    <div
                      key={activeConnIdState + '|' + tb.id}
                      style={
                        activeTabId === tb.id
                          ? { flex: 1, display: 'flex', overflow: 'hidden' }
                          : {
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            overflow: 'hidden',
                            visibility: 'hidden',
                            pointerEvents: 'none',
                          }
                      }
                    >
                      <RedisToolTab
                        type={tb.type as Exclude<RedisTabType, 'redis-key'>}
                        storageScope={connKey(activeConnConfig) || 'redis'}
                        dbIndex={redisDbIndex}
                        readOnly={readOnly}
                        theme={theme}
                        onSwitchDb={(idx, cid) => { void handleRedisSelectDb(idx, cid); }}
                      />
                    </div>
                  ))}

                {/* Terminal: mount thường trực (hide/hiện bằng CSS) to phiên PTY sống when chuyển tab */}
                {visibleTabs.filter(tb => tb.type === 'terminal').map(tb => (
                  <TerminalPanel
                    connId={tb.connId || activeConnIdState}
                    key={tb.id}
                    config={((tb as any).config || { type: connection.dbType }) as DbConnectionConfig}
                    profileName={tb.label}
                    floating={!!(tb as any).floating}
                    active={activeTabId === tb.id}
                    onToggleFloat={() => setTabs(prev => prev.map(x => x.id === tb.id ? ({ ...x, floating: !(x as any).floating } as any) : x))}
                    onClose={() => handleCloseTab(tb.id)}
                    // Terminal at đây is một tab -> already có X on tab, bỏ nút X trùng at header
                    closable={false}
                  />
                ))}

                {showAi && (
                  <AiAssistant
                    onInsertSql={handleInsertSql}
                    onRunSql={handleRunAiSql}
                    tableNameContext={activeTable}
                    dbType={connection?.dbType}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Leaving a half-edited table tab — the pending action lives in discardPrompt. */}
      <ConfirmDialog
        open={!!discardPrompt}
        danger
        title={t('app.confirmDiscardGridTitle')}
        message={t('app.confirmDiscardGridChanges')}
        confirmLabel={t('app.confirmDiscardGridLabel')}
        onConfirm={() => {
          const action = discardPrompt;
          setDiscardPrompt(null);
          action?.();
        }}
        onCancel={() => setDiscardPrompt(null)}
      />

      {/* Popup select tệp: báo định dạng allows trước when open hộp thoại of hệ điều hành */}
      <ImportFilePicker
        open={showGlobalImportPicker}
        targetTable={globalImportTargetTable}
        onCancel={() => setShowGlobalImportPicker(false)}
        onConfirm={handleGlobalFileImport}
      />

      {/* Tiến độ nhập dữ liệu ando table (modal preview already close) */}
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
              connId={activeConnIdState}
        open={showExportDbDialog}
        onClose={() => setShowExportDbDialog(false)}
        onSubmit={handleExportDatabase}
        dbName={connection?.dbName || ''}
      />

      {/* Nhập cả database from tệp dump (Import Database) */}
      <ImportDatabaseDialog
        open={showImportDbDialog}
        onClose={() => setShowImportDbDialog(false)}
        currentDb={connection?.dbName}
        canManageDatabases={!!connection && connection.dbType !== 'sqlite'}
        dbType={connection?.dbType}
        onSubmit={handleImportDatabase}
      />

      {/* Xuất một table — open from menu right click / context menu at Sidebar, cùng popup with nút Export under grid */}
      {exportTableTarget && connection && (
        <ExportTableDialog
              connId={activeConnIdState}
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

            {/* Tab preview: cấu trúc (column + kiểu suy ra) | dữ liệu (10 row đầu) */}
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
              connId={activeConnIdState}
        isOpen={showDbInfoModal}
        onClose={() => setShowDbInfoModal(false)}
        onSelectTable={(tableName) => handleSelectTable(tableName)}
        initialTab={dbInfoTab}
        onDatabaseOpened={handleDatabaseOpened}
      />

      {/* Diff Schema & Migration Modal */}
      {showSchemaMigration && connection && (
        <SchemaMigration
          dbType={connection.dbType}
          database={connection.dbName}
          onClose={() => setShowSchemaMigration(false)}
        />
      )}

      {/* compare 2 database (cấu trúc + dữ liệu) */}
      {showDbCompare && connection && (
        <DbCompareDialog
          connId={activeConnIdState}
          dbType={connection.dbType}
          currentDb={connection.dbName}
          onClose={() => setShowDbCompare(false)}
          onOpenInSqlEditor={openQueryTabWithSql}
        />
      )}

      {/* generate data test row loạt */}
      {showDataGen && connection && (
        <DataGeneratorDialog
          connId={activeConnIdState}
          dbName={connection.dbName}
          initialTable={dataGenTable}
          onClose={() => {
            setShowDataGen(false);
            setDataGenTable(null);
            // Số row of các table already đổi -> Sidebar/DataGrid load lại. Dùng lại event sẵn có
            // thay vì add event mới (schema not đổi nên not cần invalidateCatalog).
            window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId: activeConnIdState } }));
          }}
        />
      )}

      {/* About Modal */}
      {showAbout && (
        /* Bấm ra ngoài to close — trước đây chỉ close is bằng nút. */
        <div className="cm-modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="about-close" onClick={() => setShowAbout(false)} title={t('common.close')} aria-label={t('common.close')}>
              <X size={15} />
            </button>

            <img className="about-logo" src={appIcon} alt="" />
            <div className="about-name">TableNova</div>
            <div className="about-version">
              {t('app.aboutVersion', { version: appVersion })} (Build 2608)
            </div>

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
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutQuickSwitcher')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Shift + P</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('app.shortcutSearchTables')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + K</kbd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                <span style={{ color: 'var(--win-text-primary)' }}>{t('titlebar.toggleSidebar')}</span>
                <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + B</kbd>
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

      <DocViewerModal
        isOpen={showDocModal}
        onClose={() => setShowDocModal(false)}
        initialQuery={docQuery}
        initialEngine={connection?.dbType as any}
      />

      <WhatsNewModal
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />
    </>
  );
};

export default App;
