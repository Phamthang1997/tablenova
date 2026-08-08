import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { dbHelper } from '../utils/dbHelper';
import type { TableItem, ColumnInfo } from '../utils/dbHelper';
import { Search, Table, Terminal, TerminalSquare, RefreshCw, Layers, Plus, ChevronDown, ChevronRight, Braces, Cog, Info, Key, Sliders, FileCode, Trash2, CheckCircle2, Copy, AlertTriangle, History, Bookmark } from 'lucide-react';
import { CreateTableModal } from './CreateTableModal';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { GitCompare, ArrowLeftRight, HardDriveDownload, HardDriveUpload, Wand2 } from 'lucide-react';
import { RoutineEditorModal } from './RoutineEditorModal';
import { ViewEditorModal } from './ViewEditorModal';
import { SequenceManagerModal } from './SequenceManagerModal';
import { CreateRoutineModal } from './CreateRoutineModal';
import { loadHistory, loadSavedQueries, deleteHistoryEntry, deleteSavedQuery, HISTORY_CHANGED_EVENT } from '../utils/queryHistory';
import type { HistoryEntry, SavedQueryEntry } from '../utils/queryHistory';

// Sidebar width: draggable and remembered across sessions. One value for the whole
// app (not per connection) — same `tf_*` convention as tf_lang / tf_history_scope.
const SIDEBAR_WIDTH_KEY = 'tf_sidebar_width';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 240;

const readStoredWidth = (): number => {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw));
};

const removeAccents = (str: string) =>
  str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/**
 * Search matcher. Substring by default (accent- and case-insensitive), plus the
 * two TablePlus anchors: `^abc` starts-with, `abc$` ends-with, `^abc$` exact.
 *
 * Deliberately NOT full regex: the box filters on every keystroke, and a
 * half-typed pattern like `foo(` throws — the user would see the list blank out
 * mid-word. Two anchors cover the case that actually hurts (`user` matching a
 * dozen tables when only `users` was wanted) and can never be invalid.
 */
const buildMatcher = (term: string): ((name: string) => boolean) => {
  const raw = removeAccents(term.trim());
  const anchorStart = raw.startsWith('^');
  // `$` alone is a literal, not an anchor — otherwise typing `^` then `$` matches all.
  const anchorEnd = raw.length > 1 && raw.endsWith('$');
  const core = raw.slice(anchorStart ? 1 : 0, anchorEnd ? -1 : undefined);
  if (!core) return () => true;
  return (name: string) => {
    const n = removeAccents(name);
    if (anchorStart && anchorEnd) return n === core;
    if (anchorStart) return n.startsWith(core);
    if (anchorEnd) return n.endsWith(core);
    return n.includes(core);
  };
};

/**
 * Split a name so the END survives truncation: `order_line_item_2023` and
 * `order_line_item_2024` are indistinguishable when only the head is kept.
 * Short names get an empty tail and render exactly as before.
 */
const MIDDLE_ELLIPSIS_MIN_LENGTH = 14;
const MIDDLE_ELLIPSIS_MAX_TAIL = 8;
// Not exported: `react/only-export-components` is an oxlint error, and this file
// already exports the Sidebar component.
const splitObjectName = (name: string): [string, string] => {
  if (name.length < MIDDLE_ELLIPSIS_MIN_LENGTH) return [name, ''];
  const tailLen = Math.min(MIDDLE_ELLIPSIS_MAX_TAIL, Math.floor(name.length / 3));
  return [name.slice(0, name.length - tailLen), name.slice(name.length - tailLen)];
};

/** Object name with middle truncation — the head shrinks and gets the ellipsis. */
const ObjectName: React.FC<{ name: string }> = ({ name }) => {
  const [head, tail] = splitObjectName(name);
  return (
    <span className="sb-name">
      <span className="sb-name-head">{head}</span>
      {tail && <span className="sb-name-tail">{tail}</span>}
    </span>
  );
};

/**
 * Style của một dòng đối tượng.
 *
 * Khai báo ở mức module chứ không viết inline trong JSX: object inline được tạo mới
 * mỗi lần render, nên React coi prop `style` là đã đổi và ghi lại DOM cho từng dòng,
 * kể cả khi không có gì thay đổi. Chỉ hai thứ thật sự phụ thuộc trạng thái (nền/màu
 * chữ và độ đậm khi dòng đang mở) mới được tính lúc render.
 *
 * KHÔNG chuyển sang class CSS: inline style ghi đè `.workspace-container
 * .sidebar-item.active` trong index.css, nên đổi sang class sẽ đổi luôn viền và đổ
 * bóng của dòng đang chọn — nằm ngoài phạm vi thay đổi này.
 */
const ROW_WRAP_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column' };
const ROW_STYLE: React.CSSProperties = {
  borderRadius: '6px',
  margin: '1px 4px',
  padding: '4px 8px',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};
/**
 * Dòng đang chọn: nền accent NHẠT chứ không phải accent đặc.
 *
 * Chữ để `--win-text-primary`, không phải `#ffffff` cứng — cùng lý do đã ghi ở
 * `.workspace-container .sidebar-item.active` trong index.css: nền nhạt ở giao diện
 * sáng làm chữ trắng biến mất. Viền và đổ bóng vẫn do class đó lo, inline chỉ đè
 * nền và màu chữ, nên dòng đang chọn vẫn phân biệt được với dòng đang highlight
 * bằng bàn phím (`.is-highlighted` cũng dùng accent-glow nhưng không có viền).
 */
const ROW_STYLE_ACTIVE: React.CSSProperties = {
  ...ROW_STYLE,
  background: 'var(--win-accent-glow)',
  color: 'var(--win-text-primary)',
};
const CHEVRON_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '14px',
  height: '14px',
  cursor: 'pointer',
  opacity: 0.8,
};
const NAME_STYLE: React.CSSProperties = { fontWeight: 400, flex: 1, minWidth: 0 };
const NAME_STYLE_ACTIVE: React.CSSProperties = { fontWeight: 600, flex: 1, minWidth: 0 };
const COLS_WRAP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  paddingLeft: '28px',
  margin: '2px 0 4px',
};
const COLS_HINT_STYLE: React.CSSProperties = {
  fontSize: '10.5px',
  color: 'var(--win-text-disabled)',
  padding: '2px 6px',
};
const COL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '2px 6px',
  fontSize: '11.5px',
  borderRadius: '4px',
  color: 'var(--win-text-primary)',
};
const COL_LEFT_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  flex: 1,
};
const COL_KEY_SLOT_STYLE: React.CSSProperties = {
  width: '12px',
  display: 'inline-flex',
  justifyContent: 'center',
  flexShrink: 0,
};
const COL_KEY_ICON_STYLE: React.CSSProperties = { flexShrink: 0 };
const COL_KEY_SPACER_STYLE: React.CSSProperties = { width: '11px' };
const COL_NAME_STYLE: React.CSSProperties = {
  fontFamily: 'var(--win-font-mono)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const COL_TYPE_STYLE: React.CSSProperties = {
  fontFamily: 'var(--win-font-mono)',
  fontSize: '10.5px',
  color: 'var(--win-text-disabled)',
  marginLeft: '8px',
  flexShrink: 0,
};

/**
 * Bốn tab phân đoạn ở đầu thanh bên. Bảng hằng giữ KEY dịch, không giữ chuỗi đã dịch:
 * ở mức module thì không gọi được hook, và `t()` phải nhận key literal (i18next.d.ts
 * kiểm tra kiểu ở từng call site) nên `as const` là bắt buộc.
 */
const SEG_TABS = [
  ['items', 'sidebar.tabItems'],
  ['queries', 'sidebar.tabQueries'],
  ['history', 'sidebar.tabHistory'],
  ['tools', 'sidebar.tabTools'],
] as const;

interface ObjectItemProps {
  item: TableItem;
  isHighlighted: boolean;
  isActive: boolean;
  isExpanded: boolean;
  /** undefined = chưa mở hoặc chưa nạp xong. Không truyền `[]` mặc định: một mảng
   *  rỗng mới mỗi lần render sẽ phá memo của MỌI dòng đang đóng. */
  columns: ColumnInfo[] | undefined;
  isLoadingCols: boolean;
  highlightRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, name: string) => void;
  onToggleExpand: (name: string, isExpanded: boolean, e: React.MouseEvent) => void;
  onRequestDrop: (item: TableItem) => void;
}

/**
 * Một dòng bảng/view trong danh sách bên trái.
 *
 * memo hóa vì danh sách vẽ lại toàn bộ sau mỗi ký tự gõ vào ô tìm kiếm và sau mỗi
 * lần mở/đóng một bảng. Để memo có tác dụng, MỌI callback truyền vào đây phải giữ
 * nguyên identity — xem các useCallback trong Sidebar.
 */
const ObjectItem = memo(function ObjectItem({
  item,
  isHighlighted,
  isActive,
  isExpanded,
  columns,
  isLoadingCols,
  highlightRef,
  onSelect,
  onContextMenu,
  onToggleExpand,
  onRequestDrop,
}: ObjectItemProps) {
  // useTranslation ngay trong dòng thay vì nhận `t` qua prop: kiểu trả về của `t` không
  // gán được vào `string` khi đi qua prop, mà ép kiểu thì mất luôn kiểm tra key của
  // i18next.d.ts. Hook cũng tự lo việc vẽ lại khi đổi ngôn ngữ.
  const { t } = useTranslation();
  const isView = item.type === 'view';

  return (
    <div style={ROW_WRAP_STYLE}>
      <div
        ref={isHighlighted ? highlightRef : undefined}
        className={`sidebar-item ${isActive ? 'active' : ''}${isHighlighted ? ' is-highlighted' : ''}`}
        tabIndex={0}
        onClick={() => onSelect(item.name)}
        onContextMenu={(e) => onContextMenu(e, item.name)}
        onKeyDown={(e) => {
          if (e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            onRequestDrop(item);
          }
        }}
        title={t('sidebar.tableItemHint', { name: item.name })}
        style={isActive ? ROW_STYLE_ACTIVE : ROW_STYLE}
      >
        {!isView && (
          <span onClick={(e) => onToggleExpand(item.name, isExpanded, e)} style={CHEVRON_STYLE}>
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}

        {/* Không ép màu icon nữa: `#ffffff` cứng sẽ tàng hình trên nền nhạt. index.css
            đã có sẵn màu icon riêng cho trạng thái active theo từng theme. */}
        {isView ? (
          <Layers size={14} className="icon-view" />
        ) : (
          <Table size={14} className="icon-table" />
        )}

        <span style={isActive ? NAME_STYLE_ACTIVE : NAME_STYLE}>
          <ObjectName name={item.name} />
        </span>
      </div>

      {isExpanded && !isView && (
        <div style={COLS_WRAP_STYLE}>
          {isLoadingCols ? (
            <div style={COLS_HINT_STYLE}>{t('sidebar.loadingColumns')}</div>
          ) : !columns || columns.length === 0 ? (
            <div style={COLS_HINT_STYLE}>{t('sidebar.noColumns')}</div>
          ) : (
            columns.map((col) => (
              <div
                key={col.name}
                style={COL_ROW_STYLE}
                title={`${col.name} (${col.type}) ${col.isPrimaryKey ? '[PK]' : ''}`}
              >
                <div style={COL_LEFT_STYLE}>
                  <span style={COL_KEY_SLOT_STYLE}>
                    {col.isPrimaryKey ? (
                      <Key size={11} color="#f59e0b" style={COL_KEY_ICON_STYLE} />
                    ) : (
                      <span style={COL_KEY_SPACER_STYLE} />
                    )}
                  </span>
                  <span style={COL_NAME_STYLE}>{col.name}</span>
                </div>

                <span style={COL_TYPE_STYLE}>{col.type}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});

interface SidebarProps {
  dbName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  /** Chế độ chỉ đọc: chặn mọi lệnh ghi phát sinh từ sidebar (drop/truncate/rename/create). */
  readOnly?: boolean;
  onSelectTable: (name: string, viewMode?: 'data' | 'structure') => void;
  onNewQuery: () => void;
  onOpenTerminal: () => void;
  terminalConfig?: import('../utils/dbHelper').DbConnectionConfig;
  onDisconnect: () => void;
  activeTable: string | null;
  onImportToTable: (tableName: string) => void;
  onExportTable: (tableName: string) => void;
  onExportDatabase: () => void;
  onImportDatabase: () => void;
  /** Nhập tệp CSV/JSON/XLSX vào một bảng MỚI (khác onImportDatabase là phục hồi cả dump). */
  onImportNewTable?: () => void;
  onOpenDbInfo?: () => void;
  onOpenAllDbStats?: () => void;
  onSchemaMigration?: () => void;
  onCompareDatabases?: () => void;
  /** Mở Data Generator. Có tên bảng = mở sẵn với bảng đó (từ menu ngữ cảnh của bảng). */
  onGenerateData?: (tableName?: string) => void;
  onTableRenamed?: (oldName: string, newName: string) => void;
  onTableDropped?: (tableName: string) => void;
  onDatabaseChanged?: (name: string) => void;
  onOpenQueryWithSql?: (sql: string) => void;
  onOpenRoutineTab?: (name: string, kind: 'procedure' | 'function') => void;
  onOpenViewTab?: (name: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  dbName,
  dbType,
  readOnly = false,
  onSelectTable,
  onNewQuery,
  onOpenTerminal,
  terminalConfig: _terminalConfig,
  onDisconnect: _onDisconnect,
  activeTable,
  onImportToTable,
  onExportTable,
  onExportDatabase,
  onImportDatabase,
  onImportNewTable,
  onOpenDbInfo,
  onOpenAllDbStats: _onOpenAllDbStats,
  onSchemaMigration,
  onCompareDatabases,
  onGenerateData,
  onTableRenamed,
  onTableDropped,
  onDatabaseChanged,
  onOpenQueryWithSql,
  onOpenRoutineTab,
  onOpenViewTab,
}) => {
  const { t } = useTranslation();

  // Chặn thao tác ghi khi bật Chỉ đọc. Gọi ở NGAY điểm bấm (trước khi mở hộp xác nhận) để người
  // dùng không phải đi hết luồng xác nhận rồi mới bị từ chối, và lặp lại ở các hàm run*/handle*
  // thực thi lệnh để không có đường nào lọt. Dùng alert() cho khớp với phần còn lại của file.
  const blockedByReadOnly = (): boolean => {
    if (!readOnly) return false;
    alert(t('sidebar.errReadOnly'));
    return true;
  };

  const [tables, setTables] = useState<TableItem[]>([]);
  const [functions, setFunctions] = useState<string[]>([]);
  const [procedures, setProcedures] = useState<string[]>([]);
  const [objDef, setObjDef] = useState<{ name: string; kind: 'view' | 'function' | 'procedure'; sql: string } | null>(null);
  const [showSequencesModal, setShowSequencesModal] = useState<boolean>(false);
  const [showCreateRoutine, setShowCreateRoutine] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Top 4-tab segmented control (Items | Queries | History | Tools)
  const [activeTab, setActiveTab] = useState<'items' | 'queries' | 'history' | 'tools'>('items');
  const [savedQueriesList, setSavedQueriesList] = useState<SavedQueryEntry[]>([]);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);
  const [historyScope, setHistoryScope] = useState<'database' | 'connection' | 'all'>('database');
  const [historySubTab, setHistorySubTab] = useState<'history' | 'saved'>('history');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopySql = (e: React.MouseEvent, id: string, sql: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sql);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  useEffect(() => {
    const refreshHistoryQueries = () => {
      setSavedQueriesList(loadSavedQueries());
      setHistoryList(loadHistory());
    };
    refreshHistoryQueries();
    window.addEventListener(HISTORY_CHANGED_EVENT, refreshHistoryQueries);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, refreshHistoryQueries);
  }, []);

  const getGroupedHistory = () => {
    const list = historyList.filter(entry => {
      if (historyScope === 'database' && dbName && entry.db && entry.db !== dbName) return false;
      if (searchTerm) {
        return entry.sql.toLowerCase().includes(searchTerm.toLowerCase());
      }
      return true;
    });

    const groups: Record<string, HistoryEntry[]> = {};
    for (const item of list) {
      const dateStr = new Date(item.timestamp).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      if (!groups[dateStr]) groups[dateStr] = [];
      groups[dateStr].push(item);
    }
    return groups;
  };
  // View/hàm/thủ tục mặc định THU GỌN: phần lớn thời gian người dùng làm việc với danh sách
  // bảng, ba nhóm này chỉ mở khi cần (đang gõ tìm kiếm thì vẫn tự mở, xem isOpen()).
  const [collapsed, setCollapsed] = useState<{ tables: boolean; views: boolean; functions: boolean; procedures: boolean }>({ tables: false, views: true, functions: true, procedures: true });
  const inputRef = useRef<HTMLInputElement>(null);

  // Table column tree view state (expand/collapse table to see columns)
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [tableColumnsMap, setTableColumnsMap] = useState<Record<string, ColumnInfo[]>>({});
  const [loadingColumns, setLoadingColumns] = useState<Record<string, boolean>>({});

  // Hai map này chỉ được ĐỌC để quyết định có gọi backend hay không. Đọc qua ref nên
  // toggleTableExpanded giữ nguyên identity; nếu để chúng trong deps thì mỗi lần mở một
  // bảng là callback đổi -> mọi dòng re-render và React.memo ở ObjectItem thành vô nghĩa.
  const columnsMapRef = useRef(tableColumnsMap);
  columnsMapRef.current = tableColumnsMap;
  const loadingColumnsRef = useRef(loadingColumns);
  loadingColumnsRef.current = loadingColumns;

  // isExpanded do chính dòng đó truyền vào, nên không cần đọc expandedTables ở đây.
  const toggleTableExpanded = useCallback(async (tableName: string, isExpanded: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    const willExpand = !isExpanded;
    setExpandedTables(prev => ({ ...prev, [tableName]: willExpand }));

    if (willExpand && !columnsMapRef.current[tableName] && !loadingColumnsRef.current[tableName]) {
      setLoadingColumns(prev => ({ ...prev, [tableName]: true }));
      try {
        const schema = await dbHelper.getTableSchema(tableName);
        setTableColumnsMap(prev => ({ ...prev, [tableName]: schema.columns || [] }));
      } catch (err) {
        console.error(`Failed to fetch schema for ${tableName}:`, err);
      } finally {
        setLoadingColumns(prev => ({ ...prev, [tableName]: false }));
      }
    }
  }, []);

  // Kéo viền phải để đổi độ rộng thanh bên.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);

  // Nghe trên window (không phải trên tay nắm) để con trỏ chạy ra ngoài thanh bên
  // vẫn kéo tiếp được; tắt userSelect để không bôi đen chữ trong lúc kéo.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const left = rootRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX - left)));
    };
    const onUp = () => setResizing(false);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  // Ghi khi thả chuột, không ghi trong lúc kéo (mỗi mousemove một lần ghi localStorage).
  useEffect(() => {
    if (resizing) return;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [resizing, width]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tableName: string;
  } | null>(null);

  // Vị trí menu chuột phải sau khi đo kích thước thật (tránh tràn khỏi cửa sổ)
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos(clampMenu(contextMenu.x, contextMenu.y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [contextMenu]);

  const [renameState, setRenameState] = useState<{ tableName: string; value: string } | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // Menu "+" ở tiêu đề Danh sách bảng và hộp thoại tạo view
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showCreateView, setShowCreateView] = useState(false);
  const [newView, setNewView] = useState({ name: '', sql: '' });
  const [creatingView, setCreatingView] = useState(false);
  const [createViewError, setCreateViewError] = useState<string | null>(null);
  // Truncate Table & Drop Table Modals (matching Images 1 & 2)
  const [truncateModal, setTruncateModal] = useState<{
    tableName: string;
    restartIdentity: boolean;
    disableFkCheck: boolean;
    cascade: boolean;
  } | null>(null);

  const [dropModal, setDropModal] = useState<{
    tableName: string;
    isView: boolean;
    ignoreFkCheck: boolean;
    cascade: boolean;
  } | null>(null);

  // Database state
  const [_dbList, setDbList] = useState<string[]>([]);
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [newDb, setNewDb] = useState({ name: '', encoding: '', collation: '' });
  const [dbCharsets, _setDbCharsets] = useState<{ encodings: string[]; collations?: string[]; collationsByEncoding?: Record<string, string[]> }>({ encodings: [] });
  const [renameDbState, setRenameDbState] = useState<{ oldName: string; value: string } | null>(null);


  const handleRenameDatabase = async () => {
    if (!renameDbState) return;
    if (blockedByReadOnly()) return;
    const { oldName, value } = renameDbState;
    const newName = value.trim();
    if (!newName || newName === oldName) { setRenameDbState(null); return; }
    const res = await dbHelper.renameDatabase(oldName, newName);
    setRenameDbState(null);
    if (res.success) {
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
    } else {
      alert(t('sidebar.errRenameDb', { message: res.error }));
    }
  };

  const handleCreateDatabase = async () => {
    if (blockedByReadOnly()) return;
    const name = newDb.name.trim();
    if (!name) { alert(t('sidebar.promptDbName')); return; }
    const res = await dbHelper.createDatabase({
      name,
      encoding: newDb.encoding.trim() || undefined,
      collation: newDb.collation.trim() || undefined,
    });
    if (res.success) {
      setShowCreateDb(false);
      setNewDb({ name: '', encoding: '', collation: '' });
      if (confirm(t('sidebar.createdDbSwitch', { name }))) {
        await dbHelper.switchDatabase(name);
        onDatabaseChanged?.(name);
      }
    } else {
      alert(t('sidebar.errCreateDb', { message: res.error }));
    }
  };

  const fetchTables = async () => {
    setRefreshing(true);
    const list = await dbHelper.getTables();
    setTables(list);
    // Nạp thêm hàm & thủ tục (đối tượng CSDL)
    const objs = await dbHelper.getDatabaseObjects();
    setFunctions(objs.functions || []);
    setProcedures(objs.procedures || []);
    setRefreshing(false);
  };

  const handleShowObjectDef = async (name: string, kind: 'view' | 'function' | 'procedure') => {
    if (kind === 'view' && onOpenViewTab) {
      onOpenViewTab(name);
      return;
    }
    if ((kind === 'procedure' || kind === 'function') && onOpenRoutineTab) {
      onOpenRoutineTab(name, kind);
      return;
    }
    const res = await dbHelper.getObjectDefinition(name, kind);
    if (res.success && res.sql) {
      setObjDef({ name, kind, sql: res.sql });
    } else {
      alert(t('sidebar.errObjectDef', { message: res.error || '' }));
    }
  };

  useEffect(() => {
    fetchTables();
  }, [dbName]);

  useEffect(() => {
    const handleGlobalRename = () => {
      fetchTables();
    };
    const handleGlobalRestore = () => {
      fetchTables();
    };
    window.addEventListener('table-renamed', handleGlobalRename);
    window.addEventListener('database-restored', handleGlobalRestore);
    return () => {
      window.removeEventListener('table-renamed', handleGlobalRename);
      window.removeEventListener('database-restored', handleGlobalRestore);
    };
  }, []);

  // Keyboard shortcut to focus search input: Ctrl+P / Cmd+P or Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const handleTableContextMenu = useCallback((e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tableName
    });
  }, []);

  // App tạo lại handleSelectTable mỗi lần render (App.tsx: hàm thường, không useCallback),
  // nên truyền thẳng xuống ObjectItem sẽ phá memo mỗi khi App render. Đọc qua ref —
  // cùng cách App.tsx đã dùng cho selectTableRef.
  const onSelectTableRef = useRef(onSelectTable);
  onSelectTableRef.current = onSelectTable;
  const handleRowSelect = useCallback((name: string) => onSelectTableRef.current(name), []);

  // blockedByReadOnly đọc prop readOnly và t nên cũng đổi identity mỗi render.
  const blockedByReadOnlyRef = useRef(blockedByReadOnly);
  blockedByReadOnlyRef.current = blockedByReadOnly;
  const handleRowRequestDrop = useCallback((item: TableItem) => {
    if (blockedByReadOnlyRef.current()) return;
    setDropModal({ tableName: item.name, isView: item.type === 'view', ignoreFkCheck: false, cascade: false });
  }, []);

  const handleRenameTable = (tableName: string) => {
    if (blockedByReadOnly()) return;
    setRenameState({ tableName, value: tableName });
  };

  const submitRename = async () => {
    if (!renameState) return;
    if (blockedByReadOnly()) return;
    const { tableName, value } = renameState;
    const newName = value.trim();
    if (!newName || newName === tableName) {
      setRenameState(null);
      return;
    }

    try {
      const res = await dbHelper.renameTable(tableName, newName);
      if (res.success) {
        alert(t('sidebar.renameTableSuccess'));
        if (onTableRenamed) onTableRenamed(tableName, newName);
        fetchTables();
      } else {
        alert(t('sidebar.errRenameTable', { message: res.error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    } finally {
      setRenameState(null);
    }
  };

  const handleCreateTable = () => {
    if (blockedByReadOnly()) return;
    setIsCreateModalOpen(true);
  };

  // Tạo view: ghép CREATE VIEW <tên> AS <câu SELECT> rồi chạy qua execute_query.
  // Định danh trích dẫn theo dialect giống các chỗ khác trong file (MySQL backtick).
  const handleCreateView = async () => {
    if (blockedByReadOnly()) return;
    const name = newView.name.trim();
    const body = newView.sql.trim().replace(/;+\s*$/, '');
    if (!name) { setCreateViewError(t('sidebar.errViewName')); return; }
    if (!body) { setCreateViewError(t('sidebar.errViewSelect')); return; }

    const q = dbType === 'mysql' ? '`' : '"';
    const quoted = `${q}${name.replace(new RegExp(q, 'g'), q + q)}${q}`;

    setCreatingView(true);
    setCreateViewError(null);
    const res = await dbHelper.executeQuery(`CREATE VIEW ${quoted} AS ${body}`);
    setCreatingView(false);

    if (res.success) {
      setShowCreateView(false);
      setNewView({ name: '', sql: '' });
      await fetchTables();
      onSelectTable(name);
    } else {
      setCreateViewError(res.error || t('sidebar.errCreateView'));
    }
  };



  const handleConfirmTruncate = async () => {
    if (!truncateModal) return;
    if (blockedByReadOnly()) return;
    const { tableName, restartIdentity, disableFkCheck, cascade } = truncateModal;
    setTruncateModal(null);

    try {
      // Cả cụm lệnh chạy trong backend trên một connection duy nhất: các lệnh tắt/bật kiểm tra
      // khóa ngoại ở mức session sẽ vô hiệu nếu gửi thành nhiều lời gọi invoke riêng.
      const res = await dbHelper.truncateTable(tableName, {
        restartIdentity,
        disableFk: disableFkCheck,
        cascade,
      });
      const success = !!res.success;
      const error = res.error || '';

      if (success) {
        alert(t('sidebar.truncateSuccess'));
        window.dispatchEvent(new CustomEvent('database-restored'));
        fetchTables();
      } else {
        alert(t('sidebar.errTruncate', { message: error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    }
  };

  const handleConfirmDrop = async () => {
    if (!dropModal) return;
    if (blockedByReadOnly()) return;
    const { tableName, isView, ignoreFkCheck, cascade } = dropModal;
    setDropModal(null);

    const object = isView ? t('sidebar.objectView') : t('sidebar.objectTable');

    try {
      // Xem ghi chú ở handleConfirmTruncate: backend chạy cả cụm trên một connection.
      const res = await dbHelper.dropTable(tableName, { isView, cascade, ignoreFk: ignoreFkCheck });
      const success = !!res.success;
      const error = res.error || '';

      if (success) {
        alert(t('sidebar.dropSuccess', { object }));
        if (onTableDropped) onTableDropped(tableName);
        fetchTables();
      } else {
        alert(t('sidebar.errDrop', { object, message: error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
    }
  };

  // Do not name the callback parameter `t` here or in the maps/filters below:
  // `t` is the translation function, and shadowing it hides it from the body.
  const matchesSearch = useMemo(() => buildMatcher(searchTerm), [searchTerm]);

  // Bảng và view tách thành hai nhóm riêng (trước đây chung một danh sách, chỉ khác icon).
  // useMemo: mỗi ký tự gõ vào ô tìm kiếm làm Sidebar render lại, và App render lại cũng
  // kéo theo Sidebar — không có memo thì bốn lượt filter chạy lại cả những lần không liên quan.
  const filteredTables = useMemo(
    () => tables.filter((item) => item.type !== 'view' && matchesSearch(item.name)),
    [tables, matchesSearch]
  );
  const filteredViews = useMemo(
    () => tables.filter((item) => item.type === 'view' && matchesSearch(item.name)),
    [tables, matchesSearch]
  );
  const filteredFunctions = useMemo(() => functions.filter((f) => matchesSearch(f)), [functions, matchesSearch]);
  const filteredProcedures = useMemo(() => procedures.filter((p) => matchesSearch(p)), [procedures, matchesSearch]);

  // Khi đang gõ tìm kiếm thì luôn coi như mở để thấy kết quả (bỏ qua trạng thái thu gọn)
  const isSearching = searchTerm.trim() !== '';
  const isOpen = (key: 'tables' | 'views' | 'functions' | 'procedures') => isSearching || !collapsed[key];
  const toggleSection = (key: 'tables' | 'views' | 'functions' | 'procedures') => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // Điều hướng bằng ↑/↓ ngay trong ô tìm kiếm (ô này đã nhận Ctrl+P/Ctrl+K nên người
  // dùng kỳ vọng hành vi quick-open). Chỉ tính các mục ĐANG hiển thị, nếu không mũi
  // tên sẽ chạy qua những dòng nằm trong nhóm đang thu gọn.
  const navItems = [
    ...(isOpen('tables') ? filteredTables : []),
    ...(isOpen('views') ? filteredViews : []),
  ];
  const viewNavOffset = isOpen('tables') ? filteredTables.length : 0;
  const [highlight, setHighlight] = useState(-1);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHighlight(-1);
  }, [searchTerm]);

  useEffect(() => {
    if (highlight >= 0) highlightRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (navItems.length === 0) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((i) => {
        const next = i + dir;
        if (next < 0) return navItems.length - 1;
        if (next >= navItems.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter') {
      const target = navItems[highlight] ?? navItems[0];
      if (target) onSelectTable(target.name);
      return;
    }
    if (e.key === 'Escape' && searchTerm) {
      e.preventDefault();
      setSearchTerm('');
    }
  };

  const renderObjectItem = (item: TableItem, navIndex: number) => {
    const isExpanded = !!expandedTables[item.name];
    return (
      <ObjectItem
        key={item.name}
        item={item}
        isHighlighted={navIndex === highlight}
        isActive={activeTable === item.name}
        isExpanded={isExpanded}
        // Chỉ truyền khi đang mở: `tableColumnsMap[name] || []` tạo mảng rỗng mới mỗi
        // render và sẽ phá memo của mọi dòng đang đóng.
        columns={isExpanded ? tableColumnsMap[item.name] : undefined}
        isLoadingCols={!!loadingColumns[item.name]}
        highlightRef={highlightRef}
        onSelect={handleRowSelect}
        onContextMenu={handleTableContextMenu}
        onToggleExpand={toggleTableExpanded}
        onRequestDrop={handleRowRequestDrop}
      />
    );
  };

  return (
    <div className="sidebar-navigation" ref={rootRef} style={{ width: `${width}px` }}>
      {/* Tay nắm kéo ở viền phải */}
      <div
        className={`sidebar-resizer${resizing ? ' is-resizing' : ''}`}
        role="separator"
        aria-orientation="vertical"
        title={t('sidebar.resizeSidebar')}
        onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      />

      {/* Top 4-Tab Segmented Control (Items | Queries | History | Tools).
          Style nằm ở .sb-seg-tab trong index.css — trước đây bốn nút mang bốn khối
          inline style giống nhau, nên lỗi màu ở giao diện tối phải sửa bốn chỗ. */}
      <div className="sb-seg">
        {SEG_TABS.map(([id, labelKey]) => (
          <button
            key={id}
            className={`sb-seg-tab${activeTab === id ? ' is-on' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Top Search Input with Left Search Icon & Right Sliders Icon */}
      <div className="sidebar-search-container" style={{ padding: '4px 8px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={13}
            style={{
              position: 'absolute',
              left: '10px',
              color: 'var(--win-text-disabled)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            ref={inputRef}
            className="sidebar-search-input"
            placeholder={
              activeTab === 'items' ? "Search for item..." :
              activeTab === 'queries' ? "Search queries..." :
              activeTab === 'history' ? "Search history..." :
              "Search tools..."
            }
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            style={{ paddingLeft: '28px', paddingRight: '28px', width: '100%', height: '30px', fontSize: '11.5px' }}
          />
          <span
            title="Filter options"
            style={{
              position: 'absolute',
              right: '10px',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <Sliders size={13} style={{ color: 'var(--win-text-disabled)' }} />
          </span>
        </div>
      </div>

      <div className="sidebar-list-container" style={{ flex: 1, overflowY: 'auto' }}>
        {/* TAB 1: ITEMS */}
        {activeTab === 'items' && (
          <div style={{ padding: '2px 0' }}>
            {/* 1. Tables Section (At Top) */}
            <div style={{ marginBottom: '6px' }}>
              <div
                className="sidebar-section-title"
                onClick={() => toggleSection('tables')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  margin: '2px 4px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.5px',
                  color: 'var(--win-text-secondary)',
                  textTransform: 'uppercase',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isOpen('tables') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Table size={13} style={{ color: 'var(--win-accent, #2563eb)' }} />
                  <span>{t('sidebar.tablesSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: '2px',
                    }}
                  >
                    {filteredTables.length}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`sidebar-section-btn accent ${showAddMenu ? 'is-active' : ''}`}
                    title={t('sidebar.createNew')}
                    onClick={() => setShowAddMenu((v) => !v)}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    type="button"
                    className="sidebar-section-btn"
                    title={t('sidebar.refreshTables')}
                    disabled={refreshing}
                    onClick={fetchTables}
                  >
                    <RefreshCw size={13} className={refreshing ? 'loading-spinner' : undefined} />
                  </button>

                  {showAddMenu && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowAddMenu(false)} />
                      <div className="ws-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', minWidth: '200px', zIndex: 999 }}>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); handleCreateTable(); }}>
                          <Table size={13} /> {t('sidebar.createTable')}
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setNewView({ name: '', sql: '' }); setCreateViewError(null); setShowCreateView(true); }}>
                          <Layers size={13} /> {t('sidebar.createView')}
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setShowCreateRoutine(true); }}>
                          <Cog size={13} /> Tạo Stored Procedure / Function
                        </button>
                        <button className="context-menu-item" onClick={() => { setShowAddMenu(false); (onImportNewTable ?? onImportDatabase)(); }}>
                          <HardDriveUpload size={13} /> {t('sidebar.importTableFromFile')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {isOpen('tables') && (
                <div className="sidebar-list">
                  {filteredTables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '8px 12px' }}>
                      {t('sidebar.noTables')}
                    </div>
                  ) : (
                    filteredTables.map((item, i) => renderObjectItem(item, i))
                  )}
                </div>
              )}
            </div>

            {/* 2. Views Section */}
            {filteredViews.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('views')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('views') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Layers size={13} style={{ color: '#8b5cf6' }} />
                  <span>{t('sidebar.viewsSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredViews.length}
                  </span>
                </div>
                {isOpen('views') && (
                  <div className="sidebar-list">
                    {filteredViews.map((item, i) => renderObjectItem(item, viewNavOffset + i))}
                  </div>
                )}
              </div>
            )}

            {/* 3. Functions Section */}
            {filteredFunctions.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('functions')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('functions') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Braces size={13} style={{ color: '#f59e0b' }} />
                  <span>{t('sidebar.functionsSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredFunctions.length}
                  </span>
                </div>
                {isOpen('functions') && (
                  <div className="sidebar-list">
                    {filteredFunctions.map((fn) => (
                      <div
                        key={'fn_' + fn}
                        className="sidebar-item"
                        onClick={() => handleShowObjectDef(fn, 'function')}
                        title={t('sidebar.objectDefHint', { name: fn })}
                      >
                        <Braces size={14} className="icon-view" />
                        <ObjectName name={fn} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 4. Procedures Section */}
            {filteredProcedures.length > 0 && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => toggleSection('procedures')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  {isOpen('procedures') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Cog size={13} style={{ color: '#06b6d4' }} />
                  <span>{t('sidebar.proceduresSection')}</span>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'var(--win-bg-hover, rgba(0,0,0,0.06))',
                      color: 'var(--win-text-disabled)',
                      padding: '1px 6px',
                      borderRadius: '10px',
                      marginLeft: 'auto',
                    }}
                  >
                    {filteredProcedures.length}
                  </span>
                </div>
                {isOpen('procedures') && (
                  <div className="sidebar-list">
                    {filteredProcedures.map((pr) => (
                      <div
                        key={'pr_' + pr}
                        className="sidebar-item"
                        onClick={() => handleShowObjectDef(pr, 'procedure')}
                        title={t('sidebar.objectDefHint', { name: pr })}
                      >
                        <Cog size={14} className="icon-view" />
                        <ObjectName name={pr} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 5. Sequences Section */}
            {(dbType === 'postgres' || dbType === 'mysql') && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  className="sidebar-section-title"
                  onClick={() => setShowSequencesModal(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '5px 8px',
                    margin: '2px 4px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    color: 'var(--win-text-secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  <Layers size={13} style={{ color: '#8b5cf6' }} />
                  <span>Quản lý Sequences</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: QUERIES */}
        {activeTab === 'queries' && (
          <div style={{ padding: '4px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                SAVED QUERIES ({savedQueriesList.length})
              </span>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '10px', padding: '2px 6px' }}
                onClick={() => onNewQuery()}
              >
                + New Query
              </button>
            </div>

            {savedQueriesList.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '12px 0', textAlign: 'center' }}>
                No saved queries found
              </div>
            ) : (
              savedQueriesList
                .filter(sq => !searchTerm || sq.name.toLowerCase().includes(searchTerm.toLowerCase()) || sq.sql.toLowerCase().includes(searchTerm.toLowerCase()))
                .map(sq => (
                  <div
                    key={sq.id}
                    className="sidebar-item"
                    onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(sq.sql) : onNewQuery()}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '6px 8px', borderRadius: '6px', marginBottom: '4px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '12px', color: 'var(--win-text-primary)' }}>
                        <FileCode size={13} color="var(--win-accent)" />
                        <span>{sq.name}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSavedQuery(sq.id);
                          setSavedQueriesList(loadSavedQueries());
                        }}
                        style={{ background: 'transparent', border: 'none', color: 'var(--win-text-disabled)', cursor: 'pointer', padding: '2px' }}
                        title="Delete saved query"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div style={{ fontFamily: 'var(--win-font-mono)', fontSize: '10.5px', color: 'var(--win-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', marginTop: '2px' }}>
                      {sq.sql}
                    </div>
                  </div>
                ))
            )}
          </div>
        )}

        {/* TAB 3: HISTORY */}
        {activeTab === 'history' && (
          <div style={{ padding: '4px 8px' }}>
            {/* Sub-tab Switcher: History vs Saved Queries */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', marginBottom: '8px', gap: '4px' }}>
              <button
                type="button"
                onClick={() => setHistorySubTab('history')}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  fontSize: '11px',
                  fontWeight: historySubTab === 'history' ? 600 : 400,
                  border: 'none',
                  borderBottom: historySubTab === 'history' ? '2px solid var(--win-accent, #2563eb)' : '2px solid transparent',
                  background: 'transparent',
                  color: historySubTab === 'history' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                <History size={12} />
                <span>History ({historyList.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setHistorySubTab('saved')}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  fontSize: '11px',
                  fontWeight: historySubTab === 'saved' ? 600 : 400,
                  border: 'none',
                  borderBottom: historySubTab === 'saved' ? '2px solid var(--win-accent, #2563eb)' : '2px solid transparent',
                  background: 'transparent',
                  color: historySubTab === 'saved' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                <Bookmark size={12} />
                <span>Saved SQL ({savedQueriesList.length})</span>
              </button>
            </div>

            {historySubTab === 'history' ? (
              <>
                {/* Scope Filter Pill Buttons (Database | Connection | All) */}
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('database')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'database' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'database' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'database' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    Database
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('connection')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'connection' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'connection' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'connection' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    Connection
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryScope('all')}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      fontSize: '11px',
                      borderRadius: '5px',
                      border: '1px solid var(--win-border)',
                      background: historyScope === 'all' ? 'var(--win-accent, #2563eb)' : 'transparent',
                      color: historyScope === 'all' ? '#ffffff' : 'var(--win-text-secondary)',
                      fontWeight: historyScope === 'all' ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    All
                  </button>
                </div>

                {Object.keys(getGroupedHistory()).length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '16px 0', textAlign: 'center' }}>
                    No execution history found
                  </div>
                ) : (
                  Object.keys(getGroupedHistory()).map(dateStr => {
                    const groupItems = getGroupedHistory()[dateStr];
                    return (
                      <div key={dateStr} style={{ marginBottom: '12px' }}>
                        {/* Date Header Divider */}
                        <div
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: 'var(--win-text-secondary)',
                            paddingBottom: '4px',
                            borderBottom: '1px dashed var(--win-border)',
                            marginBottom: '8px',
                          }}
                        >
                          {dateStr}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {groupItems.map(item => {
                            const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            const isCopied = copiedId === item.id;
                            return (
                              <div
                                key={item.id}
                                style={{
                                  // Thẻ trong panel -> --win-bg-card (mờ, nằm trên panel),
                                  // không phải nền popover.
                                  background: 'var(--win-bg-card)',
                                  border: '1px solid var(--win-border)',
                                  borderRadius: '8px',
                                  padding: '8px 10px',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '6px',
                                  boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                                  transition: 'all 0.15s ease',
                                }}
                                onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(item.sql) : onNewQuery()}
                              >
                                {/* Card Header Meta (Status, Time, Duration, Copy, Delete) */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--win-text-secondary)' }}>
                                    {item.ok !== false ? <CheckCircle2 size={12} color="#22c55e" /> : <AlertTriangle size={12} color="#ef4444" />}
                                    <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>{timeStr}</span>
                                    {item.ms !== undefined && <span style={{ opacity: 0.65, fontSize: '10px' }}>· {item.ms}ms</span>}
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                                    <span
                                      onClick={(e) => handleCopySql(e, item.id, item.sql)}
                                      style={{
                                        color: isCopied ? '#22c55e' : 'var(--win-accent, #2563eb)',
                                        fontWeight: isCopied ? 600 : 400,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '2px',
                                      }}
                                      title="Copy SQL to clipboard"
                                    >
                                      <Copy size={11} /> {isCopied ? 'Copied!' : 'Copy'}
                                    </span>
                                    <span
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        deleteHistoryEntry(item.id);
                                        setHistoryList(loadHistory());
                                      }}
                                      style={{ color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px' }}
                                      title="Delete history entry"
                                    >
                                      Delete
                                    </span>
                                  </div>
                                </div>

                                {/* Card Body SQL Snippet */}
                                <div
                                  style={{
                                    fontFamily: 'var(--win-font-mono, monospace)',
                                    fontSize: '11px',
                                    lineHeight: '1.45',
                                    color: 'var(--win-text-primary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    maxHeight: '110px',
                                    overflowY: 'auto',
                                    padding: '2px 0 0 0',
                                  }}
                                >
                                  {item.sql}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            ) : (
              <>
                {/* Saved Queries Sub-Tab Content */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                    SAVED QUERIES ({savedQueriesList.length})
                  </span>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '10px', padding: '2px 6px' }}
                    onClick={() => onNewQuery()}
                  >
                    + New Query
                  </button>
                </div>

                {savedQueriesList.length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', padding: '12px 0', textAlign: 'center' }}>
                    No saved queries found
                  </div>
                ) : (
                  savedQueriesList
                    .filter(sq => !searchTerm || sq.name.toLowerCase().includes(searchTerm.toLowerCase()) || sq.sql.toLowerCase().includes(searchTerm.toLowerCase()))
                    .map(sq => (
                      <div
                        key={sq.id}
                        className="sidebar-item"
                        onClick={() => onOpenQueryWithSql ? onOpenQueryWithSql(sq.sql) : onNewQuery()}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '6px 8px', borderRadius: '6px', marginBottom: '4px', cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '12px', color: 'var(--win-text-primary)' }}>
                            <FileCode size={13} color="var(--win-accent)" />
                            <span>{sq.name}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSavedQuery(sq.id);
                              setSavedQueriesList(loadSavedQueries());
                            }}
                            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-disabled)', cursor: 'pointer', padding: '2px' }}
                            title="Delete saved query"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <div style={{ fontFamily: 'var(--win-font-mono)', fontSize: '10.5px', color: 'var(--win-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', marginTop: '2px' }}>
                          {sq.sql}
                        </div>
                      </div>
                    ))
                )}
              </>
            )}
          </div>
        )}

        {/* TAB 4: TOOLS */}
        {activeTab === 'tools' && (
          <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div className="sidebar-item" onClick={onNewQuery} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
              <Terminal size={14} className="title-bar-logo" />
              <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.sqlEditor')}</span>
            </div>

            <div className="sidebar-item" onClick={onOpenTerminal} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
              <TerminalSquare size={14} className="title-bar-logo" />
              <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.terminal')}</span>
            </div>

            {onOpenDbInfo && (
              <div className="sidebar-item" onClick={onOpenDbInfo} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
                <Info size={14} color="var(--win-accent)" />
                <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.databaseInfo')}</span>
              </div>
            )}

            {onSchemaMigration && (
              <div className="sidebar-item" onClick={onSchemaMigration} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
                <GitCompare size={14} color="var(--win-accent)" />
                <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.schemaMigration')}</span>
              </div>
            )}

            {onCompareDatabases && (
              <div className="sidebar-item" onClick={onCompareDatabases} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
                <ArrowLeftRight size={14} color="var(--win-accent)" />
                <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.compareDatabases')}</span>
              </div>
            )}

            {onGenerateData && (
              <div
                className="sidebar-item"
                onClick={() => {
                  if (blockedByReadOnly()) return;
                  onGenerateData();
                }}
                style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}
              >
                <Wand2 size={14} color="var(--win-accent)" />
                <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.generateData')}</span>
              </div>
            )}

            <div className="sidebar-item" onClick={onExportDatabase} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
              <HardDriveDownload size={14} />
              <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.exportDatabase')}</span>
            </div>

            <div className="sidebar-item" onClick={onImportDatabase} style={{ padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}>
              <HardDriveUpload size={14} />
              <span style={{ fontSize: '12px', fontWeight: 500 }}>{t('sidebar.importDatabase')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Floating Context Menu — vị trí được chỉnh lại theo kích thước thật để không tràn */}
      {contextMenu && (() => {
        const isView = tables.find(item => item.name === contextMenu.tableName)?.type === 'view';
        const object = isView ? t('sidebar.objectView') : t('sidebar.objectTable');
        return (
          <div ref={menuRef} className="ws-menu" style={{
            position: 'fixed',
            top: menuPos ? menuPos.top : contextMenu.y,
            left: menuPos ? menuPos.left : contextMenu.x,
            // Chưa đo xong thì ẩn để không thấy menu nhảy chỗ
            visibility: menuPos ? 'visible' : 'hidden',
            zIndex: 99999,
            minWidth: '170px'
          }}>
            {/* Tiêu đề: cho biết menu đang tác động lên bảng nào */}
            <div style={{
              padding: '6px 12px',
              fontSize: '10px',
              fontWeight: 600,
              color: 'var(--win-text-secondary)',
              borderBottom: '1px solid var(--win-border)',
              marginBottom: '4px',
              maxWidth: '240px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {contextMenu.tableName}
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onSelectTable(contextMenu.tableName, 'data');
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxOpenData')}
            </div>
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onSelectTable(contextMenu.tableName, 'structure');
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxOpenStructure', { object })}
            </div>
            <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onImportToTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', opacity: isView ? 0.5 : 1, pointerEvents: isView ? 'none' : 'auto' }}
              className="sidebar-context-item"
              title={isView ? t('sidebar.ctxImportDisabled') : undefined}
            >
              {t('sidebar.ctxImport')}
            </div>
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                onExportTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {t('sidebar.ctxExport')}
            </div>
            {/* Sinh dữ liệu test cho đúng bảng này (ghi dữ liệu -> chặn khi Chỉ đọc, và không có
                nghĩa với view). */}
            {onGenerateData && !isView && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  if (blockedByReadOnly()) return;
                  onGenerateData(contextMenu.tableName);
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                {t('sidebar.ctxGenerateData')}
              </div>
            )}
            <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                handleRenameTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', opacity: isView ? 0.5 : 1, pointerEvents: isView ? 'none' : 'auto' }}
              className="sidebar-context-item"
              title={isView ? t('sidebar.ctxRenameDisabled') : undefined}
            >
              {t('sidebar.ctxRename', { object })}
            </div>
            {!isView && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  if (blockedByReadOnly()) return;
                  setTruncateModal({
                    tableName: contextMenu.tableName,
                    restartIdentity: false,
                    disableFkCheck: false,
                    cascade: false,
                  });
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--st-warn)', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                {t('sidebar.ctxTruncate')}
              </div>
            )}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                if (blockedByReadOnly()) return;
                setDropModal({
                  tableName: contextMenu.tableName,
                  isView,
                  ignoreFkCheck: false,
                  cascade: false,
                });
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-accent)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {isView ? t('sidebar.ctxDropView') : t('sidebar.ctxDropTable')}
            </div>
          </div>
        );
      })()}



      {renameState && (
        <Modal
          title={t('sidebar.renameTableTitle')}
          onClose={() => setRenameState(null)}
          width="380px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              <Trans
                i18nKey="sidebar.renameTablePrompt"
                values={{ name: renameState.tableName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <input
              type="text"
              value={renameState.value}
              onChange={(e) => setRenameState({ ...renameState, value: e.target.value })}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitRename();
                } else if (e.key === 'Escape') {
                  setRenameState(null);
                }
              }}
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid var(--win-border)',
                background: 'var(--win-bg-input)',
                color: 'var(--win-text-primary)',
                outline: 'none',
                cursor: 'text'
              }}
            />
          </ModalBody>
          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setRenameState(null)}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={submitRename}
              style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              {t('common.save')}
            </button>
          </ModalFooter>
        </Modal>
      )}


      {isCreateModalOpen && (
        <CreateTableModal
          isOpen={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          dbType={dbType}
          onTableCreated={(name) => {
            fetchTables();
            onSelectTable(name, 'structure');
          }}
        />
      )}

      {showCreateView && (
        <Modal
          title={t('sidebar.createViewTitle')}
          onClose={() => setShowCreateView(false)}
          width="520px"
          maxWidth="90vw"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.viewName')}</label>
              <input
                type="text" autoFocus value={newView.name}
                onChange={(e) => setNewView({ ...newView, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setShowCreateView(false); }}
                placeholder={t('sidebar.viewNamePlaceholder')}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.viewSelect')}</label>
              <textarea
                value={newView.sql}
                onChange={(e) => setNewView({ ...newView, sql: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowCreateView(false);
                  // Ctrl/Cmd + Enter để tạo nhanh, Enter thường vẫn xuống dòng
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCreateView();
                }}
                placeholder="SELECT * FROM ..."
                rows={7}
                spellCheck={false}
                style={{ fontSize: '11px', padding: '8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', fontFamily: 'var(--win-font-mono, monospace)', resize: 'vertical', lineHeight: 1.5 }}
              />
              <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
                <Trans
                  i18nKey="sidebar.viewHint"
                  values={{ name: newView.name.trim() || t('sidebar.viewNamePlaceholder') }}
                  components={{ code: <code /> }}
                />
              </span>
            </div>
            {createViewError && (
              <div style={{ fontSize: '11px', color: 'var(--st-danger, #ef4444)', wordBreak: 'break-word' }}>{createViewError}</div>
            )}
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowCreateView(false)} style={{ padding: '0 12px' }}>{t('common.cancel')}</button>
            <button
              className="btn btn-primary"
              onClick={handleCreateView}
              disabled={creatingView}
              style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', opacity: creatingView ? 0.6 : 1 }}
            >
              {creatingView ? t('common.creating') : t('sidebar.createViewButton')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {showCreateDb && (
        <Modal
          title={t('sidebar.createDbTitle', { dbType: dbType.toUpperCase() })}
          onClose={() => setShowCreateDb(false)}
          width="400px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.dbName')}</label>
              <input
                type="text" autoFocus value={newDb.name}
                onChange={(e) => setNewDb({ ...newDb, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDatabase(); if (e.key === 'Escape') setShowCreateDb(false); }}
                placeholder={t('sidebar.dbNamePlaceholder')}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.encodingOptional')}</label>
              <select
                value={newDb.encoding}
                onChange={(e) => setNewDb({ ...newDb, encoding: e.target.value, collation: '' })}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', cursor: 'pointer' }}
              >
                <option value="">{t('common.defaultOption')}</option>
                {dbCharsets.encodings.map((enc) => (
                  <option key={enc} value={enc}>{enc}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('sidebar.collationOptional')}</label>
              <select
                value={newDb.collation}
                onChange={(e) => setNewDb({ ...newDb, collation: e.target.value })}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', cursor: 'pointer' }}
              >
                <option value="">{t('common.defaultOption')}</option>
                {(dbType === 'mysql'
                  ? (dbCharsets.collationsByEncoding?.[newDb.encoding] || [])
                  : (dbCharsets.collations || [])
                ).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowCreateDb(false)} style={{ padding: '0 12px' }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleCreateDatabase} style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>{t('common.create')}</button>
          </ModalFooter>
        </Modal>
      )}

      {renameDbState && (
        <Modal
          title={t('sidebar.renameDbTitle')}
          onClose={() => setRenameDbState(null)}
          width="380px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              <Trans
                i18nKey="sidebar.renameDbPrompt"
                values={{ name: renameDbState.oldName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <input
              type="text" autoFocus value={renameDbState.value}
              onChange={(e) => setRenameDbState({ ...renameDbState, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDatabase(); if (e.key === 'Escape') setRenameDbState(null); }}
              style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
            />
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setRenameDbState(null)} style={{ padding: '0 12px' }}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleRenameDatabase} style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>{t('common.rename')}</button>
          </ModalFooter>
        </Modal>
      )}

      {showSequencesModal && (
        <SequenceManagerModal onClose={() => setShowSequencesModal(false)} />
      )}

      {objDef && objDef.kind === 'view' && (
        <ViewEditorModal
          name={objDef.name}
          initialSql={objDef.sql}
          onClose={() => setObjDef(null)}
          onSaved={() => fetchTables()}
        />
      )}

      {objDef && (objDef.kind === 'procedure' || objDef.kind === 'function') && (
        <RoutineEditorModal
          name={objDef.name}
          kind={objDef.kind}
          initialSql={objDef.sql}
          onClose={() => setObjDef(null)}
          onSaved={() => fetchTables()}
        />
      )}
      {showCreateRoutine && (
        <CreateRoutineModal
          dbType={dbType}
          onClose={() => setShowCreateRoutine(false)}
          onCreated={() => fetchTables()}
        />
      )}

      {/* 1. Truncate Table Modal (Image 1) */}
      {truncateModal && (
        <Modal
          title={t('sidebar.truncateModalTitle')}
          onClose={() => setTruncateModal(null)}
          width="400px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '16px', padding: '16px 20px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={truncateModal.restartIdentity}
                onChange={(e) => setTruncateModal({ ...truncateModal, restartIdentity: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.truncateRestartIdentity')}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  {t('sidebar.truncateRestartIdentityHint')}
                </span>
              </div>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={truncateModal.disableFkCheck}
                onChange={(e) => setTruncateModal({ ...truncateModal, disableFkCheck: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.truncateDisableFk')}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  {t('sidebar.truncateDisableFkHint')}
                </span>
              </div>
            </label>

            {/* Trên Postgres, tắt kiểm tra khóa ngoại KHÔNG đủ để truncate một bảng đang bị bảng
                khác tham chiếu (đó là kiểm tra ở tầng catalog, không phải trigger) — chỉ CASCADE
                qua được, và nó truncate luôn các bảng con. Dialect khác không có mệnh đề này. */}
            {dbType === 'postgres' && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={truncateModal.cascade}
                  onChange={(e) => setTruncateModal({ ...truncateModal, cascade: e.target.checked })}
                  style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                    {t('sidebar.truncateCascade')}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--st-warn, var(--win-text-disabled))' }}>
                    {t('sidebar.truncateCascadeHint')}
                  </span>
                </div>
              </label>
            )}
          </ModalBody>
          <ModalFooter style={{ padding: '12px 20px', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setTruncateModal(null)}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmTruncate}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px', background: 'var(--win-accent, #2563eb)', color: '#fff', border: 'none' }}
            >
              {t('common.ok')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* 2. Delete tables Modal (Image 2) */}
      {dropModal && (
        <Modal
          title={dropModal.isView ? t('sidebar.dropModalTitleView') : t('sidebar.dropModalTitleTable')}
          onClose={() => setDropModal(null)}
          width="400px"
          zIndex={999999}
        >
          <ModalBody style={{ gap: '16px', padding: '16px 20px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={dropModal.ignoreFkCheck}
                onChange={(e) => setDropModal({ ...dropModal, ignoreFkCheck: e.target.checked })}
                style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                  {t('sidebar.dropIgnoreFk')}
                </span>
              </div>
            </label>

            {/* CASCADE chỉ Postgres mới thực thi thật (SQLite lỗi cú pháp, MySQL nuốt từ khóa),
                nên chỉ hiện ở Postgres — backend cũng từ chối nếu bị gọi ở dialect khác. */}
            {dbType === 'postgres' && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={dropModal.cascade}
                  onChange={(e) => setDropModal({ ...dropModal, cascade: e.target.checked })}
                  style={{ marginTop: '3px', cursor: 'pointer', width: '15px', height: '15px' }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-primary)' }}>
                    {t('sidebar.dropCascade')}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                    {t('sidebar.dropCascadeHint')}
                  </span>
                </div>
              </label>
            )}
          </ModalBody>
          <ModalFooter style={{ padding: '12px 20px', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDropModal(null)}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmDrop}
              style={{ minWidth: '80px', padding: '6px 16px', borderRadius: '6px', background: 'var(--win-accent, #2563eb)', color: '#fff', border: 'none' }}
            >
              {t('common.ok')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};
