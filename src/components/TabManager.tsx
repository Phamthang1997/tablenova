import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Terminal, TerminalSquare, X, Plus, Trash2, XCircle, ArrowRight, ChevronDown } from 'lucide-react';

export interface TabInfo {
  id: string;
  type: 'table' | 'query' | 'terminal';
  name: string; // Table name or unique query title
  label: string;
  config?: any;       // cấu hình kết nối cho tab terminal
  floating?: boolean; // terminal: đang ở chế độ cửa sổ nổi
}

interface TabManagerProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string, e?: React.MouseEvent) => void;
  onCloseOthers?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  onCloseAll?: () => void;
  onNewQueryTab: () => void;
}

export const TabManager: React.FC<TabManagerProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseTabsToRight,
  onCloseAll,
  onNewQueryTab,
}) => {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string;
  }>({
    visible: false,
    x: 0,
    y: 0,
    tabId: '',
  });

  const [showListDropdown, setShowListDropdown] = useState(false);

  useEffect(() => {
    const closeAll = () => {
      setContextMenu((prev) => ({ ...prev, visible: false }));
      setShowListDropdown(false);
    };
    window.addEventListener('click', closeAll);
    window.addEventListener('contextmenu', closeAll);
    return () => {
      window.removeEventListener('click', closeAll);
      window.removeEventListener('contextmenu', closeAll);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Bounds check to keep context menu on screen
    const menuWidth = 180;
    const menuHeight = 150;
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }
    
    setContextMenu({
      visible: true,
      x,
      y,
      tabId,
    });
  };

  return (
    <div className="tab-bar">
      <div className="tab-bar-items">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`tab-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
            >
              {/* Bỏ icon loại tab: tab chỉ phân biệt bằng màu (nền sáng + chữ
                  đậm cho tab đang xem), tiêu đề đã đủ cho biết đó là bảng hay
                  truy vấn. Danh sách tab ở dropdown vẫn giữ icon. */}
              <span className="tab-title" title={tab.label}>
                {tab.label}
              </span>
              <button
                className="tab-close-btn"
                onClick={(e) => onCloseTab(tab.id, e)}
              >
                <X size={10} style={{ flexShrink: 0 }} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tab-bar-controls">
        <button className="tab-new-btn" onClick={onNewQueryTab} title={t('tabs.newQueryTab')}>
          <Plus size={14} />
        </button>
        {tabs.length > 0 && (
          <button 
            className="tab-list-dropdown-btn" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowListDropdown((prev) => !prev);
            }}
            title={t('tabs.listOpenTabs')}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {showListDropdown && (
        <div className="tab-list-dropdown" onClick={(e) => e.stopPropagation()}>
          <div className="tab-list-dropdown-header">
            <span>{t('tabs.openTabs', { n: tabs.length })}</span>
            <button onClick={() => setShowListDropdown(false)}>×</button>
          </div>
          <div className="tab-list-dropdown-body">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div 
                  key={tab.id} 
                  className={`tab-list-dropdown-item ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setShowListDropdown(false);
                  }}
                >
                  {tab.type === 'table' ? (
                    <Table size={12} className="tab-icon-table" style={{ marginRight: '6px' }} />
                  ) : tab.type === 'terminal' ? (
                    <TerminalSquare size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  ) : (
                    <Terminal size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  )}
                  <span className="tab-list-dropdown-title" title={tab.label}>{tab.label}</span>
                  <button 
                    className="tab-list-dropdown-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {contextMenu.visible && (
        <div
          className="tab-context-menu"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="tab-context-menu-item"
            onClick={() => {
              onCloseTab(contextMenu.tabId);
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
          >
            <X size={13} style={{ flexShrink: 0 }} />
            <span>{t('tabs.closeThis')}</span>
          </div>
          {onCloseOthers && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseOthers(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <XCircle size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeOthers')}</span>
            </div>
          )}
          {onCloseTabsToRight && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseTabsToRight(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <ArrowRight size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeToRight')}</span>
            </div>
          )}
          {onCloseAll && (
            <>
              <div className="tab-context-menu-divider" />
              <div
                className="tab-context-menu-item close-all"
                onClick={() => {
                  onCloseAll();
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                style={{ color: 'var(--st-danger)' }}
              >
                <Trash2 size={13} style={{ flexShrink: 0 }} />
                <span>{t('tabs.closeAll')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

