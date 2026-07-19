import React, { useState, useEffect } from 'react';
import { Minus, Square, X } from 'lucide-react';
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
    window.addEventListener('click', closeDropdown);
    window.addEventListener('contextmenu', closeDropdown);
    return () => {
      window.removeEventListener('click', closeDropdown);
      window.removeEventListener('contextmenu', closeDropdown);
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
    onClick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    shortcut?: string;
  }

  const menuCategories: { title: string; items: MenuItem[] }[] = [
    {
      title: 'Connection',
      items: [
        { label: 'Kết nối mới...', onClick: onNewConnection },
        { label: 'Đóng kết nối', onClick: onDisconnect, danger: true, disabled: !hasConnection },
      ],
    },
    {
      title: 'Database',
      items: [
        { label: 'Truy vấn SQL mới', onClick: onNewQuery, shortcut: 'Ctrl+T', disabled: !hasConnection },
        { label: 'Sao lưu & Phục hồi...', onClick: onBackupRestore, shortcut: 'Ctrl+B', disabled: !hasConnection },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Ẩn/Hiện thanh bên', onClick: onToggleSidebar, shortcut: 'Ctrl+P', disabled: !hasConnection },
        { label: 'Chuyển giao diện Sáng/Tối', onClick: onToggleTheme },
        { label: 'Tải lại ứng dụng', onClick: () => window.location.reload() },
      ],
    },
    {
      title: 'Help',
      items: [
        { label: 'Về TableNova...', onClick: onShowAbout },
        { label: 'Phím tắt bàn phím...', onClick: onShowShortcuts },
      ],
    },
  ];

  return (
    <div className="title-bar">
      <div className="title-bar-left">
        <span className="title-bar-logo" style={{ display: 'flex', alignItems: 'center' }}>
          <img src={appIcon} alt="TableNova Logo" style={{ width: 16, height: 16, borderRadius: '3px', objectFit: 'contain' }} />
        </span>
        <span>TableNova</span>

        {/* Desktop Menu Bar */}
        <div className="title-bar-menu">
          {menuCategories.map((cat) => (
            <div key={cat.title} className="title-bar-menu-item-container">
              <button
                className={`title-bar-menu-btn ${activeCategory === cat.title ? 'active' : ''}`}
                onClick={(e) => handleCategoryClick(e, cat.title)}
                onMouseEnter={() => handleCategoryMouseEnter(cat.title)}
              >
                {cat.title}
              </button>
              {activeCategory === cat.title && (
                <div className="title-bar-dropdown" onClick={(e) => e.stopPropagation()}>
                  {cat.items.map((item) => (
                    <div
                      key={item.label}
                      className={`title-bar-dropdown-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                      onClick={() => {
                        if (item.disabled) return;
                        if (item.onClick) item.onClick();
                        setActiveCategory(null);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span className="title-bar-dropdown-shortcut">{item.shortcut}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="title-bar-right">
        <button className="title-bar-btn" onClick={handleMinimize}>
          <Minus size={12} />
        </button>
        <button className="title-bar-btn" onClick={handleMaximize}>
          <Square size={10} />
        </button>
        <button className="title-bar-btn close" onClick={handleClose}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
};

