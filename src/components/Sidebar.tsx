import React, { useState, useEffect, useRef } from 'react';
import { dbHelper } from '../utils/dbHelper';
import type { TableItem } from '../utils/dbHelper';
import { Search, Table, Terminal, TerminalSquare, LogOut, RefreshCw, Layers, Database, Plus, ChevronDown, ChevronRight, Trash2, Check, Pencil, Braces, Cog, X } from 'lucide-react';
import { CreateTableModal } from './CreateTableModal';
import { openTerminalWindow } from '../utils/terminalWindow';
import { PanelBottom, ExternalLink } from 'lucide-react';

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
  onBackupRestore: () => void;
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
  onBackupRestore,
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
  const [collapsed, setCollapsed] = useState<{ tables: boolean; functions: boolean; procedures: boolean }>({ tables: false, functions: false, procedures: false });
  const inputRef = useRef<HTMLInputElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tableName: string;
  } | null>(null);

  const [renameState, setRenameState] = useState<{ tableName: string; value: string } | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [showTermMenu, setShowTermMenu] = useState(false);

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

  const handleDropDatabase = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (name === dbName) {
      alert('Không thể xóa database đang kết nối. Hãy chuyển sang database khác trước.');
      return;
    }
    if (!confirm(`Xóa vĩnh viễn database "${name}"? Toàn bộ dữ liệu sẽ mất và không thể hoàn tác.`)) return;
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

  const handleDropTable = (tableName: string) => {
    const tableItem = tables.find(t => t.name === tableName);
    const isView = tableItem?.type === 'view';
    const label = isView ? 'khung nhìn' : 'bảng';

    setTimeout(async () => {
      if (!confirm(`Bạn có chắc chắn muốn xóa ${label} "${tableName}"? Hành động này sẽ xóa vĩnh viễn cấu trúc!`)) {
        return;
      }

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
    }, 50);
  };

  const handleTruncateTable = (tableName: string) => {
    setTimeout(async () => {
      if (!confirm(`Xóa sạch TOÀN BỘ dữ liệu trong bảng "${tableName}"? Cấu trúc bảng vẫn được giữ nguyên. Hành động này không thể hoàn tác.`)) {
        return;
      }
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
    }, 50);
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
            <div style={{
              position: 'absolute', top: 'calc(100% + 2px)', left: '8px', right: '8px', zIndex: 999,
              background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: '320px', overflowY: 'auto', padding: '4px 0'
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
                      <Trash2 size={12} style={{ opacity: 0.6, color: '#ef4444' }} />
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
            <div className="sidebar-item" onClick={onBackupRestore}>
              <Database size={14} className="title-bar-logo" />
              <span>Sao lưu & Phục hồi</span>
            </div>
            <div style={{ position: 'relative' }}>
              <div className="sidebar-item" onClick={() => setShowTermMenu(v => !v)}>
                <TerminalSquare size={14} className="title-bar-logo" />
                <span>Terminal</span>
                <ChevronDown size={12} style={{ marginLeft: 'auto', opacity: 0.6 }} />
              </div>
              {showTermMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowTermMenu(false)} />
                  <div style={{ position: 'absolute', left: '8px', top: '100%', minWidth: '190px', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 999, padding: '4px 0' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Plus
                size={12}
                style={{ cursor: 'pointer' }}
                onClick={handleCreateTable}
              />
              <RefreshCw
                size={11}
                style={{ cursor: 'pointer', transform: refreshing ? 'rotate(180deg)' : 'none', transition: 'all 0.5s ease' }}
                onClick={fetchTables}
              />
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
                      handleDropTable(t.name);
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

      {/* Floating Context Menu */}
      {contextMenu && (() => {
        const isView = tables.find(t => t.name === contextMenu.tableName)?.type === 'view';
        return (
          <div style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 99999,
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            padding: '4px 0',
            minWidth: '150px'
          }}>
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
                  handleTruncateTable(contextMenu.tableName);
                }}
                style={{ padding: '6px 12px', fontSize: '11px', color: '#f59e0b', cursor: 'pointer' }}
                className="sidebar-context-item"
              >
                Xóa sạch dữ liệu (Truncate)
              </div>
            )}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                handleDropTable(contextMenu.tableName);
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-accent)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {isView ? 'Xóa khung nhìn (Drop View)' : 'Xóa bảng (Drop Table)'}
            </div>
          </div>
        );
      })()}

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
                style={{ height: '24px', fontSize: '11px', padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
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
              <button className="btn btn-secondary" onClick={() => setShowCreateDb(false)} style={{ height: '26px', fontSize: '11px', padding: '0 12px' }}>Hủy</button>
              <button className="btn btn-primary" onClick={handleCreateDatabase} style={{ height: '26px', fontSize: '11px', padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Tạo</button>
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
              <button className="btn btn-secondary" onClick={() => setRenameDbState(null)} style={{ height: '26px', fontSize: '11px', padding: '0 12px' }}>Hủy</button>
              <button className="btn btn-primary" onClick={handleRenameDatabase} style={{ height: '26px', fontSize: '11px', padding: '0 12px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Đổi tên</button>
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
              <button className="btn btn-primary" onClick={() => setObjDef(null)} style={{ background: '#10b981', borderColor: '#10b981' }}>Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
