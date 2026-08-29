import React from 'react';
import { Database, Eye, Key, Link2, ChevronDown, ChevronRight } from 'lucide-react';
import type { ERTable, ERNodePosition, ERDetailLevel } from './erTypes';

interface ERTableNodeProps {
  table: ERTable;
  position: ERNodePosition;
  detailLevel: ERDetailLevel;
  isSelected: boolean;
  isHighlighted: boolean;
  isDimmed: boolean;
  onSelect: (tableName: string, e: React.MouseEvent) => void;
  onToggleCollapse: (tableName: string) => void;
  onDoubleClick: (tableName: string) => void;
  onHover: (tableName: string | null) => void;
  onMouseDown: (tableName: string, e: React.MouseEvent) => void;
}

export const ERTableNode: React.FC<ERTableNodeProps> = ({
  table,
  position,
  detailLevel,
  isSelected,
  isHighlighted,
  isDimmed,
  onSelect,
  onToggleCollapse,
  onDoubleClick,
  onHover,
  onMouseDown,
}) => {
  const isCollapsed = !!position.isCollapsed;

  let visibleColumns = table.columns;
  if (!isCollapsed) {
    if (detailLevel === 'keys_only') {
      visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
      if (visibleColumns.length === 0) visibleColumns = table.columns.slice(0, 3);
    } else if (detailLevel === 'compact') {
      visibleColumns = table.columns.slice(0, 5);
    }
  }

  const isView = table.kind === 'view';

  return (
    <div
      className={`er-table-node ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''} ${isDimmed ? 'dimmed' : ''}`}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${position.width}px`,
      }}
      onClick={(e) => onSelect(table.name, e)}
      onDoubleClick={() => onDoubleClick(table.name)}
      onMouseEnter={() => onHover(table.name)}
      onMouseLeave={() => onHover(null)}
      onMouseDown={(e) => onMouseDown(table.name, e)}
    >
      {/* Table Header */}
      <div className={`er-node-header ${isView ? 'view-header' : ''}`}>
        <div className="er-node-title-group">
          {isView ? <Eye size={13} className="er-icon-view" /> : <Database size={13} className="er-icon-table" />}
          <span className="er-node-title" title={table.name}>
            {table.name}
          </span>
        </div>

        <div className="er-node-actions">
          <span className="er-node-col-count" title={`${table.columns.length} columns`}>
            {table.columns.length}
          </span>
          <button
            type="button"
            className="er-node-collapse-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(table.name);
            }}
            title={isCollapsed ? 'Expand table' : 'Collapse table'}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* Columns List */}
      {!isCollapsed && (
        <div className="er-node-columns">
          {visibleColumns.map((col) => (
            <div
              key={col.name}
              className={`er-column-row ${col.isPrimaryKey ? 'pk-row' : ''} ${col.isForeignKey ? 'fk-row' : ''}`}
              title={
                col.refTable
                  ? `FK: ${col.name} -> ${col.refTable}.${col.refColumn || col.name}`
                  : col.comment || undefined
              }
            >
              <div className="er-col-left">
                {col.isPrimaryKey && (
                  <span title="Primary Key">
                    <Key size={11} className="er-badge-pk" />
                  </span>
                )}
                {col.isForeignKey && !col.isPrimaryKey && (
                  <span title={`Foreign Key: -> ${col.refTable}`}>
                    <Link2 size={11} className="er-badge-fk" />
                  </span>
                )}
                {!col.isPrimaryKey && !col.isForeignKey && <span className="er-col-bullet">•</span>}
                <span className={`er-col-name ${col.isPrimaryKey ? 'bold' : ''}`}>{col.name}</span>
              </div>

              <div className="er-col-right">
                <span className="er-col-type" title={col.type}>
                  {col.type}
                </span>
                {col.nullable === false && <span className="er-col-req-dot" title="NOT NULL" />}
              </div>
            </div>
          ))}

          {detailLevel !== 'full' && table.columns.length > visibleColumns.length && (
            <div className="er-col-more">
              + {table.columns.length - visibleColumns.length} more columns...
            </div>
          )}
        </div>
      )}
    </div>
  );
};
