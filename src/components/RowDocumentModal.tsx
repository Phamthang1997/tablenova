import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table2, Network, Code2, ChevronLeft, ChevronRight,
  Search, Copy, Check, Minimize2, Sparkles, ChevronDown
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import type { ColumnInfo } from '../utils/dbHelper';

export interface RowDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  primaryKey?: string;
  rowIndex: number;
  rows: any[];
  columns: ColumnInfo[];
  foreignKeys?: { column: string; refTable: string; refColumn: string }[];
  onNavigateRow: (newIndex: number) => void;
}

type ViewTab = 'table' | 'tree' | 'json';

interface TreeNodeProps {
  label: string;
  value: any;
  depth?: number;
  isLast?: boolean;
}

const TreeNode: React.FC<TreeNodeProps> = ({ label, value, depth = 0 }) => {
  const [expanded, setExpanded] = useState(true);

  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isExpandable = isObject || isArray;

  const getTypeInfo = (val: any): { type: string; className: string } => {
    if (val === null) return { type: 'null', className: 'doc-type-null' };
    if (Array.isArray(val)) return { type: `array[${val.length}]`, className: 'doc-type-array' };
    const t = typeof val;
    if (t === 'object') return { type: `object{${Object.keys(val).length}}`, className: 'doc-type-object' };
    if (t === 'number') return { type: 'number', className: 'doc-type-number' };
    if (t === 'boolean') return { type: 'boolean', className: 'doc-type-boolean' };
    return { type: 'string', className: 'doc-type-string' };
  };

  const typeInfo = getTypeInfo(value);

  return (
    <div>
      <div className="doc-tree-row">
        {depth > 0 && (
          <span className="doc-tree-indent" />
        )}
        {isExpandable ? (
          <button
            type="button"
            className="doc-tree-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="doc-tree-toggle" />
        )}

        <span className="doc-tree-key">{label}:</span>
        <span className={`doc-type-badge ${typeInfo.className}`}>{typeInfo.type}</span>

        {!isExpandable && (
          <span className={`doc-tree-val is-${value === null ? 'null' : typeof value}`}>
            {value === null ? 'NULL' : typeof value === 'string' ? `"${value}"` : String(value)}
          </span>
        )}
      </div>

      {isExpandable && expanded && (
        <div>
          {isArray ? (
            value.map((item: any, idx: number) => (
              <TreeNode key={idx} label={`[${idx}]`} value={item} depth={depth + 1} />
            ))
          ) : (
            Object.entries(value).map(([k, v]) => (
              <TreeNode key={k} label={k} value={v} depth={depth + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
};

export const RowDocumentModal: React.FC<RowDocumentModalProps> = ({
  isOpen,
  onClose,
  tableName,
  primaryKey = 'id',
  rowIndex,
  rows,
  columns,
  foreignKeys = [],
  onNavigateRow,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>('table');
  const [searchField, setSearchField] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [jsonText, setJsonText] = useState('');

  // Tự động nhận diện theme sáng / tối từ attribute data-theme của ứng dụng
  const [isDark, setIsDark] = useState<boolean>(() => {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  });

  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.getAttribute('data-theme') !== 'light');
    };
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const currentRow = rows[rowIndex] || null;
  const totalRows = rows.length;

  // Lấy dữ liệu dạng JSON đẹp của dòng hiện tại
  useEffect(() => {
    if (currentRow) {
      // Bỏ các thuộc tính nội bộ như __tempId
      const cleanRow: Record<string, any> = {};
      Object.keys(currentRow).forEach(k => {
        if (!k.startsWith('__')) {
          cleanRow[k] = currentRow[k];
        }
      });
      setJsonText(JSON.stringify(cleanRow, null, 2));
    }
  }, [currentRow]);

  // Phím tắt điều hướng Alt+Left / Alt+Right
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (rowIndex > 0) onNavigateRow(rowIndex - 1);
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        if (rowIndex < totalRows - 1) onNavigateRow(rowIndex + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, rowIndex, totalRows, onNavigateRow]);

  const copyToClipboard = useCallback((text: string, key?: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    if (key) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } else {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    }
  }, []);

  const handleBeautifyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
    } catch {}
  }, [jsonText]);

  const handleMinifyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed));
    } catch {}
  }, [jsonText]);

  // Sinh câu lệnh SQL INSERT từ dòng hiện tại
  const copyAsSqlInsert = useCallback(() => {
    if (!currentRow) return;
    const cols = columns.map(c => c.name);
    const colList = cols.map(c => `\`${c}\``).join(', ');
    const valList = cols.map(c => {
      const val = currentRow[c];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
      return `'${String(val).replace(/'/g, "''")}'`;
    }).join(', ');
    const sql = `INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`;
    copyToClipboard(sql);
  }, [currentRow, columns, tableName, copyToClipboard]);

  // Lọc trường cho Table View
  const filteredColumns = useMemo(() => {
    if (!searchField.trim()) return columns;
    const query = searchField.toLowerCase().trim();
    return columns.filter(c => c.name.toLowerCase().includes(query) || (c.type || '').toLowerCase().includes(query));
  }, [columns, searchField]);

  // Parsed Object cho Tree View (tự parse các trường JSON string nếu có)
  const treeData = useMemo(() => {
    if (!currentRow) return {};
    const res: Record<string, any> = {};
    columns.forEach(col => {
      const rawVal = currentRow[col.name];
      if (typeof rawVal === 'string' && (rawVal.startsWith('{') || rawVal.startsWith('['))) {
        try {
          res[col.name] = JSON.parse(rawVal);
          return;
        } catch {}
      }
      res[col.name] = rawVal;
    });
    return res;
  }, [currentRow, columns]);

  if (!isOpen || !currentRow) return null;

  const pkVal = currentRow[primaryKey];
  const titleInfo = pkVal !== undefined && pkVal !== null
    ? `${tableName} — ${primaryKey}: ${pkVal}`
    : `${tableName} — #${rowIndex + 1}`;

  return (
    <Modal
      title={
        <div className="doc-nav-info">
          <Table2 size={16} />
          <span>{t('dataGrid.documentViewer.title', { table: tableName, defaultValue: `Chi tiết bản ghi — ${tableName}` })}</span>
          <span className="doc-table-pill">{titleInfo}</span>
        </div>
      }
      onClose={onClose}
      width="840px"
      maxWidth="94vw"
      height="75vh"
      maxHeight="88vh"
      zIndex={99998}
    >
      <div className="doc-nav-header">
        <div className="doc-nav-info">
          <span className="doc-nav-counter">
            {t('dataGrid.documentViewer.rowCounter', { current: rowIndex + 1, total: totalRows, defaultValue: `Dòng ${rowIndex + 1} / ${totalRows}` })}
          </span>
        </div>

        <div className="doc-nav-controls">
          <button
            type="button"
            className="doc-nav-btn"
            disabled={rowIndex <= 0}
            onClick={() => onNavigateRow(rowIndex - 1)}
            title={t('dataGrid.documentViewer.prevRecord', 'Dòng trước (Alt+Left)')}
          >
            <ChevronLeft size={14} />
            <span>{t('dataGrid.documentViewer.prevRecord', 'Dòng trước')}</span>
          </button>
          <button
            type="button"
            className="doc-nav-btn"
            disabled={rowIndex >= totalRows - 1}
            onClick={() => onNavigateRow(rowIndex + 1)}
            title={t('dataGrid.documentViewer.nextRecord', 'Dòng sau (Alt+Right)')}
          >
            <span>{t('dataGrid.documentViewer.nextRecord', 'Dòng sau')}</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Tabs bar */}
      <div className="doc-tabs-bar">
        <button
          type="button"
          className={`doc-tab-btn ${activeTab === 'table' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('table')}
        >
          <Table2 size={14} />
          <span>{t('dataGrid.documentViewer.tabTable', 'Bảng / Form')}</span>
        </button>
        <button
          type="button"
          className={`doc-tab-btn ${activeTab === 'tree' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('tree')}
        >
          <Network size={14} />
          <span>{t('dataGrid.documentViewer.tabTree', 'Cây phân cấp')}</span>
        </button>
        <button
          type="button"
          className={`doc-tab-btn ${activeTab === 'json' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('json')}
        >
          <Code2 size={14} />
          <span>{t('dataGrid.documentViewer.tabJson', 'Mã JSON')}</span>
        </button>
      </div>

      <ModalBody className="doc-modal-body" style={{ flex: 1, minHeight: 0, padding: 0 }}>
        {/* 1. TABLE / FORM VIEW */}
        {activeTab === 'table' && (
          <div className="doc-table-view">
            <div className="doc-search-bar">
              <div className="doc-search-input-box">
                <Search size={13} className="doc-search-icon" />
                <input
                  type="text"
                  className="doc-search-input"
                  placeholder={t('dataGrid.documentViewer.searchColumns', 'Tìm kiếm trường / cột...')}
                  value={searchField}
                  onChange={(e) => setSearchField(e.target.value)}
                  autoFocus
                />
              </div>
            </div>

            <div className="doc-table-scroll">
              <table className="doc-field-table">
                <thead>
                  <tr>
                    <th className="doc-field-th doc-field-td-key">{t('dataGrid.documentViewer.colName', 'Trường / Cột')}</th>
                    <th className="doc-field-th doc-field-td-type">{t('dataGrid.documentViewer.colType', 'Kiểu dữ liệu')}</th>
                    <th className="doc-field-th doc-field-td-val">{t('dataGrid.documentViewer.colValue', 'Giá trị')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredColumns.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="doc-empty-hint">
                        {t('dataGrid.documentViewer.noFieldsFound', 'Không tìm thấy trường nào phù hợp.')}
                      </td>
                    </tr>
                  ) : (
                    filteredColumns.map(col => {
                      const val = currentRow[col.name];
                      const isPk = col.isPrimaryKey || col.name === primaryKey;
                      const fk = foreignKeys.find(f => (f.column || '').toLowerCase() === col.name.toLowerCase());
                      const strVal = val === null || val === undefined ? '' : String(val);

                      return (
                        <tr key={col.name} className="doc-field-tr">
                          <td className="doc-field-td-key">
                            <div className="doc-field-key-wrapper">
                              <span className="doc-field-name">{col.name}</span>
                              {isPk && <span className="key-badge">PK</span>}
                              {fk && <span className="fk-badge">FK</span>}
                            </div>
                          </td>
                          <td className="doc-field-td-type">
                            <span>{col.type || 'TEXT'}</span>
                          </td>
                          <td className="doc-field-td-val">
                            <div className="doc-field-val-container">
                              <div className="doc-field-val-text">
                                {val === null ? (
                                  <span className="grid-cell-null">NULL</span>
                                ) : (
                                  strVal
                                )}
                              </div>
                              <button
                                type="button"
                                className="doc-field-copy-btn"
                                onClick={() => copyToClipboard(strVal, col.name)}
                                title={t('dataGrid.documentViewer.copyField', 'Sao chép giá trị ô')}
                              >
                                {copiedKey === col.name ? <Check size={12} style={{ color: 'var(--st-ok)' }} /> : <Copy size={12} />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 2. TREE VIEW */}
        {activeTab === 'tree' && (
          <div className="doc-tree-view">
            <div className="doc-tree-toolbar">
              <div className="doc-nav-info">
                <span className="doc-nav-counter">
                  {Object.keys(treeData).length} fields
                </span>
              </div>
            </div>
            <div className="doc-tree-scroll">
              {Object.entries(treeData).map(([key, val]) => (
                <TreeNode key={key} label={key} value={val} depth={0} />
              ))}
            </div>
          </div>
        )}

        {/* 3. JSON VIEW */}
        {activeTab === 'json' && (
          <div className="doc-json-view">
            <div className="doc-json-toolbar">
              <div className="doc-nav-info">
                <span className="doc-nav-counter">JSON Document</span>
              </div>
              <div className="doc-json-actions">
                <button
                  type="button"
                  className="doc-nav-btn"
                  onClick={handleBeautifyJson}
                  title={t('dataGrid.documentViewer.beautifyJson', 'Căn chỉnh JSON')}
                >
                  <Sparkles size={12} />
                  <span>Format</span>
                </button>
                <button
                  type="button"
                  className="doc-nav-btn"
                  onClick={handleMinifyJson}
                  title={t('dataGrid.documentViewer.minifyJson', 'Nén 1 dòng')}
                >
                  <Minimize2 size={12} />
                  <span>Minify</span>
                </button>
              </div>
            </div>
            <div className="doc-json-editor-container">
              <Editor
                height="100%"
                defaultLanguage="json"
                theme={isDark ? 'vs-dark' : 'vs'}
                value={jsonText}
                options={{
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12.5,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  folding: true,
                  automaticLayout: true,
                  readOnly: true,
                }}
              />
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => copyToClipboard(jsonText)}
        >
          {copiedAll ? <Check size={13} style={{ color: 'var(--st-ok)' }} /> : <Copy size={13} />}
          <span>{t('dataGrid.documentViewer.copyJson', 'Sao chép JSON')}</span>
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={copyAsSqlInsert}
        >
          <span>{t('dataGrid.documentViewer.copySqlInsert', 'Sao chép SQL INSERT')}</span>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
