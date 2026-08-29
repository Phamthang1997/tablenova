import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Plus, X, Search } from 'lucide-react';
import * as catalog from '../../sql/catalog';
import { editorConnId } from '../../sql/editorScope';

interface AiContextPickerProps {
  attachedTables: string[];
  onAddTable: (table: string) => void;
  onRemoveTable: (table: string) => void;
}

export const AiContextPicker: React.FC<AiContextPickerProps> = ({
  attachedTables,
  onAddTable,
  onRemoveTable,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    catalog.getTables(editorConnId()).then((tables) => {
      if (active) {
        setAvailableTables(tables.map((tbl) => tbl.name));
      }
    }).catch(() => {});
    return () => {
      active = false;
    };
    // `open` is a trigger: re-read the table list each time the picker opens, not when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const filteredTables = availableTables.filter((tbl) =>
    tbl.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="ai-context-picker-wrapper" ref={popoverRef}>
      <div className="ai-context-pills-row">
        {attachedTables.map((tableName) => (
          <div key={tableName} className="ai-context-pill">
            <Table size={12} className="ai-context-table-icon" />
            <span className="ai-context-pill-text">{tableName}</span>
            <button
              className="ai-context-pill-remove"
              onClick={() => onRemoveTable(tableName)}
              title={t('common.remove', 'Remove')}
            >
              <X size={10} />
            </button>
          </div>
        ))}

        <button
          className="ai-context-add-btn"
          onClick={() => setOpen((prev) => !prev)}
          title={t('ai.attachTableHint', 'Attach table schema context')}
        >
          {attachedTables.length === 0 && <Table size={12} className="ai-context-table-icon" />}
          {attachedTables.length === 0 && <span className="ai-context-add-text">{t('ai.attachTable', 'Attach table')}</span>}
          <Plus size={11} className="ai-context-plus-icon" />
        </button>
      </div>

      {open && (
        <div className="ai-context-popover">
          <div className="ai-context-search-row">
            <Search size={12} className="ai-context-search-icon" />
            <input
              type="text"
              className="ai-context-search-input"
              placeholder={t('ai.searchTables', 'Search tables...')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          <div className="ai-context-table-list">
            {filteredTables.length === 0 ? (
              <div className="ai-context-empty">{t('ai.noTablesFound', 'No tables found')}</div>
            ) : (
              filteredTables.map((tbl) => {
                const isSelected = attachedTables.includes(tbl);
                return (
                  <button
                    key={tbl}
                    className={`ai-context-table-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      if (isSelected) {
                        onRemoveTable(tbl);
                      } else {
                        onAddTable(tbl);
                      }
                    }}
                  >
                    <Table size={12} className="ai-context-item-icon" />
                    <span className="ai-context-item-name">{tbl}</span>
                    {isSelected && <span className="ai-context-item-status">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
