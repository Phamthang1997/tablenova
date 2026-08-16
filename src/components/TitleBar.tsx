import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  Minus, Square, X, Plus, Unplug, FileCode, HardDriveDownload, HardDriveUpload,
  PanelLeft, SunMoon, RotateCw, Info, Keyboard, Check, Database,
  GitBranch, PanelBottom, Bot, Lock, LockOpen, ChevronUp, ChevronRight, ChevronLeft, Trash2, BarChart3, BookOpen, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SUPPORTED_LANGUAGES, currentLanguage } from '../i18n';
import { DbConnectionStatusPill } from './DbConnectionStatusPill';
import { TxControl } from './TxControl';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { dbHelper } from '../utils/dbHelper';
import type { ConnectionStatus } from '../utils/dbHelper';
import type { ConnEnv } from '../utils/connEnv';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface TitleBarProps {
  hasConnection: boolean;
  /** Kết nối đang hiển thị — `TxControl` lọc sự kiện `tx-state-changed` theo id này. */
  connId?: string;
  readOnly?: boolean;
  onToggleReadOnly?: () => void;
  activeConnectionInfo?: {
    host?: string;
    dbType?: string;
    dbName?: string;
    version?: string;
    tls?: string;
  };
  /** Tên + màu của profile đang kết nối, hiển thị & sửa được trong popover kết nối. */
  activeProfileName?: string;
  activeProfileColor?: string;
  /** Môi trường của kết nối đang xem. Trường riêng của profile, không suy từ màu. */
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
  /** Panel AI Copilot đang mở -> tô nút bằng màu accent. */
  aiOpen?: boolean;
  onToggleAiAssistant?: () => void;
  /** Người dùng chọn một database khác -> backend đã mở nó thành kết nối MỚI (`open_database`). */
  onDatabaseOpened?: (connId: string, dbName: string, schema?: string | null) => void;
  onOpenAllDbStats?: () => void;
  onOpenDocs?: () => void;
  onOpenCompare?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  hasConnection,
  connId,
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
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbFilter, setDbFilter] = useState('');
  const [showCreateDbModal, setShowCreateDbModal] = useState(false);
  /** Database awaiting drop confirmation — see handleDropDb. */
  const [dropDbTarget, setDropDbTarget] = useState<string | null>(null);
  const [newDbName, setNewDbName] = useState('');

  // Connection details popover state
  const [showConnPopover, setShowConnPopover] = useState(false);
  const [connPopoverPos, setConnPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // Trạng thái phiên: hỏi ở đây chứ không ở DbConnectionStatusPill, vì cả dòng
  // chữ giữa thanh tiêu đề lẫn popover chi tiết đều đọc chung một nguồn — trước
  // đây version/TLS trên dòng chữ là giá trị cứng trong App.tsx.
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
        // Ping lỗi: giữ nguyên số liệu cũ, không xoá trắng cụm trạng thái.
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
    // Neo giữa cụm trạng thái, kẹp trong màn hình để popover không tràn ra ngoài.
    const width = 320;
    const left = Math.min(
      Math.max(10, rect.left + rect.width / 2 - width / 2),
      Math.max(10, window.innerWidth - width - 10),
    );
    setConnPopoverPos({ top: rect.bottom + 6, left });
    setShowConnPopover(true);
  };

  const handleOpenDbPopover = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!hasConnection) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDbPopoverPos({ top: rect.bottom + 6, left: Math.max(10, rect.left - 100) });
    setDbFilter('');
    setShowDbPopover(true);
    setDbLoading(true);
    try {
      const res = await dbHelper.listDatabases(connId || '');
      setDbList(res.databases || []);
    } catch (err) {
      console.error(err);
    } finally {
      setDbLoading(false);
    }
  };

  const handleSwitchDb = async (name: string) => {
    if (name === activeConnectionInfo?.dbName) {
      setShowDbPopover(false);
      return;
    }
    setShowDbPopover(false);
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
  const handleDropDb = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
    if (res.success) {
      setDbList(prev => prev.filter(d => d !== name));
    } else {
      alert(t('sidebar.errDropDb', { message: res.error || '' }));
    }
  };

  const handleCreateDbSubmit = async () => {
    if (!newDbName.trim()) return;
    const res = await dbHelper.createDatabase(connId || '', { name: newDbName.trim() });
    if (res.success) {
      setShowCreateDbModal(false);
      setNewDbName('');
      handleSwitchDb(newDbName.trim());
    } else {
      alert(`Error creating database: ${res.error}`);
    }
  };

  const filteredDbList = dbList.filter(d => d.toLowerCase().includes(dbFilter.toLowerCase().trim()));

  // Dòng chữ giữa thanh tiêu đề. Ưu tiên số liệu thật của phiên, lùi về
  // activeConnectionInfo khi lần ping đầu chưa về. Postgres trả version dạng
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
        { label: t('titlebar.toggleSidebar'), Icon: PanelLeft, onClick: onToggleSidebar, shortcut: 'Ctrl+P', disabled: !hasConnection },
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
   * Một nút của cụm công cụ. `offline` = vẫn hiện khi chưa kết nối; App.tsx dựng
   * ConnectionManager đúng khi `!hasConnection`, nên cờ này cũng chính là "nút
   * này có nghĩa gì ở màn hình quản lý kết nối không" — mọi nút thao tác trên DB
   * đều bị ẩn hẳn ở đó thay vì hiện ra dưới dạng xám không bấm được.
   */
  interface Tool {
    key: string;
    offline?: boolean;
    el: React.ReactNode;
  }

  // Dựng cụm từ danh sách rồi mới chèn gạch ngăn, để cụm không bao giờ mở đầu
  // hay kết thúc bằng một gạch mồ côi khi các nút ở giữa bị lọc bỏ.
  const renderCapsule = (tools: Tool[]) => {
    const visible = tools.filter(tool => hasConnection || tool.offline);
    if (visible.length === 0) return null;
    return (
      <div className="tb-capsule">
        {visible.map((tool, i) => (
          <React.Fragment key={tool.key}>
            {i > 0 && <div className="tb-capsule-divider" />}
            {tool.el}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Ở màn kết nối, sidebar chạy lên sát đỉnh cửa sổ nên góc trái thanh tiêu đề
  // không còn là của thanh nữa — nút ⋮ chuyển sang cụm phải. Menu vì thế phải
  // mở ngược hướng: neo mép phải và bung menu con sang trái, không thì nó tràn
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

  const leftTools: Tool[] = [
    {
      key: 'sidebar',
      el: (
        <button className="tb-capsule-btn" onClick={onToggleSidebar} title={t('titlebar.toggleSidebar')}>
          <PanelLeft size={14} />
        </button>
      ),
    },
    ...(menuOnRight ? [] : [menuTool]),
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
      key: 'read-only',
      el: (
        <button
          className="tb-capsule-btn"
          onClick={onToggleReadOnly}
          style={{ color: readOnly ? '#f59e0b' : 'var(--win-text-secondary)' }}
          title={readOnly ? t('app.readOnlyOnTitle') : t('app.readOnlyOffTitle')}
        >
          {readOnly ? <Lock size={13} color="#f59e0b" /> : <LockOpen size={13} />}
        </button>
      ),
    },
    {
      key: 'databases',
      el: (
        <button
          className="tb-capsule-btn"
          onClick={handleOpenDbPopover}
          disabled={!hasConnection}
          title={t('titlebar.menuDatabase')}
        >
          <Database size={13} />
        </button>
      ),
    },
    {
      key: 'sql',
      el: (
        <button
          className="tb-capsule-btn"
          onClick={onNewQuery}
          disabled={!hasConnection}
          style={{ fontWeight: 700, fontSize: '11px', padding: '0 8px' }}
          title={t('titlebar.newQuery')}
        >
          {t('titlebar.sqlButton')}
        </button>
      ),
    },
  ];

  const rightTools: Tool[] = [
    ...(menuOnRight ? [menuTool] : []),
    {
      key: 'docs',
      offline: true,
      el: (
        <button
          className="tb-capsule-btn"
          onClick={onOpenDocs}
          style={{ padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          title={t('docs.title') + ' (F1)'}
        >
          <BookOpen size={13} style={{ color: 'var(--win-accent)' }} />
          <span style={{ fontSize: '11px', fontWeight: 600 }}>Docs</span>
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
      key: 'reload',
      offline: true,
      el: (
        <button className="tb-capsule-btn" onClick={() => window.location.reload()} title={t('titlebar.reload')}>
          <RotateCw size={13} />
        </button>
      ),
    },
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
          className="tb-capsule-btn"
          onClick={onToggleAiAssistant}
          style={{ color: aiOpen ? 'var(--win-accent)' : undefined }}
          title={t('app.toggleAiCopilot')}
        >
          <Bot size={14} />
        </button>
      ),
    },
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

        {renderCapsule(leftTools)}
      </div>

      {/* Center Status Capsule: Merged Connection Info + Speed Status Pill into 1 single capsule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, justifyContent: 'center' }}>
        <button
          type="button"
          className="tb-status-capsule"
          style={{ margin: 0, gap: '10px', justifyContent: 'center', maxWidth: '750px', padding: '0 14px' }}
          onClick={handleOpenConnPopover}
          disabled={!hasConnection}
          title={hasConnection ? t('connInfo.openTitle') : undefined}
        >
          {hasConnection ? (
            <>
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
            </>
          ) : (
            <span style={{ opacity: 0.7 }}>{t('connInfo.notConnected')}</span>
          )}
        </button>
      </div>

      {/* Right Section: Unified Right Toolbar Capsule + Window Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, ...({ WebkitAppRegion: 'no-drag' } as any) }}>
        {/* Transaction thuộc về kết nối (một connection cho cả app) nên control nằm ở đây,
            không ở toolbar của từng tab. Xem TxControl.tsx. */}
        <TxControl
          connected={hasConnection}
          connId={connId || ""}
          dbType={(connStatus?.dbType || activeConnectionInfo?.dbType || "").toLowerCase()}
        />
        {renderCapsule(rightTools)}

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

      {/* Database Switcher Popover Menu (Matching Image 2) */}
      {showDbPopover && dbPopoverPos && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99998 }}
            onClick={() => setShowDbPopover(false)}
          />
          <div
            className="db-switcher-popover"
            style={{
              position: 'fixed',
              top: `${dbPopoverPos.top}px`,
              left: `${dbPopoverPos.left}px`,
              width: '300px',
              background: 'var(--win-bg-popover)',
              border: '1px solid var(--win-border)',
              borderRadius: '12px',
              boxShadow: '0 10px 30px rgba(0, 0, 0, 0.22)',
              padding: '12px',
              zIndex: 99999,
            }}
          >
            {/* Popover Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--win-text-primary)' }}>
                  {activeConnectionInfo?.dbName || 'sakila'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '2px' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  <span>{(activeConnectionInfo?.dbType || 'MYSQL').toUpperCase()} • Connected</span>
                </div>
              </div>
              <button
                onClick={() => setShowDbPopover(false)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--win-text-disabled)', padding: '2px' }}
              >
                <ChevronUp size={16} />
              </button>
            </div>

            <div style={{ height: '1px', background: 'var(--win-border)', margin: '8px 0', opacity: 0.5 }} />

            {/* Databases Count & Search Filter */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--win-text-disabled)', letterSpacing: '0.5px' }}>
                DATABASES ({filteredDbList.length})
              </span>
            </div>

            <div style={{ marginBottom: '8px' }}>
              <input
                type="text"
                placeholder="Filter databases..."
                value={dbFilter}
                onChange={(e) => setDbFilter(e.target.value)}
                className="form-input"
                style={{ width: '100%', height: '28px', fontSize: '11px', padding: '0 8px', borderRadius: '6px' }}
                autoFocus
              />
            </div>

            {/* Scrollable Databases List */}
            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {dbLoading ? (
                <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  Loading databases...
                </div>
              ) : filteredDbList.length === 0 ? (
                <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  No databases found
                </div>
              ) : (
                filteredDbList.map((db) => {
                  const isActive = db === activeConnectionInfo?.dbName;
                  return (
                    <div
                      key={db}
                      className="db-switcher-row"
                      onClick={() => handleSwitchDb(db)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '5px 8px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        background: isActive ? 'var(--win-bg-hover, rgba(0,0,0,0.05))' : 'transparent',
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? 'var(--win-accent)' : 'var(--win-text-primary)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                        <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center' }}>
                          {isActive ? <Check size={14} color="var(--win-accent)" /> : null}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {db}
                        </span>
                      </div>

                      {!isActive && (
                        <button
                          className="db-drop-btn"
                          onClick={(e) => handleDropDb(db, e)}
                          title={`Drop database ${db}`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#ef4444',
                            cursor: 'pointer',
                            padding: '2px',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            opacity: 0.6,
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ height: '1px', background: 'var(--win-border)', margin: '8px 0', opacity: 0.5 }} />

            {/* Footer Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <button
                className="db-footer-btn"
                onClick={() => {
                  setShowDbPopover(false);
                  setShowCreateDbModal(true);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--win-accent)',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '5px 8px',
                  borderRadius: '6px',
                }}
              >
                <Plus size={14} />
                <span>Create new database...</span>
              </button>

              <button
                className="db-footer-btn"
                onClick={() => {
                  setShowDbPopover(false);
                  onOpenAllDbStats?.();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--win-text-primary)',
                  fontSize: '12px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '5px 8px',
                  borderRadius: '6px',
                }}
              >
                <BarChart3 size={14} />
                <span>All database statistics</span>
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

      {/* Modal Create New Database */}
      {showCreateDbModal && (
        <Modal
          title="Create New Database"
          onClose={() => setShowCreateDbModal(false)}
          width="420px"
          zIndex={99999}
        >
          <ModalBody>
            <div className="form-group">
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                Database Name
              </label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. sakila_new"
                value={newDbName}
                onChange={(e) => setNewDbName(e.target.value)}
                style={{ height: '32px', fontSize: '12px', width: '100%', marginTop: '4px' }}
                autoFocus
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="cm-btn" onClick={() => setShowCreateDbModal(false)}>
              Cancel
            </button>
            <button className="cm-btn cm-btn-primary" onClick={handleCreateDbSubmit} disabled={!newDbName.trim()}>
              Create Database
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

