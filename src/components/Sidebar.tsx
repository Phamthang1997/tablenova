import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { dbHelper } from '../utils/dbHelper';
import type { TableItem } from '../utils/dbHelper';
import { Search, Table, Terminal, TerminalSquare, LogOut, RefreshCw, Layers, Plus, ChevronDown, ChevronRight, Trash2, Check, Pencil, Braces, Cog, Info, BarChart3 } from 'lucide-react';
import { CreateTableModal } from './CreateTableModal';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { openTerminalWindow } from '../utils/terminalWindow';
import { PanelBottom, ExternalLink, GitCompare, ArrowLeftRight, HardDriveDownload, HardDriveUpload, Wand2 } from 'lucide-react';

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
}

export const Sidebar: React.FC<SidebarProps> = ({
  dbName,
  dbType,
  readOnly = false,
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
  onCompareDatabases,
  onGenerateData,
  onTableRenamed,
  onTableDropped,
  onDatabaseChanged,
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
      alert(t('sidebar.errSwitchDb', { message: res.error }));
    }
  };

  const handleDropDatabase = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (blockedByReadOnly()) return;
    if (name === dbName) {
      alert(t('sidebar.errDropCurrentDb'));
      return;
    }
    setShowDbMenu(false);
    setDestructive({ kind: 'drop-db', dbName: name });
  };

  const runDropDatabase = async (name: string) => {
    if (blockedByReadOnly()) return;
    const res = await dbHelper.dropDatabase(name);
    if (res.success) {
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
    } else {
      alert(t('sidebar.errDropDb', { message: res.error }));
    }
  };

  const openCreateDb = async () => {
    if (blockedByReadOnly()) return;
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
      const list = await dbHelper.listDatabases();
      setDbList(list.databases || []);
      if (confirm(t('sidebar.createdDbSwitch', { name }))) {
        handleSwitchDatabase(name);
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

  const handleTableContextMenu = (e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tableName
    });
  };

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

  // Drop/Truncate đi qua ConfirmDialog trong app (thay window.confirm) — xem state `destructive`.
  const runDropTable = async (tableName: string) => {
    if (blockedByReadOnly()) return;
    const tableItem = tables.find(item => item.name === tableName);
    const isView = tableItem?.type === 'view';
    const object = isView ? t('sidebar.objectView') : t('sidebar.objectTable');

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

  const runTruncateTable = async (tableName: string) => {
    if (blockedByReadOnly()) return;
    try {
      const res = await dbHelper.truncateTable(tableName);
      if (res.success) {
        alert(t('sidebar.truncateSuccess'));
        // Báo cho các panel đang mở bảng này refetch
        window.dispatchEvent(new CustomEvent('database-restored'));
      } else {
        alert(t('sidebar.errTruncate', { message: res.error }));
      }
    } catch (e: any) {
      alert(t('common.connectionError', { message: e.message }));
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

  // Do not name the callback parameter `t` here or in the maps/filters below:
  // `t` is the translation function, and shadowing it hides it from the body.
  const filteredTables = tables.filter((item) =>
    removeAccents(item.name).includes(removeAccents(searchTerm))
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
          title={canManageDatabases ? t('sidebar.switchDbHint', { name: dbName }) : dbName}
          onClick={() => (showDbMenu ? setShowDbMenu(false) : openDbMenu())}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', cursor: canManageDatabases ? 'pointer' : 'default' }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dbName}</span>
          {canManageDatabases && <ChevronDown size={13} style={{ flexShrink: 0, opacity: switching ? 0.4 : 0.8 }} />}
        </div>
        <div className="sidebar-db-status">
          <span className="sidebar-db-status-dot"></span>
          <span>
            {dbType.toUpperCase()} • {switching ? t('sidebar.switchingDatabase') : t('sidebar.connected')}
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
                {t('sidebar.databases')} {dbLoading ? t('sidebar.databasesLoading') : t('sidebar.databasesCount', { n: dbList.length })}
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
                      title={t('sidebar.renameDatabase')}
                      style={{ display: 'flex', flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); setShowDbMenu(false); setRenameDbState({ oldName: db, value: db }); }}
                    >
                      <Pencil size={12} style={{ opacity: 0.6, color: 'var(--win-text-secondary)' }} />
                    </span>
                  )}
                  {db !== dbName && (
                    <span
                      title={t('sidebar.dropDatabase')}
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
                <Plus size={12} /> {t('sidebar.createDatabase')}
              </div>
              {onOpenAllDbStats && (
                <div
                  onClick={() => { setShowDbMenu(false); onOpenAllDbStats(); }}
                  className="sidebar-context-item"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer', color: 'var(--win-text-primary)' }}
                >
                  <BarChart3 size={12} /> {t('sidebar.allDatabaseStats')}
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
            placeholder={t('sidebar.searchPlaceholder')}
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
          <div className="sidebar-section-title">{t('sidebar.toolsSection')}</div>
          <div className="sidebar-list">
            <div className="sidebar-item" onClick={onNewQuery}>
              <Terminal size={14} className="title-bar-logo" />
              <span>{t('sidebar.sqlEditor')}</span>
            </div>
            {/* Terminal đi cùng nhóm "chạy lệnh" với Trình viết SQL */}
            <div style={{ position: 'relative' }}>
              <div className="sidebar-item" onClick={() => setShowTermMenu(v => !v)}>
                <TerminalSquare size={14} className="title-bar-logo" />
                <span>{t('sidebar.terminal')}</span>
                <ChevronDown size={12} style={{ marginLeft: 'auto', opacity: 0.6 }} />
              </div>
              {showTermMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setShowTermMenu(false)} />
                  <div className="ws-menu" style={{ position: 'absolute', left: '8px', top: 'calc(100% + 4px)', minWidth: '190px', zIndex: 999 }}>
                    <button className="context-menu-item" onClick={() => { setShowTermMenu(false); onOpenTerminal(); }}>
                      <PanelBottom size={13} /> {t('sidebar.terminalInTab')}
                    </button>
                    <button className="context-menu-item" onClick={() => { setShowTermMenu(false); openTerminalWindow(terminalConfig || { type: dbType }, dbName); }}>
                      <ExternalLink size={13} /> {t('sidebar.terminalNewWindow')}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Nhóm 2: xem và so cấu trúc — chỉ đọc */}
            {(onOpenDbInfo || onSchemaMigration || onCompareDatabases) && <div className="sidebar-tools-sep" />}
            {onOpenDbInfo && (
              <div className="sidebar-item" onClick={onOpenDbInfo}>
                <Info size={14} className="title-bar-logo" />
                <span>{t('sidebar.databaseInfo')}</span>
              </div>
            )}
            {onSchemaMigration && (
              <div className="sidebar-item" onClick={onSchemaMigration}>
                <GitCompare size={14} className="title-bar-logo" />
                <span>{t('sidebar.schemaMigration')}</span>
              </div>
            )}
            {/* So hai database ĐANG chạy — khác với Diff Schema ở trên (so với snapshot đã lưu) */}
            {onCompareDatabases && (
              <div className="sidebar-item" onClick={onCompareDatabases}>
                <ArrowLeftRight size={14} className="title-bar-logo" />
                <span>{t('sidebar.compareDatabases')}</span>
              </div>
            )}

            {/* Nhóm 3: chuyển dữ liệu vào/ra — ít dùng nhất và Nhập thì có ghi dữ liệu,
                nên để cuối; xuất (an toàn) đứng trước nhập (ghi đè được) */}
            <div className="sidebar-tools-sep" />
            {onGenerateData && (
              <div
                className="sidebar-item"
                onClick={() => {
                  if (blockedByReadOnly()) return;
                  onGenerateData();
                }}
              >
                <Wand2 size={14} className="title-bar-logo" />
                <span>{t('sidebar.generateData')}</span>
              </div>
            )}
            <div className="sidebar-item" onClick={onExportDatabase}>
              <HardDriveDownload size={14} className="title-bar-logo" />
              <span>{t('sidebar.exportDatabase')}</span>
            </div>
            <div className="sidebar-item" onClick={onImportDatabase}>
              <HardDriveUpload size={14} className="title-bar-logo" />
              <span>{t('sidebar.importDatabase')}</span>
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
              title={t('sidebar.toggleSection')}
            >
              {isOpen('tables') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('sidebar.tablesSection', { n: filteredTables.length })}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }}>
              <button
                type="button"
                className={`sidebar-section-btn accent ${showAddMenu ? 'is-active' : ''}`}
                title={t('sidebar.createNew')}
                aria-label={t('sidebar.createNew')}
                onClick={() => setShowAddMenu((v) => !v)}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className="sidebar-section-btn"
                title={t('sidebar.refreshTables')}
                aria-label={t('sidebar.refreshTables')}
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
                      <Table size={13} /> {t('sidebar.createTable')}
                    </button>
                    <button className="context-menu-item" onClick={() => { setShowAddMenu(false); setNewView({ name: '', sql: '' }); setCreateViewError(null); setShowCreateView(true); }}>
                      <Layers size={13} /> {t('sidebar.createView')}
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
              filteredTables.map((item) => (
                <div
                  key={item.name}
                  className={`sidebar-item ${activeTable === item.name ? 'active' : ''}`}
                  tabIndex={0}
                  onClick={() => onSelectTable(item.name)}
                  onContextMenu={(e) => handleTableContextMenu(e, item.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault();
                      e.stopPropagation(); // tránh kích hoạt Delete-xóa-dòng của DataGrid
                      if (blockedByReadOnly()) return;
                      setDestructive({ kind: 'drop-table', tableName: item.name, isView: item.type === 'view' });
                    }
                  }}
                  title={t('sidebar.tableItemHint', { name: item.name })}
                >
                  {item.type === 'view' ? <Layers size={14} className="icon-view" /> : <Table size={14} className="icon-table" />}
                  <span>{item.name}</span>
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
              title={t('sidebar.toggleSection')}
            >
              {isOpen('functions') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('sidebar.functionsSection', { n: filteredFunctions.length })}
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
              title={t('sidebar.toggleSection')}
            >
              {isOpen('procedures') ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('sidebar.proceduresSection', { n: filteredProcedures.length })}
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
          <span>{t('sidebar.disconnect')}</span>
        </button>
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
                  setDestructive({ kind: 'truncate', tableName: contextMenu.tableName });
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
                setDestructive({ kind: 'drop-table', tableName: contextMenu.tableName, isView });
              }}
              style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--win-accent)', cursor: 'pointer' }}
              className="sidebar-context-item"
            >
              {isView ? t('sidebar.ctxDropView') : t('sidebar.ctxDropTable')}
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
            ? t('sidebar.confirmTruncateTitle')
            : destructive?.kind === 'drop-db'
              ? t('sidebar.confirmDropDbTitle')
              : destructive?.isView
                ? t('sidebar.confirmDropViewTitle')
                : t('sidebar.confirmDropTableTitle')
        }
        message={
          destructive?.kind === 'truncate' ? (
            <Trans
              i18nKey="sidebar.confirmTruncateMessage"
              values={{ name: destructive.tableName }}
              components={{ strong: <b />, code: <b style={{ fontFamily: 'monospace' }} /> }}
            />
          ) : destructive?.kind === 'drop-db' ? (
            <Trans
              i18nKey="sidebar.confirmDropDbMessage"
              values={{ name: destructive.dbName }}
              components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
            />
          ) : destructive?.kind === 'drop-table' ? (
            <Trans
              i18nKey="sidebar.confirmDropTableMessage"
              values={{
                object: destructive.isView ? t('sidebar.objectView') : t('sidebar.objectTable'),
                name: destructive.tableName,
              }}
              components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
            />
          ) : null
        }
        note={t('sidebar.confirmIrreversible')}
        confirmLabel={destructive?.kind === 'truncate' ? t('sidebar.confirmTruncateLabel') : t('sidebar.confirmDeleteLabel')}
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

      {objDef && (
        <Modal
          title={<>{objDef.kind === 'procedure' ? t('sidebar.objDefProcedure') : objDef.kind === 'function' ? t('sidebar.objDefFunction') : t('sidebar.objDefView')} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{objDef.name}</span></>}
          onClose={() => setObjDef(null)}
          width="680px"
          maxWidth="92%"
          maxHeight="82vh"
          zIndex={999999}
        >
          <ModalBody style={{ gap: 0, flex: 1, background: 'var(--win-bg-window)' }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
              {objDef.sql}
            </pre>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => { navigator.clipboard.writeText(objDef.sql).catch(() => {}); }}>{t('common.copy')}</button>
            <button className="btn btn-primary" onClick={() => setObjDef(null)} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>{t('common.close')}</button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};
