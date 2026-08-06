import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Minus, Square, X, Plus, Unplug, FileCode, HardDriveDownload, HardDriveUpload,
  PanelLeft, SunMoon, RotateCw, Info, Keyboard, Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import appIcon from '../assets/icon.png';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SUPPORTED_LANGUAGES, currentLanguage } from '../i18n';

interface TitleBarProps {
  hasConnection: boolean;
  onNewConnection?: () => void;
  onDisconnect?: () => void;
  onNewQuery?: () => void;
  onExportDatabase?: () => void;
  onImportDatabase?: () => void;
  onToggleSidebar?: () => void;
  onToggleTheme?: () => void;
  onShowShortcuts?: () => void;
  onShowAbout?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  hasConnection,
  onNewConnection,
  onDisconnect,
  onNewQuery,
  onExportDatabase,
  onImportDatabase,
  onToggleSidebar,
  onToggleTheme,
  onShowShortcuts,
  onShowAbout,
}) => {
  const { t, i18n } = useTranslation();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    const closeDropdown = () => setActiveCategory(null);
    // Escape để đóng menu — trước đây chỉ đóng được bằng cách bấm ra ngoài.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveCategory(null);
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

  const handleCategoryClick = (e: React.MouseEvent, title: string) => {
    e.stopPropagation();
    setActiveCategory((prev) => (prev === title ? null : title));
  };

  const handleCategoryMouseEnter = (title: string) => {
    if (activeCategory !== null) {
      setActiveCategory(title);
    }
  };

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
    /** Kẻ một đường phân cách phía trên mục này. */
    separatorBefore?: boolean;
    /** Radio-style item (language pick): `false` keeps the icon slot for alignment. */
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
      // Language gets its own category rather than living under "View": a user
      // stuck in a language they cannot read still has to find it, so the
      // category label is bilingual and each item stays in its native script.
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
        { label: t('titlebar.shortcuts'), Icon: Keyboard, onClick: onShowShortcuts },
        { label: t('titlebar.about'), Icon: Info, onClick: onShowAbout, separatorBefore: true },
      ],
    },
  ];

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  return (
    <div className="title-bar">
      <div className="title-bar-left">
        {isMac && (
          <div className="mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '10px' }}>
            <button className="mac-traffic-btn mac-close" onClick={handleClose} title={t('titlebar.closeWindow')} />
            <button className="mac-traffic-btn mac-minimize" onClick={handleMinimize} title={t('titlebar.minimize')} />
            <button className="mac-traffic-btn mac-maximize" onClick={handleMaximize} title={t('titlebar.maximize')} />
          </div>
        )}

        <span className="title-bar-logo">
          <img src={appIcon} alt="" style={{ width: 16, height: 16, borderRadius: '3px', objectFit: 'contain' }} />
        </span>
        <span className="title-bar-brand">TableNova</span>

        {/* Desktop Menu Bar */}
        <div className="title-bar-menu">
          {menuCategories.map((cat) => (
            <div key={cat.title} className="title-bar-menu-item-container">
              <button
                className={`title-bar-menu-btn ${activeCategory === cat.title ? 'active' : ''}`}
                onClick={(e) => handleCategoryClick(e, cat.title)}
                onMouseEnter={() => handleCategoryMouseEnter(cat.title)}
                aria-haspopup="menu"
                aria-expanded={activeCategory === cat.title}
              >
                {cat.title}
              </button>
              {activeCategory === cat.title && (
                <div className="title-bar-dropdown" role="menu" onClick={(e) => e.stopPropagation()}>
                  {cat.items.map((item) => (
                    <React.Fragment key={item.label}>
                      {item.separatorBefore && <div className="title-bar-dropdown-sep" />}
                      <div
                        role="menuitem"
                        className={`title-bar-dropdown-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                        onClick={() => {
                          if (item.disabled) return;
                          if (item.onClick) item.onClick();
                          setActiveCategory(null);
                        }}
                      >
                        <item.Icon
                          size={14}
                          className="title-bar-dropdown-icon"
                          style={item.checked === false ? { opacity: 0 } : undefined}
                        />
                        <span className="title-bar-dropdown-label">{item.label}</span>
                        {item.shortcut && (
                          <span className="title-bar-dropdown-shortcut">{item.shortcut}</span>
                        )}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {!isMac && (
        <div className="title-bar-right">
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
  );
};

