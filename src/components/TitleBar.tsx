import React, { useState, useEffect } from 'react';
import {
  Minus, Square, X, Plus, Unplug, FileCode, HardDriveDownload,
  PanelLeft, SunMoon, RotateCw, Info, Keyboard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import appIcon from '../assets/icon.png';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface TitleBarProps {
  hasConnection: boolean;
  onNewConnection?: () => void;
  onDisconnect?: () => void;
  onNewQuery?: () => void;
  onBackupRestore?: () => void;
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
  onBackupRestore,
  onToggleSidebar,
  onToggleTheme,
  onShowShortcuts,
  onShowAbout,
}) => {
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
  }

  // Nhãn menu để tiếng Việt cho khớp với các mục con và phần còn lại của app.
  const menuCategories: { title: string; items: MenuItem[] }[] = [
    {
      title: 'Kết nối',
      items: [
        { label: 'Kết nối mới...', Icon: Plus, onClick: onNewConnection },
        { label: 'Đóng kết nối', Icon: Unplug, onClick: onDisconnect, danger: true, disabled: !hasConnection, separatorBefore: true },
      ],
    },
    {
      title: 'Cơ sở dữ liệu',
      items: [
        { label: 'Truy vấn SQL mới', Icon: FileCode, onClick: onNewQuery, shortcut: 'Ctrl+T', disabled: !hasConnection },
        { label: 'Sao lưu & Phục hồi...', Icon: HardDriveDownload, onClick: onBackupRestore, shortcut: 'Ctrl+B', disabled: !hasConnection },
      ],
    },
    {
      title: 'Hiển thị',
      items: [
        { label: 'Ẩn/hiện thanh bên', Icon: PanelLeft, onClick: onToggleSidebar, shortcut: 'Ctrl+P', disabled: !hasConnection },
        { label: 'Đổi giao diện sáng/tối', Icon: SunMoon, onClick: onToggleTheme },
        { label: 'Tải lại ứng dụng', Icon: RotateCw, onClick: () => window.location.reload(), separatorBefore: true },
      ],
    },
    {
      title: 'Trợ giúp',
      items: [
        { label: 'Phím tắt bàn phím...', Icon: Keyboard, onClick: onShowShortcuts },
        { label: 'Về TableNova...', Icon: Info, onClick: onShowAbout, separatorBefore: true },
      ],
    },
  ];

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  return (
    <div className="title-bar">
      <div className="title-bar-left">
        {isMac && (
          <div className="mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '10px' }}>
            <button className="mac-traffic-btn mac-close" onClick={handleClose} title="Đóng (Close)" />
            <button className="mac-traffic-btn mac-minimize" onClick={handleMinimize} title="Thu nhỏ (Minimize)" />
            <button className="mac-traffic-btn mac-maximize" onClick={handleMaximize} title="Phóng to (Maximize)" />
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
                        <item.Icon size={14} className="title-bar-dropdown-icon" />
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
          <button className="title-bar-btn" onClick={handleMinimize} title="Thu nhỏ" aria-label="Thu nhỏ">
            <Minus size={13} />
          </button>
          <button className="title-bar-btn" onClick={handleMaximize} title="Phóng to / thu về" aria-label="Phóng to">
            <Square size={11} />
          </button>
          <button className="title-bar-btn close" onClick={handleClose} title="Đóng" aria-label="Đóng">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
};

