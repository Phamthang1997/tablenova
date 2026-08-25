import React, { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Minus, Square, X, Plus, Unplug, FileCode, HardDriveDownload, HardDriveUpload,
  PanelLeft, SunMoon, RotateCw, Info, Keyboard, Check, Database,
  GitBranch, PanelBottom, Bot, ChevronRight, ChevronLeft, BookOpen, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SUPPORTED_LANGUAGES, currentLanguage } from '../i18n';
import { DbConnectionStatusPill } from './DbConnectionStatusPill';
import { TxControl } from './TxControl';
import { SafeModeControl } from './SafeModeControl';
import { JobsTray } from './JobsTray';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { QuickSwitcherPopover, type SwitcherConn } from './QuickSwitcherPopover';
import type { SavedProfile } from './ConnectionManager';
import { dbHelper } from '../utils/dbHelper';
import type { ConnectionStatus } from '../utils/dbHelper';
import type { ConnEnv } from '../utils/connEnv';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface TitleBarProps {
  hasConnection: boolean;
  /** Kết nối currently display — `TxControl` filter sự kiện `tx-state-changed` theo id này. */
  connId?: string;
  /** `connKey(config)` of kết nối currently xem — Safe Mode save theo server. Xem SafeModeControl.tsx. */
  connKey?: string;
  readOnly?: boolean;
  onToggleReadOnly?: () => void;
  activeConnectionInfo?: {
    host?: string;
    dbType?: string;
    dbName?: string;
    version?: string;
    tls?: string;
  };
  /** Tên + màu of profile currently kết nối, display & edit is in popover kết nối. */
  activeProfileName?: string;
  activeProfileColor?: string;
  /** environment of kết nối currently xem. Trường riêng of profile, not suy from màu. */
  activeProfileEnv?: ConnEnv;
  onProfileChange?: (patch: { name?: string; color?: string; env?: ConnEnv }) => void;
  theme?: 'dark' | 'light';
  onThemeChange?: (theme: 'dark' | 'light') => void;
  onReconnect?: () => Promise<{ success: boolean; message?: string }>;
  activeTableName?: string | null;
  onNewConnection?: () => void;
  onDisconnect?: () => void;
  onNewQuery?: () => void;
  onExportDatabase?: () => void;
  onImportDatabase?: () => void;
  onToggleSidebar?: () => void;
  onToggleTheme?: () => void;
  onShowShortcuts?: () => void;
  onShowAbout?: () => void;
  onShowWhatsNew?: () => void;
  onToggleTerminal?: () => void;
  /** Panel AI Copilot currently open -> tô nút bằng màu accent. */
  aiOpen?: boolean;
  onToggleAiAssistant?: () => void;
  /** user select một database khác -> backend already open nó thành kết nối MỚI (`open_database`). */
  onDatabaseOpened?: (connId: string, dbName: string, schema?: string | null) => void;
  /**
   * Kết nối currently open, for Quick Switcher. Truyền ando chứ not read `list_connections` at đây: nhãn,
   * environment and config chỉ App biết (backend not trả config vì nó mang credential).
   */
  openConns?: SwitcherConn[];
  onSelectConnection?: (connId: string) => void;
  onConnectSavedProfile?: (profile: SavedProfile) => void;
  onOpenAllDbStats?: () => void;
  onOpenDocs?: () => void;
  onOpenCompare?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  hasConnection,
  connId,
  connKey = '',
  readOnly = false,
  onToggleReadOnly,
  activeConnectionInfo,
  activeProfileName = '',
  activeProfileColor = '',
  activeProfileEnv = 'none',
  onProfileChange,
  theme: _theme = 'dark',
  onThemeChange: _onThemeChange,
  onReconnect,
  activeTableName,
  onNewConnection,
  onDisconnect,
  onNewQuery,
  onExportDatabase,
  onImportDatabase,
  onToggleSidebar,
  onToggleTheme,
  onShowShortcuts,
  onShowAbout,
  onShowWhatsNew,
  onToggleTerminal,
  aiOpen = false,
  onToggleAiAssistant,
  onDatabaseOpened,
  openConns = [],
  onSelectConnection,
  onConnectSavedProfile,
  onOpenAllDbStats,
  onOpenDocs,
  onOpenCompare,
}) => {
  const { t, i18n } = useTranslation();
  // Cascading menu: the root panel only lists category names; the items of a
  // category live in a submenu that opens to the right on hover.
  const [menuOpen, setMenuOpen] = useState(false);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Database Switcher Popover state
  const [showDbPopover, setShowDbPopover] = useState(false);
  const [dbPopoverPos, setDbPopoverPos] = useState<{ top: number; left: number } | null>(null);
  /** Nút database — neo of popover, cần cả when open bằng Ctrl+P (not có sự kiện chuột). */
  const dbBtnRef = useRef<HTMLButtonElement>(null);
  const [showCreateDbModal, setShowCreateDbModal] = useState(false);
  /** Database awaiting drop confirmation — see handleDropDb. */
  const [dropDbTarget, setDropDbTarget] = useState<string | null>(null);
  const [newDbName, setNewDbName] = useState('');

  // Connection details popover state
  const [showConnPopover, setShowConnPopover] = useState(false);
  const [connPopoverPos, setConnPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // status phiên: hỏi at đây chứ not at DbConnectionStatusPill, vì cả row
  // chữ giữa title bar lẫn popover chi tiết đều read chung một nguồn — trước
  // đây version/TLS on row chữ is giá trị cứng in App.tsx.
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    if (!hasConnection) {
      setConnStatus(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const info = await dbHelper.getConnectionStatus();
        if (alive && info.isConnected) setConnStatus(info);
      } catch {
        // Ping error: preserve số liệu cũ, not delete trắng cụm status.
      }
    };
    refresh();
    const timer = setInterval(refresh, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hasConnection]);

  const handleOpenConnPopover = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!hasConnection) return;
    if (showConnPopover) {
      setShowConnPopover(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Neo giữa cụm status, kẹp in màn hình to popover not tràn ra ngoài.
    const width = 320;
    const left = Math.min(
      Math.max(10, rect.left + rect.width / 2 - width / 2),
      Math.max(10, window.innerWidth - width - 10),
    );
    setConnPopoverPos({ top: rect.bottom + 6, left });
    setShowConnPopover(true);
  };

  // Danh sách database do `QuickSwitcherPopover` tự load when nó open — not load trước at đây nữa: ism
  // vậy thì popup chỉ hiện sau when query xong, tức bấm rồi must wait mới thấy gì.
  //
  // position tính from ref of nút, not from `e.currentTarget`: `Ctrl+Shift+P` cũng open popover này and
  // bàn phím not có sự kiện chuột nào to read toạ độ ra.
  const openDbPopover = () => {
    if (!hasConnection) return;
    const rect = dbBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDbPopoverPos({ top: rect.bottom + 6, left: Math.max(10, rect.left - 100) });
    setShowDbPopover(true);
  };

  const handleOpenDbPopover = () => openDbPopover();

  /**
   * Phím tắt điều hướng, theo đúng quy ước VS Code — nơi user already có phản xạ sẵn.
   *
   *   `Ctrl+Shift+P` → Quick Switcher (VS Code: Command Palette)
   *   `Ctrl+B`       → hide/hiện sidebar
   *   `Ctrl+K`       → focus ô search of Sidebar (preserve, xem `Sidebar.tsx`)
   *
   * `Ctrl+P` trơn cố ý to trống. Trước đây nó mang **hai** nghĩa and not nghĩa nào is cái user
   * thấy: menu quảng cáo nó is "hide/hiện sidebar", còn listener of Sidebar giành nó trước to focus
   * ô search. Giờ mỗi phím có đúng một nghĩa, and nhãn in menu nói đúng thứ will xảy ra.
   *
   * with Shift giữ, `e.key` of phím P is `'P'` — nên must `toLowerCase()` rồi mới so.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && e.shiftKey) {
        e.preventDefault();
        if (showDbPopover) setShowDbPopover(false);
        else openDbPopover();
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `openDbPopover` read `hasConnection` and ref; ref ổn định, nên đây is toàn bộ deps thật.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDbPopover, hasConnection, onToggleSidebar]);

  const handleSwitchDb = async (name: string) => {
    if (name === activeConnectionInfo?.dbName) return;
    // Picking a database OPENS it as another connection rather than switching this one onto it.
    // Switching replaced the pool, so it had to refuse whenever the current database had
    // uncommitted work — a refusal the user could not clear without losing that work. Opening adds
    // a pool on the same `ServerHandle` (same tunnel, same credentials, no re-auth), so there is
    // nothing to refuse and the transaction on the old database keeps running.
    const res = await dbHelper.openDatabase(connId || '', name);
    if (res.success && res.connId) {
      onDatabaseOpened?.(res.connId, res.database || name, res.schema);
    } else {
      alert(t('sidebar.errOpenDb', { message: res.error || '' }));
    }
  };

  /**
   * Opens the drop-database confirmation.
   *
   * Deliberately NOT `window.confirm`: inside the Tauri webview it is replaced by a call to
   * `plugin:dialog|confirm`, and dialog 2.7.2 only ships `message`/`open`/`save` — the call
   * throws "Command not found" and the user sees nothing at all. `alert()` still works
   * because it maps to `message`. Use the app's ConfirmDialog, like every other delete.
   */
  const handleDropDb = (name: string) => {
    if (readOnly) {
      alert(t('sidebar.errReadOnly'));
      return;
    }
    if (name === activeConnectionInfo?.dbName) {
      alert(t('sidebar.errDropCurrentDb'));
      return;
    }
    setDropDbTarget(name);
  };

  const confirmDropDb = async () => {
    const name = dropDbTarget;
    setDropDbTarget(null);
    if (!name) return;
    const res = await dbHelper.dropDatabase(name);
    if (!res.success) alert(t('sidebar.errDropDb', { message: res.error || '' }));
  };

  const handleCreateDbSubmit = async () => {
    if (!newDbName.trim()) return;
    const res = await dbHelper.createDatabase(connId || '', { name: newDbName.trim() });
    if (res.success) {
      setShowCreateDbModal(false);
      setNewDbName('');
      handleSwitchDb(newDbName.trim());
    } else {
      alert(t('quickSwitcher.errCreateDb', { message: res.error || '' }));
    }
  };

  // row chữ giữa title bar. Ưu tiên số liệu thật of phiên, lùi về
  // activeConnectionInfo when lần ping đầu chưa về. Postgres trả version dạng
  // "16.2 (Debian 16.2-1...)" nên chỉ lấy token đầu, kẻo đẩy phần còn lại ra ngoài.
  const statusLine = React.useMemo(() => {
    const host = connStatus?.host || activeConnectionInfo?.host || 'LOCAL';
    const driver = (connStatus?.dbType || activeConnectionInfo?.dbType || '').toUpperCase();
    const version = (connStatus?.serverVersion || activeConnectionInfo?.version || '').split(' ')[0];
    const tls = connStatus?.tlsVersion || activeConnectionInfo?.tls || '';
    const db = connStatus?.database || activeConnectionInfo?.dbName || '';
    const tail = [[driver, version].filter(Boolean).join(' '), tls, db, activeTableName]
      .filter(Boolean)
      .join(' : ');
    return tail ? `${host} | ${tail}` : host;
  }, [connStatus, activeConnectionInfo, activeTableName]);

  useEffect(() => {
    const closeDropdown = () => {
      setMenuOpen(false);
      setOpenCategory(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDropdown();
    };
    window.addEventListener('click', closeDropdown);
    window.addEventListener('contextmenu', closeDropdown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeDropdown);
      window.removeEventListener('contextmenu', closeDropdown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.toggleMaximize();
    } catch (error) {
      console.error('Failed to toggle maximize window:', error);
    }
  };

  const handleClose = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.close();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  };

  interface MenuItem {
    label: string;
    Icon: LucideIcon;
    onClick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    shortcut?: string;
    separatorBefore?: boolean;
    checked?: boolean;
  }

  const activeLang = currentLanguage();

  const menuCategories: { title: string; items: MenuItem[] }[] = [
    {
      title: t('titlebar.menuConnection'),
      items: [
        { label: t('titlebar.newConnection'), Icon: Plus, onClick: onNewConnection },
        { label: t('titlebar.disconnect'), Icon: Unplug, onClick: onDisconnect, danger: true, disabled: !hasConnection, separatorBefore: true },
      ],
    },
    {
      title: t('titlebar.menuDatabase'),
      items: [
        { label: t('titlebar.newQuery'), Icon: FileCode, onClick: onNewQuery, shortcut: 'Ctrl+T', disabled: !hasConnection },
        { label: t('titlebar.exportDatabase'), Icon: HardDriveDownload, onClick: onExportDatabase, disabled: !hasConnection, separatorBefore: true },
        { label: t('titlebar.importDatabase'), Icon: HardDriveUpload, onClick: onImportDatabase, disabled: !hasConnection },
      ],
    },
    {
      title: t('titlebar.menuView'),
      items: [
        // `Ctrl+B` chứ not must `Ctrl+P`: nhãn cũ chưa bao giờ đúng vì listener of Sidebar giành
        // Ctrl+P trước to focus ô search. Giờ nhãn này có một binding thật đứng sau nó.
        { label: t('titlebar.toggleSidebar'), Icon: PanelLeft, onClick: onToggleSidebar, shortcut: 'Ctrl+B', disabled: !hasConnection },
        { label: t('titlebar.toggleTheme'), Icon: SunMoon, onClick: onToggleTheme },
        { label: t('titlebar.reload'), Icon: RotateCw, onClick: () => window.location.reload(), separatorBefore: true },
      ],
    },
    {
      title: `${t('language.label')} / 言語`,
      items: SUPPORTED_LANGUAGES.map((lang) => ({
        label: `${lang.flag} ${t(lang.labelKey)}`,
        Icon: Check,
        checked: lang.code === activeLang,
        onClick: () => { i18n.changeLanguage(lang.code); },
      })),
    },
    {
      title: t('titlebar.menuHelp'),
      items: [
        { label: t('docs.title'), Icon: BookOpen, onClick: onOpenDocs, shortcut: 'F1' },
        { label: t('titlebar.shortcuts'), Icon: Keyboard, onClick: onShowShortcuts },
        { label: t('titlebar.whatsNew'), Icon: Sparkles, onClick: onShowWhatsNew },
        { label: t('titlebar.about'), Icon: Info, onClick: onShowAbout, separatorBefore: true },
      ],
    },
  ];

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /**
   * Một nút of cụm công cụ. `offline` = vẫn hiện when chưa kết nối; App.tsx build
   * ConnectionManager đúng when `!hasConnection`, nên cờ này cũng chính is "nút
   * này có nghĩa gì at màn hình quản lý kết nối not" — mọi nút thao tác on DB
   * đều is hide hẳn at đó thay vì hiện ra under dạng xám not bấm is.
   */
  interface Tool {
    key: string;
    offline?: boolean;
    el: React.ReactNode;
  }

  // build các cụm công cụ theo nhóm logic.
  // Gạch ngăn chỉ xuất hiện giữa các nhóm chức năng, not xuất hiện giữa fromng nút lẻ.
  const renderCapsuleGroups = (groups: Tool[][]) => {
    const visibleGroups = groups
      .map(grp => grp.filter(tool => hasConnection || tool.offline))
      .filter(grp => grp.length > 0);

    if (visibleGroups.length === 0) return null;

    return (
      <div className="tb-capsule">
        {visibleGroups.map((grp, grpIdx) => (
          <React.Fragment key={grpIdx}>
            {grpIdx > 0 && <div className="tb-capsule-divider" />}
            <div className="tb-capsule-group">
              {grp.map(tool => (
                <React.Fragment key={tool.key}>{tool.el}</React.Fragment>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  };

  // at màn kết nối, sidebar run lên sát đỉnh window nên góc trái title bar
  // not còn is of thanh nữa — nút ⋮ chuyển sang cụm must. Menu vì thế must
  // open ngược hướng: neo mép must and bung menu con sang trái, not thì nó tràn
  // ra ngoài màn hình.
  const menuOnRight = !hasConnection;

  const menuTool: Tool = {
    key: 'menu',
    offline: true,
    el: (
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <button
          className={`tb-capsule-btn ${menuOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(prev => !prev);
            setOpenCategory(null);
          }}
          title={t('titlebar.menu')}
        >
          <span style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1 }}>⋮</span>
        </button>

        {menuOpen && (
          <div
            className={`title-bar-dropdown tb-menu-root ${menuOnRight ? 'tb-menu-flip' : ''}`}
            style={{ top: '42px' }}
            onClick={(e) => e.stopPropagation()}
          >
            {menuCategories.map(cat => (
              <div
                key={cat.title}
                className={`tb-menu-cat ${openCategory === cat.title ? 'open' : ''}`}
                onMouseEnter={() => setOpenCategory(cat.title)}
                onClick={() => setOpenCategory(cat.title)}
              >
                <span className="tb-menu-cat-label">{cat.title}</span>
                {menuOnRight
                  ? <ChevronLeft size={13} className="tb-menu-cat-arrow" />
                  : <ChevronRight size={13} className="tb-menu-cat-arrow" />}

                {openCategory === cat.title && (
                  <div className="title-bar-dropdown tb-menu-sub">
                    {cat.items.map(item => (
                      <React.Fragment key={item.label}>
                        {item.separatorBefore && <div className="title-bar-dropdown-sep" />}
                        <div
                          className={`title-bar-dropdown-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.disabled) return;
                            if (item.onClick) item.onClick();
                            setMenuOpen(false);
                            setOpenCategory(null);
                          }}
                        >
                          {item.checked === undefined ? (
                            <item.Icon size={14} className="title-bar-dropdown-icon" />
                          ) : (
                            <span className="title-bar-dropdown-icon" style={{ width: '14px', display: 'inline-flex' }}>
                              {item.checked && <Check size={14} />}
                            </span>
                          )}
                          <span className="title-bar-dropdown-label">{item.label}</span>
                          {item.shortcut && <span className="title-bar-dropdown-shortcut">{item.shortcut}</span>}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  };

  const leftToolGroups: Tool[][] = [
    // Nhóm 1: Điều hướng & Menu chính
    [
      {
        key: 'sidebar',
        el: (
          <button className="tb-capsule-btn" onClick={onToggleSidebar} title={t('titlebar.toggleSidebar')}>
            <PanelLeft size={14} />
          </button>
        ),
      },
      ...(menuOnRight ? [] : [menuTool]),
    ],
    // Nhóm 2: Quản lý kết nối & mode an toàn
    [
      {
        key: 'new-connection',
        el: (
          <button className="tb-capsule-btn" onClick={onNewConnection} title={t('titlebar.newConnection')}>
            <Unplug size={14} />
          </button>
        ),
      },
      {
        key: 'disconnect',
        el: (
          <button className="tb-capsule-btn" onClick={onDisconnect} disabled={!hasConnection} title={t('titlebar.disconnect')}>
            <X size={14} />
          </button>
        ),
      },
      {
        // Chỉ read is mức khắt khe nhất of cùng một thang "kết nối này bảo vệ tới đâu", nên nó nằm
        // in menu Safe Mode chứ not còn is công tắc riêng: hai nút cạnh nhau bắt user
        // suy ra from hai chỗ mới biết một câu DELETE will ra sao. Xem SafeModeControl.tsx.
        key: 'safe-mode',
        el: (
          <SafeModeControl
            connected={hasConnection}
            connKey={connKey}
            readOnly={readOnly}
            onToggleReadOnly={onToggleReadOnly}
            connId={connId}
            dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || '').toLowerCase()}
          />
        ),
      },
    ],
    // Nhóm 3: Công cụ Database & Query Editor
    [
      {
        key: 'databases',
        el: (
          <button
            ref={dbBtnRef}
            className="tb-capsule-btn"
            onClick={handleOpenDbPopover}
            disabled={!hasConnection}
            title={`${t('titlebar.menuDatabase')} (Ctrl+Shift+P)`}
          >
            <Database size={13} />
          </button>
        ),
      },
      {
        key: 'sql',
        el: (
          <button
            className="tb-capsule-btn tb-capsule-btn-sql"
            onClick={onNewQuery}
            disabled={!hasConnection}
            title={t('titlebar.newQuery')}
          >
            <FileCode size={13} />
            <span>{t('titlebar.sqlButton')}</span>
          </button>
        ),
      },
    ],
  ];

  const rightToolGroups: Tool[][] = [
    // Nhóm 1: Công cụ ism việc chính (Docs, compare, Terminal, AI Copilot)
    [
      ...(menuOnRight ? [menuTool] : []),
      {
        key: 'docs',
        offline: true,
        el: (
          <button
            className="tb-capsule-btn tb-capsule-btn-docs"
            onClick={onOpenDocs}
            title={t('docs.title') + ' (F1)'}
          >
            <BookOpen size={13} style={{ color: 'var(--win-accent)' }} />
            <span>Docs</span>
          </button>
        ),
      },
      {
        key: 'compare',
        el: (
          <button
            className="tb-capsule-btn"
            disabled={!hasConnection}
            onClick={onOpenCompare}
            title={t('titlebar.schemaCompare')}
          >
            <GitBranch size={13} />
          </button>
        ),
      },
      {
        key: 'terminal',
        el: (
          <button className="tb-capsule-btn" onClick={onToggleTerminal} title={t('titlebar.toggleTerminal')}>
            <PanelBottom size={14} />
          </button>
        ),
      },
      {
        key: 'ai',
        el: (
          <button
            className={`tb-capsule-btn ${aiOpen ? 'is-active-accent' : ''}`}
            onClick={onToggleAiAssistant}
            title={t('app.toggleAiCopilot')}
          >
            <Bot size={14} />
          </button>
        ),
      },
    ],
    // Nhóm 2: Tiện ích hệ thống (Phím tắt & download lại)
    [
      {
        key: 'shortcuts',
        offline: true,
        el: (
          <button className="tb-capsule-btn" onClick={onShowShortcuts} title={t('titlebar.shortcuts')}>
            <Keyboard size={13} />
          </button>
        ),
      },
      {
        key: 'reload',
        offline: true,
        el: (
          <button className="tb-capsule-btn" onClick={() => window.location.reload()} title={t('titlebar.reload')}>
            <RotateCw size={13} />
          </button>
        ),
      },
    ],
  ];

  return (
    <div className={`title-bar ${hasConnection ? '' : 'title-bar-flat'}`} style={{ gap: '8px' }}>
      <div className="title-bar-left" style={{ gap: '6px' }}>
        {isMac && (
          <div className="mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '6px' }}>
            <button className="mac-traffic-btn mac-close" onClick={handleClose} title={t('titlebar.closeWindow')} />
            <button className="mac-traffic-btn mac-minimize" onClick={handleMinimize} title={t('titlebar.minimize')} />
            <button className="mac-traffic-btn mac-maximize" onClick={handleMaximize} title={t('titlebar.maximize')} />
          </div>
        )}

        {renderCapsuleGroups(leftToolGroups)}
      </div>

      {/* Center Status Capsule: Merged Connection Info + Speed Status Pill into 1 single capsule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, justifyContent: 'center' }}>
        {hasConnection && (
          <button
            type="button"
            className="tb-status-capsule"
            style={{ margin: 0, gap: '10px', justifyContent: 'center', maxWidth: '750px', padding: '0 14px' }}
            onClick={handleOpenConnPopover}
            title={t('connInfo.openTitle')}
          >
            {activeProfileColor && (
              <span
                aria-hidden
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: activeProfileColor,
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusLine}
            </span>
            <div style={{ height: '12px', width: '1px', background: 'var(--win-border)', opacity: 0.6, flexShrink: 0 }} />
            <DbConnectionStatusPill status={connStatus} />
          </button>
        )}
      </div>

      {/* Right Section: Unified Right Toolbar Capsule + Window Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, ...({ WebkitAppRegion: 'no-drag' } as any) }}>
        {/* Transaction thuộc về kết nối (một connection for cả app) nên control nằm at đây,
            not at toolbar of fromng tab. Xem TxControl.tsx. */}
        {/* Việc run nền: cùng lý do đặt chỗ with TxControl. Xem JobsTray.tsx. */}
        <JobsTray />
        <TxControl
          connected={hasConnection}
          connId={connId || ""}
          dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || "").toLowerCase()}
        />
        {renderCapsuleGroups(rightToolGroups)}

        {!isMac && (
          <div className="title-bar-right" style={{ marginLeft: '4px' }}>
            <button className="title-bar-btn" onClick={handleMinimize} title={t('titlebar.minimize')} aria-label={t('titlebar.minimize')}>
              <Minus size={13} />
            </button>
            <button className="title-bar-btn" onClick={handleMaximize} title={t('titlebar.maximize')} aria-label={t('titlebar.maximize')}>
              <Square size={11} />
            </button>
            <button className="title-bar-btn close" onClick={handleClose} title={t('titlebar.closeWindow')} aria-label={t('titlebar.closeWindow')}>
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      {showConnPopover && connPopoverPos && hasConnection && (
        <ConnectionInfoPopover
          anchor={connPopoverPos}
          status={connStatus}
          profileName={activeProfileName}
          profileColor={activeProfileColor}
          profileEnv={activeProfileEnv}
          onProfileChange={(patch) => onProfileChange?.(patch)}
          onDisconnect={() => {
            setShowConnPopover(false);
            onDisconnect?.();
          }}
          onReconnect={async () => (onReconnect ? onReconnect() : { success: false })}
          onEdit={() => {
            setShowConnPopover(false);
            onNewConnection?.();
          }}
          onClose={() => setShowConnPopover(false)}
        />
      )}

      {showDbPopover && dbPopoverPos && (
        <QuickSwitcherPopover
          anchor={dbPopoverPos}
          activeConnId={connId || ''}
          activeDbName={activeConnectionInfo?.dbName}
          openConns={openConns}
          onSelectConnection={(id) => onSelectConnection?.(id)}
          onConnectSavedProfile={(p) => onConnectSavedProfile?.(p)}
          onOpenDatabase={handleSwitchDb}
          onCreateDatabase={() => setShowCreateDbModal(true)}
          onDropDatabase={handleDropDb}
          onNewConnection={() => onNewConnection?.()}
          onOpenAllDbStats={() => onOpenAllDbStats?.()}
          onClose={() => setShowDbPopover(false)}
        />
      )}

      {/* Modal Create New Database */}
      {showCreateDbModal && (
        <Modal
          title={t('quickSwitcher.createDbTitle')}
          onClose={() => setShowCreateDbModal(false)}
          width="420px"
          zIndex={99999}
        >
          <ModalBody>
            <div className="form-group">
              <label>{t('quickSwitcher.createDbNameLabel')}</label>
              <input
                type="text"
                className="form-input"
                placeholder={t('quickSwitcher.createDbPlaceholder')}
                value={newDbName}
                onChange={(e) => setNewDbName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newDbName.trim()) void handleCreateDbSubmit(); }}
                autoFocus
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowCreateDbModal(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleCreateDbSubmit} disabled={!newDbName.trim()}>
              {t('quickSwitcher.createDbSubmit')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Drop-database confirmation. requireText: the name must be typed — dropping a
          database loses every table and row, and the trash icon sits right next to the
          selected row, which makes a misclick easy. */}
      <ConfirmDialog
        open={!!dropDbTarget}
        danger
        title={t('sidebar.confirmDropDbTitle')}
        message={<Trans i18nKey="sidebar.confirmDropDbMessage" values={{ name: dropDbTarget || '' }} />}
        note={t('sidebar.confirmIrreversible')}
        requireText={dropDbTarget || undefined}
        confirmLabel={t('sidebar.dropDatabase')}
        onConfirm={confirmDropDb}
        onCancel={() => setDropDbTarget(null)}
      />
    </div>
  );
};

