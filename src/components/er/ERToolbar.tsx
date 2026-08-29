import React, { useState, useRef, useEffect } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Wand2,
  Search,
  Download,
  Filter,
  Layers,
  Copy,
  FileCode,
  Image as ImageIcon,
  Check,
  ChevronDown,
} from 'lucide-react';
import type { ERDetailLevel, ERExportFormat } from './erTypes';

interface ERToolbarProps {
  zoom: number;
  tableCount: number;
  relationCount: number;
  searchQuery: string;
  detailLevel: ERDetailLevel;
  showViews: boolean;
  showIsolated: boolean;
  showMinimap: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onResetView: () => void;
  onAutoLayout: () => void;
  onSearchChange: (query: string) => void;
  onDetailLevelChange: (level: ERDetailLevel) => void;
  onToggleViews: () => void;
  onToggleIsolated: () => void;
  onToggleMinimap: () => void;
  onExport: (format: ERExportFormat) => void;
}

export const ERToolbar: React.FC<ERToolbarProps> = ({
  zoom,
  tableCount,
  relationCount,
  searchQuery,
  detailLevel,
  showViews,
  showIsolated,
  showMinimap,
  onZoomIn,
  onZoomOut,
  onFitView,
  onResetView,
  onAutoLayout,
  onSearchChange,
  onDetailLevelChange,
  onToggleViews,
  onToggleIsolated,
  onToggleMinimap,
  onExport,
}) => {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [copiedStatus, setCopiedStatus] = useState<string | null>(null);

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setShowFilterMenu(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleExportAction = (format: ERExportFormat) => {
    setShowExportMenu(false);
    onExport(format);
    if (format === 'clipboard' || format === 'mermaid') {
      setCopiedStatus(format);
      setTimeout(() => setCopiedStatus(null), 2500);
    }
  };

  return (
    <div className="er-toolbar-container">
      {/* Summary Stats */}
      <span className="er-stat-pill">
        <b>{tableCount}</b> tables
      </span>
      <span className="er-stat-pill">
        <b>{relationCount}</b> relations
      </span>

      {/* Search Input */}
      <div className="er-search-box">
        <Search size={12} className="er-search-icon" />
        <input
          type="text"
          className="er-search-input"
          placeholder="Search table..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <div className="er-toolbar-divider" />

      {/* Detail Level Selector (Individual buttons) */}
      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'full' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('full')}
        title="Full: Show all columns and data types"
      >
        Full
      </button>
      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'keys_only' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('keys_only')}
        title="Keys Only: Show PK and FK columns only"
      >
        Keys Only
      </button>
      <button
        type="button"
        className={`er-toolbar-btn ${detailLevel === 'compact' ? 'active' : ''}`}
        onClick={() => onDetailLevelChange('compact')}
        title="Compact: Show top columns only"
      >
        Compact
      </button>

      <div className="er-toolbar-divider" />

      {/* Auto Layout Button */}
      <button
        type="button"
        className="er-toolbar-btn"
        onClick={onAutoLayout}
        title="Auto-Layout: Re-organize tables hierarchically"
      >
        <Wand2 size={12} />
        <span>Auto Layout</span>
      </button>

      {/* Zoom Controls */}
      <div className="er-btn-group">
        <button type="button" className="er-toolbar-icon-btn" onClick={onZoomOut} title="Zoom Out (-)">
          <ZoomOut size={12} />
        </button>
        <span className="er-zoom-label" onClick={onResetView} title="Reset Zoom (100%)">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className="er-toolbar-icon-btn" onClick={onZoomIn} title="Zoom In (+)">
          <ZoomIn size={12} />
        </button>
        <button type="button" className="er-toolbar-icon-btn" onClick={onFitView} title="Fit to View">
          <Maximize2 size={12} />
        </button>
      </div>

      <div className="er-toolbar-divider" />

      {/* Filters Dropdown */}
      <div className="er-popover-wrap" ref={filterMenuRef}>
        <button
          type="button"
          className={`er-toolbar-btn ${showFilterMenu ? 'active' : ''}`}
          onClick={() => setShowFilterMenu(!showFilterMenu)}
          title="Diagram Display Filters"
        >
          <Filter size={12} />
          <span>Filters</span>
        </button>

          {showFilterMenu && (
            <div className="er-popover-menu">
              <div className="er-popover-header">Display Filters</div>
              <label className="er-filter-item">
                <input type="checkbox" checked={showViews} onChange={onToggleViews} />
                <span>Show Views</span>
              </label>
              <label className="er-filter-item">
                <input type="checkbox" checked={showIsolated} onChange={onToggleIsolated} />
                <span>Show Isolated Tables</span>
              </label>
              <label className="er-filter-item">
                <input type="checkbox" checked={showMinimap} onChange={onToggleMinimap} />
                <span>Show Radar Minimap</span>
              </label>
            </div>
          )}
        </div>

        {/* Export Dropdown Menu */}
        <div className="er-popover-wrap" ref={exportMenuRef}>
          <button
            type="button"
            className="er-toolbar-btn primary"
            onClick={() => setShowExportMenu(!showExportMenu)}
            title="Export Diagram"
          >
            <Download size={13} />
            <span>Export</span>
            <ChevronDown size={12} />
          </button>

          {showExportMenu && (
            <div className="er-popover-menu right-aligned">
              <div className="er-popover-header">Visual Export</div>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('png')}
              >
                <ImageIcon size={13} />
                <span>Export PNG (High-Res)</span>
              </button>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('clipboard')}
              >
                {copiedStatus === 'clipboard' ? <Check size={13} className="er-green" /> : <Copy size={13} />}
                <span>{copiedStatus === 'clipboard' ? 'Copied to Clipboard!' : 'Copy Image to Clipboard'}</span>
              </button>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('svg')}
              >
                <Layers size={13} />
                <span>Export Vector SVG</span>
              </button>

              <div className="er-menu-divider" />
              <div className="er-popover-header">Code & Schema Export</div>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('mermaid')}
              >
                {copiedStatus === 'mermaid' ? <Check size={13} className="er-green" /> : <FileCode size={13} />}
                <span>{copiedStatus === 'mermaid' ? 'Mermaid Code Copied!' : 'Copy Mermaid ER Markdown'}</span>
              </button>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('dbml')}
              >
                <FileCode size={13} />
                <span>Export DBML (dbdiagram.io)</span>
              </button>
              <button
                type="button"
                className="er-menu-item"
                onClick={() => handleExportAction('sql')}
              >
                <FileCode size={13} />
                <span>Export DDL SQL Schema</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
};
