import React, { useState, useRef, useEffect } from 'react';
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
import { setupSqlCompletion, langIdForDbType } from '../sql/sqlLanguage';

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

// Đăng ký smart completion (dùng chung, chỉ chạy 1 lần)
setupSqlCompletion();

// Pack monaco directly into the loader config
loader.config({ monaco });
import { dbHelper } from '../utils/dbHelper';
import { maskCommentsAndStrings } from '../utils/queryParamHelper';

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

// Cache metadata (bảng + cột) cho autocomplete. Làm mới ở chế độ NỀN để KHÔNG gọi backend mỗi lần gõ
// (tránh lag khi DB ở host public/độ trễ cao như Render).
let cachedTables: { name: string; type: string }[] = [];
let columnsCache: Record<string, string[]> = {};
let sqlMetaFetchedAt = 0;
let sqlMetaFetching = false;

async function refreshSqlMeta() {
  if (sqlMetaFetching) return;
  sqlMetaFetching = true;
  try {
    const tables = await dbHelper.getTables();
    cachedTables = tables;
    const names = new Set(tables.map(t => t.name));
    // Bỏ cache cột của bảng không còn tồn tại
    Object.keys(columnsCache).forEach(n => { if (!names.has(n)) delete columnsCache[n]; });
    // Nạp cột cho những bảng chưa có trong cache (chạy nền)
    await Promise.all(tables.map(async (t) => {
      if (!columnsCache[t.name]) {
        try {
          const s = await dbHelper.getTableSchema(t.name);
          columnsCache[t.name] = (s.columns || []).map(c => c.name);
        } catch { /* bỏ qua bảng lỗi */ }
      }
    }));
  } catch { /* ignore */ }
  finally { sqlMetaFetchedAt = Date.now(); sqlMetaFetching = false; }
}

// Làm mới cache ngay khi cấu trúc thay đổi (đổi tên/khôi phục/đổi database)
if (!(window as any).__sqlMetaListener) {
  (window as any).__sqlMetaListener = true;
  const invalidate = () => { sqlMetaFetchedAt = 0; };
  window.addEventListener('table-renamed', invalidate);
  window.addEventListener('database-restored', invalidate);
}

// Register completion item provider to suggest DB tables, columns, and SQL keywords.
// Dispose of any previously registered provider (specifically for HMR during development)
if ((window as any).sqlCompletionDisposable) {
  try {
    (window as any).sqlCompletionDisposable.dispose();
  } catch (e) {
    console.error('Error disposing autocomplete provider:', e);
  }
}

(window as any).sqlCompletionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // Làm mới cache ở chế độ nền nếu quá cũ (>15s) — KHÔNG await, không chặn khi gõ
      if (Date.now() - sqlMetaFetchedAt > 15000) { void refreshSqlMeta(); }
      const tables = cachedTables;

      try {

        // Lấy toàn bộ văn bản từ đầu tệp đến vị trí con trỏ hiện tại
        const textBeforeCursor = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });

        // Phân tích các từ khóa yêu cầu chỉ định bảng
        const tableOnlyKeywords = ['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'];
        const tokens = textBeforeCursor.trimEnd().toUpperCase().split(/[\s,()]+/);
        const lastToken = tokens[tokens.length - 1];
        const secondLastToken = tokens.length > 1 ? tokens[tokens.length - 2] : null;

        // Kiểm tra xem ký tự ngay trước con trỏ có phải là khoảng trắng/xuống dòng không
        const hasTrailingSpace = /\s$/.test(textBeforeCursor);

        let isTableOnlyContext = false;
        if (hasTrailingSpace) {
          isTableOnlyContext = tableOnlyKeywords.includes(lastToken);
        } else {
          isTableOnlyContext = secondLastToken ? tableOnlyKeywords.includes(secondLastToken) : false;
        }

        // Nếu ở trong ngữ cảnh chỉ được chọn Bảng (sau FROM, JOIN, etc.)
        if (isTableOnlyContext) {
          const tableSuggestions = tables.map((t) => ({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t.name,
            detail: t.type === 'view' ? 'Khung nhìn (View)' : 'Bảng (Table)',
            range: range,
          }));
          return { suggestions: tableSuggestions };
        }

        // Hiển thị tất cả bảng, cột và từ khóa trực tiếp nếu gõ bình thường
        const suggestions: any[] = tables.map((t) => ({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          detail: t.type === 'view' ? 'Khung nhìn (View)' : 'Bảng (Table)',
          range: range,
        }));

        // Bổ sung gợi ý tất cả cột trực tiếp
        Object.entries(columnsCache).forEach(([tName, cols]) => {
          cols.forEach((col) => {
            suggestions.push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              detail: `Cột của bảng ${tName}`,
              range: range,
            });
          });
        });

        // Bổ sung từ khóa
        const keywords = [
          'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 
          'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'ON', 'GROUP BY', 
          'ORDER BY', 'LIMIT', 'AND', 'OR', 'NOT', 'AS', 'IN', 'LIKE', 'IS NULL'
        ];
        
        keywords.forEach((kw) => {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: 'Từ khóa SQL',
            range: range,
          });
        });

        return { suggestions };
      } catch {
        return { suggestions: [] };
      }
    },
  });

function formatSql(sql: string): string {
  const keywords = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
    'OUTER JOIN', 'ON', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'LIMIT', 'OFFSET',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DELETE FROM', 'HAVING',
    'UNION', 'AS', 'IN', 'IS', 'NULL', 'LIKE', 'NOT', 'CREATE TABLE', 'DROP TABLE'
  ];

  const parts = sql.split(/('[^']*'|"[^"]*"|`[^`]*`)/);
  const formattedParts = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    let temp = part;
    keywords.forEach(kw => {
      const regex = new RegExp('\\b' + kw + '\\b', 'gi');
      temp = temp.replace(regex, kw);
    });
    return temp;
  });

  const uppercaseSql = formattedParts.join('');

  const breakKeywords = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
    'OUTER JOIN', 'ORDER BY', 'GROUP BY', 'LIMIT', 'VALUES', 'SET', 'UNION'
  ];

  const subParts = uppercaseSql.split(/('[^']*'|"[^"]*"|`[^`]*`)/);
  const finalParts = subParts.map((part, index) => {
    if (index % 2 === 1) return part;
    let temp = part;
    breakKeywords.forEach(kw => {
      const regex = new RegExp('\\s*\\b' + kw + '\\b', 'g');
      temp = temp.replace(regex, `\n${kw}`);
    });
    const andOrRegex = /\s*\b(AND|OR)\b/g;
    temp = temp.replace(andOrRegex, '\n  $1');
    return temp;
  });

  const result = finalParts.join('');
  return result
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, i, arr) => line.trim() !== '' || (i > 0 && arr[i-1].trim() !== ''))
    .join('\n')
    .trim();
}

function minifySql(sql: string): string {
  if (!sql.trim()) return sql;
  
  // Strip single line comments (-- ...) and block comments (/* ... */)
  let cleaned = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
    
  // Split by string literals ('...', "...", `...`)
  const parts = cleaned.split(/('[^']*'|"[^"]*"|`[^`]*`)/);
  const minified = parts.map((part, index) => {
    if (index % 2 === 1) return part; // Keep string literals untouched
    return part
      .replace(/\s+/g, ' ')
      .replace(/\s*([,;()=><+\-*/])\s*/g, '$1');
  }).join('').trim();

  // Ensure SQL keywords and word boundaries have clean single space padding
  return minified
    .replace(/\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|ORDER BY|GROUP BY|LIMIT|OFFSET|INSERT INTO|VALUES|UPDATE|SET|DELETE|HAVING|UNION|AS|IN|IS|NULL|LIKE|NOT)\b/gi, (match) => ` ${match} `)
    .replace(/\s+/g, ' ')
    .trim();
}

let isFormatRegistered = false;
if (!isFormatRegistered) {
  isFormatRegistered = true;
  const formatProvider = {
    provideDocumentFormattingEdits(model: any) {
      const formatted = formatSql(model.getValue());
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  };
  // Đăng ký cho cả 'sql' lẫn dialect của monaco-sql-languages ('mysql'/'pgsql')
  ['sql', 'mysql', 'pgsql'].forEach((lang) => {
    monaco.languages.registerDocumentFormattingEditProvider(lang, formatProvider);
  });
}
import { Play, Clipboard, Trash2, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, Copy, AlignLeft, ChevronsLeft, ChevronsRight, History, X, Bookmark, ChevronDown, MoreHorizontal, Star, Columns, Rows, Settings, Network, Zap, FileText, Square } from 'lucide-react';
import { getQueryParamsConfig, saveQueryParamsConfig, extractQueryParams, buildParameterizedSql, type QueryParamsConfig } from '../utils/queryParamHelper';
import { buildExplainQuery, parseExplainOutput, type ExplainResult } from '../utils/explainHelper';
import { QueryParamsConfigModal } from './QueryParamsConfigModal';
import { QueryParamsModal } from './QueryParamsModal';
import { ExplainViewer } from './ExplainViewer';

interface SqlEditorProps {
  dbType?: string;
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

// Câu lệnh chỉ đọc được phép chạy trong chế độ Chỉ đọc
const READ_ONLY_PREFIXES = ['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'PRAGMA', 'WITH'];
function isReadOnlySql(text: string): boolean {
  // Mask comment + chuỗi (giữ nguyên độ dài) rồi mới tách theo ';' -> dấu ';' nằm trong
  // chuỗi/comment không làm vỡ câu lệnh. Từ khóa đầu (SELECT/SHOW...) nằm ngoài chuỗi nên vẫn còn.
  const masked = maskCommentsAndStrings(text);
  return masked.split(';').map(s => s.trim()).filter(Boolean).every(stmt => {
    const first = stmt.split(/\s+/)[0].toUpperCase();
    return READ_ONLY_PREFIXES.includes(first);
  });
}

export const SqlEditor: React.FC<SqlEditorProps> = ({
  dbType = 'sqlite',
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
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  
  const [savedQueries, setSavedQueries] = useState<any[]>([]);
  const [historyTab, setHistoryTab] = useState<'history' | 'saved'>('history');

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

  // EXPLAIN State
  const [explainResult1, setExplainResult1] = useState<ExplainResult | null>(null);
  const [explainResult2, setExplainResult2] = useState<ExplainResult | null>(null);
  const [activeTabType1, setActiveTabType1] = useState<'data' | 'explain'>('data');
  const [activeTabType2, setActiveTabType2] = useState<'data' | 'explain'>('data');

  // Load history & saved queries on mount
  useEffect(() => {
    const historyStr = localStorage.getItem('sql_query_history') || '[]';
    try {
      setHistoryList(JSON.parse(historyStr));
    } catch {
      setHistoryList([]);
    }

    const savedStr = localStorage.getItem('sql_saved_queries') || '[]';
    try {
      setSavedQueries(JSON.parse(savedStr));
    } catch {
      setSavedQueries([]);
    }
  }, []);

  // Recalculate Monaco editor layout when history drawer, split mode, or height changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (editorRef.current) editorRef.current.layout();
      if (editorRef2.current) editorRef2.current.layout();
    }, 50);
    return () => clearTimeout(timer);
  }, [showHistory, splitMode, paneEditorHeight]);

  const addToHistory = (queryText: string) => {
    if (!queryText.trim()) return;
    const historyStr = localStorage.getItem('sql_query_history') || '[]';
    let history = [];
    try {
      history = JSON.parse(historyStr);
    } catch {
      history = [];
    }
    
    // Avoid double logging the exact same query in a row
    if (history.length > 0 && history[0].sql.trim() === queryText.trim()) {
      return;
    }

    const newEntry = {
      id: Date.now().toString(),
      sql: queryText,
      timestamp: new Date().toISOString()
    };

    const updated = [newEntry, ...history].slice(0, 500);
    localStorage.setItem('sql_query_history', JSON.stringify(updated));
    setHistoryList(updated);
  };

  const handleClearHistory = () => {
    if (confirm("Bạn có chắc muốn xóa sạch lịch sử truy vấn?")) {
      localStorage.setItem('sql_query_history', '[]');
      setHistoryList([]);
    }
  };

  const handleSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      if (!val.trim()) {
        setStatusMsg("Vui lòng nhập câu lệnh trước khi lưu.");
        setTimeout(() => setStatusMsg(null), 3000);
        return;
      }
      setNewQueryName(`Truy vấn ngày ${new Date().toLocaleDateString('vi-VN')}`);
      setShowSaveModal(true);
    }
  };

  const handleConfirmSaveQuery = () => {
    if (editorRef.current) {
      const val = editorRef.current.getValue();
      const name = newQueryName.trim() || `Truy vấn ngày ${new Date().toLocaleDateString('vi-VN')}`;
      
      const savedStr = localStorage.getItem('sql_saved_queries') || '[]';
      let saved = [];
      try { saved = JSON.parse(savedStr); } catch { saved = []; }
      
      const newEntry = {
        id: Date.now().toString(),
        name: name,
        sql: val,
        timestamp: new Date().toISOString()
      };
      const updated = [newEntry, ...saved];
      localStorage.setItem('sql_saved_queries', JSON.stringify(updated));
      setSavedQueries(updated);
      setShowSaveModal(false);
      setNewQueryName('');
      setStatusMsg(`Đã lưu câu lệnh "${name}".`);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const handleDeleteSaved = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Bạn có chắc muốn xóa câu lệnh đã lưu này?")) {
      const updated = savedQueries.filter(q => q.id !== id);
      setSavedQueries(updated);
      localStorage.setItem('sql_saved_queries', JSON.stringify(updated));
    }
  };

  const handleSelectHistoryItem = (sqlText: string) => {
    if (editorRef.current) {
      editorRef.current.setValue(sqlText);
      setSql(sqlText);
      setStatusMsg("Đã nạp câu lệnh SQL.");
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  const getGroupTitle = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
      return 'Hôm nay';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Hôm qua';
    } else {
      return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  };

  const getFilteredHistory = () => {
    const filtered = historyList.filter(item => 
      item.sql.toLowerCase().includes(historySearch.toLowerCase())
    );
    
    const groups: { [key: string]: any[] } = {};
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
      item.name.toLowerCase().includes(historySearch.toLowerCase()) ||
      item.sql.toLowerCase().includes(historySearch.toLowerCase())
    );
  };

  const editorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

    // Format / Beautify / Minify actions cho Monaco context menu
    editor.addAction({
      id: 'format-beautify-sql',
      label: 'Làm đẹp SQL (Beautify)',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.1,
      run: () => {
        handleBeautify(editorId);
      }
    });

    editor.addAction({
      id: 'format-minify-sql',
      label: 'Nén SQL 1 dòng (Minify / Uglify)',
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
      label: 'Chia khung dọc (Left / Right)',
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
      label: 'Tắt chia khung (Single Pane)',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.7,
      run: () => {
        setSplitMode('none');
        onSplitModeChange?.('none');
      }
    });

    editor.addAction({
      id: 'explain-query-plan',
      label: 'Phân tích kế hoạch (EXPLAIN Plan)',
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const textToRun = getCurrentStatement(editor);
      executeSql(textToRun, editorId);
    });
    
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      executeSql(editor.getValue(), editorId);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
      handleSaveQuery();
    });

    void refreshSqlMeta();

    setTimeout(() => {
      editor.layout();
    }, 100);
  };

  const executeSql = async (queryText?: string, targetPane?: 1 | 2) => {
    const pane = targetPane || focusedEditor;
    const textToRun = queryText || (pane === 2 ? sql2 : sql);
    if (!textToRun.trim()) return;

    // Chế độ Chỉ đọc: chỉ cho phép câu lệnh đọc (SELECT/SHOW/...)
    if (readOnly && !isReadOnlySql(textToRun)) {
      const msg = 'Đang ở chế độ Chỉ đọc: chỉ cho phép SELECT/SHOW/EXPLAIN/PRAGMA. Tắt "Chỉ đọc" để chạy câu lệnh ghi.';
      if (pane === 1) setErrorMsg(msg);
      else setErrorMsg2(msg);
      return;
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
    addToHistory(textToRun); // Log query history immediately

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
          errText = msg.message || 'Lỗi không rõ khi thực thi SQL.';
        } else if (msg.type === 'done') {
          cancelled = !!msg.cancelled;
        }
      }, params);
    } catch (e: any) {
      errText = `Lỗi truy vấn: ${e}`;
    }

    flush(); // phản chiếu lần cuối (đảm bảo batch cuối cùng đã vào state)

    const totalRows = acc.reduce((s, r) => s + r.data.length, 0);
    const affectedTotal = acc.reduce((s, r) => s + (r.affected || 0), 0);
    const elapsed = performance.now() - t0;
    const execMs = tFirst > 0 ? tFirst - t0 : elapsed;
    const timeInfo = `thực thi ${execMs.toFixed(0)}ms, tải ${elapsed.toFixed(0)}ms`;
    const n = acc.length;

    const setLoad = isPane1 ? setLoading : setLoading2;
    const setErr = isPane1 ? setErrorMsg : setErrorMsg2;
    const setStat = isPane1 ? setStatusMsg : setStatusMsg2;
    const setRunId = isPane1 ? setRunningQueryId : setRunningQueryId2;

    setLoad(false);
    setRunId(null);

    if (errText) {
      setErr(errText);
      if (acc.length > 0 && onRunSuccess) onRunSuccess();
    } else {
      const head = cancelled
        ? `Đã dừng truy vấn`
        : (n > 1 ? `Thực thi thành công ${n} câu lệnh` : 'Thực thi thành công');
      const parts: string[] = [`${totalRows.toLocaleString('vi-VN')} dòng`];
      if (affectedTotal > 0) parts.push(`${affectedTotal.toLocaleString('vi-VN')} dòng bị ảnh hưởng`);
      setStat(`${head} — ${parts.join(', ')} (${timeInfo}).`);
      if (onRunSuccess) onRunSuccess();
    }
  };

  const handleExplain = async (paneId: 1 | 2 = focusedEditor, variant: 'explain' | 'analyze' | 'json' = 'explain') => {
    const editorInstance = paneId === 1 ? editorRef.current : editorRef2.current;
    const textToRun = editorInstance ? getCurrentStatement(editorInstance) : (paneId === 1 ? sql : sql2);
    if (!textToRun.trim()) return;

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
        const err = res.error || 'Không thể lấy kế hoạch EXPLAIN';
        if (isPane1) setErrorMsg(err);
        else setErrorMsg2(err);
      }
    } catch (e: any) {
      const err = `Lỗi EXPLAIN: ${e.message || e}`;
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

  const getCurrentStatement = (editor: any): string => {
    if (!editor) return '';
    const model = editor.getModel();
    const text = model.getValue();
    const offset = model.getOffsetAt(editor.getPosition());
    const before = text.lastIndexOf(';', offset - 1);
    const after = text.indexOf(';', offset);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after;
    return text.slice(start, end).trim();
  };

  const getPaneEditor = (paneId: 1 | 2 = focusedEditor) => {
    return paneId === 2 ? editorRef2.current : editorRef.current;
  };

  const getPaneSql = (paneId: 1 | 2 = focusedEditor) => {
    return paneId === 2 ? sql2 : sql;
  };

  const handleRun = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const selection = editor.getSelection();
    const selectedText = selection ? editor.getModel().getValueInRange(selection) : '';
    const textToRun = selectedText.trim() ? selectedText : getCurrentStatement(editor);
    executeSql(textToRun, paneId);
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
      setMsg('Không có câu lệnh để lưu.');
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    const name = `Yêu thích ${new Date().toLocaleString('vi-VN')}`;
    const savedStr = localStorage.getItem('sql_saved_queries') || '[]';
    let saved: any[] = [];
    try { saved = JSON.parse(savedStr); } catch { saved = []; }
    const entry = { id: Date.now().toString(), name, sql: val, timestamp: new Date().toISOString() };
    const updated = [entry, ...saved];
    localStorage.setItem('sql_saved_queries', JSON.stringify(updated));
    setSavedQueries(updated);
    setMsg(`Đã thêm vào Yêu thích: "${name}".`);
    setTimeout(() => setMsg(null), 3000);
  };

  const handleBeautify = (paneId: 1 | 2 = focusedEditor) => {
    const editor = getPaneEditor(paneId);
    if (!editor) return;
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const selectedText = editor.getModel()?.getValueInRange(selection) || '';
      const formatted = formatSql(selectedText);
      editor.executeEdits('format-beautify', [{
        range: selection,
        text: formatted,
        forceMoveMarkers: true
      }]);
      setMsg("Đã làm đẹp (Beautify) đoạn SQL được chọn.");
    } else {
      const val = editor.getValue();
      const formatted = formatSql(val);
      editor.setValue(formatted);
      if (paneId === 1) { setSql(formatted); onSqlChange?.(formatted); }
      else { setSql2(formatted); onSql2Change?.(formatted); }
      setMsg("Đã làm đẹp (Beautify) toàn bộ câu lệnh SQL.");
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
      editor.executeEdits('format-minify', [{
        range: selection,
        text: minified,
        forceMoveMarkers: true
      }]);
      setMsg("Đã nén (Minify/Uglify) đoạn SQL được chọn thành 1 dòng.");
    } else {
      const val = editor.getValue();
      const minified = minifySql(val);
      editor.setValue(minified);
      if (paneId === 1) { setSql(minified); onSqlChange?.(minified); }
      else { setSql2(minified); onSql2Change?.(minified); }
      setMsg("Đã nén (Minify/Uglify) toàn bộ câu lệnh SQL thành 1 dòng.");
    }
    setTimeout(() => setMsg(null), 3000);
  };

  const handleCopySql = (paneId: 1 | 2 = focusedEditor) => {
    const val = getPaneSql(paneId);
    const setMsg = paneId === 1 ? setStatusMsg : setStatusMsg2;
    if (val) {
      navigator.clipboard.writeText(val);
      setMsg("Đã sao chép câu lệnh SQL vào bộ nhớ tạm.");
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
        setMsg("Đã dán câu lệnh SQL từ bộ nhớ tạm.");
        setTimeout(() => setMsg(null), 3000);
      }
    } catch {
      setMsg("Không thể đọc bộ nhớ tạm. Hãy dùng Ctrl+V.");
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
          title="Kéo rê lên/xuống để chỉnh độ cao Editor"
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
              title="Kéo rê để chỉnh độ cao Editor"
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
                title="Chạy câu hiện tại (Ctrl+Enter)"
              >
                <Play size={11} fill="#fff" />
                <span>Chạy</span>
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
                style={{ padding: '0 5px', display: 'flex', alignItems: 'center', borderLeft: '1px solid rgba(255,255,255,0.3)' }}
                title="Tùy chọn chạy"
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
                      <span>Chạy câu hiện tại</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Enter</kbd>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); runAll(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-warn)' }} />
                      <span>Chạy tất cả câu lệnh</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+Enter</kbd>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <div style={{ padding: '4px 12px 2px 12px', fontSize: '10px', fontWeight: 700, color: 'var(--win-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Phân tích Kế hoạch (EXPLAIN)
                    </div>

                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'explain'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Network size={13} style={{ flexShrink: 0, color: 'var(--win-accent)' }} />
                      <span>EXPLAIN (Ước tính)</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '12px', fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Alt+E</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'analyze'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Zap size={13} style={{ flexShrink: 0, color: 'var(--st-ok)' }} />
                      <span>EXPLAIN ANALYZE (Thực tế)</span>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setRunMenuPane(null); handleExplain(paneId, 'json'); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <FileText size={13} style={{ flexShrink: 0 }} />
                      <span>EXPLAIN FORMAT=JSON</span>
                    </button>

                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleQuickFavorite(paneId); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Star size={13} style={{ flexShrink: 0 }} />
                      <span>Thêm vào Yêu thích</span>
                    </button>
                    <button className="context-menu-item" onClick={() => { setRunMenuPane(null); handleSaveQuery(); }} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}>
                      <Bookmark size={13} style={{ flexShrink: 0 }} />
                      <span>Lưu câu lệnh...</span>
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
                title="Dừng truy vấn đang chạy"
              >
                <X size={12} />
                <span>Dừng</span>
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
                title="Tùy chọn Định dạng / Làm đẹp / Nén 1 dòng SQL"
              >
                <AlignLeft size={11} />
                <span>Định dạng</span>
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
                      <span>Làm đẹp (Beautify SQL)</span>
                      <kbd style={{ marginLeft: 'auto', paddingLeft: '16px', flexShrink: 0, fontSize: '10.5px', color: 'var(--win-text-disabled)', fontFamily: 'inherit' }}>Ctrl+Shift+F</kbd>
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => { setFormatMenuPane(null); handleMinify(paneId); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px' }}
                    >
                      <Rows size={13} style={{ flexShrink: 0 }} />
                      <span>Nén 1 dòng (Minify / Uglify)</span>
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
                title="Thao tác khác"
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
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleCopySql(paneId); }}><Copy size={12} /> Sao chép SQL</button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handlePasteSql(paneId); }}><Clipboard size={12} /> Dán SQL</button>
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); handleClear(paneId); }}><Trash2 size={12} /> Xóa sạch</button>
                    <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />
                    <button className="context-menu-item" onClick={() => { setMoreMenuPane(null); setShowQueryParamsConfigModal(true); }}><Settings size={12} /> Tùy chọn Param...</button>
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
              title={queryParamsConfig.enabled ? 'Tham số truy vấn: Đang Bật' : 'Cấu hình Tham số Truy vấn (Query Params Options)'}
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
                      <span>Không chia (Đơn)</span>
                    </button>
                    <button 
                      className={`context-menu-item ${splitMode === 'vertical' ? 'active' : ''}`}
                      onClick={() => { setSplitMode('vertical'); onSplitModeChange?.('vertical'); setSplitMenuPane(null); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                    >
                      <Columns size={13} style={{ flexShrink: 0 }} />
                      <span>Chia dọc (Left / Right)</span>
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
              title="Lịch sử & câu lệnh đã lưu"
            >
              <History size={11} />
              <span>Lịch sử</span>
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
      successMsg = "Đã sao chép kết quả dạng bảng (TSV).";
    } else if (format === 'object') {
      textToCopy = JSON.stringify(curResults, null, 2);
      successMsg = "Đã sao chép kết quả dạng JSON Object.";
    } else if (format === 'array') {
      let arrayData;
      if (curColumns.length === 1) {
        const singleCol = curColumns[0];
        arrayData = curResults.map(row => row[singleCol]);
      } else {
        arrayData = curResults.map(row => curColumns.map(col => row[col]));
      }
      textToCopy = JSON.stringify(arrayData, null, 2);
      successMsg = `Đã sao chép kết quả dạng JSON Array (${curColumns.length === 1 ? 'mảng 1 chiều' : 'mảng 2 chiều'}).`;
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
      setStatusMsg("Đã tải xuống file CSV kết quả Khung 1.");
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2("Đã tải xuống file CSV kết quả Khung 2.");
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
      setStatusMsg("Đã tải xuống file JSON kết quả Khung 1.");
      setTimeout(() => setStatusMsg(null), 3000);
    } else {
      setStatusMsg2("Đã tải xuống file JSON kết quả Khung 2.");
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
                  ? ` ✓${Number(resItem.affected).toLocaleString('vi-VN')}`
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
                Kết quả
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
              <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)', marginRight: '2px' }}>Xuất:</span>
              <div style={{ position: 'relative', display: 'inline-block', zIndex: 1000 }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => pSetShowCopyDropdown(!pShowCopyDropdown)}
                  style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '3px' }}
                  title="Sao chép kết quả dưới nhiều định dạng"
                >
                  <span>Sao chép</span>
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
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('table', paneId); pSetShowCopyDropdown(false); }}>Sao chép dạng Bảng (TSV)</button>
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('object', paneId); pSetShowCopyDropdown(false); }}>Sao chép dạng JSON Object</button>
                      <button className="copy-dropdown-item" onClick={() => { handleCopyAs('array', paneId); pSetShowCopyDropdown(false); }}>Sao chép dạng JSON Array</button>
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
            <ExplainViewer explainResult={pExplainResult} />
          ) : (
            <>
              {pErrorMsg && (
                <div style={{ padding: '16px', color: 'var(--st-danger)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontWeight: 600 }}>
                    <AlertTriangle size={16} />
                    <span>LỖI TRUY VẤN SQL</span>
                  </div>
                  {pErrorMsg}
                </div>
              )}

              {!pErrorMsg && pResults.length === 0 && pColumns.length === 0 && (
                <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                  {pLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--win-text-secondary)' }}>
                      <LoadingSpinner size={14} />
                      <span>Đang chạy truy vấn...</span>
                    </div>
                  ) : pHasRun ? (
                    activeResult && activeResult.affected !== undefined && activeResult.affected !== null
                      ? `Thực thi thành công — ${Number(activeResult.affected).toLocaleString('vi-VN')} dòng bị ảnh hưởng.`
                      : 'Truy vấn đã thực thi thành công nhưng không trả về dữ liệu (0 dòng).'
                  ) : (
                    'Nhấn nút "Chạy" để xem kết quả truy vấn tại đây.'
                  )}
                </div>
              )}

              {!pErrorMsg && (pResults.length > 0 || pColumns.length > 0) && (
                <div className="grid-table-container" style={{ height: '100%' }}>
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th style={{ width: '36px', textAlign: 'center' }}>#</th>
                        {pColumns.map(col => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pResults.slice((pPage - 1) * pPageSize, pPage * pPageSize).map((row, index) => (
                        <tr key={index}>
                          <td style={{ textAlign: 'center', color: 'var(--win-text-secondary)', background: 'rgba(0,0,0,0.1)' }}>
                            {(pPage - 1) * pPageSize + index + 1}
                          </td>
                          {pColumns.map(col => {
                            const cellVal = row[col];
                            return (
                              <td key={col}>
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
              Hiển thị <b>{(pPage - 1) * pPageSize + 1}</b> - <b>{Math.min(pPage * pPageSize, pResults.length)}</b> trên <b>{pResults.length}</b> dòng
            </div>
            <div className="pagination-controls">
              <span style={{ marginRight: '6px' }}>
                Dòng:{' '}
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

              <button className="pagination-btn" onClick={() => pSetPage(1)} disabled={pPage === 1} title="Trang đầu">
                <ChevronsLeft size={14} />
              </button>
              <button className="pagination-btn" onClick={() => pSetPage(p => Math.max(p - 1, 1))} disabled={pPage === 1} title="Trang trước">
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

              <button className="pagination-btn" onClick={() => pSetPage(p => Math.min(p + 1, totalPagesNum))} disabled={pPage >= totalPagesNum} title="Trang sau">
                <ChevronRight size={14} />
              </button>
              <button className="pagination-btn" onClick={() => pSetPage(totalPagesNum)} disabled={pPage >= totalPagesNum} title="Trang cuối">
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
                      | Khung {paneId}: {activeResult.affectedRows > 0 ? `Ảnh hưởng ${activeResult.affectedRows} dòng` : `Lấy ${activeResult.data?.length || 0} dòng`}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <span>Khung {paneId} - Sẵn sàng.</span>
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
              theme={theme === 'light' ? 'vs' : 'vs-dark'}
              defaultValue={initialSql}
              onChange={(val) => { setSql(val || ''); onSqlChange?.(val || ''); }}
              onMount={(editor) => handleEditorDidMount(editor, 1)}
              loading={
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                  Đang tải trình viết SQL...
                </div>
              }
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "Consolas, 'Courier New', monospace",
                lineNumbers: 'on',
                automaticLayout: true,
                tabSize: 2,
                wordBasedSuggestions: 'off',
                renderLineHighlight: 'none',
                scrollbar: {
                  verticalScrollbarSize: 8,
                  horizontalScrollbarSize: 8,
                },
              }}
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
            title="Kéo rê để thay đổi kích thước 2 khung"
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
                title="Đóng khung 2 (Single Pane)"
              >
                <X size={12} />
              </button>
              <Editor
                height="100%"
                language={langId}
                theme={theme === 'light' ? 'vs' : 'vs-dark'}
                defaultValue={initialSql2}
                onChange={(val) => { setSql2(val || ''); onSql2Change?.(val || ''); }}
                onMount={(editor) => handleEditorDidMount(editor, 2)}
                loading={
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    Đang tải trình viết SQL...
                  </div>
                }
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
                  fontLigatures: true,
                  lineNumbers: 'on',
                  automaticLayout: true,
                  tabSize: 2,
                  wordBasedSuggestions: 'off',
                  renderLineHighlight: 'none',
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
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
                <span>Bảng truy vấn</span>
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
                Lịch sử ({historyList.length})
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
                Đã lưu ({savedQueries.length})
              </button>
            </div>
          </div>
          <div className="sql-history-search">
            <input 
              type="text" 
              className="sql-history-search-input" 
              placeholder={historyTab === 'history' ? "Tìm lịch sử..." : "Tìm câu lệnh đã lưu..."}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>
          <div className="sql-history-list">
            {historyTab === 'history' ? (
              Object.keys(getFilteredHistory()).length === 0 ? (
                <div className="sql-history-empty">
                  Không tìm thấy lịch sử truy vấn nào.
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
                        const timeStr = new Date(item.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div 
                            key={item.id} 
                            className="sql-history-item"
                            onClick={() => handleSelectHistoryItem(item.sql)}
                            title="Click để nạp câu lệnh này vào trình soạn thảo"
                          >
                            <div className="sql-history-item-meta">
                              <span>{timeStr}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span 
                                  style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(item.sql);
                                    setStatusMsg("Đã sao chép câu lệnh SQL!");
                                    setTimeout(() => setStatusMsg(null), 2500);
                                  }}
                                  title="Sao chép câu lệnh SQL vào bộ nhớ tạm"
                                >
                                  <Copy size={11} /> Sao chép
                                </span>
                                <span 
                                  style={{ cursor: 'pointer', color: 'var(--st-danger)', display: 'flex', alignItems: 'center', gap: '2px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (confirm("Xóa câu lệnh này khỏi lịch sử?")) {
                                      const updated = historyList.filter(h => h.id !== item.id);
                                      setHistoryList(updated);
                                      localStorage.setItem('sql_query_history', JSON.stringify(updated));
                                    }
                                  }}
                                  title="Xóa bản ghi lịch sử này"
                                >
                                  Xóa
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
                  Chưa có câu lệnh nào được lưu.
                </div>
              ) : (
                getFilteredSaved().map(item => {
                  const dateStr = new Date(item.timestamp).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
                  return (
                    <div 
                      key={item.id} 
                      className="sql-history-item"
                      onClick={() => handleSelectHistoryItem(item.sql)}
                      style={{ borderLeft: '3px solid var(--win-accent)', paddingLeft: '8px' }}
                      title="Click để nạp câu lệnh này"
                    >
                      <div className="sql-history-item-meta">
                        <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>{item.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span>{dateStr}</span>
                          <span 
                            style={{ cursor: 'pointer', color: 'var(--win-accent)', display: 'flex', alignItems: 'center', gap: '2px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.sql);
                              setStatusMsg("Đã sao chép câu lệnh SQL!");
                              setTimeout(() => setStatusMsg(null), 2500);
                            }}
                            title="Sao chép câu lệnh SQL"
                          >
                            <Copy size={11} /> Sao chép
                          </span>
                          <span 
                            style={{ cursor: 'pointer', color: 'var(--st-danger)' }}
                            onClick={(e) => handleDeleteSaved(item.id, e)}
                            title="Xóa câu lệnh đã lưu này"
                          >
                            Xóa
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
          {historyTab === 'history' && historyList.length > 0 && (
            <div style={{ padding: '8px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', background: 'rgba(0, 0, 0, 0.02)' }}>
              <button 
                className="btn btn-secondary" 
                onClick={handleClearHistory}
                style={{ width: '100%' }}
              >
                Xóa tất cả lịch sử
              </button>
            </div>
          )}
        </div>
      )}

      {showSaveModal && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.6)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(3px)'
        }}>
          <div style={{
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '6px',
            padding: '16px',
            width: '320px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <h3 style={{ fontSize: '13px', margin: 0, fontWeight: 600, color: 'var(--win-text-primary)' }}>LƯU CÂU LỆNH SQL</h3>
            <div>
              <label style={{ fontSize: '11px', display: 'block', marginBottom: '6px', color: 'var(--win-text-secondary)' }}>
                Tên gợi nhớ của câu lệnh:
              </label>
              <input 
                type="text" 
                className="form-input" 
                value={newQueryName}
                onChange={(e) => setNewQueryName(e.target.value)}
                placeholder="Nhập tên câu lệnh..."
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
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => {
                  setShowSaveModal(false);
                  setNewQueryName('');
                }}
                style={{ padding: '4px 12px' }}
              >
                Hủy
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleConfirmSaveQuery}
                style={{ padding: '4px 12px' }}
              >
                Lưu lại
              </button>
            </div>
          </div>
        </div>
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
    </div>
  );
};
