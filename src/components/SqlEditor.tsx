import React, { useState, useRef, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import * as monaco from 'monaco-editor';
import Editor, { loader } from '@monaco-editor/react';

// Import workers directly using Vite's ?worker loader query
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// Worker cho monaco-sql-languages (parser + ngữ cảnh caret) theo dialect
import MySQLWorker from 'monaco-sql-languages/esm/languages/mysql/mysql.worker?worker';
import PgSQLWorker from 'monaco-sql-languages/esm/languages/pgsql/pgsql.worker?worker';
import GenericSQLWorker from 'monaco-sql-languages/esm/languages/generic/generic.worker?worker';
import { setupSqlCompletion, langIdForDbType, LANG_IDS } from '../sql/sqlLanguage';
import { setupSqlHover, findTable, openTableTab } from '../sql/intellisense';
import { defineSqlThemes, sqlThemeName } from '../sql/theme';
import { SQL_EDITOR_OPTIONS } from '../sql/editorOptions';
import { formatSql, minifySql } from '../sql/format';
import {
  statementAt, analyzeStatements, splitStatements, isSchemaChangingSql,
  findUnsafeStatements, type UnsafeStatement, type UnsafeStatementKind,
} from '../sql/statements';
import * as catalog from '../sql/catalog';

// Configure Monaco Environment for Vite native web workers
(window as any).MonacoEnvironment = {
  getWorker(_: any, label: string) {
    if (label === 'json') {
      return new jsonWorker();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new cssWorker();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new htmlWorker();
    }
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }
    if (label === 'mysql') {
      return new MySQLWorker();
    }
    if (label === 'pgsql') {
      return new PgSQLWorker();
    }
    if (label === 'genericsql') {
      return new GenericSQLWorker();
    }
    return new editorWorker();
  }
};

// Đăng ký smart completion + hover + theme (dùng chung, chỉ chạy 1 lần)
setupSqlCompletion();
setupSqlHover();
defineSqlThemes();

// Monaco đo bề rộng ký tự lúc khởi tạo. Nếu JetBrains Mono nạp xong SAU đó thì con trỏ
// sẽ lệch khỏi chữ -> đo lại khi mọi font đã sẵn sàng.
if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
  (document as any).fonts.ready.then(() => monaco.editor.remeasureFonts()).catch(() => { /* bỏ qua */ });
}

// Pack monaco directly into the loader config
loader.config({ monaco });
import { dbHelper } from '../utils/dbHelper';

const LoadingSpinner: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 16, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="loading-spinner"
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="var(--win-border-strong, #383b44)"
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      stroke="var(--win-accent)"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

// Đăng ký format provider (Shift+Alt+F / Format Document) cho ĐỦ 3 dialect,
// kể cả 'genericsql' mà SQLite đang dùng.
// dbType hiện hành: provider đăng ký 1 lần nhưng phải format theo DB đang kết nối,
// kể cả khi người dùng đổi sang kết nối loại khác mà không tải lại app.
let formatterDbType = 'sqlite';
function registerSqlFormatter(dbType: string) {
  formatterDbType = dbType;
  const w = window as any;
  // Cờ/disposable phải nằm trên window: HMR nạp lại module sẽ reset biến module và
  // đăng ký provider lần 2 -> Monaco có 2 formatter cho cùng language.
  if (Array.isArray(w.__sqlFormatDisposables)) {
    for (const d of w.__sqlFormatDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
    }
  }
  const formatProvider = {
    provideDocumentFormattingEdits(model: any) {
      const formatted = formatSql(model.getValue(), formatterDbType);
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  };
  w.__sqlFormatDisposables = ['sql', ...LANG_IDS].map((lang) =>
    monaco.languages.registerDocumentFormattingEditProvider(lang, formatProvider)
  );
}
import { Play, Clipboard, Trash2, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, Copy, AlignLeft, ChevronsLeft, ChevronsRight, History, X, Bookmark, ChevronDown, MoreHorizontal, Star, Columns, Rows, Settings, Network, Zap, FileText, Square } from 'lucide-react';
import { getQueryParamsConfig, saveQueryParamsConfig, extractQueryParams, buildParameterizedSql, type QueryParamsConfig } from '../utils/queryParamHelper';
import { buildExplainQuery, explainJsonLabel, parseExplainOutput, supportsJsonExplain, type ExplainResult } from '../utils/explainHelper';
import {
  HISTORY_CHANGED_EVENT,
  addHistoryEntry,
  addSavedQuery,
  clearHistory,
  deleteHistoryEntry,
  deleteSavedQuery,
  loadHistory,
  loadSavedQueries,
  matchesScope,
  parseHistoryScope,
  recordHistoryResult,
  type HistoryEntry,
  type HistoryScope,
  type SavedQueryEntry,
} from '../utils/queryHistory';
import { QueryParamsConfigModal } from './QueryParamsConfigModal';
import { QueryParamsModal } from './QueryParamsModal';
import { ConfirmDialog } from './ConfirmDialog';
import { ExplainViewer } from './ExplainViewer';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface SqlEditorProps {
  dbType?: string;
  /** Định danh máy chủ đang kết nối (utils/connKey) — dùng để gắn nhãn & lọc lịch sử. */
  connKey?: string;
  /** Tên database đang dùng, hiện trên từng dòng lịch sử khi xem "tất cả kết nối". */
  dbName?: string;
  initialSql?: string;
  initialSql2?: string;
  initialSplitMode?: 'none' | 'vertical' | 'horizontal';
  onRunSuccess?: () => void;
  theme?: 'dark' | 'light';
  readOnly?: boolean;
  onSqlChange?: (sql: string) => void;
  onSql2Change?: (sql2: string) => void;
  onSplitModeChange?: (mode: 'none' | 'vertical' | 'horizontal') => void;
}

// Bộ lọc phạm vi của ngăn lịch sử. Bảng hằng ở mức module nên giữ KEY dịch,
// hàm t() gọi trong component (i18next phải kiểm được từng key).
const SCOPE_OPTIONS = [
  { scope: 'db', labelKey: 'sqlEditor.scopeDb', titleKey: 'sqlEditor.scopeDbTitle' },
  { scope: 'conn', labelKey: 'sqlEditor.scopeConn', titleKey: 'sqlEditor.scopeConnTitle' },
  { scope: 'all', labelKey: 'sqlEditor.scopeAll', titleKey: 'sqlEditor.scopeAllTitle' },
] as const;

// Câu lệnh chỉ đọc được phép chạy trong chế độ Chỉ đọc
const READ_ONLY_PREFIXES = ['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'PRAGMA', 'WITH'];
function isReadOnlySql(text: string): boolean {
  // Dùng chung splitter với editor: dấu ';' trong chuỗi/comment/khối $$ và dấu kết thúc câu
  // do DELIMITER đổi đều được xử lý đúng (tự split(';') sẽ đánh giá sai các script đó).
  return splitStatements(text).every(stmt => {
    const first = stmt.text.split(/\s+/)[0].toUpperCase();
    return READ_ONLY_PREFIXES.includes(first);
  });
}

export const SqlEditor: React.FC<SqlEditorProps> = ({
  dbType = 'sqlite',
  connKey = '',
  dbName = '',
  initialSql = '',
  initialSql2 = '',
  initialSplitMode = 'none',
  onRunSuccess,
  theme = 'dark',
  readOnly = false,
  onSqlChange,
  onSql2Change,
  onSplitModeChange,
}) => {
  const { t, i18n } = useTranslation();
  // Dates and thousands separators follow the active UI language.
  const locale = i18n.language;
  // Monaco actions and the run-glyph are registered once per editor mount, so
  // their labels are read through a ref that always holds the latest `t`.
  const tRef = useRef(t);
  tRef.current = t;

  const langId = langIdForDbType(dbType); // 'mysql' | 'pgsql' cho smart completion
  const [sql, setSql] = useState(initialSql);
  const [sql2, setSql2] = useState(initialSql2);
  const [splitMode, setSplitMode] = useState<'none' | 'vertical' | 'horizontal'>(initialSplitMode);
  const [splitRatio, setSplitRatio] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [focusedEditor, setFocusedEditor] = useState<1 | 2>(1);
  const editorRef2 = useRef<any>(null);

  const [results, setResults] = useState<any[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [allResults, setAllResults] = useState<any[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [pageInput, setPageInput] = useState('1');
  const [showCopyDropdown, setShowCopyDropdown] = useState(false);
  const [runningQueryId, setRunningQueryId] = useState<string | null>(null);

  // Pane 2 execution results state
  const [results2, setResults2] = useState<any[]>([]);
  const [columns2, setColumns2] = useState<string[]>([]);
  const [allResults2, setAllResults2] = useState<any[]>([]);
  const [activeTabIndex2, setActiveTabIndex2] = useState(0);
  const [loading2, setLoading2] = useState(false);
  const [hasRun2, setHasRun2] = useState(false);
  const [errorMsg2, setErrorMsg2] = useState<string | null>(null);
  const [statusMsg2, setStatusMsg2] = useState<string | null>(null);
  const [page2, setPage2] = useState(1);
  const [pageSize2, setPageSize2] = useState(50);
  const [pageInput2, setPageInput2] = useState('1');
  const [showCopyDropdown2, setShowCopyDropdown2] = useState(false);
  const [runningQueryId2, setRunningQueryId2] = useState<string | null>(null);

  const [paneEditorHeight, setPaneEditorHeight] = useState<number>(220);
  const [isDraggingResizer, setIsDraggingResizer] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');

  const [savedQueries, setSavedQueries] = useState<SavedQueryEntry[]>([]);
  const [historyTab, setHistoryTab] = useState<'history' | 'saved'>('history');
  // Xem lịch sử của database đang dùng, của cả máy chủ, hay của mọi kết nối. Nhớ
  // lựa chọn qua các lần mở app (quy ước tf_*): đây là thói quen làm việc, không
  // phải trạng thái tạm.
  const [historyScope, setHistoryScope] = useState<HistoryScope>(
    () => parseHistoryScope(localStorage.getItem('tf_history_scope'))
  );

  const changeHistoryScope = (scope: HistoryScope) => {
    setHistoryScope(scope);
    localStorage.setItem('tf_history_scope', scope);
  };

  /** Không biết đang ở kết nối nào (chạy vite-dev thuần) thì không lọc được gì. */
  const effectiveScope: HistoryScope = connKey ? historyScope : 'all';
  const inScope = (entry: HistoryEntry) => matchesScope(entry, connKey, dbName, effectiveScope);

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [newQueryName, setNewQueryName] = useState('');

  // Dropdown của nút Chạy (split button), menu "thêm thao tác", và menu "chia khung" theo Pane (1 | 2)
  const [runMenuPane, setRunMenuPane] = useState<1 | 2 | null>(null);
  const [moreMenuPane, setMoreMenuPane] = useState<1 | 2 | null>(null);
  const [splitMenuPane, setSplitMenuPane] = useState<1 | 2 | null>(null);
  const [formatMenuPane, setFormatMenuPane] = useState<1 | 2 | null>(null);
  const [dropdownPlacement, setDropdownPlacement] = useState<Record<string, 'up' | 'down'>>({});

  const toggleDropdown = (menuKey: string, paneId: 1 | 2, e: React.MouseEvent<HTMLElement>, setMenuPane: React.Dispatch<React.SetStateAction<1 | 2 | null>>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceBelow < 280 && rect.top > spaceBelow ? 'up' : 'down';
    setDropdownPlacement(prev => ({ ...prev, [`${menuKey}_${paneId}`]: placement }));
    setMenuPane(prev => prev === paneId ? null : paneId);
  };

  // Query Parameters State
  const [queryParamsConfig, setQueryParamsConfig] = useState<QueryParamsConfig>(getQueryParamsConfig());
  const [showQueryParamsConfigModal, setShowQueryParamsConfigModal] = useState(false);
  const [paramPromptData, setParamPromptData] = useState<{ pane: 1 | 2; originalSql: string; params: string[]; action: 'run' | 'explain'; variant?: 'explain' | 'analyze' | 'json' } | null>(null);

  // Hỏi lại trước khi chạy câu lệnh xoá sạch dữ liệu (DELETE thiếu WHERE / DROP TABLE).
  // Chỉ là cảnh báo — muốn chặn hẳn thì bật chế độ Chỉ đọc.
  const [unsafePrompt, setUnsafePrompt] = useState<{
    pane: 1 | 2;
    sql: string;
    items: UnsafeStatement[];
    /** Bấm "Vẫn chạy" thì chạy tiếp bằng đường nào (nút Run hay EXPLAIN ANALYZE). */
    resume: 'run' | 'analyze';
  } | null>(null);

  // switch trả về key literal, KHÔNG nội suy key động (i18next phải kiểm được từng key).
  const unsafeKindLabel = (kind: UnsafeStatementKind): string => {
    switch (kind) {
      case 'deleteNoWhere': return t('sqlEditor.unsafeKindDeleteNoWhere');
      case 'dropTable': return t('sqlEditor.unsafeKindDropTable');
    }
  };

  // EXPLAIN State
  const [explainResult1, setExplainResult1] = useState<ExplainResult | null>(null);
  const [explainResult2, setExplainResult2] = useState<ExplainResult | null>(null);
  const [activeTabType1, setActiveTabType1] = useState<'data' | 'explain'>('data');
  const [activeTabType2, setActiveTabType2] = useState<'data' | 'explain'>('data');

  // Load history & saved queries on mount, then follow the shared store: mỗi tab
  // truy vấn là một SqlEditor riêng với bản copy riêng, nên phải nạp lại khi tab
  // khác thêm/xoá (utils/queryHistory phát HISTORY_CHANGED_EVENT sau mỗi lần ghi).
  useEffect(() => {
    const reload = () => {
      setHistoryList(loadHistory());
      setSavedQueries(loadSavedQueries());
    };
    reload();
    window.addEventListener(HISTORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, reload);
  }, []);

  // Recalculate Monaco editor layout when history drawer, split mode, or height changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    }, 50);
    return () => clearTimeout(timer);
  }, [showHistory, splitMode, paneEditorHeight]);

  /** Trả về id dòng lịch sử để `runRawSql` ghi kết quả lên đó khi chạy xong. */
  const addToHistory = (queryText: string): string => {
    const { list, id } = addHistoryEntry(queryText, connKey, dbName, Date.now().toString());
    setHistoryList(list);
    return id;
  };

  // Xoá đúng phạm vi đang xem, không nhiều hơn.
  // switch trả về key literal, KHÔNG nội suy key động (i18next phải kiểm được từng key).
  const clearHistoryLabel = (): string => {
    switch (effectiveScope) {
      case 'db': return t('sqlEditor.clearDbHistory');
      case 'conn': return t('sqlEditor.clearConnHistory');
      case 'all': return t('sqlEditor.clearAllHistory');
    }
  };

  const handleClearHistory = () => {
    const message = effectiveScope === 'db'
      ? t('sqlEditor.confirmClearDbHistory')
      : effectiveScope === 'conn'
        ? t('sqlEditor.confirmClearConnHistory')
        : t('sqlEditor.confirmClearHistory');
    if (confirm(message)) {
      setHistoryList(clearHistory(effectiveScope, connKey, dbName));
    }
  };

  const handleSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      if (!val.trim()) {
        setStatusMsg(t('sqlEditor.errNoSqlToSave'));
        setTimeout(() => setStatusMsg(null), 3000);
        return;
      }
      setNewQueryName(t('sqlEditor.defaultQueryName', { date: new Date().toLocaleDateString(locale) }));
      setShowSaveModal(true);
    }
  };

  const handleConfirmSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      const name = newQueryName.trim() || t('sqlEditor.defaultQueryName', { date: new Date().toLocaleDateString(locale) });

      setSavedQueries(addSavedQuery(name, val, connKey, dbName, Date.now().toString()));
      setShowSaveModal(false);
      setNewQueryName('');
      setStatusMsg(t('sqlEditor.savedQuery', { name }));
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleDeleteSaved = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(t('sqlEditor.confirmDeleteSaved'))) {
      setSavedQueries(deleteSavedQuery(id));
    }
  };

  const handleSelectHistoryItem = (sqlText: string) => {
    if (editorRef.current) {
      editorRef.current.setValue(sqlText);
      setSql(sqlText);
      setStatusMsg(t('sqlEditor.loadedQuery'));
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const getGroupTitle = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
      return t('sqlEditor.today');
    } else if (date.toDateString() === yesterday.toDateString()) {
      return t('sqlEditor.yesterday');
    } else {
      return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  };

  /** "37 ms · 200 dòng" — bỏ qua phần không có (dòng cũ chưa ghi kết quả, câu DDL không trả dòng). */
  const historyMetrics = (item: HistoryEntry): string => {
    const parts: string[] = [];
    if (item.ms !== undefined) parts.push(t('sqlEditor.historyMs', { n: item.ms.toLocaleString(locale) }));
    if (item.rows) parts.push(t('sqlEditor.historyRows', { n: item.rows.toLocaleString(locale) }));
    if (item.affected) parts.push(t('sqlEditor.historyAffected', { n: item.affected.toLocaleString(locale) }));
    return parts.join(' · ');
  };

  const getFilteredHistory = () => {
    const filtered = historyList.filter(item =>
      inScope(item) && item.sql.toLowerCase().includes(historySearch.toLowerCase())
    );

    const groups: { [key: string]: HistoryEntry[] } = {};
    filtered.forEach(item => {
      const dateKey = new Date(item.timestamp).toDateString();
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(item);
    });
    
    return groups;
  };

  const getFilteredSaved = () => {
    return savedQueries.filter(item =>
      inScope(item) && (
        item.name.toLowerCase().includes(historySearch.toLowerCase()) ||
        item.sql.toLowerCase().includes(historySearch.toLowerCase())
      )
    );
  };

  // Số dòng hiện trên tiêu đề tab phải khớp danh sách đang hiện (đã lọc theo kết nối).
  const historyCount = historyList.filter(inScope).length;
  const savedCount = savedQueries.filter(inScope).length;

  const editorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Đồng bộ nội dung ra React state + component cha theo NHỊP (trailing debounce).
  // Trước đây mỗi ký tự gõ/xoá gọi onSqlChange -> App.setTabs -> re-render CẢ app (mọi tab,
  // kể cả DataGrid) nên giữ Backspace là thấy giật. Nội dung "thật" luôn đọc từ editor
  // (getPaneSql/getCurrentStatement) nên trễ 150ms ở state không ảnh hưởng hành vi.
  const SQL_SYNC_DELAY = 150;
  const sqlSyncRef = useRef<{ timer: any; value: string | null }[]>([
    { timer: null, value: null },
    { timer: null, value: null },
  ]);

  const flushSqlSync = (paneId: 1 | 2) => {
    const slot = sqlSyncRef.current[paneId - 1];
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.value === null) return;
    const val = slot.value;
    slot.value = null;
    if (paneId === 1) { setSql(val); onSqlChange?.(val); }
    else { setSql2(val); onSql2Change?.(val); }
  };

  const queueSqlSync = (paneId: 1 | 2, val: string) => {
    const slot = sqlSyncRef.current[paneId - 1];
    slot.value = val;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => flushSqlSync(paneId), SQL_SYNC_DELAY);
  };

  // Giữ callback của cha trong ref: cleanup lúc unmount phải gọi bản MỚI NHẤT, mà effect
  // thì chỉ được chạy 1 lần (deps rỗng) nên không thể đọc trực tiếp từ closure.
  const changeCallbacksRef = useRef({ onSqlChange, onSql2Change });
  changeCallbacksRef.current = { onSqlChange, onSql2Change };

  // Rời khỏi component: đẩy nốt nội dung còn treo (khỏi mất chữ vừa gõ khi đóng/đổi tab)
  useEffect(() => () => {
    [1, 2].forEach((p) => {
      const slot = sqlSyncRef.current[p - 1];
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.value === null) return;
      const cb = changeCallbacksRef.current;
      if (p === 1) cb.onSqlChange?.(slot.value);
      else cb.onSql2Change?.(slot.value);
    });
  }, []);

  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSplit(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const initialRatio = splitRatio;

    const wrapper = containerRef.current?.querySelector('.sql-editor-split-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (splitMode === 'vertical') {
        const deltaX = moveEvent.clientX - startX;
        const newRatio = Math.max(15, Math.min(85, initialRatio + (deltaX / rect.width) * 100));
        setSplitRatio(newRatio);
      } else if (splitMode === 'horizontal') {
        const deltaY = moveEvent.clientY - startY;
        const newRatio = Math.max(15, Math.min(85, initialRatio + (deltaY / rect.height) * 100));
        setSplitRatio(newRatio);
      }
    };

    const handleMouseUp = () => {
      setIsDraggingSplit(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    if (editorRef.current) {
      setTimeout(() => editorRef.current?.layout(), 50);
    }
    if (editorRef2.current) {
      setTimeout(() => editorRef2.current?.layout(), 50);
    }
  }, [splitMode, splitRatio, paneEditorHeight]);

  const handleEditorDidMount = (editor: any, editorId: 1 | 2) => {
    if (editorId === 1) {
      editorRef.current = editor;
    } else {
      editorRef2.current = editor;
    }

    editor.onDidFocusEditorText(() => {
      setFocusedEditor(editorId);
    });

    // Rời khung -> đẩy ngay nội dung còn treo trong debounce ra state/cha
    editor.onDidBlurEditorText(() => {
      flushSqlSync(editorId);
    });

    // Format / Beautify / Minify actions cho Monaco context menu
    editor.addAction({
      id: 'format-beautify-sql',
      label: tRef.current('sqlEditor.actionBeautify'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.1,
      run: () => {
        handleBeautify(editorId);
      }
    });

    editor.addAction({
      id: 'format-minify-sql',
      label: tRef.current('sqlEditor.actionMinify'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.2,
      run: () => {
        handleMinify(editorId);
      }
    });

    // Shortcuts cho Beautify (Ctrl+Shift+F) & Minify (Ctrl+Shift+M)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
      handleBeautify(editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM, () => {
      handleMinify(editorId);
    });

    // Monaco context menu actions cho Split Panes
    editor.addAction({
      id: 'split-pane-vertical',
      label: tRef.current('sqlEditor.actionSplitVertical'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.5,
      run: () => {
        setSplitMode('vertical');
        onSplitModeChange?.('vertical');
      }
    });

    editor.addAction({
      id: 'split-pane-horizontal',
      label: 'Chia khung ngang (Top / Bottom)',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.6,
      run: () => {
        setSplitMode('horizontal');
        onSplitModeChange?.('horizontal');
      }
    });

    editor.addAction({
      id: 'close-split-pane',
      label: tRef.current('sqlEditor.actionSinglePane'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.7,
      run: () => {
        setSplitMode('none');
        onSplitModeChange?.('none');
      }
    });

    editor.addAction({
      id: 'explain-query-plan',
      label: tRef.current('sqlEditor.actionExplain'),
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.8,
      run: () => {
        handleExplain(editorId, 'explain');
      }
    });

    // Phím tắt Explain (Ctrl+Alt+E / Cmd+Option+E)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyE, () => {
      handleExplain(editorId, 'explain');
    });

    // Phím tắt chia khung (Ctrl+Shift+D / Cmd+Shift+D)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD, () => {
      setSplitMode(prev => {
        const next = prev === 'vertical' ? 'horizontal' : prev === 'horizontal' ? 'none' : 'vertical';
        onSplitModeChange?.(next);
        return next;
      });
    });

    // Phím tắt (đọc trực tiếp từ editor nên không lo stale state)
    // getTextToRun, not getCurrentStatement: the Run button and the menu item labelled
    // "Ctrl+Enter" both honour the selection, so the key itself must too — otherwise the
    // same advertised shortcut runs something different from the button next to it.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      executeSql(getTextToRun(editorId), editorId);
    });
    
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      executeSql(editor.getValue(), editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      handleSaveQuery();
    });

    // F12 / context menu: mở bảng đang ở dưới con trỏ trong tab mới
    editor.addAction({
      id: 'open-table-under-cursor',
      label: tRef.current('sqlEditor.actionOpenTable'),
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.1,
      // Ctrl+B là phím "go to declaration" quen thuộc của JetBrains/DataGrip; F12 để dự phòng.
      keybindings: [monaco.KeyCode.F12, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
      run: () => {
        const pos = editor.getPosition();
        const word = pos ? editor.getModel()?.getWordAtPosition(pos) : null;
        if (word) void openTableIfExists(word.word, editorId);
      }
    });

    // Ctrl/Cmd + Click lên tên bảng -> mở tab bảng (giống go-to-definition)
    editor.onMouseDown((e: any) => {
      if (!(e.event?.ctrlKey || e.event?.metaKey)) return;
      if (e.target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) return;
      const word = editor.getModel()?.getWordAtPosition(e.target.position);
      if (word) void openTableIfExists(word.word, editorId, false);
    });

    // Click mũi tên ở lề trái -> chạy câu lệnh bắt đầu tại dòng đó
    editor.onMouseDown((e: any) => {
      if (e.target?.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      editor.setPosition(e.target.position);
      const stmt = getCurrentStatement(editor);
      if (stmt) executeSql(stmt, editorId);
    });

    // Tô sáng câu lệnh dưới con trỏ — câu mà Ctrl+Enter sẽ chạy KHI KHÔNG bôi đen.
    // Có vùng bôi thì vùng đó thắng (xem getTextToRun) và chính Monaco đã tự tô nó.
    const decorations = editor.createDecorationsCollection([]);
    let highlightTimer: any = null;
    const refreshStatementHighlight = () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;
      const text = model.getValue();
      // Script rất lớn: bỏ qua để không tốn CPU mỗi lần gõ
      if (text.length > 200000) { decorations.set([]); return; }
      // Lấy cả danh sách câu lệnh lẫn câu dưới con trỏ trong 1 lần mask văn bản
      const { statements: stmts, current: stmt } = analyzeStatements(text, model.getOffsetAt(pos));
      if (!stmt) { decorations.set([]); return; }

      const from = model.getPositionAt(stmt.start);
      const to = model.getPositionAt(stmt.end);
      const items: any[] = [{
        // Mũi tên "chạy câu này" ở lề trái, đặt tại dòng đầu của câu lệnh
        range: new monaco.Range(from.lineNumber, 1, from.lineNumber, 1),
        options: {
          glyphMarginClassName: 'sql-run-glyph',
          glyphMarginHoverMessage: { value: tRef.current('sqlEditor.runThisStatement') },
        },
      }];
      // Chỉ tô nền/vạch khi có nhiều câu lệnh — 1 câu duy nhất thì tô cả trang là vô nghĩa
      if (stmts.length > 1) {
        items.push({
          range: new monaco.Range(from.lineNumber, 1, to.lineNumber, model.getLineMaxColumn(to.lineNumber)),
          options: {
            isWholeLine: true,
            className: 'sql-current-stmt',
            linesDecorationsClassName: 'sql-current-stmt-strip',
            overviewRuler: { color: 'rgba(96, 165, 250, 0.45)', position: monaco.editor.OverviewRulerLane.Left },
          },
        });
      }
      decorations.set(items);
    };
    const scheduleHighlight = () => {
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(refreshStatementHighlight, 80);
    };
    editor.onDidChangeCursorPosition(scheduleHighlight);
    editor.onDidChangeModelContent(scheduleHighlight);
    editor.onDidDispose(() => { if (highlightTimer) clearTimeout(highlightTimer); });
    refreshStatementHighlight();

    registerSqlFormatter(dbType);
    void catalog.getTables(); // nạp nền catalog cho autocomplete/hover

    setTimeout(() => {
      editor.layout();
    }, 100);
  };

  // Mở tab bảng nếu `name` đúng là một bảng/view trong DB hiện tại.
  // `notify` = false cho Ctrl+Click (click nhầm vào từ khoá thì im lặng), = true cho F12.
  const openTableIfExists = async (name: string, paneId: 1 | 2, notify = true) => {
    const found = await findTable(name);
    if (!found) {
      if (!notify) return;
      const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
      setMsg(t('sqlEditor.errTableNotFound', { name }));
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    openTableTab(found.name);
  };

  const executeSql = async (queryText?: string, targetPane?: 1 | 2, skipUnsafeCheck = false) => {
    const pane = targetPane || focusedEditor;
    const textToRun = queryText || (pane === 2 ? sql2 : sql);
    if (!textToRun.trim()) return;

    // Chế độ Chỉ đọc: chỉ cho phép câu lệnh đọc (SELECT/SHOW/...)
    if (readOnly && !isReadOnlySql(textToRun)) {
      const msg = t('sqlEditor.errReadOnlyRun');
      if (pane === 1) setErrorMsg(msg);
      else setErrorMsg2(msg);
      return;
    }

    // Cảnh báo trước khi xoá sạch dữ liệu. Không cần kiểm tra `readOnly` ở đây: khi bật Chỉ đọc,
    // mọi DELETE/DROP đã bị chặn ở nhánh trên nên đoạn này chỉ chạy khi đang cho phép ghi.
    // Đặt TRƯỚC bước hỏi tham số truy vấn để cả đường đi qua QueryParamsModal cũng được hỏi.
    if (!skipUnsafeCheck) {
      const items = findUnsafeStatements(textToRun);
      if (items.length > 0) {
        setUnsafePrompt({ pane, sql: textToRun, items, resume: 'run' });
        return;
      }
    }

    // Process Query Parameters if enabled
    if (queryParamsConfig.enabled) {
      const detectedParams = extractQueryParams(textToRun, queryParamsConfig.patternIndex);
      if (detectedParams.length > 0) {
        setParamPromptData({
          pane,
          originalSql: textToRun,
          params: detectedParams,
          action: 'run'
        });
        return;
      }
    }

    await runRawSql(textToRun, pane);
  };

  const runRawSql = async (textToRun: string, pane: 1 | 2, params?: any[]) => {
    const historyId = addToHistory(textToRun); // Log query history immediately

    const isPane1 = pane === 1;
    const queryId = `q_${crypto.randomUUID()}`;

    if (isPane1) {
      setLoading(true);
      setHasRun(true);
      setErrorMsg(null);
      setStatusMsg(null);
      setPage(1);
      setActiveTabIndex(0);
      setRunningQueryId(queryId);
      setAllResults([]);
      setResults([]);
      setColumns([]);
    } else {
      setLoading2(true);
      setHasRun2(true);
      setErrorMsg2(null);
      setStatusMsg2(null);
      setPage2(1);
      setActiveTabIndex2(0);
      setRunningQueryId2(queryId);
      setAllResults2([]);
      setResults2([]);
      setColumns2([]);
    }

    // Gom kết quả stream vào acc rồi phản chiếu ra state. Trong lúc stream chỉ hiển thị live
    // câu lệnh đầu tiên (tab 0); các câu lệnh sau vẫn được tích lũy và xem được khi bấm sang tab.
    const acc: { query: string; columns: string[]; data: any[]; affected?: number }[] = [];
    let errText: string | null = null;
    let cancelled = false;
    const t0 = performance.now();
    let tFirst = 0; // thời điểm nhận batch dữ liệu đầu tiên (~ thực thi xong, bắt đầu tải)

    const flush = () => {
      const snapshot = acc.map(r => ({ query: r.query, columns: r.columns, data: r.data, affected: r.affected }));
      if (isPane1) {
        setAllResults(snapshot);
        const first = snapshot[0];
        if (first) { setColumns(first.columns); setResults(first.data.slice()); }
      } else {
        setAllResults2(snapshot);
        const first = snapshot[0];
        if (first) { setColumns2(first.columns); setResults2(first.data.slice()); }
      }
    };

    try {
      await dbHelper.executeQueryStream(textToRun, queryId, (msg) => {
        if (msg.type === 'columns') {
          const i = msg.stmtIndex ?? 0;
          acc[i] = { query: msg.query || '', columns: msg.columns || [], data: [] };
          flush();
        } else if (msg.type === 'rows') {
          if (tFirst === 0) tFirst = performance.now();
          const i = msg.stmtIndex ?? 0;
          if (!acc[i]) acc[i] = { query: '', columns: [], data: [] };
          acc[i].data.push(...(msg.rows || []));
          flush();
        } else if (msg.type === 'affected') {
          // Câu lệnh ghi (INSERT/UPDATE/DELETE/DDL): không có cột/dòng, chỉ có số dòng ảnh hưởng.
          if (tFirst === 0) tFirst = performance.now();
          const i = msg.stmtIndex ?? 0;
          acc[i] = { query: msg.query || '', columns: [], data: [], affected: msg.affected ?? 0 };
          flush();
        } else if (msg.type === 'error') {
          errText = msg.message || t('sqlEditor.errUnknownExec');
        } else if (msg.type === 'done') {
          cancelled = !!msg.cancelled;
        }
      }, params);
    } catch (e: any) {
      errText = t('sqlEditor.errQuery', { message: String(e) });
    }

    flush(); // phản chiếu lần cuối (đảm bảo batch cuối cùng đã vào state)

    const totalRows = acc.reduce((s, r) => s + r.data.length, 0);
    const affectedTotal = acc.reduce((s, r) => s + (r.affected || 0), 0);
    const elapsed = performance.now() - t0;
    const execMs = tFirst > 0 ? tFirst - t0 : elapsed;
    const timeInfo = t('sqlEditor.timeInfo', { exec: execMs.toFixed(0), load: elapsed.toFixed(0) });
    const n = acc.length;

    const setLoad = isPane1 ? setLoading : setLoading2;
    const setErr = isPane1 ? setErrorMsg : setErrorMsg2;
    const setStat = isPane1 ? setStatusMsg : setStatusMsg2;
    const setRunId = isPane1 ? setRunningQueryId : setRunningQueryId2;

    setLoad(false);
    setRunId(null);

    // Kết quả lần chạy về đúng dòng lịch sử đã tạo lúc bắt đầu: chấm trạng thái,
    // thời gian và số dòng hiện ngay trong ngăn lịch sử.
    setHistoryList(recordHistoryResult(historyId, {
      // Bấm Dừng thì không phải thành công cũng không phải lỗi -> để trống, khỏi
      // gắn dấu tích xanh cho một lần chạy dở dang.
      ok: errText ? false : (cancelled ? undefined : true),
      ms: Math.round(execMs),
      rows: totalRows,
      affected: affectedTotal,
      error: errText || undefined,
    }));

    if (errText) {
      setErr(errText);
      if (acc.length > 0 && onRunSuccess) onRunSuccess();
    } else {
      const head = cancelled
        ? t('sqlEditor.stopped')
        : (n > 1 ? t('sqlEditor.execOkMulti', { n }) : t('sqlEditor.execOk'));
      const parts: string[] = [t('sqlEditor.rowsPart', { n: totalRows.toLocaleString(locale) })];
      if (affectedTotal > 0) parts.push(t('sqlEditor.affectedPart', { n: affectedTotal.toLocaleString(locale) }));
      setStat(`${head} — ${parts.join(', ')} (${timeInfo}).`);
      if (onRunSuccess) onRunSuccess();
    }

    // Câu lệnh vừa chạy có đổi cấu trúc (DDL) hoặc đổi database (USE / search_path) -> xoá cache
    // catalog để autocomplete/hover thấy ngay bảng/cột mới, khỏi phải chờ TTL.
    if (isSchemaChangingSql(textToRun)) catalog.invalidateCatalog();
  };

  const handleExplain = async (paneId: 1 | 2 = focusedEditor, variant: 'explain' | 'analyze' | 'json' = 'explain', skipUnsafeCheck = false) => {
    // Same resolution as the Run button, selection included.
    const textToRun = getTextToRun(paneId);
    if (!textToRun.trim()) return;

    // EXPLAIN ANALYZE THỰC SỰ thực thi câu lệnh (Postgres: `EXPLAIN (… ANALYZE …)`, MySQL:
    // `EXPLAIN ANALYZE`) — `EXPLAIN ANALYZE DELETE FROM t` xoá dữ liệu thật. Nên nó phải đi qua
    // đúng hai chốt của nút Run. Các variant còn lại chỉ lấy kế hoạch nên không cần.
    if (variant === 'analyze') {
      if (readOnly && !isReadOnlySql(textToRun)) {
        const msg = t('sqlEditor.errReadOnlyRun');
        if (paneId === 1) setErrorMsg(msg);
        else setErrorMsg2(msg);
        return;
      }
      if (!skipUnsafeCheck) {
        const items = findUnsafeStatements(textToRun);
        if (items.length > 0) {
          setUnsafePrompt({ pane: paneId, sql: textToRun, items, resume: 'analyze' });
          return;
        }
      }
    }

    // Nếu bật Tham số Truy vấn và câu lệnh có placeholder -> prompt giá trị rồi EXPLAIN bản parameterized.
    if (queryParamsConfig.enabled) {
      const detectedParams = extractQueryParams(textToRun, queryParamsConfig.patternIndex);
      if (detectedParams.length > 0) {
        setParamPromptData({ pane: paneId, originalSql: textToRun, params: detectedParams, action: 'explain', variant });
        return;
      }
    }

    await runExplainQuery(buildExplainQuery(textToRun, dbType, variant), paneId);
  };

  // Chạy một câu EXPLAIN đã dựng sẵn (có thể kèm params đã bind ở tầng driver) và hiển thị kế hoạch.
  const runExplainQuery = async (explainQuery: string, paneId: 1 | 2, params?: any[]) => {
    const isPane1 = paneId === 1;
    if (isPane1) {
      setLoading(true);
      setErrorMsg(null);
    } else {
      setLoading2(true);
      setErrorMsg2(null);
    }

    try {
      const res = await dbHelper.executeQuery(explainQuery, params);
      const rows = res.data || (res as any).rows || [];
      if (res.success && rows.length > 0) {
        const parsed = parseExplainOutput(rows, dbType);
        if (isPane1) {
          setExplainResult1(parsed);
          setActiveTabType1('explain');
          setHasRun(true);
        } else {
          setExplainResult2(parsed);
          setActiveTabType2('explain');
          setHasRun2(true);
        }
      } else {
        const err = res.error || t('sqlEditor.errExplainFailed');
        if (isPane1) setErrorMsg(err);
        else setErrorMsg2(err);
      }
    } catch (e: any) {
      const err = t('sqlEditor.errExplain', { message: e.message || e });
      if (isPane1) setErrorMsg(err);
      else setErrorMsg2(err);
    } finally {
      if (isPane1) setLoading(false);
      else setLoading2(false);
    }
  };

  const stopQuery = (paneId: 1 | 2 = focusedEditor) => {
    const qid = paneId === 1 ? runningQueryId : runningQueryId2;
    if (qid) dbHelper.cancelQuery(qid);
  };

  // Câu lệnh dưới con trỏ. Dùng statementAt (bỏ qua ';' nằm trong chuỗi/comment)
  // nên không còn cắt sai ở những câu như: WHERE note = 'a;b'
  const getCurrentStatement = (editor: any): string => {
    if (!editor) return '';
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return '';
    const text = model.getValue();
    return statementAt(text, model.getOffsetAt(pos))?.text || '';
  };

  const getPaneEditor = (paneId: 1 | 2 = focusedEditor) => {
    return paneId === 2 ? editorRef2.current : editorRef.current;
  };

  // Luôn lấy nội dung từ chính editor (chính xác tuyệt đối), state chỉ là bản dự phòng
  // vì nó được cập nhật theo nhịp debounce.
  const getPaneSql = (paneId: 1 | 2 = focusedEditor) => {
    const value = getPaneEditor(paneId)?.getValue?.();
    return typeof value === 'string' ? value : (paneId === 2 ? sql2 : sql);
  };

  // The SQL the user means to act on: the selection when there is one, otherwise the
  // statement under the caret. Shared by Run and EXPLAIN — EXPLAIN used to read only the
  // statement under the caret, so selecting a sub-query and explaining it analysed the
  // whole statement instead, silently disagreeing with what the Run button would execute.
  const getTextToRun = (paneId: 1 | 2 = focusedEditor): string => {
    const editor = getPaneEditor(paneId);
    if (!editor) return paneId === 2 ? sql2 : sql;
    const selection = editor.getSelection();
    const selectedText = selection ? editor.getModel().getValueInRange(selection) : '';
    return selectedText.trim() ? selectedText : getCurrentStatement(editor);
  };

  const handleRun = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    flushSqlSync(paneId); // chạy -> chốt luôn nội dung ra state/cha
    executeSql(getTextToRun(paneId), paneId);
  };

  const runAll = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    const editor = getPaneEditor(paneId);
    if (editor) executeSql(editor.getValue(), paneId);
  };

  const runCurrent = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    handleRun(paneId);
  };

  const handleQuickFavorite = (paneId: 1 | 2 = focusedEditor) => {
    setRunMenuPane(null);
    const val = getPaneSql(paneId);
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    if (!val.trim()) {
      setMsg(t('sqlEditor.errNoSqlToFavorite'));
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    const name = t('sqlEditor.favoriteName', { date: new Date().toLocaleString(locale) });
    setSavedQueries(addSavedQuery(name, val, connKey, dbName, Date.now().toString()));
    setMsg(t('sqlEditor.addedFavorite', { name }));
    setTimeout(() => setMsg(null), 3000);
  };

  const handleBeautify = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection) || '';
      const formatted = formatSql(selectedText, dbType);
      editor.pushUndoStop();
      editor.executeEdits('format-beautify', [{
        range: selection,
        text: formatted,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      setMsg(formatted === selectedText
        ? t('sqlEditor.errBeautifySelection')
        : t('sqlEditor.beautifiedSelection'));
    } else {
      const val = editor.getValue();
      const formatted = formatSql(val, dbType);
      // Dùng executeEdits thay setValue để Ctrl+Z hoàn tác được lần làm đẹp này
      editor.pushUndoStop();
      editor.executeEdits('format-beautify', [{
        range: editor.getModel().getFullModelRange(),
        text: formatted,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      if (paneId === 1) { setSql(formatted); onSqlChange?.(formatted); }
      else { setSql2(formatted); onSql2Change?.(formatted); }
      setMsg(formatted === val
        ? t('sqlEditor.errBeautifyAll')
        : t('sqlEditor.beautifiedAll'));
    }
    setTimeout(() => setMsg(null), 3000);
  };

  const handleMinify = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection) || '';
      const minified = minifySql(selectedText);
      editor.pushUndoStop();
      editor.executeEdits('format-minify', [{
        range: selection,
        text: minified,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      setMsg(t('sqlEditor.minifiedSelection'));
    } else {
      const val = editor.getValue();
      const minified = minifySql(val);
      editor.pushUndoStop();
      editor.executeEdits('format-minify', [{
        range: editor.getModel().getFullModelRange(),
        text: minified,
        forceMoveMarkers: true
      }]);
      editor.pushUndoStop();
      if (paneId === 1) { setSql(minified); onSqlChange?.(minified); }
      else { setSql2(minified); onSql2Change?.(minified); }
      setMsg(t('sqlEditor.minifiedAll'));
    }
    setTimeout(() => setMsg(null), 3000);
  };

  const handleCopySql = (paneId: 1 | 2 = focusedEditor) => {
    const val = getPaneSql(paneId);
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    if (val) {
      navigator.clipboard.writeText(val);
      setMsg(t('sqlEditor.copiedSql'));
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const handlePasteSql = async (paneId: 1 | 2 = focusedEditor) => {
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    try {
      const text = await navigator.clipboard.readText();
      const editor = getPaneEditor(paneId);
      if (editor) {
        editor.setValue(text);
        if (paneId === 1) {
          setSql(text);
          onSqlChange?.(text);
        } else {
          setSql2(text);
          onSql2Change?.(text);
        }
        setMsg(t('sqlEditor.pastedSql'));
        setTimeout(() => setMsg(null), 3000);
      }
    } catch {
      setMsg(t('sqlEditor.errClipboardRead'));
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const handleClear = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (editor) {
      editor.setValue('');
      if (paneId === 1) {
        setSql('');
        onSqlChange?.('');
      } else {
        setSql2('');
        onSql2Change?.('');
      }
    }
  };

  const renderPaneActionBar = (paneId: 1 | 2) => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', flexShrink: 0 }}>
        {/* Full-width Resizer Drag Bar */}
        <div
          onMouseDown={handleInnerResizerMouseDown}
          style={{
            height: '6px',
            cursor: 'row-resize',
            background: isDraggingResizer ? 'var(--win-accent-light, rgba(59, 130, 246, 0.2))' : 'var(--win-bg-window)',
            borderTop: '1px solid var(--win-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            flexShrink: 0,
            transition: 'background 0.15s ease'
          }}
          title={t('sqlEditor.resizeEditorTitle')}
        >
          <div style={{ width: '40px', height: '3px', borderRadius: '2px', background: isDraggingResizer ? 'var(--win-accent)' : 'var(--win-text-disabled)', opacity: isDraggingResizer ? 1 : 0.6 }} />
        </div>

        <div 
          className="sql-pane-action-bar" 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            padding: '3px 8px', 
            background: 'var(--win-bg-card, var(--win-bg-window))', 
            borderTop: '1px solid var(--win-border)', 
            borderBottom: '1px solid var(--win-border)',
            flexShrink: 0,
            fontSize: '11px',
            userSelect: 'none'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div 
              onMouseDown={handleInnerResizerMouseDown}
              style={{ cursor: 'row-resize', display: 'flex', alignItems: 'center', color: 'var(--win-text-disabled)', padding: '2px 4px' }}
              title={t('sqlEditor.resizeEditorTitle')}
            >
              <MoreHorizontal size={14} style={{ transform: 'rotate(90deg)' }} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Split button: Chạy + dropdown */}
            <div style={{ position: 'relative', display: 'flex' }}>
              <button
                className="btn btn-primary btn-join-l"
                onClick={() => handleRun(paneId)}
                disabled={paneId === 1 ? loading : loading2}
                style={{ display: 'flex', alignItems: 'center', padding: '0 10px' }}
                title={t('sqlEditor.runCurrentTitle')}
              >
                {/* currentColor, not a hardcoded #fff: `.btn:disabled` repaints the button
                    with a light background in the light theme, and a white triangle on it
                    is invisible. Following the text colour keeps the icon readable in
                    every state. */}
                <Play size={11} fill="currentColor" />
                <span>{t('sqlEditor.run')}</span>
              </button>
              <button
                className="btn btn-primary btn-join-r"
                onClick={(e) => {
                  setMoreMenuPane(null);
                  setSplitMenuPane(null);
                  setFormatMenuPane(null);
                  toggleDropdown('run', paneId, e, setRunMenuPane);
                }}
                disabled={paneId === 1 ? loading : loading2}
                style={{ padding: '0 5px', display: 'flex', alignItems: 'center' }}
                title={t('sqlEditor.runOptions')}
              >
                <ChevronDown size={12} />
              </button>
              {runMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setRunMenuPane(null)} />
                  <div className="sql-run-menu" style={{
                    position: 'absolute',
                    top: dropdownPlacement[`run_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`run_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    left: 0,
                    width: 'max-content',
                    minWidth: '240px',
                    background: 'var(--win-bg-card)',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0',
                    boxSizing: 'border-box'
                  }}>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); runCurrent(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Play size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.runCurrent')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Enter</kbd>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); runAll(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-warn)' }} />
                      <span>{t('sqlEditor.runAll')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+Enter</kbd>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <div style={{ padding: '4px 12px 2px 12px', fontSize: '10px', fontWeight: 700, color: 'var(--win-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {t('sqlEditor.explainHeading')}
                    </div>

                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'explain'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Network size={13} style={{ flexShrink: 0, color: 'var(--win-accent)' }} />
                      <span>{t('sqlEditor.explainEstimate')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Alt+E</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'analyze'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-ok)' }} />
                      <span>{t('sqlEditor.explainAnalyze')}</span>
                    </button>
                    {supportsJsonExplain(dbType) && (
                      <button
                        className="context-menu-item"
                        onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'json'); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                      >
                        <FileText size={13} style={{ flexShrink: 0 }} />
                        {/* The statement itself, not prose — no translation key. */}
                        <span>{explainJsonLabel(dbType)}</span>
                      </button>
                    )}

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleQuickFavorite(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Star size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.addFavorite')}</span>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleSaveQuery(); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Bookmark size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.saveQuery')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+S</kbd>
                    </button>
                  </div>
                </>
              )}
            </div>

            {(paneId === 1 ? loading : loading2) && (
              <button
                className="btn btn-secondary"
                onClick={() => stopQuery(paneId)}
                style={{ padding: '2px 8px', fontSize: '11px', height: '22px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)', borderColor: 'var(--st-danger)' }}
                title={t('sqlEditor.stopTitle')}
              >
                <X size={12} />
                <span>{t('sqlEditor.stop')}</span>
              </button>
            )}

            {/* Menu Định dạng SQL: Beautify / Minify */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setMoreMenuPane(null);
                  setSplitMenuPane(null);
                  toggleDropdown('format', paneId, e, setFormatMenuPane);
                }}
                style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={t('sqlEditor.formatTitle')}
              >
                <AlignLeft size={11} />
                <span>{t('sqlEditor.format')}</span>
                <span style={{ fontSize: '7px', opacity: 0.7 }}>▼</span>
              </button>
              {formatMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setFormatMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`format_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`format_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    width: 'max-content',
                    minWidth: '270px',
                    background: 'var(--win-bg-card)',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0',
                    boxSizing: 'border-box'
                  }}>
                    <button
                      className="context-menu-item"
                      onClick={() => { setFormatMenuPane(null); handleBeautify(paneId); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <AlignLeft size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.beautify')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '16px', flexShrink: 0, fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+F</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setFormatMenuPane(null); handleMinify(paneId); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Rows size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.minify')}</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '16px', flexShrink: 0, fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+M</kbd>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Menu thao tác phụ */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setFormatMenuPane(null);
                  setSplitMenuPane(null);
                  toggleDropdown('more', paneId, e, setMoreMenuPane);
                }}
                style={{ padding: '2px 6px', fontSize: '11px', height: '22px', display: 'flex', alignItems: 'center' }}
                title={t('sqlEditor.moreActions')}
              >
                <MoreHorizontal size={13} />
              </button>
              {moreMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setMoreMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`more_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`more_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    minWidth: '170px',
                    background: 'var(--win-bg-card)',
                    border: '1px solid var(--win-border)',
                    borderRadius: '6px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    zIndex: 9999,
                    padding: '4px 0'
                  }}>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleCopySql(paneId); }}><Copy size={12} /> {t('sqlEditor.copySql')}</button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handlePasteSql(paneId); }}><Clipboard size={12} /> {t('sqlEditor.pasteSql')}</button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleClear(paneId); }}><Trash2 size={12} /> {t('sqlEditor.clearAll')}</button>
                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); setShowQueryParamsConfigModal(true); }}><Settings size={12} /> {t('sqlEditor.paramOptions')}</button>
                  </div>
                </>
              )}
            </div>

            {/* Nút Param Options */}
            <button
              className="btn btn-secondary"
              onClick={() => setShowQueryParamsConfigModal(true)}
              style={{
                padding: '2px 6px',
                fontSize: '11px',
                height: '22px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                color: queryParamsConfig.enabled ? 'var(--win-accent)' : undefined,
                borderColor: queryParamsConfig.enabled ? 'var(--win-accent)' : undefined
              }}
              title={queryParamsConfig.enabled ? t('sqlEditor.paramsOn') : t('sqlEditor.paramsConfigure')}
            >
              <Settings size={11} style={{ color: queryParamsConfig.enabled ? 'var(--win-accent)' : undefined }} />
              <span>Param</span>
            </button>

            {/* Menu chia khung */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={(e) => {
                  setRunMenuPane(null);
                  setFormatMenuPane(null);
                  setMoreMenuPane(null);
                  toggleDropdown('split', paneId, e, setSplitMenuPane);
                }}
                style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}
                title="Chia khung (Split Panes)"
              >
                {splitMode === 'none' && <Columns size={11} />}
                {splitMode === 'vertical' && <Columns size={11} style={{ color: 'var(--win-accent)' }} />}
                {splitMode === 'horizontal' && <Rows size={11} style={{ color: 'var(--win-accent)' }} />}
                <span>Chia khung</span>
                <span style={{ fontSize: '7px', opacity: 0.7 }}>▼</span>
              </button>
              {splitMenuPane === paneId && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setSplitMenuPane(null)} />
                  <div style={{
                    position: 'absolute',
                    top: dropdownPlacement[`split_${paneId}`] === 'up' ? undefined : 'calc(100% + 4px)',
                    bottom: dropdownPlacement[`split_${paneId}`] === 'up' ? 'calc(100% + 4px)' : undefined,
                    right: 0,
                    width: 'max-content',
                    minWidth: '220px',
                    background: 'var(--win-bg-card)',
                    border: '1px solid var(--win-border-strong, var(--win-border))',
                    borderRadius: '6px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                    zIndex: 9999,
                    padding: '4px 0',
                    boxSizing: 'border-box'
                  }}>
                    <button 
                      className={`context-menu-item ${splitMode === 'none' ? 'active' : ''}`}
                      onClick={() => { setSplitMode('none'); onSplitModeChange?.('none'); setSplitMenuPane(null); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                    >
                      <Square size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.singlePane')}</span>
                    </button>
                    <button 
                      className={`context-menu-item ${splitMode === 'vertical' ? 'active' : ''}`}
                      onClick={() => { setSplitMode('vertical'); onSplitModeChange?.('vertical'); setSplitMenuPane(null); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                    >
                      <Columns size={13} style={{ flexShrink: 0 }} />
                      <span>{t('sqlEditor.splitVertical')}</span>
                    </button>
                    <button 
                      className={`context-menu-item ${splitMode === 'horizontal' ? 'active' : ''}`}
                      onClick={() => { setSplitMode('horizontal'); onSplitModeChange?.('horizontal'); setSplitMenuPane(null); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                    >
                      <Rows size={13} style={{ flexShrink: 0 }} />
                      <span>Chia ngang (Top / Bottom)</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            <button 
              className="btn btn-secondary" 
              onClick={() => setShowHistory(!showHistory)} 
              style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }} 
              title={t('sqlEditor.historyTitle')}
            >
              <History size={11} />
              <span>{t('sqlEditor.history')}</span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  const handleTabChange = (index: number, paneId: 1 | 2 = 1) => {
    if (paneId === 1) {
      setActiveTabIndex(index);
      setPage(1);
      const targetResult = allResults[index];
      if (targetResult) {
        setResults(targetResult.data || []);
        setColumns(targetResult.columns || []);
      }
    } else {
      setActiveTabIndex2(index);
      setPage2(1);
      const targetResult = allResults2[index];
      if (targetResult) {
        setResults2(targetResult.data || []);
        setColumns2(targetResult.columns || []);
      }
    }
  };

  const totalPages = Math.ceil(results.length / pageSize) || 1;
  const totalPages2 = Math.ceil(results2.length / pageSize2) || 1;

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  useEffect(() => {
    setPageInput2(String(page2));
  }, [page2]);

  const handlePageSubmit = (paneId: 1 | 2 = 1) => {
    if (paneId === 1) {
      const parsed = parseInt(pageInput);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages) {
        setPage(parsed);
      } else {
        setPageInput(String(page));
      }
    } else {
      const parsed = parseInt(pageInput2);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages2) {
        setPage2(parsed);
      } else {
        setPageInput2(String(page2));
      }
    }
  };

  const handleCopyAs = (format: 'table' | 'object' | 'array', paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    const curColumns = paneId === 1 ? columns : columns2;
    if (curResults.length === 0) return;
    
    let textToCopy = '';
    let successMsg = '';
    
    if (format === 'table') {
      const headers = curColumns.join('\t');
      const rows = curResults.map(row => 
        curColumns.map(col => {
          const val = row[col];
          return val === null ? 'NULL' : String(val).replace(/\t/g, ' ').replace(/\n/g, ' ');
        }).join('\t')
      ).join('\n');
      textToCopy = `${headers}\n${rows}`;
      successMsg = t('sqlEditor.copiedTable');
    } else if (format === 'object') {
      textToCopy = JSON.stringify(curResults, null, 2);
      successMsg = t('sqlEditor.copiedJsonObject');
    } else if (format === 'array') {
      let arrayData;
      if (curColumns.length === 1) {
        const singleCol = curColumns[0];
        arrayData = curResults.map(row => row[singleCol]);
      } else {
        arrayData = curResults.map(row => curColumns.map(col => row[col]));
      }
      textToCopy = JSON.stringify(arrayData, null, 2);
      successMsg = t('sqlEditor.copiedJsonArray', {
        shape: curColumns.length === 1 ? t('sqlEditor.arrayShape1d') : t('sqlEditor.arrayShape2d'),
      });
    }
    
    navigator.clipboard.writeText(textToCopy);
    if (paneId === 1) {
      setStatusMsg(successMsg);
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(successMsg);
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  const handleExportCsv = (paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    const curColumns = paneId === 1 ? columns : columns2;
    if (curResults.length === 0) return;
    const headers = curColumns.map(c => `"${c.replace(/"/g, '""')}"`).join(',');
    const rows = curResults.map(row => 
      curColumns.map(col => {
        const val = row[col];
        if (val === null) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(',')
    ).join('\n');
    const csvContent = '\uFEFF' + `${headers}\n${rows}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `query_result_pane${paneId}_${Date.now()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (paneId === 1) {
      setStatusMsg(t('sqlEditor.downloadedCsv', { pane: 1 }));
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(t('sqlEditor.downloadedCsv', { pane: 2 }));
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  const handleExportJson = (paneId: 1 | 2 = 1) => {
    const curResults = paneId === 1 ? results : results2;
    if (curResults.length === 0) return;
    const jsonContent = JSON.stringify(curResults, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `query_result_pane${paneId}_${Date.now()}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (paneId === 1) {
      setStatusMsg(t('sqlEditor.downloadedJson', { pane: 1 }));
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2(t('sqlEditor.downloadedJson', { pane: 2 }));
      setTimeout(() => setStatusMsg2(null), 3000);
    }
  };

  const handleInnerResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingResizer(true);
    const startY = e.clientY;
    const startHeight = paneEditorHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const newHeight = Math.max(60, Math.min(window.innerHeight - 180, startHeight + deltaY));
      setPaneEditorHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsDraggingResizer(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const renderResultGrid = (paneId: 1 | 2) => {
    const pResults = paneId === 1 ? results : results2;
    const pColumns = paneId === 1 ? columns : columns2;
    const pAllResults = paneId === 1 ? allResults : allResults2;
    const pActiveTabIndex = paneId === 1 ? activeTabIndex : activeTabIndex2;
    const pLoading = paneId === 1 ? loading : loading2;
    const pHasRun = paneId === 1 ? hasRun : hasRun2;
    const pErrorMsg = paneId === 1 ? errorMsg : errorMsg2;
    const pStatusMsg = paneId === 1 ? statusMsg : statusMsg2;
    const pPage = paneId === 1 ? page : page2;
    const pPageSize = paneId === 1 ? pageSize : pageSize2;
    const pPageInput = paneId === 1 ? pageInput : pageInput2;
    const pShowCopyDropdown = paneId === 1 ? showCopyDropdown : showCopyDropdown2;
    const pSetPage = paneId === 1 ? setPage : setPage2;
    const pSetPageSize = paneId === 1 ? setPageSize : setPageSize2;
    const pSetPageInput = paneId === 1 ? setPageInput : setPageInput2;
    const pSetShowCopyDropdown = paneId === 1 ? setShowCopyDropdown : setShowCopyDropdown2;

    const pExplainResult = paneId === 1 ? explainResult1 : explainResult2;
    const pActiveTabType = paneId === 1 ? activeTabType1 : activeTabType2;
    const pSetActiveTabType = paneId === 1 ? setActiveTabType1 : setActiveTabType2;

    const activeResult = pAllResults[pActiveTabIndex] || { data: [], columns: [], affectedRows: 0, query: '' };
    const totalPagesNum = Math.ceil(pResults.length / pPageSize) || 1;

    return (
      <div className="sql-results-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTop: '1px solid var(--win-border)' }}>
        <div className="sql-results-tabs" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--win-bg-window)', borderBottom: '1px solid var(--win-border)', overflow: 'visible', paddingRight: '8px', height: '28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '2px', overflowX: 'auto', flex: 1, height: '100%', alignItems: 'center', scrollbarWidth: 'none' }}>
            {pAllResults.length > 0 ? (
              pAllResults.map((resItem, idx) => {
                const firstWord = resItem.query.trim().split(/\s+/)[0].toUpperCase();
                // Hậu tố đếm: câu ghi hiện "✓N" (dòng ảnh hưởng), câu đọc hiện "(N)" (số dòng trả về).
                const countSuffix = resItem.affected !== undefined && resItem.affected !== null
                  ? ` ✓${Number(resItem.affected).toLocaleString(locale)}`
                  : ` (${(resItem.data?.length || 0).toLocaleString('vi-VN')})`;
                const label = `${idx + 1}: ${firstWord || 'SQL'}${countSuffix}`;
                const isActive = pActiveTabType === 'data' && pActiveTabIndex === idx;
                return (
                  <div
                    key={idx}
                    className={`sql-results-tab ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      pSetActiveTabType('data');
                      handleTabChange(idx, paneId);
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      cursor: 'pointer',
                      borderBottom: isActive ? '2px solid var(--win-accent)' : 'none',
                      color: isActive ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                      fontWeight: isActive ? 600 : 'normal',
                      whiteSpace: 'nowrap'
                    }}
                    title={resItem.query}
                  >
                    {label}
                  </div>
                );
              })
            ) : (
              <div
                className={`sql-results-tab ${pActiveTabType === 'data' ? 'active' : ''}`}
                onClick={() => pSetActiveTabType('data')}
                style={{ fontSize: '11px', padding: '4px 12px', cursor: 'pointer' }}
              >
                {t('sqlEditor.results')}
              </div>
            )}

            {pExplainResult && (
              <div
                className={`sql-results-tab ${pActiveTabType === 'explain' ? 'active' : ''}`}
                onClick={() => pSetActiveTabType('explain')}
                style={{
                  padding: '4px 12px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  borderBottom: pActiveTabType === 'explain' ? '2px solid var(--win-accent)' : 'none',
                  color: pActiveTabType === 'explain' ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  fontWeight: pActiveTabType === 'explain' ? 600 : 'normal',
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <Network size={12} />
                <span>EXPLAIN Plan</span>
              </div>
            )}
          </div>

          {pResults.length > 0 && (
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', padding: '2px 0' }}>
              <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)', marginRight: '2px' }}>{t('sqlEditor.exportLabel')}</span>
              <div style={{ position: 'relative', display: 'inline-block', zIndex: 1000 }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => pSetShowCopyDropdown(!pShowCopyDropdown)}
                  style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '3px' }}
                  title={t('sqlEditor.copyResultsTitle')}
                >
                  <span>{t('sqlEditor.copy')}</span>
                  <span style={{ fontSize: '7px', opacity: 0.7 }}>▼</span>
                </button>
                {pShowCopyDropdown && (
                  <>
                    <div 
                      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} 
                      onClick={() => pSetShowCopyDropdown(false)} 
                    />
                    <div style={{
                      position: 'absolute',
                      top: '22px',
                      left: 0,
                      background: 'var(--win-bg-card)',
                      border: '1px solid var(--win-border-strong, var(--win-border))',
                      borderRadius: '4px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                      zIndex: 1000,
                      minWidth: '160px',
                      display: 'flex',
                      flexDirection: 'column',
                      padding: '4px 0',
                    }}>
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('table', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsTable')}</button>
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('object', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsJsonObject')}</button>
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('array', paneId); pSetShowCopyDropdown(false); }}>{t('sqlEditor.copyAsJsonArray')}</button>
                    </div>
                  </>
                )}
              </div>
              <button className="btn btn-secondary" onClick={() => handleExportCsv(paneId)} style={{ padding: '2px 6px' }}>CSV</button>
              <button className="btn btn-secondary" onClick={() => handleExportJson(paneId)} style={{ padding: '2px 6px' }}>JSON</button>
            </div>
          )}
        </div>

        <div className="sql-results-content" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          {pActiveTabType === 'explain' && pExplainResult ? (
            <ExplainViewer
              explainResult={pExplainResult}
              // Only MySQL has a cost-less EXPLAIN variant worth re-running as JSON; Postgres
              // already returns JSON for every variant and SQLite never reports cost.
              onRequestJsonPlan={
                /mysql|maria/i.test(dbType) ? () => handleExplain(paneId, 'json') : undefined
              }
            />
          ) : (
            <>
              {pErrorMsg && (
                <div style={{ padding: '16px', color: 'var(--st-danger)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontWeight: 600 }}>
                    <AlertTriangle size={16} />
                    <span>{t('sqlEditor.sqlError')}</span>
                  </div>
                  {pErrorMsg}
                </div>
              )}

              {!pErrorMsg && pResults.length === 0 && pColumns.length === 0 && (
                <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                  {pLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--win-text-secondary)' }}>
                      <LoadingSpinner size={14} />
                      <span>{t('sqlEditor.running')}</span>
                    </div>
                  ) : pHasRun ? (
                    activeResult && activeResult.affected !== undefined && activeResult.affected !== null
                      ? t('sqlEditor.execOkAffected', { n: Number(activeResult.affected).toLocaleString(locale) })
                      : t('sqlEditor.execOkNoRows')
                  ) : (
                    t('sqlEditor.pressRunHint')
                  )}
                </div>
              )}

              {!pErrorMsg && (pResults.length > 0 || pColumns.length > 0) && (
                <div className="grid-table-container" style={{ height: '100%' }}>
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th style={{ width: '36px', textAlign: 'center' }}>#</th>
                        {/* key theo VỊ TRÍ, không theo tên: `SELECT *` qua nhiều JOIN trả về
                            trùng tên cột (film_id có ở film/film_actor/inventory) nên tên cột
                            không phải khoá duy nhất — React sẽ cảnh báo và có thể nhân đôi/bỏ ô. */}
                        {pColumns.map((col, ci) => (
                          <th key={ci}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pResults.slice((pPage - 1) * pPageSize, pPage * pPageSize).map((row, index) => (
                        <tr key={index}>
                          <td style={{ textAlign: 'center', color: 'var(--win-text-secondary)', background: 'rgba(0,0,0,0.1)' }}>
                            {(pPage - 1) * pPageSize + index + 1}
                          </td>
                          {pColumns.map((col, ci) => {
                            const cellVal = row[col];
                            return (
                              <td key={ci}>
                                {cellVal === null ? (
                                  <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                ) : (
                                  String(cellVal)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {!pErrorMsg && pResults.length > 0 && (
          <div className="grid-pagination" style={{ borderTop: '1px solid var(--win-border)', background: 'var(--win-bg-window)', flexShrink: 0, padding: '2px 8px', fontSize: '11px' }}>
            <div>
              <Trans
                i18nKey="sqlEditor.rowsRange"
                values={{
                  from: (pPage - 1) * pPageSize + 1,
                  to: Math.min(pPage * pPageSize, pResults.length),
                  total: pResults.length,
                }}
                components={{ strong: <b /> }}
              />
            </div>
            <div className="pagination-controls">
              <span style={{ marginRight: '6px' }}>
                {t('sqlEditor.rowsLabel')}{' '}
                <select
                  value={pPageSize}
                  onChange={(e) => {
                    pSetPageSize(parseInt(e.target.value));
                    pSetPage(1);
                  }}
                  style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '3px', padding: '1px 2px', fontSize: '11px' }}
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                </select>
              </span>

              <button className="pagination-btn" onClick={() => pSetPage(1)} disabled={pPage === 1} title={t('sqlEditor.firstPage')}>
                <ChevronsLeft size={14} />
              </button>
              <button className="pagination-btn" onClick={() => pSetPage(p => Math.max(p - 1, 1))} disabled={pPage === 1} title={t('sqlEditor.prevPage')}>
                <ChevronLeft size={14} />
              </button>
              
              <span style={{ display: 'flex', alignItems: 'center' }}>
                Trang 
                <input
                  type="number"
                  value={pPageInput}
                  onChange={(e) => pSetPageInput(e.target.value)}
                  onBlur={() => handlePageSubmit(paneId)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handlePageSubmit(paneId); }}
                  style={{
                    width: '30px',
                    textAlign: 'center',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    borderRadius: '3px',
                    padding: '1px 0',
                    margin: '0 3px',
                    fontSize: '11px',
                    fontWeight: 600
                  }}
                />
                / <b>{totalPagesNum}</b>
              </span>

              <button className="pagination-btn" onClick={() => pSetPage(p => Math.min(p + 1, totalPagesNum))} disabled={pPage >= totalPagesNum} title={t('sqlEditor.nextPage')}>
                <ChevronRight size={14} />
              </button>
              <button className="pagination-btn" onClick={() => pSetPage(totalPagesNum)} disabled={pPage >= totalPagesNum} title={t('sqlEditor.lastPage')}>
                <ChevronsRight size={14} />
              </button>
            </div>
          </div>
        )}

        <div className="sql-results-status" style={{ flexShrink: 0, height: '24px', padding: '0 8px', fontSize: '11px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pStatusMsg ? (
              <>
                <CheckCircle2 size={12} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />
                <span style={{ color: 'var(--st-ok)' }}>
                  {pStatusMsg}
                  {activeResult && activeResult.query && (
                    <span style={{ fontSize: '10.5px', color: 'var(--win-text-secondary)', marginLeft: '6px' }}>
                      {activeResult.affectedRows > 0
                        ? t('sqlEditor.paneAffected', { pane: paneId, n: activeResult.affectedRows })
                        : t('sqlEditor.paneFetched', { pane: paneId, n: activeResult.data?.length || 0 })}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <span>{t('sqlEditor.paneReady', { pane: paneId })}</span>
            )}
          </div>
          <div></div>
        </div>
      </div>
    );
  };

  return (
    <div className="sql-editor-container" ref={containerRef} style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* Main Split Wrapper: holds Pane 1 and optional Pane 2 side-by-side or stacked */}
      <div className={`sql-editor-split-wrapper ${splitMode}`} style={{ 
        flex: 1, 
        display: 'flex',
        flexDirection: splitMode === 'horizontal' ? 'column' : 'row',
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0
      }}>
        {/* Pane 1 */}
        <div 
          className="sql-pane"
          style={{ 
            flex: splitMode === 'none' ? '1 1 100%' : 'none',
            width: splitMode === 'vertical' ? `${splitRatio}%` : '100%', 
            height: splitMode === 'horizontal' ? `${splitRatio}%` : '100%', 
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            border: splitMode === 'none' ? 'none' : focusedEditor === 1 ? '1px solid var(--win-accent)' : '1px solid var(--win-border)'
          }}
        >
          {/* Editor 1 Section */}
          <div style={{ height: `${paneEditorHeight}px`, flex: 'none', position: 'relative', overflow: 'hidden' }}>
            <Editor
              height="100%"
              language={langId}
              theme={sqlThemeName(theme)}
              defaultValue={initialSql}
              onChange={(val) => queueSqlSync(1, val || '')}
              onMount={(editor) => handleEditorDidMount(editor, 1)}
              loading={
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                  {t('sqlEditor.loadingEditor')}
                </div>
              }
              options={SQL_EDITOR_OPTIONS}
            />
          </div>

          {/* Action Bar & Resizer handle for Pane 1 */}
          {renderPaneActionBar(1)}

          {/* Result Grid 1 Section */}
          {renderResultGrid(1)}
        </div>

        {/* Resizer Divider Bar between Pane 1 & Pane 2 */}
        {splitMode !== 'none' && (
          <div 
            className={`${splitMode === 'vertical' ? 'split-divider-h' : 'split-divider-v'} ${isDraggingSplit ? 'dragging' : ''}`}
            onMouseDown={handleSplitMouseDown}
            title={t('sqlEditor.resizePanes')}
          />
        )}

        {/* Pane 2 (Rendered when splitMode !== 'none') */}
        {splitMode !== 'none' && (
          <div 
            className="sql-pane"
            style={{ 
              flex: '1 1 0%',
              width: splitMode === 'vertical' ? `calc(${100 - splitRatio}% - 6px)` : '100%', 
              height: splitMode === 'horizontal' ? `calc(${100 - splitRatio}% - 6px)` : '100%', 
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: focusedEditor === 2 ? '1px solid var(--win-accent)' : '1px solid var(--win-border)',
              position: 'relative'
            }}
          >
            {/* Editor 2 Section */}
            <div style={{ height: `${paneEditorHeight}px`, flex: 'none', position: 'relative', overflow: 'hidden' }}>
              <button 
                className="split-pane-close-btn"
                onClick={() => {
                  setSplitMode('none');
                  onSplitModeChange?.('none');
                }}
                style={{ position: 'absolute', top: '4px', right: '8px', zIndex: 10, background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff', borderRadius: '3px', padding: '2px 4px', cursor: 'pointer' }}
                title={t('sqlEditor.closePane2')}
              >
                <X size={12} />
              </button>
              <Editor
                height="100%"
                language={langId}
                theme={sqlThemeName(theme)}
                defaultValue={initialSql2}
                onChange={(val) => queueSqlSync(2, val || '')}
                onMount={(editor) => handleEditorDidMount(editor, 2)}
                loading={
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    {t('sqlEditor.loadingEditor')}
                  </div>
                }
                options={SQL_EDITOR_OPTIONS}
              />
            </div>

            {/* Action Bar & Resizer handle for Pane 2 */}
            {renderPaneActionBar(2)}

            {/* Result Grid 2 Section */}
            {renderResultGrid(2)}
          </div>
        )}
      </div>

      {showHistory && (
        <div className="sql-history-panel">
          <div className="sql-history-header" style={{ padding: '0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--win-border)', width: '100%', boxSizing: 'border-box' }}>
              <div className="sql-history-title">
                <History size={13} />
                <span>{t('sqlEditor.queryTable')}</span>
              </div>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowHistory(false)}
                style={{ padding: '2px 6px', height: '20px', minWidth: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={12} />
              </button>
            </div>
            <div style={{ display: 'flex', background: 'rgba(0,0,0,0.02)', width: '100%' }}>
              <button
                style={{
                  flex: 1,
                  padding: '6px',
                  fontSize: '11px',
                  border: 'none',
                  background: historyTab === 'history' ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderBottom: historyTab === 'history' ? '2px solid var(--win-accent)' : 'none',
                  color: historyTab === 'history' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  fontWeight: historyTab === 'history' ? 600 : 'normal'
                }}
                onClick={() => setHistoryTab('history')}
              >
                {t('sqlEditor.historyTab', { n: historyCount })}
              </button>
              <button
                style={{
                  flex: 1,
                  padding: '6px',
                  fontSize: '11px',
                  border: 'none',
                  background: historyTab === 'saved' ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderBottom: historyTab === 'saved' ? '2px solid var(--win-accent)' : 'none',
                  color: historyTab === 'saved' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  fontWeight: historyTab === 'saved' ? 600 : 'normal'
                }}
                onClick={() => setHistoryTab('saved')}
              >
                {t('sqlEditor.savedTab', { n: savedCount })}
              </button>
            </div>
          </div>
          <div className="sql-history-search">
            <input
              type="text"
              className="sql-history-search-input"
              placeholder={historyTab === 'history' ? t('sqlEditor.searchHistory') : t('sqlEditor.searchSaved')}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
            {/* Phạm vi: database đang dùng (mặc định), cả máy chủ, hay mọi kết nối.
                Câu viết trên DB dev thường cần chạy lại trên prod, nên phải xem được
                cả của kết nối khác — chỉ là không trộn sẵn vào mặc định. */}
            {!!connKey && (
              <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                {SCOPE_OPTIONS.map(({ scope, labelKey, titleKey }) => (
                  <button
                    key={scope}
                    onClick={() => changeHistoryScope(scope)}
                    title={t(titleKey)}
                    style={{
                      flex: 1,
                      padding: '3px 6px',
                      fontSize: '10px',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === scope ? 'var(--win-accent)' : 'transparent',
                      color: historyScope === scope ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === scope ? 600 : 'normal',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="sql-history-list">
            {historyTab === 'history' ? (
              Object.keys(getFilteredHistory()).length === 0 ? (
                <div className="sql-history-empty">
                  {t('sqlEditor.noHistory')}
                </div>
              ) : (
                Object.keys(getFilteredHistory()).map(dateKey => {
                  const groupItems = getFilteredHistory()[dateKey];
                  return (
                    <div key={dateKey} className="sql-history-group">
                      <div className="sql-history-group-title">
                        {getGroupTitle(dateKey)}
                      </div>
                      {groupItems.map(item => {
                        const timeStr = new Date(item.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div
                            key={item.id}
                            className="sql-history-item"
                            onClick={() => handleSelectHistoryItem(item.sql)}
                            title={item.error || t('sqlEditor.loadIntoEditor')}
                          >
                            <div className="sql-history-item-meta">
                              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                {/* Kết quả lần chạy. Dòng cũ (và dòng đang chạy dở) không có
                                    item.ok -> không hiện gì, không giả vờ là thành công. */}
                                {item.ok === true && <CheckCircle2 size={11} style={{ color: 'var(--st-ok)', flexShrink: 0 }} />}
                                {item.ok === false && <AlertTriangle size={11} style={{ color: 'var(--st-danger)', flexShrink: 0 }} />}
                                {timeStr}
                                {/* Chạy trên DB nào: chỉ cần khi đang xem nhiều kết nối.
                                    Dòng ghi trước khi có tính năng này thì không có item.db. */}
                                {effectiveScope !== 'db' && item.db && (
                                  <span style={{ opacity: 0.7 }}>· {item.db}</span>
                                )}
                                {historyMetrics(item) && (
                                  <span style={{ opacity: 0.7 }}>· {historyMetrics(item)}</span>
                                )}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span 
                                  style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(item.sql);
                                    setStatusMsg(t('sqlEditor.copiedSqlShort'));
                                    setTimeout(() => setStatusMsg(null), 2500);
                                  }}
                                  title={t('sqlEditor.copySqlTitle')}
                                >
                                  <Copy size={11} /> {t('sqlEditor.copy')}
                                </span>
                                <span 
                                  style={{ cursor: 'pointer', color: 'var(--st-danger)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (confirm(t('sqlEditor.confirmDeleteHistoryItem'))) {
                                      setHistoryList(deleteHistoryEntry(item.id));
                                    }
                                  }}
                                  title={t('sqlEditor.deleteHistoryItemTitle')}
                                >
                                  {t('sqlEditor.delete')}
                                </span>
                              </div>
                            </div>
                            <div className="sql-history-item-sql">
                              {item.sql}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )
            ) : (
              getFilteredSaved().length === 0 ? (
                <div className="sql-history-empty">
                  {t('sqlEditor.noSaved')}
                </div>
              ) : (
                getFilteredSaved().map(item => {
                  const dateStr = new Date(item.timestamp).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
                  return (
                    <div 
                      key={item.id} 
                      className="sql-history-item"
                      onClick={() => handleSelectHistoryItem(item.sql)}
                      style={{ borderLeft: '3px solid var(--win-accent)', paddingLeft: '8px' }}
                      title={t('sqlEditor.loadThisQuery')}
                    >
                      <div className="sql-history-item-meta">
                        <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>{item.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {effectiveScope !== 'db' && item.db && <span style={{ opacity: 0.7 }}>{item.db}</span>}
                          <span>{dateStr}</span>
                          <span 
                            style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.sql);
                              setStatusMsg(t('sqlEditor.copiedSqlShort'));
                              setTimeout(() => setStatusMsg(null), 2500);
                            }}
                            title={t('sqlEditor.copySqlTitle')}
                          >
                            <Copy size={11} /> {t('sqlEditor.copy')}
                          </span>
                          <span
                            style={{ cursor: 'pointer', color: 'var(--st-danger)' }}
                            onClick={(e) => handleDeleteSaved(item.id, e)}
                            title={t('sqlEditor.deleteSavedTitle')}
                          >
                            {t('sqlEditor.delete')}
                          </span>
                        </div>
                      </div>
                      <div className="sql-history-item-sql">
                        {item.sql}
                      </div>
                    </div>
                  );
                })
              )
            )}
          </div>
          {historyTab === 'history' && historyCount > 0 && (
            <div style={{ padding: '8px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', background: 'rgba(0, 0, 0, 0.02)' }}>
              <button 
                className="btn btn-secondary" 
                onClick={handleClearHistory}
                style={{ width: '100%' }}
              >
                {clearHistoryLabel()}
              </button>
            </div>
          )}
        </div>
      )}

      {showSaveModal && (
        <Modal
          title={t('sqlEditor.saveModalTitle')}
          onClose={() => { setShowSaveModal(false); setNewQueryName(''); }}
          width="360px"
          zIndex={9999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div>
              <label style={{ fontSize: '11px', display: 'block', marginBottom: '6px', color: 'var(--win-text-secondary)' }}>
                {t('sqlEditor.saveModalLabel')}
              </label>
              <input 
                type="text" 
                className="form-input" 
                value={newQueryName}
                onChange={(e) => setNewQueryName(e.target.value)}
                placeholder={t('sqlEditor.saveModalPlaceholder')}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px', fontSize: '12px' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmSaveQuery();
                  if (e.key === 'Escape') {
                    setShowSaveModal(false);
                    setNewQueryName('');
                  }
                }}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowSaveModal(false);
                setNewQueryName('');
              }}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleConfirmSaveQuery}
              style={{ padding: '0 12px' }}
            >
              {t('sqlEditor.saveModalConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Query Params Config Modal */}
      {showQueryParamsConfigModal && (
        <QueryParamsConfigModal
          initialConfig={queryParamsConfig}
          onSave={(newCfg) => {
            setQueryParamsConfig(newCfg);
            saveQueryParamsConfig(newCfg);
          }}
          onClose={() => setShowQueryParamsConfigModal(false)}
        />
      )}

      {/* Query Params Prompt Modal */}
      {paramPromptData && (
        <QueryParamsModal
          params={paramPromptData.params}
          sqlPreview={paramPromptData.originalSql}
          onSubmit={(valuesMap) => {
            // Với EXPLAIN: bọc EXPLAIN quanh câu gốc trước rồi mới đổi placeholder -> native + values.
            // Với chạy thường: đổi trực tiếp câu gốc. Cả hai đều bind ở tầng driver (không nội suy -> chống SQL injection).
            const p = paramPromptData.pane;
            const isExplain = paramPromptData.action === 'explain';
            const srcSql = isExplain
              ? buildExplainQuery(paramPromptData.originalSql, dbType, paramPromptData.variant || 'explain')
              : paramPromptData.originalSql;
            const { sql: finalSql, values } = buildParameterizedSql(
              srcSql,
              queryParamsConfig.patternIndex,
              valuesMap,
              dbType
            );
            setParamPromptData(null);
            if (isExplain) {
              runExplainQuery(finalSql, p, values);
            } else {
              runRawSql(finalSql, p, values);
            }
          }}
          onClose={() => setParamPromptData(null)}
        />
      )}

      {/* Cảnh báo DELETE thiếu WHERE / DROP TABLE. Liệt kê nguyên văn câu vi phạm — hữu ích hơn
          tên bảng đã tách, vì script nhiều câu lệnh thì người dùng cần biết CHÍNH XÁC câu nào. */}
      {unsafePrompt && (
        <ConfirmDialog
          open
          danger
          title={t('sqlEditor.unsafeTitle')}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span>{t('sqlEditor.unsafeIntro', { n: unsafePrompt.items.length })}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                {unsafePrompt.items.map((item, i) => (
                  <div key={i} style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '6px 8px', background: 'var(--win-bg-window)' }}>
                    <div style={{ fontSize: '10px', color: 'var(--st-danger)', fontWeight: 600, marginBottom: '2px' }}>
                      {unsafeKindLabel(item.kind)}
                    </div>
                    <code style={{ fontFamily: 'var(--win-font-mono)', fontSize: '11px', wordBreak: 'break-all', color: 'var(--win-text-primary)' }}>
                      {item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          }
          note={t('sqlEditor.unsafeNote')}
          confirmLabel={t('sqlEditor.unsafeConfirm')}
          onConfirm={() => {
            const p = unsafePrompt;
            setUnsafePrompt(null);
            if (p.resume === 'analyze') handleExplain(p.pane, 'analyze', true);
            else executeSql(p.sql, p.pane, true);
          }}
          onCancel={() => setUnsafePrompt(null)}
        />
      )}
    </div>
  );
};
