import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { dbHelper } from '../utils/dbHelper';
import type { TableItem } from '../utils/dbHelper';
import { Search, Table, Terminal, TerminalSquare, LogOut, RefreshCw, Layers, Plus, ChevronDown, ChevronRight, Trash2, Check, Pencil, Braces, Cog, X, Info, BarChart3 } from 'lucide-react';
import { CreateTableModal } from './CreateTableModal';
import { ConfirmDialog } from './ConfirmDialog';
import { openTerminalWindow } from '../utils/terminalWindow';
import { PanelBottom, ExternalLink, GitCompare, HardDriveDownload, HardDriveUpload } from 'lucide-react';

interface SidebarProps {
  dbName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
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
  onTableRenamed?: (oldName: string, newName: string) => void;
  onTableDropped?: (tableName: string) => void;
  onDatabaseChanged?: (name: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  dbName,
  dbType,
  onSelectTable,
  onNewQuery,
  onOpenTerminal,
  terminalConfig,
  onDisconnect,
  activeTable,
  onImportToTable,
  onExportTable,
  onExportDatabase,
  onImportDatabase,
  onImportNewTable,
  onOpenDbInfo,
  onOpenAllDbStats,
  onSchemaMigration,
  onTableRenamed,
  onTableDropped,
  onDatabaseChanged,
}) => {
  const [tables, setTables] = useState<TableItem[]>([]);
  const [functions, setFunctions] = useState<string[]>([]);
  const [procedures, setProcedures] = useState<string[]>([]);
  const [objDef, setObjDef] = useState<{ name: string; kind: 'view' | 'function' | 'procedure'; sql: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Hàm/thủ tục mặc định THU GỌN: phần lớn thời gian người dùng làm việc với danh sách bảng,
  // hai nhóm này chỉ mở khi cần (đang gõ tìm kiếm thì vẫn tự mở, xem isOpen()).
  const [collapsed, setCollapsed] = useState<{ tables: boolean; functions: boolean; procedures: boolean }>({ tables: false, functions: true, procedures: true });
  const inputRef = useRef<HTMLInputElement>(null);

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
  const [showTermMenu, setShowTermMenu] = useState(false);
  // Menu "+" ở tiêu đề Danh sách bảng và hộp thoại tạo view
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showCreateView, setShowCreateView] = useState(false);
  const [newView, setNewView] = useState({ name: '', sql: '' });
  const [creatingView, setCreatingView] = useState(false);
  const [createViewError, setCreateViewError] = useState<string | null>(null);
  // Hành động phá huỷ dữ liệu đang chờ xác nhận (drop bảng/view, truncate, drop database)
  const [destructive, setDestructive] = useState<
    | { kind: 'drop-table'; tableName: string; isView: boolean }
    | { kind: 'truncate'; tableName: string }
    | { kind: 'drop-db'; dbName: string }
    | null
  >(null);

  // Database switcher (PG/MySQL)
  const canManageDatabases = dbType !== 'sqlite';
  const [showDbMenu, setShowDbMenu] = useState(false);
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [newDb, setNewDb] = useState({ name: '', encoding: '', collation: '' });
  const [dbCharsets, setDbCharsets] = useState<{ encodings: string[]; collations?: string[]; collationsByEncoding?: Record<string, string[]> }>({ encodings: [] });
  const [renameDbState, setRenameDbState] = useState<{ oldName: string; value: string } | null>(null);

  const openDbMenu = async () => {
    if (!canManageDatabases) return;
    setShowDbMenu(true);
    setDbLoading(true);
    const res = await dbHelper.listDatabases();
    setDbList(res.databases || []);
    setDbLoading(false);
  };

  const handleSwitchDatabase = async (name: string) => {
    if (name === dbName) { setShowDbMenu(false); return; }
    setSwitching(true);
    const res = await dbHelper.switchDatabase(name);
    setSwitching(false);
    setShowDbMenu(false);
    if (res.success) {
      onDatabaseChanged?.(res.database || name);
    } else {
      alert('Lỗi đổi database: ' + res.error);
    }
  };

  const handleDropDatabase = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (name === dbName) {
      alert('Không thể xóa database đang kết nối. Hãy chuyển sang database khác trước.');
      return;
    }
    setShowDbMenu(false);
    setDestructive({ kind: 'drop-db', dbName: name });
  };

  const runDropDatabase = async (name: string) => {
    const res = await dbHelper.dropDatabase(name);
    if (res.success) {
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
    } else {
      alert('Lỗi xóa database: ' + res.error);
    }
  };

  const openCreateDb = async () => {
    setShowDbMenu(false);
    setShowCreateDb(true);
    const cs = await dbHelper.getDbCharsets();
    setDbCharsets({ encodings: cs.encodings, collations: cs.collations, collationsByEncoding: cs.collationsByEncoding });
    const defEnc = dbType === 'mysql'
      ? (cs.encodings.includes('utf8mb4') ? 'utf8mb4' : (cs.encodings[0] || ''))
      : (cs.encodings.includes('UTF8') ? 'UTF8' : (cs.encodings[0] || ''));
    setNewDb({ name: '', encoding: defEnc, collation: '' });
  };

  const handleRenameDatabase = async () => {
    if (!renameDbState) return;
    const { oldName, value } = renameDbState;
    const newName = value.trim();
    if (!newName || newName === oldName) { setRenameDbState(null); return; }
    const res = await dbHelper.renameDatabase(oldName, newName);
    setRenameDbState(null);
    if (res.success) {
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
    } else {
      alert('Lỗi đổi tên database: ' + res.error);
    }
  };

  const handleCreateDatabase = async () => {
    const name = newDb.name.trim();
    if (!name) { alert('Vui lòng nhập tên database.'); return; }
    const res = await dbHelper.createDatabase({
      name,
      encoding: newDb.encoding.trim() || undefined,
      collation: newDb.collation.trim() || undefined,
    });
    if (res.success) {
      setShowCreateDb(false);
      setNewDb({ name: '', encoding: '', collation: '' });
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
      if (confirm(`Đã tạo database "${name}". Chuyển sang dùng database này ngay?`)) {
        handleSwitchDatabase(name);
      }
    } else {
      alert('Lỗi tạo database: ' + res.error);
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
    const res = await dbHelper.getObjectDefinition(name, kind);
    if (res.success && res.sql) {
      setObjDef({ name, kind, sql: res.sql });
    } else {
      alert('Không lấy được định nghĩa: ' + (res.error || ''));
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

  const handleTableContextMenu = (e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tableName
    });
  };

  const handleRenameTable = (tableName: string) => {
    setRenameState({ tableName, value: tableName });
  };

  const submitRename = async () => {
    if (!renameState) return;
    const { tableName, value } = renameState;
    const newName = value.trim();
    if (!newName || newName === tableName) {
      setRenameState(null);
      return;
    }

    try {
      const res = await dbHelper.renameTable(tableName, newName);
      if (res.success) {
        alert('Đổi tên bảng thành công!');
        if (onTableRenamed) onTableRenamed(tableName, newName);
        fetchTables();
      } else {
        alert('Lỗi đổi tên: ' + res.error);
      }
    } catch (e: any) {
      alert('Lỗi kết nối: ' + e.message);
    } finally {
      setRenameState(null);
    }
  };

  const handleCreateTable = () => {
    setIsCreateModalOpen(true);
  };

  // Tạo view: ghép CREATE VIEW <tên> AS <câu SELECT> rồi chạy qua execute_query.
  // Định danh trích dẫn theo dialect giống các chỗ khác trong file (MySQL backtick).
  const handleCreateView = async () => {
    const name = newView.name.trim();
    const body = newView.sql.trim().replace(/;+\s*$/, '');
    if (!name) { setCreateViewError('Vui lòng nhập tên view.'); return; }
    if (!body) { setCreateViewError('Vui lòng nhập câu SELECT cho view.'); return; }

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
      setCreateViewError(res.error || 'Không tạo được view');
    }
  };

  // Drop/Truncate đi qua ConfirmDialog trong app (thay window.confirm) — xem state `destructive`.
  const runDropTable = async (tableName: string) => {
    const tableItem = tables.find(t => t.name === tableName);
    const isView = tableItem?.type === 'view';
    const label = isView ? 'khung nhìn' : 'bảng';

    try {
      let success = false;
      let error = '';
      if (isView) {
        const q = dbType === 'mysql' ? '`' : '"';
        const res = await dbHelper.executeQuery(`DROP VIEW ${q}${tableName}${q}`);
        success = !!res.success;
        error = res.error || '';
      } else {
        const res = await dbHelper.dropTable(tableName);
        success = !!res.success;
        error = res.error || '';
      }

      if (success) {
        alert(`Đã xóa ${label} thành công!`);
        if (onTableDropped) onTableDropped(tableName);
        fetchTables();
      } else {
        alert(`Lỗi xóa ${label}: ` + error);
      }
    } catch (e: any) {
      alert('Lỗi kết nối: ' + e.message);
    }
  };

  const runTruncateTable = async (tableName: string) => {
    try {
      const res = await dbHelper.truncateTable(tableName);
      if (res.success) {
        alert('Đã xóa sạch dữ liệu bảng!');
        // Báo cho các panel đang mở bảng này refetch
        window.dispatchEvent(new CustomEvent('database-restored'));
      } else {
        alert('Lỗi xóa dữ liệu: ' + res.error);
      }
    } catch (e: any) {
      alert('Lỗi kết nối: ' + e.message);
    }
  };

  const removeAccents = (str: string) => {
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase();
  };

  const filteredTables = tables.filter((t) =>
    removeAccents(t.name).includes(removeAccents(searchTerm))
  );
  const filteredFunctions = functions.filter((f) => removeAccents(f).includes(removeAccents(searchTerm)));
  const filteredProcedures = procedures.filter((p) => removeAccents(p).includes(removeAccents(searchTerm)));

  // Khi đang gõ tìm kiếm thì luôn coi như mở để thấy kết quả (bỏ qua trạng thái thu gọn)
  const isSearching = searchTerm.trim() !== '';
  const isOpen = (key: 'tables' | 'functions' | 'procedures') => isSearching || !collapsed[key];
  const toggleSection = (key: 'tables' | 'functions' | 'procedures') => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && filteredTables.length > 0) {
      onSelectTable(filteredTables[0].name);
    }
  };

  return (
    <div className="sidebar-navigation">
      <div className="sidebar-db-info" style={{ position: 'relative' }}>
        <div
          className="sidebar-db-name"
          title={canManageDatabases ? `${dbName} — bấm để đổi database` : dbName}
          onClick={() => (showDbMenu ? setShowDbMenu(false) : openDbMenu())}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', cursor: canManageDatabases ? 'pointer' : 'default' }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dbName}</span>
          {canManageDatabases && <ChevronDown size={13} style={{ flexShrink: 0, opacity: switching ? 0.4 : 0.8 }} />}
        </div>
        <div className="sidebar-db-status">
          <span className="sidebar-db-status-dot"></span>
          <span>
            {dbType.toUpperCase()} • {switching ? 'Đang đổi database...' : 'Đã kết nối'}
          </span>
        </div>

        {showDbMenu && canManageDatabases && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowDbMenu(false)} />
            {/* Nền/viền/bóng lấy từ .ws-menu — menu cần đủ đục để đọc được,
                không để nội dung sidebar phía sau xuyên qua. */}
            <div className="ws-menu" style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: '8px', right: '8px', zIndex: 999,
              maxHeight: '320px', overflowY: 'auto'
            }}>
              <div style={{ padding: '4px 10px', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--win-text-disabled)' }}>
                Databases {dbLoading ? '(đang tải...)' : `(${dbList.length})`}
              </div>
              {dbList.map((db) => (
                <div
                  key={db}
                  onClick={() => handleSwitchDatabase(db)}
                  className="sidebar-context-item"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer', color: 'var(--win-text-primary)' }}
                >
                  <Check size={12} style={{ opacity: db === dbName ? 1 : 0, color: 'var(--win-accent)', flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: db === dbName ? 600 : 400 }}>{db}</span>
                  {dbType === 'postgres' && db !== dbName && (
                    <span
                      title="Đổi tên database"
                      style={{ display: 'flex', flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); setShowDbMenu(false); setRenameDbState({ oldName: db, value: db }); }}
                    >
                      <Pencil size={12} style={{ opacity: 0.6, color: 'var(--win-text-secondary)' }} />
                    </span>
                  )}
                  {db !== dbName && (
                    <span
                      title="Xóa database"
                      style={{ display: 'flex', flexShrink: 0 }}
                      onClick={(e) => handleDropDatabase(db, e)}
                    >
                      <Trash2 size={12} style={{ opacity: 0.6, color: 'var(--st-danger)' }} />
                    </span>
                  )}
                </div>
              ))}
              <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
              <div
                onClick={openCreateDb}
                className="sidebar-context-item"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer', color: 'var(--win-accent)' }}
              >
                <Plus size={12} /> Tạo database mới...
              </div>
              {onOpenAllDbStats && (
                <div
                  onClick={() => { setShowDbMenu(false); onOpenAllDbStats(); }}
                  className="sidebar-context-item"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer', color: 'var(--win-text-primary)' }}
                >
                  <BarChart3 size={12} /> Thống kê tất cả database
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="sidebar-search-container">
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            ref={inputRef}
            className="sidebar-search-input"
            placeholder="Tìm bảng hoặc view (⌘P)..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <Search
            size={12}
            style={{
              position: 'absolute',
              right: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--win-text-secondary)',
              pointerEvents: 'none',
            }}
          />
        </div>
      </div>

      <div className="sidebar-list-container">
        <div>
          <div className="sidebar-section-title">Công cụ</div>
          <div className="sidebar-list">
            <div className="sidebar-item" onClick={onNewQuery}>
              <Terminal size={14} className="title-bar-logo" />
              <span>Trình viết SQL</span>
            </div>
            {/* Terminal đi cùng nhóm "chạy lệnh" với Trình viết SQL */}
            <div style={{ position: 'relative' }}>
              <div className="sidebar-item" onClick={() => setShowTermMenu(v => !v)}>
                <TerminalSquare size={14} className="title-bar-logo" />
                <span>Terminal</span>
                <ChevronDown size={12} style={{ marginLeft: 'auto', opacity: 0.6 }} />
              </div>
              {showTermMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowTermMenu(false)} />
                  <div className="ws-menu" style={{ position: 'absolute', left: '8px', top: 'calc(100% + 4px)', minWidth: '190px', zIndex: 999 }}>
                    <button className="context-menu-item" onClick={() => { setShowTermMenu(false); onOpenTerminal(); }}>
                      <PanelBottom size={13} /> Mở trong tab
                    </button>
                    <button className="context-menu-item" onClick={() => { setShowTermMenu(false); openTerminalWindow(terminalConfig || { type: dbType }, dbName); }}>
                      <ExternalLink size={13} /> Mở cửa sổ mới
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Nhóm 2: xem và so cấu trúc — chỉ đọc */}
            {(onOpenDbInfo || onSchemaMigration) && <div className="sidebar-tools-sep" />}
            {onOpenDbInfo && (
              <div className="sidebar-item" onClick={onOpenDbInfo}>
                <Info size={14} className="title-bar-logo" />
                <span>Thông tin Database</span>
              </div>
            )}
            {onSchemaMigration && (
              <div className="sidebar-item" onClick={onSchemaMigration}>
                <GitCompare size={14} className="title-bar-logo" />
                <span>Diff Schema & Migration</span>
              </div>
            )}

            {/* Nhóm 3: chuyển dữ liệu vào/ra — ít dùng nhất và Nhập thì có ghi dữ liệu,
                nên để cuối; xuất (an toàn) đứng trước nhập (ghi đè được) */}
            <div className="sidebar-tools-sep" />
            <div className="sidebar-item" onClick={onExportDatabase}>
              <HardDriveDownload size={14} className="title-bar-logo" />
              <span>Xuất Database (Export)</span>
            </div>
            <div className="sidebar-item" onClick={onImportDatabase}>
              <HardDriveUpload size={14} className="title-bar-logo" />
              <span>Nhập Database (Import)</span>
            </div>
          </div>
        </div>

        <div>
          <div
            className="sidebar-section-title"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span
              onClick={() => toggleSection('tables')}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}
              title="Thu gọn / mở rộng"
            >
              {isOpen('tables') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Danh sách bảng ({filteredTables.length})
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }}>
              <button
                type="button"
                className={`sidebar-section-btn accent ${showAddMenu ? 'is-active' : ''}`}
                title="Tạo mới..."
                aria-label="Tạo mới"
                onClick={() => setShowAddMenu((v) => !v)}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className="sidebar-section-btn"
                title="Tải lại danh sách bảng"
                aria-label="Tải lại danh sách bảng"
                disabled={refreshing}
                onClick={fetchTables}
              >
                <RefreshCw size={12} className={refreshing ? 'loading-spinner' : undefined} />
              </button>

              {showAddMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowAddMenu(false)} />
                  <div className="ws-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', minWidth: '200px', zIndex: 999 }}>
                    <button className="context-menu-item" onClick={() => { setShowAddMenu(false); handleCreateTable(); }}>
                      <Table size={13} /> Tạo bảng mới...
                    </button>
                    <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setNewView({ name: '', sql: '' }); setCreateViewError(null); setShowCreateView(true); }}>
                      <Layers size={13} /> Tạo View mới...
                    </button>
                    <button className="context-menu-item" onClick={() => { setShowAddMenu(false); (onImportNewTable ?? onImportDatabase)(); }}>
                      <HardDriveUpload size={13} /> Import bảng từ tệp...
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
                Không tìm thấy bảng nào
              </div>
            ) : (
              filteredTables.map((t) => (
                <div
                  key={t.name}
                  className={`sidebar-item ${activeTable === t.name ? 'active' : ''}`}
                  tabIndex={0}
                  onClick={() => onSelectTable(t.name)}
                  onContextMenu={(e) => handleTableContextMenu(e, t.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault();
                      e.stopPropagation(); // tránh kích hoạt Delete-xóa-dòng của DataGrid
                      setDestructive({ kind: 'drop-table', tableName: t.name, isView: t.type === 'view' });
                    }
                  }}
                  title={`${t.name} (nhấn Delete để xóa bảng)`}
                >
                  {t.type === 'view' ? <Layers size={14} className="icon-view" /> : <Table size={14} className="icon-table" />}
                  <span>{t.name}</span>
                </div>
              ))
            )}
          </div>
          )}
        </div>

        {filteredFunctions.length > 0 && (
          <div>
            <div
              className="sidebar-section-title"
              onClick={() => toggleSection('functions')}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
              title="Thu gọn / mở rộng"
            >
              {isOpen('functions') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Hàm (Functions) ({filteredFunctions.length})
            </div>
            {isOpen('functions') && (
            <div className="sidebar-list">
              {filteredFunctions.map((fn) => (
                <div
                  key={'fn_' + fn}
                  className="sidebar-item"
                  onClick={() => handleShowObjectDef(fn, 'function')}
                  title={`${fn} — xem định nghĩa`}
                >
                  <Braces size={14} className="icon-view" />
                  <span>{fn}</span>
                </div>
              ))}
            </div>
            )}
          </div>
        )}

        {filteredProcedures.length > 0 && (
          <div>
            <div
              className="sidebar-section-title"
              onClick={() => toggleSection('procedures')}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
              title="Thu gọn / mở rộng"
            >
              {isOpen('procedures') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Thủ tục (Procedures) ({filteredProcedures.length})
            </div>
            {isOpen('procedures') && (
            <div className="sidebar-list">
              {filteredProcedures.map((pr) => (
                <div
                  key={'pr_' + pr}
                  className="sidebar-item"
                  onClick={() => handleShowObjectDef(pr, 'procedure')}
                  title={`${pr} — xem định nghĩa`}
                >
                  <Cog size={14} className="icon-view" />
                  <span>{pr}</span>
                </div>
              ))}
            </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="btn btn-secondary"
          onClick={onDisconnect}
          style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '6px' }}
        >
          <LogOut size={13} />
          <span>Ngắt kết nối</span>
        </button>
      </div>

      {/* Floating Context Menu — vị trí được chỉnh lại theo kích thước thật để không tràn */}
      {contextMenu && (() => {
        const isView = tables.find(t => t.name === contextMenu.tableName)?.type === 'view';
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
              Mở xem dữ liệu (Open)
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
              Mở cấu trúc {isView ? 'khung nhìn' : 'bảng'} (Structure)
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
              title={isView ? 'Không thể nhập dữ liệu vào khung nhìn' : undefined}
            >
              Nhập dữ liệu (Import...)
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
              Xuất dữ liệu (Export...)
            </div>
            <div style={{ height: '1px', background: 'var(--win-border)', margin: '4px 0' }} />
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                handleRenameTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', opacity: isView ? 0.5 : 1, pointerEvents: isView ? 'none' : 'auto' }}
              className="sidebar-context-item"
              title={isView ? 'Không thể đổi tên khung nhìn trực tiếp' : undefined}
            >
              Đổi tên {isView ? 'khung nhìn' : 'bảng'} (Rename)
            </div>
            {!isView && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu(null);
                  setDestructive({ kind: 'truncate', tableName: contextMenu.tableName });
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--st-warn)', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                Xóa sạch dữ liệu (Truncate)
              </div>
            )}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                setDestructive({ kind: 'drop-table', tableName: contextMenu.tableName, isView });
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-accent)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {isView ? 'Xóa khung nhìn (Drop View)' : 'Xóa bảng (Drop Table)'}
            </div>
          </div>
        );
      })()}

      {/* Hỏi trước khi Truncate / Drop table / Drop database */}
      <ConfirmDialog
        open={!!destructive}
        danger
        title={
          destructive?.kind === 'truncate'
            ? 'Xóa sạch dữ liệu bảng (Truncate)'
            : destructive?.kind === 'drop-db'
              ? 'Xóa database (Drop Database)'
              : destructive?.isView
                ? 'Xóa khung nhìn (Drop View)'
                : 'Xóa bảng (Drop Table)'
        }
        message={
          destructive?.kind === 'truncate' ? (
            <>Xóa <b>TOÀN BỘ dữ liệu</b> trong bảng <b style={{ fontFamily: 'monospace' }}>{destructive.tableName}</b>? Cấu trúc bảng vẫn được giữ nguyên.</>
          ) : destructive?.kind === 'drop-db' ? (
            <>Xóa vĩnh viễn database <b style={{ fontFamily: 'monospace' }}>{destructive.dbName}</b>? Toàn bộ bảng và dữ liệu bên trong sẽ mất.</>
          ) : destructive?.kind === 'drop-table' ? (
            <>Xóa vĩnh viễn {destructive.isView ? 'khung nhìn' : 'bảng'} <b style={{ fontFamily: 'monospace' }}>{destructive.tableName}</b>? Cả cấu trúc và dữ liệu đều bị xóa.</>
          ) : null
        }
        note="Hành động này không thể hoàn tác."
        confirmLabel={destructive?.kind === 'truncate' ? 'Xóa sạch dữ liệu' : 'Xóa'}
        // Drop database nguy hiểm nhất -> buộc gõ lại tên để tránh bấm nhầm.
        requireText={destructive?.kind === 'drop-db' ? destructive.dbName : undefined}
        onCancel={() => setDestructive(null)}
        onConfirm={() => {
          const action = destructive;
          setDestructive(null);
          if (!action) return;
          if (action.kind === 'truncate') runTruncateTable(action.tableName);
          else if (action.kind === 'drop-table') runDropTable(action.tableName);
          else runDropDatabase(action.dbName);
        }}
      />

      {renameState && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 999999
        }}>
          <div style={{
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border)',
            borderRadius: '6px',
            padding: '16px',
            minWidth: '300px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Đổi tên bảng</h4>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              Nhập tên mới cho bảng <strong>{renameState.tableName}</strong>:
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setRenameState(null)}
                style={{ height: '24px', fontSize: '11px', padding: '0 12px', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px' }}
              >
                Hủy bỏ
              </button>
              <button
                className="btn btn-primary"
                onClick={submitRename}
                style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Lưu
              </button>
            </div>
          </div>
        </div>
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
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 999999
        }}>
          <div style={{
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px',
            padding: '16px', width: '520px', maxWidth: '90vw', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex', flexDirection: 'column', gap: '12px'
          }}>
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Tạo View mới</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Tên view</label>
              <input
                type="text" autoFocus value={newView.name}
                onChange={(e) => setNewView({ ...newView, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setShowCreateView(false); }}
                placeholder="ten_view"
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Câu lệnh SELECT</label>
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
                Hệ thống tự thêm <code>CREATE VIEW "{newView.name.trim() || 'ten_view'}" AS</code> phía trước — chỉ cần nhập phần SELECT.
              </span>
            </div>
            {createViewError && (
              <div style={{ fontSize: '11px', color: 'var(--st-danger, #ef4444)', wordBreak: 'break-word' }}>{createViewError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button className="btn btn-secondary" onClick={() => setShowCreateView(false)} style={{ padding: '0 12px' }}>Hủy</button>
              <button
                className="btn btn-primary"
                onClick={handleCreateView}
                disabled={creatingView}
                style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', opacity: creatingView ? 0.6 : 1 }}
              >
                {creatingView ? 'Đang tạo...' : 'Tạo View'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateDb && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 999999
        }}>
          <div style={{
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px',
            padding: '16px', minWidth: '340px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex', flexDirection: 'column', gap: '12px'
          }}>
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Tạo database mới ({dbType.toUpperCase()})</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Tên database</label>
              <input
                type="text" autoFocus value={newDb.name}
                onChange={(e) => setNewDb({ ...newDb, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDatabase(); if (e.key === 'Escape') setShowCreateDb(false); }}
                placeholder="ten_database"
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Encoding (tùy chọn)</label>
              <select
                value={newDb.encoding}
                onChange={(e) => setNewDb({ ...newDb, encoding: e.target.value, collation: '' })}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', cursor: 'pointer' }}
              >
                <option value="">(mặc định)</option>
                {dbCharsets.encodings.map((enc) => (
                  <option key={enc} value={enc}>{enc}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Collation (tùy chọn)</label>
              <select
                value={newDb.collation}
                onChange={(e) => setNewDb({ ...newDb, collation: e.target.value })}
                style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none', cursor: 'pointer' }}
              >
                <option value="">(mặc định)</option>
                {(dbType === 'mysql'
                  ? (dbCharsets.collationsByEncoding?.[newDb.encoding] || [])
                  : (dbCharsets.collations || [])
                ).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button className="btn btn-secondary" onClick={() => setShowCreateDb(false)} style={{ padding: '0 12px' }}>Hủy</button>
              <button className="btn btn-primary" onClick={handleCreateDatabase} style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Tạo</button>
            </div>
          </div>
        </div>
      )}

      {renameDbState && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 999999
        }}>
          <div style={{
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px',
            padding: '16px', minWidth: '320px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex', flexDirection: 'column', gap: '12px'
          }}>
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Đổi tên database</h4>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              Đổi tên database <strong>{renameDbState.oldName}</strong> thành:
            </div>
            <input
              type="text" autoFocus value={renameDbState.value}
              onChange={(e) => setRenameDbState({ ...renameDbState, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDatabase(); if (e.key === 'Escape') setRenameDbState(null); }}
              style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button className="btn btn-secondary" onClick={() => setRenameDbState(null)} style={{ padding: '0 12px' }}>Hủy</button>
              <button className="btn btn-primary" onClick={handleRenameDatabase} style={{ padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Đổi tên</button>
            </div>
          </div>
        </div>
      )}

      {objDef && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 999999 }}
          onClick={() => setObjDef(null)}
        >
          <div
            style={{ background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '8px', width: '680px', maxWidth: '92%', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--win-border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{objDef.kind === 'procedure' ? 'Thủ tục' : objDef.kind === 'function' ? 'Hàm' : 'Khung nhìn'} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{objDef.name}</span></span>
              <button onClick={() => setObjDef(null)} style={{ background: 'none', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer' }}><X size={14} /></button>
            </div>
            <div style={{ padding: '16px', flex: 1, overflowY: 'auto', background: 'var(--win-bg-window)' }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
                {objDef.sql}
              </pre>
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'var(--win-bg-card)' }}>
              <button className="btn btn-secondary" onClick={() => { navigator.clipboard.writeText(objDef.sql).catch(() => {}); }}>Sao chép</button>
              <button className="btn btn-primary" onClick={() => setObjDef(null)} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
