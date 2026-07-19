import React, { useState, useEffect, useCallback } from 'react';
import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, ColumnInfo, GridChange } from '../utils/dbHelper';
import {
  Save, RotateCcw, Plus, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, Minus
} from 'lucide-react';
import { StructureViewer } from './StructureViewer';

const LoadingSpinner: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 16, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="loading-spinner"
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="var(--win-border-strong, #383b44)"
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      stroke="var(--win-accent)"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

interface DataGridProps {
  tableName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  initialViewMode?: 'data' | 'structure';
  readOnly?: boolean;
}

interface FilterRow {
  id: string;
  active: boolean;
  column: string;
  operator: string;
  value: string;
}

function parseCSV(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',' || char === '\t') {
        row.push(cell.trim());
        cell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        row.push(cell.trim());
        if (row.length > 1 || row[0] !== '') {
          result.push(row);
        }
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    result.push(row);
  }

  return result;
}

export const DataGrid: React.FC<DataGridProps> = ({ tableName, dbType, initialViewMode = 'data', readOnly = false }) => {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);

  // Data State
  const [rows, setRows] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [primaryKey, setPrimaryKey] = useState('id');

  // Pagination & Filtering
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterText, setFilterText] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  // Advanced Filter Builder State
  const [filterMode, setFilterMode] = useState<'visual' | 'sql'>('visual');
  const [filterRows, setFilterRows] = useState<FilterRow[]>([]);

  // Editing State
  const [updates, setUpdates] = useState<{ [rowId: string]: { [colName: string]: any } }>({});
  const [deletes, setDeletes] = useState<Set<any>>(new Set());
  const [inserts, setInserts] = useState<any[]>([]);
  const [nextTempId, setNextTempId] = useState(1);
  const [editingCell, setEditingCell] = useState<{ rowId: any; colName: string } | null>(null);
  const [editValue, setEditValue] = useState<any>('');

  // Undo/Redo cho buffer thay đổi (updates/deletes/inserts). Ghi lịch sử theo effect nên
  // không phải chèn vào từng nơi mutate. Mỗi lần buffer đổi -> đẩy snapshot TRƯỚC ĐÓ vào undoStack.
  type GridSnap = { updates: any; deletes: any[]; inserts: any[] };
  const [undoStack, setUndoStack] = useState<GridSnap[]>([]);
  const [redoStack, setRedoStack] = useState<GridSnap[]>([]);
  const prevSnapRef = React.useRef<GridSnap>({ updates: {}, deletes: [], inserts: [] });
  const skipHistoryRef = React.useRef(true); // bỏ qua lần chạy đầu (mount) và lúc undo/redo khôi phục
  const curSnap = (): GridSnap => ({
    updates: JSON.parse(JSON.stringify(updates)),
    deletes: Array.from(deletes),
    inserts: JSON.parse(JSON.stringify(inserts)),
  });

  useEffect(() => {
    const cur = curSnap();
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      prevSnapRef.current = cur;
      return;
    }
    setUndoStack(s => [...s, prevSnapRef.current].slice(-100));
    setRedoStack([]);
    prevSnapRef.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updates, deletes, inserts]);

  const restoreSnap = (snap: GridSnap) => {
    skipHistoryRef.current = true;
    setUpdates(snap.updates);
    setDeletes(new Set(snap.deletes));
    setInserts(snap.inserts);
    prevSnapRef.current = snap;
  };

  const undoGridChange = () => {
    if (undoStack.length === 0) return;
    const target = undoStack[undoStack.length - 1];
    setRedoStack(r => [...r, curSnap()]);
    setUndoStack(s => s.slice(0, -1));
    restoreSnap(target);
  };

  const redoGridChange = () => {
    if (redoStack.length === 0) return;
    const target = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, curSnap()]);
    setRedoStack(r => r.slice(0, -1));
    restoreSnap(target);
  };

  // Reset lịch sử (sau khi commit thành công: buffer trống, không cho undo về thay đổi đã ghi DB)
  const resetGridHistory = () => {
    skipHistoryRef.current = true;
    setUndoStack([]);
    setRedoStack([]);
    prevSnapRef.current = { updates: {}, deletes: [], inserts: [] };
  };

  // Transaction preview trước khi commit
  const [commitPreview, setCommitPreview] = useState<string[] | null>(null);
  const [pendingChanges, setPendingChanges] = useState<GridChange[]>([]);

  // Selected row for highlighting
  const [selectedRowId, setSelectedRowId] = useState<any | null>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    rowId: any; row: any;
    colName: string; cellValue: any;
  } | null>(null);

  // Quick Look Modal State
  const [quickLookCell, setQuickLookCell] = useState<{ colName: string; value: any } | null>(null);

  // Schema View Toggle
  const [viewMode, setViewMode] = useState<'data' | 'structure'>(initialViewMode);
  const [showFilterBar, setShowFilterBar] = useState(false);

  // Columns Visibility State
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [pendingVisibleColumns, setPendingVisibleColumns] = useState<string[]>([]);
  const [showColumnsPopover, setShowColumnsPopover] = useState(false);

  // Import/Export State
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json' | 'sql' | 'xlsx'>('csv');
  const [previewText, setPreviewText] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  // Import Preview State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importFileType, setImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [importPendingRows, setImportPendingRows] = useState<any[]>([]);
  const [importSqlContent, setImportSqlContent] = useState('');

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Fetch preview when modal is active or format changes
  useEffect(() => {
    if (!showExportModal) return;

    const fetchPreview = () => {
      setPreviewText(`Xem trước dữ liệu xuất định dạng ${exportFormat.toUpperCase()} của bảng "${tableName}" đã sẵn sàng.`);
      setPreviewLoading(false);
    };
    fetchPreview();
  }, [showExportModal, exportFormat, tableName, sortBy, sortDir, activeFilter]);

  const handleExport = (format: 'csv' | 'json' | 'sql' | 'xlsx') => {
    setShowExportDropdown(false);
    setExportFormat(format);
    setShowExportModal(true);
  };

  const triggerFullDownload = async () => {
    try {
      const res = await dbHelper.exportTable(tableName, exportFormat);
      if (res.success) {
        setSuccessMsg(`Xuất dữ liệu bảng "${tableName}" thành công!`);
      } else {
        setErrorMsg('Lỗi xuất dữ liệu: ' + res.error);
      }
    } catch (err: any) {
      setErrorMsg('Lỗi kết nối: ' + err.message);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    setErrorMsg(null);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        if (file.name.endsWith('.json')) {
          const parsedJson = JSON.parse(text);
          if (!Array.isArray(parsedJson)) {
            throw new Error('Định dạng JSON phải là một mảng các đối tượng.');
          }
          setImportFileType('json');
          setImportPendingRows(parsedJson);
          setShowImportModal(true);
        } else if (file.name.endsWith('.csv')) {
          let cleanText = text;
          if (cleanText.charCodeAt(0) === 0xFEFF) {
            cleanText = cleanText.substring(1);
          }
          const parsedCsv = parseCSV(cleanText);
          if (parsedCsv.length < 2) {
            throw new Error('File CSV không có dữ liệu.');
          }
          const headers = parsedCsv[0];
          const rowsToImport: any[] = [];
          for (let i = 1; i < parsedCsv.length; i++) {
            const values = parsedCsv[i];
            const row: any = {};
            headers.forEach((h, idx) => {
              const val = values[idx];
              row[h] = val === undefined || val === '' ? null : val;
            });
            rowsToImport.push(row);
          }
          setImportFileType('csv');
          setImportPendingRows(rowsToImport);
          setShowImportModal(true);
        } else if (file.name.endsWith('.sql')) {
          setImportFileType('sql');
          setImportSqlContent(text);
          setShowImportModal(true);
        } else {
          throw new Error('Chỉ hỗ trợ import tệp .csv, .json, hoặc .sql');
        }
      } catch (err: any) {
        setErrorMsg('Lỗi đọc file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const confirmImport = async () => {
    setShowImportModal(false);
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      if (importFileType === 'sql') {
        const res = await dbHelper.executeQuery(importSqlContent);
        setLoading(false);
        if (res.success) {
          setSuccessMsg('Đã thực thi câu lệnh SQL import thành công!');
          fetchData();
        } else {
          setErrorMsg('Lỗi thực thi SQL: ' + res.error);
        }
      } else {
        const resData = await dbHelper.importTableData(tableName, importPendingRows);
        setLoading(false);
        if (resData.success) {
          setSuccessMsg(`Nhập thành công dữ liệu từ file!`);
          fetchData();
        } else {
          setErrorMsg(resData.error || 'Import thất bại.');
        }
      }
    } catch (err: any) {
      setLoading(false);
      setErrorMsg('Lỗi kết nối: ' + err.message);
    }
  };

  // Messages
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch Table Schema (Metadata)
  const fetchSchema = useCallback(async () => {
    try {
      const s = await dbHelper.getTableSchema(tableName);
      if (s && Array.isArray(s.columns)) {
        setSchema(s);
        setColumns(s.columns);
        setVisibleColumns(s.columns.map(c => c.name));
        setPendingVisibleColumns(s.columns.map(c => c.name));
        const pk = s.columns.find(c => c.isPrimaryKey);
        setPrimaryKey(pk ? pk.name : 'id');
      } else {
        setSchema(null);
        setColumns([]);
        setVisibleColumns([]);
        setPendingVisibleColumns([]);
        if (s && (s as any).error) {
          setErrorMsg((s as any).error);
        }
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg('Không thể tải cấu trúc bảng.');
      setSchema(null);
      setColumns([]);
      setVisibleColumns([]);
      setPendingVisibleColumns([]);
    }
  }, [tableName]);

  // Sync columns with filter builder
  useEffect(() => {
    if (columns.length > 0) {
      setFilterRows([
        { id: '1', active: true, column: columns[0].name, operator: 'Contains', value: '' }
      ]);
    } else {
      setFilterRows([]);
    }
  }, [columns]);

  // Filter Row Mutations
  const addFilterRow = useCallback((afterId?: string) => {
    const newRow: FilterRow = {
      id: String(Date.now()),
      active: true,
      column: columns[0]?.name || '',
      operator: 'Contains',
      value: ''
    };
    if (afterId) {
      setFilterRows(prev => {
        const idx = prev.findIndex(r => r.id === afterId);
        if (idx !== -1) {
          const next = [...prev];
          next.splice(idx + 1, 0, newRow);
          return next;
        }
        return [...prev, newRow];
      });
    } else {
      setFilterRows(prev => [...prev, newRow]);
    }
  }, [columns]);

  // Keyboard Shortcuts (Ctrl/Cmd + F for search, Ctrl/Cmd + I to insert, Delete/Backspace to delete row, Ctrl/Cmd + S to commit)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 0. Chuyển Data/Structure (Ctrl/Cmd + [ hoặc ])
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        setViewMode('structure');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        setViewMode('data');
        return;
      }

      // 1. Toggle filter bar (Ctrl/Cmd + F)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFilterBar(prev => !prev);
        return;
      }
      
      // 2. Insert new row (Ctrl/Cmd + I, hoặc Ctrl/Cmd + Shift + N cho khớp doc)
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'i' || (e.shiftKey && e.key.toLowerCase() === 'n'))) {
        e.preventDefault();
        handleAddRow();
        return;
      }

      // 2b. Undo/Redo buffer thay đổi (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z hoặc Ctrl/Cmd+Y)
      // Chỉ khi KHÔNG đang gõ trong ô/text (để undo native của input hoạt động bình thường)
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        const el = document.activeElement;
        const editingText = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true');
        if (!editingText) {
          const isRedo = e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey);
          e.preventDefault();
          if (isRedo) redoGridChange(); else undoGridChange();
          return;
        }
      }

      // 3. Save / Commit Changes (Ctrl/Cmd + S)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleCommit();
        return;
      }

      // 4. Delete Selected Row (Delete or Backspace - only when not editing a text input/textarea)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRowId !== null) {
        const activeEl = document.activeElement;
        const isEditingText = activeEl && (
          activeEl.tagName === 'INPUT' || 
          activeEl.tagName === 'TEXTAREA' || 
          activeEl.getAttribute('contenteditable') === 'true'
        );
        if (!isEditingText) {
          e.preventDefault();
          handleDeleteRow();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showFilterBar, filterMode, selectedRowId, updates, deletes, inserts, columns, tableName, undoStack, redoStack]);

  // Fetch Data Row
  const fetchData = useCallback(async () => {
    setLoading(true);
    const data = await dbHelper.getTableData(tableName, page, pageSize, sortBy, sortDir, activeFilter);
    setRows(data.rows);
    setTotalCount(data.totalCount);
    if (data.primaryKey) setPrimaryKey(data.primaryKey);
    setLoading(false);
  }, [tableName, page, pageSize, sortBy, sortDir, activeFilter]);

  useEffect(() => {
    // Tôn trọng chế độ xem ban đầu (Data/Structure) khi mở tab, thay vì luôn ép về 'data'
    setViewMode(initialViewMode);
    fetchSchema().then(() => {
      // Reset changes on table change
      setUpdates({});
      setDeletes(new Set());
      setInserts([]);
      setSelectedRowId(null);
      setPage(1);
      setSortBy(undefined);
      setActiveFilter('');
      setFilterText('');
    });
  }, [tableName, fetchSchema, initialViewMode]);

  useEffect(() => {
    if (columns.length > 0) {
      fetchData();
    }
  }, [columns, fetchData]);

  // Handle Sort Toggle
  const handleSort = (colName: string) => {
    if (sortBy === colName) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(colName);
      setSortDir('asc');
    }
    setPage(1);
  };

  // Handle Cell Editing
  const startEdit = (rowId: any, colName: string, currentValue: any) => {
    if (readOnly) {
      setErrorMsg('Đang ở chế độ Chỉ đọc: không thể sửa dữ liệu.');
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }
    // Cho phép sửa cả cột khóa chính: backend UPDATE dùng giá trị PK gốc trong WHERE,
    // còn SET áp giá trị PK mới (rowId luôn giữ nguyên giá trị gốc cho tới khi commit + refetch).
    setEditingCell({ rowId, colName });
    setEditValue(currentValue === null ? '' : currentValue);
  };

  const saveEdit = () => {
    if (!editingCell) return;
    const { rowId, colName } = editingCell;

    // Check if cell changed from original
    const isTemp = String(rowId).startsWith('temp_');

    if (isTemp) {
      // Modify inserts array (định danh theo __tempId, không dùng cột PK vì PK có thể được sửa)
      setInserts(prev =>
        prev.map(row => {
          if (row.__tempId === rowId) {
            return { ...row, [colName]: editValue };
          }
          return row;
        })
      );
    } else {
      // Find original row
      const originalRow = rows.find(r => r[primaryKey] === rowId);
      const originalVal = originalRow ? originalRow[colName] : undefined;

      if (String(originalVal) !== String(editValue)) {
        setUpdates(prev => {
          const rowUpdates = prev[rowId] || {};
          return {
            ...prev,
            [rowId]: {
              ...rowUpdates,
              [colName]: editValue
            }
          };
        });
      } else {
        // Revert to original if match
        setUpdates(prev => {
          const rowUpdates = { ...(prev[rowId] || {}) };
          delete rowUpdates[colName];
          const newUpdates = { ...prev };
          if (Object.keys(rowUpdates).length === 0) {
            delete newUpdates[rowId];
          } else {
            newUpdates[rowId] = rowUpdates;
          }
          return newUpdates;
        });
      }
    }

    setEditingCell(null);
  };

  // Add Empty Row
  const handleAddRow = () => {
    const tempId = `temp_${nextTempId}`;
    setNextTempId(nextTempId + 1);

    // __tempId là định danh nội bộ; cột PK để trống để người dùng nhập hoặc DB tự sinh (auto-increment)
    const newRow: any = { __tempId: tempId };
    columns.forEach(col => {
      newRow[col.name] = col.name === primaryKey ? '' : (col.defaultValue || '');
    });

    setInserts([...inserts, newRow]);
  };

  // Delete Selected / Marked Row
  const handleDeleteRow = (targetRowId?: any) => {
    const rowId = targetRowId ?? selectedRowId;
    if (rowId === null || rowId === undefined) {
      setErrorMsg('Vui lòng click chọn một dòng để xóa.');
      return;
    }

    const isTemp = String(rowId).startsWith('temp_');
    if (isTemp) {
      setInserts(inserts.filter(row => row.__tempId !== rowId));
    } else {
      setDeletes(prev => {
        const next = new Set(prev);
        if (next.has(rowId)) {
          next.delete(rowId); // toggle off
        } else {
          next.add(rowId); // toggle on
        }
        return next;
      });
    }
    setSelectedRowId(null);
  };

  // Duplicate selected row (append as new insert)
  const handleDuplicateRow = (row: any) => {
    const tempId = `temp_${nextTempId}`;
    setNextTempId(n => n + 1);
    // Không sao chép giá trị PK (tránh trùng khóa); để trống cho người dùng nhập hoặc DB tự sinh
    const newRow: any = { __tempId: tempId };
    columns.forEach(col => {
      newRow[col.name] = col.name === primaryKey ? '' : (row[col.name] ?? null);
    });
    setInserts(prev => [...prev, newRow]);
    setSelectedRowId(tempId);
    setSuccessMsg('Đã nhân bản dòng. Nhấn Ctrl+S để lưu.');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Copy helpers
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    });
  };

  const copyRowAsCSV = (row: any, withHeader: boolean) => {
    const cols = activeColumns.map(c => c.name);
    const vals = cols.map(c => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    });
    const csv = withHeader ? `${cols.join(',')}\n${vals.join(',')}` : vals.join(',');
    copyToClipboard(csv);
    setSuccessMsg('Đã sao chép dòng dưới dạng CSV!');
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsSQL = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const colList = cols.map(c => `\`${c}\``).join(', ');
    const valList = cols.map(c => {
      const v = row[c];
      if (v === null || v === undefined) return 'NULL';
      return `'${String(v).replace(/'/g, "''")}'`;
    }).join(', ');
    copyToClipboard(`INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`);
    setSuccessMsg('Đã sao chép dưới dạng SQL INSERT!');
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsMarkdown = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const header = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const vals = `| ${cols.map(c => String(row[c] ?? '')).join(' | ')} |`;
    copyToClipboard(`${header}\n${sep}\n${vals}`);
    setSuccessMsg('Đã sao chép dưới dạng Markdown table!');
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [contextMenu]);

  // Discard all changes
  const handleDiscard = () => {
    setUpdates({});
    setDeletes(new Set());
    setInserts([]);
    setEditingCell(null);
    setSuccessMsg('Đã hủy bỏ tất cả thay đổi nháp.');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Commit changes to Database
  const handleCommit = async () => {
    const changesList: GridChange[] = [];

    // 1. Gather Deletes
    deletes.forEach(rowId => {
      changesList.push({ type: 'delete', rowId });
    });

    // 2. Gather Inserts
    inserts.forEach(row => {
      const data = { ...row };
      delete data.__tempId;
      // Chỉ bỏ cột PK khỏi INSERT khi để trống -> DB tự sinh (auto-increment).
      // Nếu người dùng đã nhập giá trị PK (vd officeCode) thì giữ lại để đưa vào câu INSERT.
      const pkVal = data[primaryKey];
      if (pkVal === '' || pkVal === null || pkVal === undefined || String(pkVal).startsWith('temp_')) {
        delete data[primaryKey];
      }
      changesList.push({ type: 'insert', rowId: row.__tempId, newData: data });
    });

    // 3. Gather Updates
    Object.keys(updates).forEach(rowId => {
      const originalRow = rows.find(r => String(r[primaryKey]) === String(rowId));
      changesList.push({
        type: 'update',
        rowId,
        originalData: originalRow,
        newData: updates[rowId]
      });
    });

    if (readOnly) {
      setErrorMsg('Đang ở chế độ Chỉ đọc: không thể lưu thay đổi. Tắt "Chỉ đọc" để ghi.');
      setTimeout(() => setErrorMsg(null), 4000);
      return;
    }

    if (changesList.length === 0) {
      setErrorMsg('Không có thay đổi nào cần lưu.');
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }

    // Lấy trước danh sách SQL sẽ chạy để người dùng xem trước (transaction preview)
    setLoading(true);
    const preview = await dbHelper.commitChanges(tableName, changesList, primaryKey, true);
    setLoading(false);

    if (!preview.success) {
      setErrorMsg(`Lỗi tạo bản xem trước: ${preview.message}`);
      return;
    }
    setPendingChanges(changesList);
    setCommitPreview(preview.sqls || []);
  };

  // Thực thi commit thật sau khi người dùng xác nhận ở modal xem trước
  const handleConfirmCommit = async () => {
    setCommitPreview(null);
    setLoading(true);
    const res = await dbHelper.commitChanges(tableName, pendingChanges, primaryKey);
    setLoading(false);
    setPendingChanges([]);

    if (res.success) {
      setSuccessMsg('Đã lưu tất cả thay đổi vào cơ sở dữ liệu thành công!');
      setUpdates({});
      setDeletes(new Set());
      setInserts([]);
      resetGridHistory(); // buffer đã ghi DB -> xoá undo/redo
      fetchData();
      setTimeout(() => setSuccessMsg(null), 4000);
    } else {
      setErrorMsg(`Lỗi lưu thay đổi: ${res.message}`);
    }
  };

  // Helper to build SQL WHERE clause from visual filters
  const buildWhereFromVisual = (rowsToBuild: FilterRow[]) => {
    const active = rowsToBuild.filter(r => r.active && r.column);
    if (active.length === 0) return '';
    // Trích dẫn định danh theo dialect: MySQL dùng backtick, còn lại dùng dấu nháy kép
    const qc = dbType === 'mysql' ? '`' : '"';
    return active.map(r => {
      const col = `${qc}${r.column}${qc}`;
      const val = r.value.replace(/'/g, "''");
      switch (r.operator) {
        case '=': return `${col} = '${val}'`;
        case '!=': return `${col} != '${val}'`;
        case '>': return `${col} > '${val}'`;
        case '>=': return `${col} >= '${val}'`;
        case '<': return `${col} < '${val}'`;
        case '<=': return `${col} <= '${val}'`;
        case 'Contains': return `${col} LIKE '%${val}%'`;
        case 'Starts with': return `${col} LIKE '${val}%'`;
        case 'Ends with': return `${col} LIKE '%${val}'`;
        case 'IS NULL': return `${col} IS NULL`;
        case 'IS NOT NULL': return `${col} IS NOT NULL`;
        default: return `${col} = '${val}'`;
      }
    }).join(' AND ');
  };



  const removeFilterRow = (id: string) => {
    if (filterRows.length <= 1) {
      setFilterRows([
        { id: '1', active: true, column: columns[0]?.name || '', operator: 'Contains', value: '' }
      ]);
      return;
    }
    setFilterRows(filterRows.filter(r => r.id !== id));
  };

  const updateFilterRow = (id: string, fieldUpdates: Partial<FilterRow>) => {
    setFilterRows(filterRows.map(r => r.id === id ? { ...r, ...fieldUpdates } : r));
  };

  // Filter Trigger
  const triggerFilter = () => {
    if (filterMode === 'sql') {
      setActiveFilter(filterText);
    } else {
      setActiveFilter(buildWhereFromVisual(filterRows));
    }
    setPage(1);
  };

  const applySingleFilterRow = (rowId: string) => {
    const updated = filterRows.map(r => r.id === rowId ? { ...r, active: true } : r);
    setFilterRows(updated);
    setActiveFilter(buildWhereFromVisual(updated));
    setPage(1);
  };

  const clearFilter = () => {
    setFilterText('');
    if (columns.length > 0) {
      setFilterRows([
        { id: '1', active: true, column: columns[0].name, operator: 'Contains', value: '' }
      ]);
    } else {
      setFilterRows([]);
    }
    setActiveFilter('');
    setPage(1);
  };

  // Helper count of pending changes
  const changeCount = Object.keys(updates).length + deletes.size + inserts.length;

  // Guard rời đi khi còn thay đổi chưa lưu:
  //  - beforeunload: cảnh báo khi reload/đóng app.
  //  - window.__gridDirty: cờ để App hỏi xác nhận khi đổi tab/bảng/ngắt kết nối.
  useEffect(() => {
    (window as any).__gridDirty = changeCount > 0;
    const handler = (e: BeforeUnloadEvent) => {
      if (changeCount > 0) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      (window as any).__gridDirty = false;
    };
  }, [changeCount]);

  const activeColumns = columns.filter(c => visibleColumns.includes(c.name));

  return (
    <div className="table-data-view">
      {viewMode === 'data' && showFilterBar && (
        <div className="visual-filter-container">
          {filterMode === 'sql' ? (
            /* Raw SQL Input Mode */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
                <input
                  type="text"
                  className="sidebar-search-input"
                  style={{ width: '100%', paddingRight: '24px' }}
                  placeholder="Lọc SQL (ví dụ: status='Active' hoặc age > 30)..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && triggerFilter()}
                  autoFocus
                />
                {activeFilter && (
                  <button
                    onClick={clearFilter}
                    style={{
                      position: 'absolute', right: '8px', background: 'transparent',
                      border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer',
                      fontSize: '14px'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="visual-filter-footer">
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="visual-filter-btn-apply" onClick={clearFilter}>
                    Clear All
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('visual')} style={{ fontWeight: 600 }}>
                    Visual
                  </button>
                </div>
                <button className="btn btn-primary" onClick={triggerFilter} style={{ height: '26px', fontSize: '11px', padding: '0 12px' }}>
                  Apply SQL
                </button>
              </div>
            </div>
          ) : (
            /* Visual Filter Builder Mode */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filterRows.map((row) => (
                <div key={row.id} className="visual-filter-row">
                  <input
                    type="checkbox"
                    className="visual-filter-checkbox"
                    checked={row.active}
                    onChange={(e) => updateFilterRow(row.id, { active: e.target.checked })}
                  />
                  <select
                    className="visual-filter-select"
                    value={row.column}
                    onChange={(e) => updateFilterRow(row.id, { column: e.target.value })}
                  >
                    {columns.map(col => (
                      <option key={col.name} value={col.name}>{col.name}</option>
                    ))}
                  </select>
                  <select
                    className="visual-filter-select"
                    style={{ minWidth: '110px' }}
                    value={row.operator}
                    onChange={(e) => updateFilterRow(row.id, { operator: e.target.value })}
                  >
                    <option value="Contains">Contains</option>
                    <option value="=">=</option>
                    <option value="!=">!=</option>
                    <option value=">">&gt;</option>
                    <option value=">=">&gt;=</option>
                    <option value="<">&lt;</option>
                    <option value="<=">&lt;=</option>
                    <option value="Starts with">Starts with</option>
                    <option value="Ends with">Ends with</option>
                    <option value="IS NULL">IS NULL</option>
                    <option value="IS NOT NULL">IS NOT NULL</option>
                  </select>
                  <input
                    type="text"
                    className="visual-filter-input"
                    placeholder="Nhập giá trị..."
                    value={row.value}
                    disabled={row.operator === 'IS NULL' || row.operator === 'IS NOT NULL'}
                    onChange={(e) => updateFilterRow(row.id, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && triggerFilter()}
                  />
                  <button className="visual-filter-btn-apply" onClick={() => applySingleFilterRow(row.id)}>
                    Apply
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => removeFilterRow(row.id)}>
                    —
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => addFilterRow(row.id)}>
                    ＋
                  </button>
                </div>
              ))}
              <div className="visual-filter-footer">
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <button className="visual-filter-btn-apply" onClick={clearFilter}>
                    Clear All
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('sql')} style={{ fontWeight: 600 }}>
                    SQL
                  </button>
                  <div className="visual-filter-footer-info" style={{ marginLeft: '12px' }}>
                    <span>Show: ⌘F / Ctrl+F</span>
                    <span>Insert: ⌘I / Ctrl+I</span>
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={triggerFilter}
                  style={{ height: '26px', fontSize: '11px', padding: '0 16px', background: '#10b981' }}
                >
                  Apply All
                </button>
              </div>
            </div>
          )}
        </div>
      )}      {/* Commit/Discard buttons removed from here to prevent squeezing */}

      {successMsg && (
        <div className="info-bar" style={{ background: 'rgba(16, 185, 129, 0.1)', borderLeftColor: '#10b981' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} color="#10b981" />
            <span>{successMsg}</span>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="info-bar" style={{ background: 'rgba(239, 68, 68, 0.1)', borderLeftColor: '#ef4444' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} color="#ef4444" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg(null)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer' }}>×</button>
        </div>
      )}

      {viewMode === 'structure' && schema ? (
        <StructureViewer
          tableName={tableName}
          schema={schema}
          dbType={dbType}
          onSchemaChanged={fetchSchema}
          readOnly={readOnly}
        />
      ) : (
        <div className="grid-table-container">
          {loading && rows.length === 0 ? (
            <div style={{ padding: '40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', color: 'var(--win-text-secondary)' }}>
              <LoadingSpinner size={32} />
              <span style={{ fontSize: '11px' }}>Đang tải dữ liệu...</span>
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  {activeColumns.map(col => (
                    <th key={col.name} onClick={() => handleSort(col.name)} style={{ cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyItems: 'center', gap: '6px' }}>
                        <span>{col.name}</span>
                        {col.isPrimaryKey && <span className="key-badge">PK</span>}
                        {sortBy === col.name && (
                          <span style={{ fontSize: '10px', color: 'var(--win-accent)' }}>
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* 1. Render database rows */}
                {rows.map((row, index) => {
                  const rowId = row[primaryKey];
                  // Guard: if PK is missing, use index-based fallback to prevent shared state across rows
                  const hasPK = rowId !== undefined && rowId !== null;
                  const selectionKey = hasPK ? rowId : `__idx_${index}`;
                  const isDeleted = hasPK && deletes.has(rowId);
                  const isSelected = selectedRowId === selectionKey;
                  const rowUpdates = hasPK ? (updates[rowId] || {}) : {};

                  return (
                    <tr
                      key={selectionKey}
                      className={`${isDeleted ? 'grid-row-deleted' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedRowId(selectionKey)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedRowId(selectionKey);
                        const colName = (e.target as HTMLElement).closest('td')?.dataset.col || activeColumns[0]?.name || '';
                        const cellVal = colName in rowUpdates ? rowUpdates[colName] : row[colName];
                        setContextMenu({ x: e.clientX, y: e.clientY, rowId: selectionKey, row, colName, cellValue: cellVal });
                      }}
                    >
                      {activeColumns.map(col => {
                        const isCellDirty = col.name in rowUpdates;
                        const cellVal = isCellDirty ? rowUpdates[col.name] : row[col.name];
                        const isEditing = editingCell?.rowId === rowId && editingCell?.colName === col.name;

                        return (
                          <td
                            key={col.name}
                            data-col={col.name}
                            className={isCellDirty ? 'grid-cell-dirty' : ''}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedRowId(selectionKey);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId: selectionKey, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <input
                                type="text"
                                className="grid-input-edit"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit();
                                  if (e.key === 'Escape') setEditingCell(null);
                                }}
                                autoFocus
                              />
                            ) : cellVal === null ? (
                              <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                            ) : (
                              String(cellVal)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* 2. Render new added rows */}
                {inserts.map((row) => {
                  const rowId = row.__tempId;
                  const isSelected = selectedRowId === rowId;
                  return (
                    <tr
                      key={rowId}
                      className={`grid-row-added ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedRowId(rowId)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedRowId(rowId);
                        const colName = (e.target as HTMLElement).closest('td')?.dataset.col || activeColumns[0]?.name || '';
                        setContextMenu({ x: e.clientX, y: e.clientY, rowId, row, colName, cellValue: row[colName] });
                      }}
                    >
                      {activeColumns.map(col => {
                        const cellVal = row[col.name];
                        const isEditing = editingCell?.rowId === rowId && editingCell?.colName === col.name;

                        return (
                          <td
                            key={col.name}
                            data-col={col.name}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedRowId(rowId);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <input
                                type="text"
                                className="grid-input-edit"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit();
                                  if (e.key === 'Escape') setEditingCell(null);
                                }}
                                autoFocus
                              />
                            ) : (
                              String(cellVal)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="grid-pagination" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--win-bg-window)', borderTop: '1px solid var(--win-border)', padding: '6px 12px' }}>
        {/* Left segment: Data | Structure & + Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="segmented-control">
            <button
              className={`segment-btn ${viewMode === 'data' ? 'active' : ''}`}
              onClick={() => setViewMode('data')}
            >
              Data
            </button>
            <button
              className={`segment-btn ${viewMode === 'structure' ? 'active' : ''}`}
              onClick={() => setViewMode('structure')}
            >
              Structure
            </button>
          </div>

          {viewMode === 'data' && (
            <>
              <button
                className="btn btn-secondary"
                onClick={handleAddRow}
                style={{
                  height: '24px',
                  fontSize: '11px',
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px'
                }}
              >
                <Plus size={11} />
                <span>Row</span>
              </button>

              <button
                className="btn btn-secondary"
                onClick={handleDeleteRow}
                disabled={selectedRowId === null}
                style={{
                  height: '24px',
                  fontSize: '11px',
                  padding: '0 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  color: selectedRowId === null ? 'var(--win-text-disabled)' : '#ef4444'
                }}
                title="Xóa dòng đang chọn"
              >
                <Minus size={11} />
                <span>Row</span>
              </button>
            </>
          )}

          {/* Commit/Discard Actions */}
          {changeCount > 0 && (
            <div style={{ display: 'flex', gap: '4px', marginLeft: '6px' }}>
              <button
                className="btn btn-secondary"
                onClick={handleDiscard}
                style={{ height: '24px', fontSize: '10px', padding: '0 6px', display: 'flex', alignItems: 'center' }}
                title="Hủy thay đổi nháp"
              >
                <RotateCcw size={10} />
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCommit}
                style={{ height: '24px', fontSize: '10px', padding: '0 8px', display: 'flex', alignItems: 'center', gap: '4px', background: '#10b981' }}
                title="Lưu tất cả thay đổi"
              >
                <Save size={10} />
                <span>Lưu ({changeCount})</span>
              </button>
            </div>
          )}
        </div>

        {/* Middle section: Row Count */}
        {viewMode === 'data' && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
            <b>{(page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalCount)}</b> of <b>{totalCount.toLocaleString('vi-VN')}</b> rows
          </div>
        )}

        {/* Right section: Columns | Filters | Navigation */}
        {viewMode === 'data' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ position: 'relative' }}>
              <button
                className={`btn btn-secondary ${showColumnsPopover ? 'btn-primary' : ''}`}
                onClick={() => {
                  if (!showColumnsPopover) {
                    setPendingVisibleColumns([...visibleColumns]);
                  }
                  setShowColumnsPopover(!showColumnsPopover);
                }}
                style={{
                  height: '24px',
                  fontSize: '11px',
                  padding: '0 8px',
                  background: showColumnsPopover ? 'var(--win-accent)' : 'rgba(255,255,255,0.05)',
                  color: showColumnsPopover ? '#fff' : 'var(--win-text-primary)'
                }}
                title="Cấu hình hiển thị cột"
              >
                Columns
              </button>

              {showColumnsPopover && (
                <div style={{
                  position: 'absolute',
                  bottom: '30px',
                  right: '0',
                  width: '320px',
                  background: 'var(--win-bg-card)',
                  border: '1px solid var(--win-border-strong, var(--win-border))',
                  borderRadius: '6px',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
                  zIndex: 1000,
                  padding: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', marginBottom: '4px' }}>
                    Hiển thị các cột
                  </div>

                  <div>
                    <select
                      className="form-input"
                      style={{
                        width: '100%',
                        height: '28px',
                        fontSize: '11px',
                        padding: '2px 6px',
                        background: 'var(--win-bg-window)',
                        border: '1px solid var(--win-border)',
                        color: 'var(--win-text-primary)',
                        borderRadius: '4px',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val && !pendingVisibleColumns.includes(val)) {
                          setPendingVisibleColumns([...pendingVisibleColumns, val]);
                        }
                      }}
                    >
                      <option value="" disabled style={{ background: 'var(--win-bg-window)', color: 'var(--win-text-primary)' }}>Thêm cột hiển thị...</option>
                      {columns.map(c => c.name)
                        .filter(name => !pendingVisibleColumns.includes(name))
                        .map(name => (
                          <option key={name} value={name} style={{ background: 'var(--win-bg-window)', color: 'var(--win-text-primary)' }}>{name}</option>
                        ))}
                    </select>
                  </div>

                  <div style={{
                    minHeight: '80px',
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    padding: '8px',
                    background: 'var(--win-bg-hover, rgba(0,0,0,0.05))',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    alignContent: 'flex-start'
                  }}>
                    {pendingVisibleColumns.length === 0 ? (
                      <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>Không có cột nào được hiển thị</span>
                    ) : (
                      pendingVisibleColumns.map(colName => (
                        <div
                          key={colName}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            background: 'var(--win-accent-glow)',
                            border: '1px solid rgba(77, 139, 244, 0.4)',
                            color: 'var(--win-text-primary)',
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontWeight: 500
                          }}
                        >
                          <span>{colName}</span>
                          <button
                            onClick={() => setPendingVisibleColumns(pendingVisibleColumns.filter(c => c !== colName))}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--win-accent)',
                              padding: 0,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              marginLeft: '2px',
                              fontWeight: 'bold',
                              fontSize: '12px'
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setPendingVisibleColumns([])}
                      style={{
                        height: '26px',
                        fontSize: '11px',
                        padding: '0 12px',
                        background: 'var(--win-bg-hover)',
                        border: '1px solid var(--win-border)',
                        color: 'var(--win-text-primary)',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Clear
                    </button>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => setShowColumnsPopover(false)}
                        style={{
                          height: '26px',
                          fontSize: '11px',
                          padding: '0 12px',
                          background: 'var(--win-bg-hover)',
                          border: '1px solid var(--win-border)',
                          color: 'var(--win-text-primary)',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        Hủy
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setVisibleColumns([...pendingVisibleColumns]);
                          setShowColumnsPopover(false);
                        }}
                        style={{
                          height: '26px',
                          fontSize: '11px',
                          padding: '0 14px',
                          background: 'var(--win-accent)',
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 600
                        }}
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Hidden Input for Import */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileImport}
              accept=".csv,.json,.sql"
              style={{ display: 'none' }}
            />

            <button
              className="btn btn-secondary"
              onClick={handleImportClick}
              disabled={loading}
              style={{
                height: '24px',
                fontSize: '11px',
                padding: '0 8px',
                background: 'rgba(255,255,255,0.05)',
                color: 'var(--win-text-primary)'
              }}
              title="Nhập dữ liệu từ CSV/JSON/SQL"
            >
              Import
            </button>

            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportDropdown(!showExportDropdown)}
                style={{
                  height: '24px',
                  fontSize: '11px',
                  padding: '0 8px',
                  background: showExportDropdown ? 'var(--win-accent)' : 'rgba(255,255,255,0.05)',
                  color: showExportDropdown ? '#fff' : 'var(--win-text-primary)'
                }}
                title="Xuất dữ liệu ra CSV/JSON/SQL/XLSX"
              >
                Export
              </button>
              {showExportDropdown && (
                <div style={{
                  position: 'absolute',
                  bottom: '30px',
                  right: 0,
                  background: 'var(--win-bg-card)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  boxShadow: '0 8px 16px rgba(0,0,0,0.3)',
                  zIndex: 1000,
                  display: 'flex',
                  flexDirection: 'column',
                  width: '120px',
                  padding: '4px 0'
                }}>
                  {['CSV', 'JSON', 'SQL', 'XLSX'].map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => handleExport(fmt.toLowerCase() as any)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--win-text-primary)',
                        padding: '6px 12px',
                        fontSize: '11px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        width: '100%',
                        display: 'block'
                      }}
                      className="export-dropdown-item"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              className={`btn btn-secondary ${showFilterBar ? 'btn-primary' : ''}`}
              onClick={() => setShowFilterBar(!showFilterBar)}
              style={{
                height: '24px',
                fontSize: '11px',
                padding: '0 8px',
                background: showFilterBar ? 'var(--win-accent)' : 'rgba(255,255,255,0.05)',
                color: showFilterBar ? '#fff' : 'var(--win-text-primary)'
              }}
              title="Bật/Tắt bộ lọc dữ liệu"
            >
              Filters
            </button>

            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--win-bg-card)', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
              <button
                onClick={() => setPage(p => Math.max(p - 1, 1))}
                disabled={page === 1}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: page === 1 ? 'var(--win-text-disabled)' : 'var(--win-text-primary)',
                  padding: '2px 8px',
                  cursor: page === 1 ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <ChevronLeft size={14} />
              </button>

              <div style={{ width: '1px', height: '14px', background: 'var(--win-border)' }} />

              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value));
                  setPage(1);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--win-text-primary)',
                  fontSize: '11px',
                  padding: '0 4px',
                  cursor: 'pointer',
                  outline: 'none'
                }}
                title="Số dòng mỗi trang"
              >
                <option value="50" style={{ background: 'var(--win-bg-card)', color: 'var(--win-text-primary)' }}>50</option>
                <option value="100" style={{ background: 'var(--win-bg-card)', color: 'var(--win-text-primary)' }}>100</option>
                <option value="200" style={{ background: 'var(--win-bg-card)', color: 'var(--win-text-primary)' }}>200</option>
              </select>

              <div style={{ width: '1px', height: '14px', background: 'var(--win-border)' }} />

              <button
                onClick={() => setPage(p => Math.min(p + 1, totalPages))}
                disabled={page >= totalPages}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: page >= totalPages ? 'var(--win-text-disabled)' : 'var(--win-text-primary)',
                  padding: '2px 8px',
                  cursor: page >= totalPages ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showExportModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.6)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            width: '640px',
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '6px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                Xuất dữ liệu & Xem trước - Bảng: {tableName}
              </span>
              <button
                onClick={() => setShowExportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Tab Selector */}
              <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--win-border)', paddingBottom: '8px' }}>
                {(['csv', 'json', 'sql', 'xlsx'] as const).map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => setExportFormat(fmt)}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid transparent',
                      cursor: 'pointer',
                      background: exportFormat === fmt ? 'var(--win-accent)' : 'transparent',
                      color: exportFormat === fmt ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: exportFormat === fmt ? 600 : 500
                    }}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>

              {/* Preview Area */}
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
                  Xem trước 10 bản ghi đầu tiên:
                </div>
                {previewLoading ? (
                  <div style={{
                    height: '240px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: 'var(--win-text-secondary)'
                  }}>
                    Đang tải dữ liệu xem trước...
                  </div>
                ) : exportFormat === 'xlsx' ? (
                  <div
                    style={{
                      height: '240px',
                      overflow: 'auto',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      borderRadius: '4px',
                      padding: '8px',
                      fontSize: '11px'
                    }}
                    dangerouslySetInnerHTML={{ __html: previewText }}
                  />
                ) : (
                  <textarea
                    readOnly
                    value={previewText}
                    style={{
                      width: '100%',
                      height: '240px',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      color: 'var(--win-text-primary)',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '10px',
                      borderRadius: '4px',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                )}
              </div>
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              padding: '12px 16px',
              borderTop: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(previewText);
                  alert('Đã sao chép nội dung xem trước vào bộ nhớ tạm!');
                }}
                disabled={previewLoading || !previewText}
                style={{ height: '26px', fontSize: '11px', padding: '0 12px' }}
              >
                Sao chép Preview
              </button>
              <button
                className="btn btn-primary"
                onClick={triggerFullDownload}
                disabled={previewLoading}
                style={{ height: '26px', fontSize: '11px', padding: '0 16px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px' }}
              >
                Tải xuống tệp đầy đủ
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.6)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            width: '720px',
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '6px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                Xem trước dữ liệu Nhập (Import Preview) - Tệp: {importFileName}
              </span>
              <button
                onClick={() => setShowImportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                {importFileType === 'sql' ? (
                  <span>Định dạng SQL Script: Câu lệnh bên dưới sẽ được chạy trực tiếp trên database.</span>
                ) : (
                  <span>
                    Định dạng {importFileType.toUpperCase()}: Phát hiện <b>{importPendingRows.length} bản ghi</b>.
                    Dưới đây là xem trước 5 bản ghi đầu tiên:
                  </span>
                )}
              </div>

              {importFileType === 'sql' ? (
                <textarea
                  readOnly
                  value={importSqlContent.slice(0, 5000) + (importSqlContent.length > 5000 ? '\n... (nội dung còn lại ẩn đi trong preview)' : '')}
                  style={{
                    width: '100%',
                    height: '280px',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    padding: '10px',
                    borderRadius: '4px',
                    resize: 'none',
                    outline: 'none'
                  }}
                />
              ) : (
                <div style={{
                  height: '280px',
                  overflow: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)'
                }}>
                  {importPendingRows.length > 0 ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {Object.keys(importPendingRows[0]).map(col => (
                            <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importPendingRows.slice(0, 5).map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {Object.keys(importPendingRows[0]).map(col => (
                              <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                                {row[col] === null ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span> : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--win-text-disabled)' }}>Không có bản ghi nào.</div>
                  )}
                </div>
              )}
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              padding: '12px 16px',
              borderTop: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowImportModal(false)}
                style={{ height: '26px', fontSize: '11px', padding: '0 12px' }}
              >
                Hủy
              </button>
              <button
                className="btn btn-primary"
                onClick={confirmImport}
                style={{ height: '26px', fontSize: '11px', padding: '0 16px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px' }}
              >
                Xác nhận Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Right-Click Context Menu ─── */}
      {contextMenu && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: Math.min(contextMenu.y, window.innerHeight - 320),
            left: Math.min(contextMenu.x, window.innerWidth - 230),
            zIndex: 99999,
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border)',
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            padding: '4px 0',
            minWidth: '210px',
            fontSize: '12px',
          }}
        >
          {/* Row actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Dòng</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); handleDuplicateRow(contextMenu.row); }}>
            <span>📋</span> Nhân bản dòng (Duplicate)
          </button>
          <button className="context-menu-item" style={{ color: '#ef4444' }} onClick={() => { setContextMenu(null); handleDeleteRow(contextMenu.rowId); }}>
            <span>🗑</span> Xóa dòng (Delete)
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Sort actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sắp xếp theo "{contextMenu.colName}"</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('asc'); setPage(1); }}>
            <span>↑</span> Tăng dần (ASC)
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('desc'); setPage(1); }}>
            <span>↓</span> Giảm dần (DESC)
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy cell */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ô "{contextMenu.colName}"</div>
          <button className="context-menu-item" onClick={() => {
            const cm = contextMenu;
            setContextMenu(null);
            startEdit(cm.rowId, cm.colName, cm.cellValue);
          }}>
            <span>✏️</span> Sửa ô (Edit)
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            copyToClipboard(contextMenu.cellValue === null ? '' : String(contextMenu.cellValue));
            setSuccessMsg('Đã sao chép giá trị ô!'); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📄</span> Sao chép giá trị ô
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            const allVals = rows.map(r => r[contextMenu.colName]).filter(v => v !== null && v !== undefined).join('\n');
            copyToClipboard(allVals);
            setSuccessMsg('Đã sao chép tất cả giá trị cột!'); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📋</span> Sao chép tất cả giá trị cột
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setQuickLookCell({ colName: contextMenu.colName, value: contextMenu.cellValue }); }}>
            <span>🔍</span> Quick Look
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy row */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sao chép dòng dưới dạng</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, false); }}>
            <span>📊</span> CSV
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, true); }}>
            <span>📊</span> CSV (kèm tiêu đề)
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsSQL(contextMenu.row); }}>
            <span>🗄</span> SQL INSERT
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsMarkdown(contextMenu.row); }}>
            <span>📝</span> Markdown Table
          </button>
        </div>
      )}

      {/* ─── Quick Look Modal ─── */}
      {quickLookCell && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 99998,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setQuickLookCell(null)}
        >
          <div
            style={{
              background: 'var(--win-bg-card)',
              border: '1px solid var(--win-border)',
              borderRadius: '10px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              padding: '0',
              minWidth: '400px',
              maxWidth: '700px',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--win-border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Quick Look — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{quickLookCell.colName}</span></span>
              <button onClick={() => setQuickLookCell(null)} style={{ background: 'none', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}>✕</button>
            </div>
            <div style={{ padding: '16px', flex: 1, overflowY: 'auto', background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {quickLookCell.value === null
                ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                : String(quickLookCell.value)
              }
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'var(--win-bg-card)' }}>
              <button className="btn btn-secondary" onClick={() => { copyToClipboard(quickLookCell.value === null ? '' : String(quickLookCell.value)); }}>Sao chép</button>
              <button className="btn btn-primary" style={{ background: '#10b981', borderColor: '#10b981' }} onClick={() => setQuickLookCell(null)}>Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Transaction Preview Modal (xem trước SQL trước khi commit) ─── */}
      {commitPreview && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setCommitPreview(null); setPendingChanges([]); }}
        >
          <div
            style={{ background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '8px', width: '640px', maxWidth: '92%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--win-border)', fontWeight: 600 }}>
              Xem trước thay đổi — {commitPreview.length} câu lệnh sẽ chạy
            </div>
            <div style={{ padding: '16px', flex: 1, overflowY: 'auto', background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
              {commitPreview.length === 0 ? (
                <div style={{ color: 'var(--win-text-disabled)' }}>Không có câu lệnh nào.</div>
              ) : (
                commitPreview.map((sql, idx) => (
                  <pre key={idx} style={{ margin: '0 0 10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < commitPreview.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                    {sql};
                  </pre>
                ))
              )}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'var(--win-bg-card)' }}>
              <button className="btn btn-secondary" onClick={() => { setCommitPreview(null); setPendingChanges([]); }} disabled={loading}>Hủy</button>
              <button className="btn btn-primary" onClick={handleConfirmCommit} disabled={loading || commitPreview.length === 0} style={{ background: '#10b981', borderColor: '#10b981' }}>
                {loading ? 'Đang chạy...' : 'Xác nhận & Lưu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
