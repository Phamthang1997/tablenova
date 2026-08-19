import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { clampMenu, type MenuRect } from '../utils/menuPosition';
import { dbHelper } from '../utils/dbHelper';
import type { SchemaInfo, ColumnInfo, GridChange } from '../utils/dbHelper';
import {
  Save, RotateCcw, Plus, ChevronLeft, ChevronRight,
  CheckCircle2, AlertTriangle, Minus, Copy, Calendar
} from 'lucide-react';
import { StructureViewer } from './StructureViewer';
import { parseXlsx } from '../utils/xlsxReader';
import { collectColumns, inferColType } from '../utils/importPreview';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ImportFilePicker } from './ImportFilePicker';
import { ExportTableDialog } from './ExportTableDialog';
import { Modal, ModalBody, ModalFooter } from './Modal';

/** Số dòng mỗi lô khi nhập dữ liệu vào bảng (để báo được tiến độ). */
const IMPORT_BATCH_SIZE = 500;

// Ký hiệu phím điều khiển theo nền tảng, để chỉ hiện đúng một phím tắt.
const modKey = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';

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

const getInitialFilterClause = (filterObj?: { column: string; value: any }, type?: string) => {
  if (!filterObj || !filterObj.column) return '';
  const qc = type === 'mysql' ? '`' : '"';
  const val = String(filterObj.value).replace(/'/g, "''");
  const col = `${qc}${filterObj.column}${qc}`;
  return `${col} = '${val}'`;
};

const isDateField = (colName: string, colType?: string, val?: any): boolean => {
  const name = colName.toLowerCase();
  const type = (colType || '').toLowerCase();
  const strVal = String(val || '');

  if (type.includes('date') || type.includes('timestamp') || type.includes('time')) return true;
  if (name.endsWith('_at') || name.includes('date') || name.includes('time') || name.includes('updated') || name.includes('created')) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(strVal)) return true;

  return false;
};

const formatForPicker = (val: string): string => {
  if (!val) {
    const now = new Date();
    return now.toISOString().slice(0, 19);
  }
  const str = String(val).trim().replace(' ', 'T');
  const match = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
  if (match) return match[1];

  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      const secs = String(d.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${mins}:${secs}`;
    }
  } catch {}

  return '';
};

interface DataGridProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, không đọc id ambient (§4.1). */
  connId: string;
  tableName: string;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  initialViewMode?: 'data' | 'structure';
  initialFilter?: { column: string; value: any };
  readOnly?: boolean;
  /**
   * Còn sửa đổi chưa commit hay không. App dùng để chấm dấu "chưa lưu" lên tab
   * và để hỏi xác nhận khi rời đi — thay cho cờ toàn cục `window.__gridDirty`
   * trước đây, vốn không kéo theo render nào nên thanh tab không thể phản ứng.
   */
  onDirtyChange?: (dirty: boolean) => void;
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

export const DataGrid: React.FC<DataGridProps> = ({ connId, tableName, dbType, initialViewMode = 'data', initialFilter, readOnly = false, onDirtyChange }) => {
  const { t, i18n } = useTranslation();
  // Thousands separators follow the active UI language instead of a hardcoded locale.
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);
  // `t` gets a new identity on every language switch. Memoized callbacks that
  // feed an effect read it through this ref instead, so switching language does
  // not re-run fetchSchema — that effect clears the unsaved edit buffer.
  const tRef = useRef(t);
  tRef.current = t;

  // Cùng lý do: App truyền một arrow inline nên callback đổi identity mỗi lần
  // render. Để thẳng vào deps của effect theo dõi changeCount thì effect chạy
  // lại liên tục, và mỗi lần chạy lại hàm dọn dẹp bắn `false` -> dấu chưa lưu
  // trên tab nhấp nháy.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

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
  const [filterText, setFilterText] = useState<string>(() =>
    getInitialFilterClause(initialFilter, dbType)
  );
  const [activeFilter, setActiveFilter] = useState<string>(() =>
    getInitialFilterClause(initialFilter, dbType)
  );

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

  // Vị trí menu chuột phải sau khi đo kích thước thật (tránh tràn khỏi cửa sổ)
  const cellMenuRef = useRef<HTMLDivElement>(null);
  const [cellMenuPos, setCellMenuPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!contextMenu) {
      setCellMenuPos(null);
      return;
    }
    const el = cellMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCellMenuPos(clampMenu(contextMenu.x, contextMenu.y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [contextMenu]);

  // Quick Look Modal State
  const [quickLookCell, setQuickLookCell] = useState<{ colName: string; value: any } | null>(null);

  // Schema View Toggle
  const [viewMode, setViewMode] = useState<'data' | 'structure'>(initialViewMode);
  const [structSection, setStructSection] = useState<'columns' | 'indexes' | 'fks' | 'check_constraints' | 'triggers' | 'partitions' | 'ddl'>('columns');
  const [showFilterBar, setShowFilterBar] = useState<boolean>(() =>
    !!(initialFilter && initialFilter.column)
  );

  // Columns Visibility State
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [pendingVisibleColumns, setPendingVisibleColumns] = useState<string[]>([]);
  const [showColumnsPopover, setShowColumnsPopover] = useState(false);

  // Export State — toàn bộ tuỳ chọn/preview nằm trong ExportTableDialog
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Import Preview State
  const [importTab, setImportTab] = useState<'structure' | 'data'>('structure');
  const [importProgress, setImportProgress] = useState<ProgressState | null>(null);
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importFileType, setImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [importPendingRows, setImportPendingRows] = useState<any[]>([]);
  const [importSqlContent, setImportSqlContent] = useState('');

  // Cột có trong tệp (gộp key của mọi dòng: CSV/JSON có thể thiếu cột ở một số dòng)
  const importFileCols = React.useMemo(() => collectColumns(importPendingRows), [importPendingRows]);

  // Cột trong tệp mà bảng đích không có -> nhập sẽ lỗi, cảnh báo trước.
  const importUnknownCols = React.useMemo(() => {
    if (columns.length === 0) return [];
    const target = columns.map(c => c.name.toLowerCase());
    return importFileCols.filter(c => !target.includes(c.toLowerCase()));
  }, [importFileCols, columns]);

  const handleImportClick = () => {
    setShowImportPicker(true);
  };

  // Nhận tệp từ ImportFilePicker (đã kiểm tra phần mở rộng ở đó) rồi parse để xem trước.
  const handleFileImport = async (file: File) => {
    setShowImportPicker(false);
    setImportTab('structure');
    setImportFileName(file.name);
    setErrorMsg(null);
    setSuccessMsg(null);

    // XLSX nhị phân -> đọc ArrayBuffer + parse riêng.
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const rows = await parseXlsx(buf);
        if (rows.length === 0) throw new Error(t('dataGrid.errXlsxEmpty'));
        setImportFileType('json'); // dòng dạng object, đi chung nhánh ghi DB với CSV/JSON
        setImportPendingRows(rows);
        setShowImportModal(true);
      } catch (err: any) {
        setErrorMsg(t('dataGrid.errReadFile', { message: err.message }));
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        if (file.name.endsWith('.json')) {
          const parsedJson = JSON.parse(text);
          if (!Array.isArray(parsedJson)) {
            throw new Error(t('dataGrid.errJsonArray'));
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
            throw new Error(t('dataGrid.errCsvEmpty'));
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
          throw new Error(t('dataGrid.errUnsupportedFile'));
        }
      } catch (err: any) {
        setErrorMsg(t('dataGrid.errReadFile', { message: err.message }));
      }
    };
    reader.readAsText(file);
  };

  const confirmImport = async () => {
    setShowImportModal(false);
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setImportProgress({
      label: importFileType === 'sql'
        ? t('dataGrid.importRunningSql')
        : t('dataGrid.importWritingRows', { n: importPendingRows.length, table: tableName }),
    });

    try {
      if (importFileType === 'sql') {
        // Xem ghi chú ở App.tsx: tệp .sql có nhiều câu lệnh nên phải qua executeQueryMulti.
        const res = await dbHelper.executeQueryMulti(connId, importSqlContent);
        setImportProgress(null);
        setLoading(false);
        if (res.success) {
          setSuccessMsg(t('dataGrid.importSqlSuccess'));
          fetchData();
        } else {
          setErrorMsg(t('dataGrid.errImportSql', { message: res.error }));
        }
      } else {
        // Ghi theo lô để báo được tiến độ thật (backend chèn từng dòng trong mỗi lô).
        const total = importPendingRows.length;
        let done = 0;
        for (let i = 0; i < total; i += IMPORT_BATCH_SIZE) {
          const batch = importPendingRows.slice(i, i + IMPORT_BATCH_SIZE);
          const resData = await dbHelper.importTableData(connId, tableName, batch);
          if (!resData.success) {
            setImportProgress(null);
            setLoading(false);
            const failure = resData.error || t('dataGrid.errImportFailed');
            setErrorMsg(
              done > 0 ? t('dataGrid.errImportWithProgress', { message: failure, done, total }) : failure
            );
            fetchData();
            return;
          }
          done += batch.length;
          setImportProgress({
            label: t('dataGrid.importWriting', { table: tableName }),
            current: done,
            total,
            detail: t('dataGrid.importRowsDetail', { done: fmtNum(done), total: fmtNum(total) }),
          });
        }
        setImportProgress(null);
        setLoading(false);
        setSuccessMsg(t('dataGrid.importDone', { n: done, table: tableName }));
        fetchData();
      }
    } catch (err: any) {
      setImportProgress(null);
      setLoading(false);
      setErrorMsg(t('common.connectionError', { message: err.message }));
    }
  };

  // Messages
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Thông báo thành công tự ẩn. Các đường tự hẹn giờ (sao chép ô, lưu thay đổi...) vẫn ẩn sớm
  // hơn theo timer của chúng; hiệu ứng này lo những đường không hẹn giờ — Export/Import gọi
  // onSuccess từ dialog nên trước đây dải xanh treo lại mãi.
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(null), 5000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Fetch Table Schema (Metadata)
  const fetchSchema = useCallback(async () => {
    try {
      const s = await dbHelper.getTableSchema(connId, tableName);
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
      setErrorMsg(tRef.current('dataGrid.errLoadSchema'));
      setSchema(null);
      setColumns([]);
      setVisibleColumns([]);
      setPendingVisibleColumns([]);
    }
  }, [connId, tableName]);

  // Sync columns with filter builder
  useEffect(() => {
    if (columns.length > 0) {
      if (initialFilter && initialFilter.column) {
        setFilterRows([
          { id: '1', active: true, column: initialFilter.column, operator: '=', value: String(initialFilter.value) }
        ]);
      } else {
        setFilterRows([
          { id: '1', active: true, column: columns[0].name, operator: 'Contains', value: '' }
        ]);
      }
    } else {
      setFilterRows([]);
    }
  }, [columns, initialFilter]);

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
  //
  // Bản cũ khai 10 dep nhưng THIẾU 5 handler (handleAddRow, handleCommit,
  // handleDeleteRow, undo/redoGridChange). Đây không chỉ là cảnh báo lint: các
  // handler bị "đóng băng" theo lần render mà effect chạy gần nhất, nên phím tắt
  // có thể gọi phiên bản cũ với state cũ (ví dụ Ctrl+I dùng activeColumns lỗi thời).
  // Thêm chúng vào deps cũng không đúng: chúng được tạo lại mỗi render nên listener
  // sẽ bị gỡ/gắn lại liên tục. Giải pháp: giữ handler mới nhất trong ref rồi gắn
  // MỘT listener duy nhất, ổn định suốt đời component.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => { });

  keyHandlerRef.current = (e: KeyboardEvent) => {
    {
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
    }
  };

  // Gắn MỘT listener duy nhất suốt đời component; nó luôn gọi bản handler mới nhất
  // qua ref nên không còn closure cũ, và cũng không gỡ/gắn lại mỗi lần state đổi.
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Fetch Data Row
  const fetchData = useCallback(async () => {
    setLoading(true);
    const data = await dbHelper.getTableData(connId, tableName, page, pageSize, sortBy, sortDir, activeFilter);
    setRows(data.rows);
    setTotalCount(data.totalCount);
    if (data.primaryKey) setPrimaryKey(data.primaryKey);
    setLoading(false);
  }, [connId, tableName, page, pageSize, sortBy, sortDir, activeFilter]);

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
      const clause = getInitialFilterClause(initialFilter, dbType);
      setActiveFilter(clause);
      setFilterText(clause);
      if (clause) {
        setShowFilterBar(true);
      }
    });
  }, [tableName, fetchSchema, initialViewMode, initialFilter, dbType]);

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
      setErrorMsg(t('dataGrid.errReadOnlyEdit'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }
    // Cho phép sửa cả cột khóa chính: backend UPDATE dùng giá trị PK gốc trong WHERE,
    // còn SET áp giá trị PK mới (rowId luôn giữ nguyên giá trị gốc cho tới khi commit + refetch).
    setEditingCell({ rowId, colName });
    setEditValue(currentValue === null ? '' : currentValue);
  };

  const saveEdit = (e?: React.FocusEvent) => {
    if (e?.relatedTarget && (e.relatedTarget as HTMLElement).closest('.grid-edit-wrapper')) {
      return;
    }
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
    if (readOnly) {
      setErrorMsg(t('dataGrid.errReadOnlyAdd'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }

    const tempId = `temp_${nextTempId}`;
    setNextTempId(nextTempId + 1);

    // __tempId là định danh nội bộ; cột PK để trống để người dùng nhập hoặc DB tự sinh (auto-increment)
    const newRow: any = { __tempId: tempId };
    columns.forEach(col => {
      newRow[col.name] = col.name === primaryKey ? '' : (col.defaultValue || '');
    });

    setInserts([...inserts, newRow]);

    // Chọn dòng và mở sẵn ô nhập đầu tiên: dòng trống mà phải tự đoán là "nhấp
    // đôi để sửa" thì rất khó dùng. Bỏ qua cột PK tự tăng vì DB tự sinh giá trị.
    const firstEditable = activeColumns.find(c => !(c.isPrimaryKey && c.autoIncrement)) || activeColumns[0];
    setSelectedRowId(tempId);
    if (firstEditable) {
      startEdit(tempId, firstEditable.name, newRow[firstEditable.name] ?? '');
    }

    setSuccessMsg(t('dataGrid.rowAdded'));
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  // Delete Selected / Marked Row
  const handleDeleteRow = (targetRowId?: any) => {
    const rowId = targetRowId ?? selectedRowId;
    if (rowId === null || rowId === undefined) {
      setErrorMsg(t('dataGrid.errNoRowSelected'));
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
    setSuccessMsg(t('dataGrid.rowDuplicated'));
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
    setSuccessMsg(t('dataGrid.copiedRowCsv'));
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
    setSuccessMsg(t('dataGrid.copiedRowSql'));
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  const copyRowAsMarkdown = (row: any) => {
    const cols = activeColumns.map(c => c.name);
    const header = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const vals = `| ${cols.map(c => String(row[c] ?? '')).join(' | ')} |`;
    copyToClipboard(`${header}\n${sep}\n${vals}`);
    setSuccessMsg(t('dataGrid.copiedRowMarkdown'));
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
    setSuccessMsg(t('dataGrid.discarded'));
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
      setErrorMsg(t('dataGrid.errReadOnlyCommit'));
      setTimeout(() => setErrorMsg(null), 4000);
      return;
    }

    if (changesList.length === 0) {
      setErrorMsg(t('dataGrid.errNoChanges'));
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }

    // Lấy trước danh sách SQL sẽ chạy để người dùng xem trước (transaction preview)
    setLoading(true);
    const preview = await dbHelper.commitChanges(connId, tableName, changesList, primaryKey, true);
    setLoading(false);

    if (!preview.success) {
      setErrorMsg(t('dataGrid.errPreview', { message: preview.message }));
      return;
    }
    setPendingChanges(changesList);
    setCommitPreview(preview.sqls || []);
  };

  // Thực thi commit thật sau khi người dùng xác nhận ở modal xem trước
  const handleConfirmCommit = async () => {
    setCommitPreview(null);
    setLoading(true);
    const res = await dbHelper.commitChanges(connId, tableName, pendingChanges, primaryKey);
    setLoading(false);
    setPendingChanges([]);

    if (res.success) {
      setSuccessMsg(t('dataGrid.commitSuccess'));
      setUpdates({});
      setDeletes(new Set());
      setInserts([]);
      resetGridHistory(); // buffer đã ghi DB -> xoá undo/redo
      fetchData();
      setTimeout(() => setSuccessMsg(null), 4000);
    } else {
      setErrorMsg(t('dataGrid.errCommit', { message: res.message }));
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
        case '!=':
        case '<>': return `${col} != '${val}'`;
        case '<': return `${col} < '${val}'`;
        case '>': return `${col} > '${val}'`;
        case '<=': return `${col} <= '${val}'`;
        case '>=': return `${col} >= '${val}'`;
        case 'IN': return `${col} IN (${r.value.trim()})`;
        case 'NOT IN': return `${col} NOT IN (${r.value.trim()})`;
        case 'IS NULL': return `${col} IS NULL`;
        case 'IS NOT NULL': return `${col} IS NOT NULL`;
        case 'BETWEEN': return `${col} BETWEEN ${r.value.trim()}`;
        case 'NOT BETWEEN': return `${col} NOT BETWEEN ${r.value.trim()}`;
        case 'LIKE': return `${col} LIKE '${val}'`;
        case 'Contains': return `${col} LIKE '%${val}%'`;
        case 'Not contains': return `${col} NOT LIKE '%${val}%'`;
        case 'Starts with': return `${col} LIKE '${val}%'`;
        case 'Ends with': return `${col} LIKE '%${val}'`;
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

  // Dựng câu SELECT hoàn chỉnh từ điều kiện lọc đang có, để dán thẳng vào trình
  // viết SQL. Kèm ORDER BY nếu đang sắp xếp, nhờ vậy câu SQL tái hiện đúng những
  // gì lưới đang hiển thị.
  const buildFilterSql = () => {
    const qc = dbType === 'mysql' ? '`' : '"';
    const where = filterMode === 'sql' ? filterText.trim() : buildWhereFromVisual(filterRows);
    let sql = `SELECT * FROM ${qc}${tableName}${qc}`;
    if (where) sql += `\nWHERE ${where}`;
    if (sortBy) sql += `\nORDER BY ${qc}${sortBy}${qc} ${sortDir.toUpperCase()}`;
    return sql + ';';
  };

  const handleCopyFilterSql = async () => {
    try {
      await navigator.clipboard.writeText(buildFilterSql());
      setSuccessMsg(t('dataGrid.copiedFilterSql'));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch {
      setErrorMsg(t('dataGrid.errClipboard'));
      setTimeout(() => setErrorMsg(null), 3000);
    }
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
  //  - onDirtyChange: báo lên App để hỏi xác nhận khi đổi tab/bảng/ngắt kết nối,
  //    đồng thời chấm dấu "chưa lưu" lên tab.
  //
  // Hàm dọn dẹp báo `false`: lúc đó tab đã đổi rồi, và App luôn xoá cờ chứ không
  // gán theo tab nào, nên grid cũ tháo đi không thể để lại dấu trên tab mới.
  useEffect(() => {
    onDirtyChangeRef.current?.(changeCount > 0);
    const handler = (e: BeforeUnloadEvent) => {
      if (changeCount > 0) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      onDirtyChangeRef.current?.(false);
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
                  placeholder={t('dataGrid.filterSqlPlaceholder')}
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
                    {t('dataGrid.clearAll')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('visual')} style={{ fontWeight: 600 }}>
                    {t('dataGrid.filterVisual')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={handleCopyFilterSql} title={t('dataGrid.copySqlTitle')}>
                    <Copy size={12} /> {t('dataGrid.copySql')}
                  </button>
                </div>
                <button className="visual-filter-btn-primary" onClick={triggerFilter}>
                  {t('dataGrid.runSqlFilter')}
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
                  {/* CHỈ đổi phần nhãn hiển thị, value phải giữ nguyên vì nó
                      được dùng trực tiếp khi dựng câu WHERE. */}
                  <select
                    className="visual-filter-select"
                    style={{ minWidth: '130px' }}
                    value={row.operator}
                    onChange={(e) => updateFilterRow(row.id, { operator: e.target.value })}
                  >
                    <option value="=">=</option>
                    <option value="!=">&lt;&gt;</option>
                    <option value="<">&lt;</option>
                    <option value=">">&gt;</option>
                    <option value="<=">&lt;=</option>
                    <option value=">=">&gt;=</option>
                    <optgroup label="────────────">
                      <option value="IN">IN</option>
                      <option value="NOT IN">NOT IN</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="IS NULL">IS NULL</option>
                      <option value="IS NOT NULL">IS NOT NULL</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="BETWEEN">BETWEEN</option>
                      <option value="NOT BETWEEN">NOT BETWEEN</option>
                    </optgroup>
                    <optgroup label="────────────">
                      <option value="LIKE">LIKE</option>
                      <option value="Contains">{t('dataGrid.opContains', 'Contains')}</option>
                      <option value="Not contains">Not contains</option>
                      <option value="Starts with">{t('dataGrid.opStartsWith', 'Starts with')}</option>
                      <option value="Ends with">{t('dataGrid.opEndsWith', 'Ends with')}</option>
                    </optgroup>
                  </select>
                  <input
                    type="text"
                    className="visual-filter-input"
                    placeholder={t('dataGrid.filterValuePlaceholder')}
                    value={row.value}
                    disabled={row.operator === 'IS NULL' || row.operator === 'IS NOT NULL'}
                    onChange={(e) => updateFilterRow(row.id, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && triggerFilter()}
                    style={{ flex: 1, minWidth: '220px' }}
                  />
                  <button className="visual-filter-btn-apply" onClick={() => applySingleFilterRow(row.id)} title={t('dataGrid.applyRowTitle')}>
                    {t('dataGrid.applyRow')}
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => removeFilterRow(row.id)} title={t('dataGrid.removeFilterRow')} aria-label={t('dataGrid.removeFilterRow')}>
                    <Minus size={13} />
                  </button>
                  <button className="visual-filter-btn-icon" onClick={() => addFilterRow(row.id)} title={t('dataGrid.addFilterRow')} aria-label={t('dataGrid.addFilterRow')}>
                    <Plus size={13} />
                  </button>
                </div>
              ))}
              <div className="visual-filter-footer">
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <button className="visual-filter-btn-apply" onClick={clearFilter}>
                    {t('dataGrid.clearAll')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={() => setFilterMode('sql')} style={{ fontWeight: 600 }}>
                    {t('dataGrid.filterBySql')}
                  </button>
                  <button className="visual-filter-btn-apply" onClick={handleCopyFilterSql} title={t('dataGrid.copySqlTitle')}>
                    <Copy size={12} /> {t('dataGrid.copySql')}
                  </button>
                  {/* Chỉ hiện phím tắt của đúng nền tảng đang chạy, thay vì in cả
                      "⌘F / Ctrl+F" khiến người dùng phải tự lọc. */}
                  <div className="visual-filter-footer-info" style={{ marginLeft: '12px' }}>
                    <span>{t('dataGrid.shortcutToggleFilter')} <kbd>{modKey}F</kbd></span>
                    <span>{t('dataGrid.shortcutAddRow')} <kbd>{modKey}I</kbd></span>
                  </div>
                </div>
                <button className="visual-filter-btn-primary" onClick={triggerFilter}>
                  {t('dataGrid.applyAll')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}      {/* Commit/Discard buttons removed from here to prevent squeezing */}

      {/* Tiến độ nhập dữ liệu — modal xem trước đã đóng nên báo ở dải thông báo của grid */}
      {importProgress && (
        <div className="info-bar info-bar-blue">
          <ProgressBar progress={importProgress} />
        </div>
      )}

      {successMsg && (
        <div className="info-bar info-bar-success">
          <div className="info-bar-content">
            <CheckCircle2 size={16} />
            <span>{successMsg}</span>
          </div>
          {/* Đóng tay được, không phải đợi hết 5 giây */}
          <button className="info-bar-close" onClick={() => setSuccessMsg(null)}>×</button>
        </div>
      )}

      {errorMsg && (
        <div className="info-bar info-bar-error">
          <div className="info-bar-content">
            <AlertTriangle size={16} />
            <span>{errorMsg}</span>
          </div>
          <button className="info-bar-close" onClick={() => setErrorMsg(null)}>×</button>
        </div>
      )}

      {viewMode === 'structure' && schema ? (
        <StructureViewer
          connId={connId}
          tableName={tableName}
          schema={schema}
          dbType={dbType}
          onSchemaChanged={fetchSchema}
          readOnly={readOnly}
          activeSection={structSection}
          onSectionChange={setStructSection}
        />
      ) : (
        <div className="grid-table-container">
          {loading && rows.length === 0 ? (
            <div className="grid-loading-box">
              <LoadingSpinner size={32} />
              <span className="grid-loading-text">{t('dataGrid.loadingData')}</span>
            </div>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  {activeColumns.map(col => (
                    <th key={col.name} className="grid-th-clickable" onClick={() => handleSort(col.name)}>
                      <div className="grid-th-content">
                        <span>{col.name}</span>
                        {col.isPrimaryKey && <span className="key-badge">PK</span>}
                        {sortBy === col.name && (
                          <span className="grid-sort-icon">
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
                            className={`${isCellDirty ? 'grid-cell-dirty' : ''} ${isEditing ? 'is-editing' : ''}`.trim()}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedRowId(selectionKey);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId: selectionKey, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <>
                                <span className="grid-cell-ghost">{cellVal === null ? 'NULL' : String(cellVal)}</span>
                                <div className="grid-edit-wrapper">
                                <input
                                  type="text"
                                  className={`grid-input-edit ${isDateField(col.name, col.type, cellVal) ? 'has-date-picker' : ''}`}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  autoFocus
                                />
                                {isDateField(col.name, col.type, cellVal) && (
                                  <div
                                    className="grid-date-picker-btn"
                                    title={t('common.selectDate', 'Select Date & Time')}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const pickerEl = e.currentTarget.querySelector('input[type="datetime-local"]') as HTMLInputElement;
                                      if (pickerEl && typeof pickerEl.showPicker === 'function') {
                                        try { pickerEl.showPicker(); } catch {}
                                      }
                                    }}
                                  >
                                    <Calendar size={13} style={{ pointerEvents: 'none' }} />
                                    <input
                                      type="datetime-local"
                                      step="1"
                                      className="grid-date-picker-input"
                                      value={formatForPicker(editValue)}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (typeof e.currentTarget.showPicker === 'function') {
                                          try { e.currentTarget.showPicker(); } catch {}
                                        }
                                      }}
                                      onChange={(e) => {
                                        if (e.target.value) {
                                          const orig = String(cellVal || editValue || '');
                                          if (orig.includes('+')) {
                                            const tz = orig.slice(orig.indexOf('+'));
                                            setEditValue(e.target.value + tz);
                                          } else if (orig.includes('Z')) {
                                            setEditValue(e.target.value + 'Z');
                                          } else if (orig.includes(' ') && !orig.includes('T')) {
                                            setEditValue(e.target.value.replace('T', ' '));
                                          } else {
                                            setEditValue(e.target.value);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                               </div>
                              </>
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
                            className={isEditing ? 'is-editing' : ''}
                            onDoubleClick={() => startEdit(rowId, col.name, cellVal)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedRowId(rowId);
                              setContextMenu({ x: e.clientX, y: e.clientY, rowId, row, colName: col.name, cellValue: cellVal });
                            }}
                          >
                            {isEditing ? (
                              <>
                                <span className="grid-cell-ghost">{cellVal === null || cellVal === '' ? '—' : String(cellVal)}</span>
                                <div className="grid-edit-wrapper">
                                <input
                                  type="text"
                                  className={`grid-input-edit ${isDateField(col.name, col.type, cellVal) ? 'has-date-picker' : ''}`}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  autoFocus
                                />
                                {isDateField(col.name, col.type, cellVal) && (
                                  <div
                                    className="grid-date-picker-btn"
                                    title={t('common.selectDate', 'Select Date & Time')}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const pickerEl = e.currentTarget.querySelector('input[type="datetime-local"]') as HTMLInputElement;
                                      if (pickerEl && typeof pickerEl.showPicker === 'function') {
                                        try { pickerEl.showPicker(); } catch {}
                                      }
                                    }}
                                  >
                                    <Calendar size={13} style={{ pointerEvents: 'none' }} />
                                    <input
                                      type="datetime-local"
                                      step="1"
                                      className="grid-date-picker-input"
                                      value={formatForPicker(editValue)}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (typeof e.currentTarget.showPicker === 'function') {
                                          try { e.currentTarget.showPicker(); } catch {}
                                        }
                                      }}
                                      onChange={(e) => {
                                        if (e.target.value) {
                                          const orig = String(cellVal || editValue || '');
                                          if (orig.includes('+')) {
                                            const tz = orig.slice(orig.indexOf('+'));
                                            setEditValue(e.target.value + tz);
                                          } else if (orig.includes('Z')) {
                                            setEditValue(e.target.value + 'Z');
                                          } else if (orig.includes(' ') && !orig.includes('T')) {
                                            setEditValue(e.target.value.replace('T', ' '));
                                          } else {
                                            setEditValue(e.target.value);
                                          }
                                        }
                                      }}
                                    />
                                  </div>
                                )}
                               </div>
                              </>
                            ) : cellVal === null || cellVal === '' ? (
                              /* Ô chưa có giá trị: hiện dấu gạch mờ để thấy được ô,
                                 thay vì chuỗi rỗng làm cả dòng trông như trống trơn. */
                              <span className="grid-cell-empty">—</span>
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

      {/* Nền, viền trên và chiều cao lấy từ class .grid-pagination để thanh này
          cao đúng bằng chân sidebar (--ws-foot-h); đặt inline sẽ đè mất glass. */}
      <div className="grid-pagination gp-container">
        {/* Left segment: Data | Structure & + Row */}
        <div className="gp-left-section">
          <div className="segmented-control">
            <button
              className={`segment-btn ${viewMode === 'data' ? 'active' : ''}`}
              onClick={() => setViewMode('data')}
            >
              {t('dataGrid.dataTab')}
            </button>

            {viewMode === 'data' ? (
              <button
                className="segment-btn"
                onClick={() => { setViewMode('structure'); setStructSection('columns'); }}
              >
                {t('dataGrid.structureTab')}
              </button>
            ) : (
              <>
                <button
                  className={`segment-btn ${structSection === 'columns' ? 'active' : ''}`}
                  onClick={() => setStructSection('columns')}
                >
                  Columns {schema?.columns?.length !== undefined ? <span className="st-seg-count">{schema.columns.length}</span> : null}
                </button>
                <button
                  className={`segment-btn ${structSection === 'indexes' ? 'active' : ''}`}
                  onClick={() => setStructSection('indexes')}
                >
                  Indexes {schema?.indexes?.length !== undefined ? <span className="st-seg-count">{schema.indexes.length}</span> : null}
                </button>
                <button
                  className={`segment-btn ${structSection === 'fks' ? 'active' : ''}`}
                  onClick={() => setStructSection('fks')}
                >
                  Foreign keys {schema?.foreignKeys?.length !== undefined ? <span className="st-seg-count">{schema.foreignKeys.length}</span> : null}
                </button>
                <button
                  className={`segment-btn ${structSection === 'check_constraints' ? 'active' : ''}`}
                  onClick={() => setStructSection('check_constraints')}
                >
                  Check Constraints
                </button>
                <button
                  className={`segment-btn ${structSection === 'triggers' ? 'active' : ''}`}
                  onClick={() => setStructSection('triggers')}
                >
                  Triggers
                </button>
                <button
                  className={`segment-btn ${structSection === 'partitions' ? 'active' : ''}`}
                  onClick={() => setStructSection('partitions')}
                >
                  Partitions
                </button>
                <button
                  className={`segment-btn ${structSection === 'ddl' ? 'active' : ''}`}
                  onClick={() => setStructSection('ddl')}
                >
                  DDL
                </button>
              </>
            )}
          </div>

          {viewMode === 'data' && (
            <>
              <button className="gp-btn" onClick={handleAddRow} title={t('dataGrid.addRowTitle')}>
                <Plus size={12} />
                <span>{t('dataGrid.rowLabel')}</span>
              </button>

              <button
                className="gp-btn danger"
                onClick={handleDeleteRow}
                disabled={selectedRowId === null}
                title={t('dataGrid.deleteRowTitle')}
              >
                <Minus size={12} />
                <span>{t('dataGrid.rowLabel')}</span>
              </button>
            </>
          )}

          {/* Commit/Discard Actions */}
          {changeCount > 0 && (
            <div className="gp-btn-group">
              <button className="gp-btn icon" onClick={handleDiscard} title={t('dataGrid.discardTitle')}>
                <RotateCcw size={12} />
              </button>
              <button className="gp-btn save" onClick={handleCommit} title={t('dataGrid.saveTitle')}>
                <Save size={12} />
                <span>{t('dataGrid.saveButton', { n: changeCount })}</span>
              </button>
            </div>
          )}
        </div>

        {/* Middle section: Row Count */}
        {viewMode === 'data' && (
          <div className="gp-status-text">
            <Trans
              i18nKey="dataGrid.rowsRange"
              values={{
                from: (page - 1) * pageSize + 1,
                to: Math.min(page * pageSize, totalCount),
                total: fmtNum(totalCount),
              }}
              components={{ strong: <b /> }}
            />
          </div>
        )}

        {/* Right section: Columns | Filters | Navigation */}
        {viewMode === 'data' && (
          <div className="gp-right-section">
            <div className="gp-popover-wrap">
              <button
                className={`gp-btn ${showColumnsPopover ? 'on' : ''}`}
                onClick={() => {
                  if (!showColumnsPopover) {
                    setPendingVisibleColumns([...visibleColumns]);
                  }
                  setShowColumnsPopover(!showColumnsPopover);
                }}
                title={t('dataGrid.columnsTitle')}
              >
                {t('dataGrid.columnsBtn')}
              </button>

              {showColumnsPopover && (
                <div className="ws-menu gp-popover-menu">
                  <div className="gp-popover-heading">
                    {t('dataGrid.columnsHeading')}
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
                      <option value="" disabled style={{ background: 'var(--win-bg-window)', color: 'var(--win-text-primary)' }}>{t('dataGrid.addColumnOption')}</option>
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
                      <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>{t('dataGrid.noVisibleColumns')}</span>
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
                      {t('dataGrid.clearBtn')}
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
                        {t('common.cancel')}
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
                        {t('dataGrid.applyBtn')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              className="gp-btn"
              onClick={handleImportClick}
              disabled={loading}
              title={t('dataGrid.importTitle')}
            >
              {t('dataGrid.importBtn')}
            </button>

            <button
              className="gp-btn"
              onClick={() => setShowExportDialog(true)}
              disabled={loading}
              title={t('dataGrid.exportTitle')}
            >
              {t('dataGrid.exportBtn')}
            </button>

            <button
              className={`gp-btn ${showFilterBar ? 'on' : ''}`}
              onClick={() => setShowFilterBar(!showFilterBar)}
              title={t('dataGrid.filtersTitle')}
            >
              {t('dataGrid.filtersBtn')}
            </button>

            <div className="gp-pager">
              <button
                className="gp-pager-btn"
                onClick={() => setPage(p => Math.max(p - 1, 1))}
                disabled={page === 1}
                title={t('dataGrid.prevPage')}
              >
                <ChevronLeft size={14} />
              </button>

              <span className="gp-pager-sep" />

              <select
                className="gp-pager-select"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value));
                  setPage(1);
                }}
                title={t('dataGrid.rowsPerPage')}
              >
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
              </select>

              <span className="gp-pager-sep" />

              <button
                className="gp-pager-btn"
                onClick={() => setPage(p => Math.min(p + 1, totalPages))}
                disabled={page >= totalPages}
                title={t('dataGrid.nextPage')}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Xuất bảng: popup tuỳ chọn + xem trước, dùng chung với menu chuột phải ở Sidebar */}
      <ExportTableDialog
        connId={connId}
        open={showExportDialog}
        tableName={tableName}
        dbType={dbType}
        grid={{
          columns: columns.map((c) => c.name),
          visibleColumns,
          sortBy,
          sortDir,
          filter: activeFilter,
          totalCount,
        }}
        onClose={() => setShowExportDialog(false)}
        onSuccess={setSuccessMsg}
        onError={setErrorMsg}
      />

      {/* Popup chọn tệp: báo định dạng cho phép trước khi mở hộp thoại của hệ điều hành */}
      <ImportFilePicker
        open={showImportPicker}
        targetTable={tableName}
        onCancel={() => setShowImportPicker(false)}
        onConfirm={handleFileImport}
      />

      {showImportModal && (
        <Modal
          title={t('dataGrid.importPreviewTitle', { file: importFileName })}
          onClose={() => setShowImportModal(false)}
          width="720px"
          zIndex={9999}
        >
          <ModalBody style={{ gap: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
              {importFileType === 'sql' ? (
                <span>{t('dataGrid.importSqlNote')}</span>
              ) : (
                <span>
                  <Trans
                    i18nKey="dataGrid.importSummary"
                    values={{
                      format: importFileType.toUpperCase(),
                      rows: importPendingRows.length,
                      cols: importFileCols.length,
                      table: tableName,
                    }}
                    components={{ strong: <b />, code: <b style={{ fontFamily: 'monospace' }} /> }}
                  />
                </span>
              )}
            </div>

            {importFileType === 'sql' ? (
              <textarea
                readOnly
                value={importSqlContent.slice(0, 5000) + (importSqlContent.length > 5000 ? t('dataGrid.importTruncated') : '')}
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
              <>
                {/* Tab: cấu trúc (cột trong tệp vs bảng đích) | dữ liệu (10 dòng đầu) */}
                <div style={{ display: 'flex', gap: '4px' }}>
                  {([
                    { id: 'structure', label: t('dataGrid.importTabStructure', { n: importFileCols.length }) },
                    { id: 'data', label: t('dataGrid.importTabData', { n: importPendingRows.length }) },
                  ] as const).map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setImportTab(tab.id)}
                      style={{
                        padding: '4px 12px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: importTab === tab.id ? 'var(--win-accent)' : 'transparent',
                        color: importTab === tab.id ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {importUnknownCols.length > 0 && (
                  <div style={{
                    fontSize: '11px',
                    color: 'var(--st-warn, #d98600)',
                    background: 'rgba(255,170,0,0.08)',
                    border: '1px solid rgba(255,170,0,0.35)',
                    borderRadius: '4px',
                    padding: '8px 10px',
                    lineHeight: 1.5
                  }}>
                    <Trans
                      i18nKey="dataGrid.importUnknownCols"
                      values={{
                        n: importUnknownCols.length,
                        table: tableName,
                        cols: importUnknownCols.join(', '),
                      }}
                      components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                    />
                  </div>
                )}

                <div style={{
                  height: '280px',
                  overflow: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)'
                }}>
                  {importPendingRows.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--win-text-disabled)' }}>{t('dataGrid.importNoRows')}</div>
                  ) : importTab === 'structure' ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {[t('dataGrid.colInFile'), t('dataGrid.colInferredType'), t('dataGrid.colInTarget'), t('dataGrid.colTargetType')].map(h => (
                            <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importFileCols.map(col => {
                          const target = columns.find(c => c.name.toLowerCase() === col.toLowerCase());
                          return (
                            <tr key={col} style={{ borderBottom: '1px solid var(--win-border)' }}>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>{col}</td>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>{inferColType(importPendingRows, col)}</td>
                              <td style={{ padding: '6px 8px', borderRight: '1px solid var(--win-border)', color: target ? 'var(--win-text-primary)' : 'var(--st-warn, #d98600)' }}>
                                {target ? target.name : t('dataGrid.colMissing')}
                              </td>
                              <td style={{ padding: '6px 8px', color: 'var(--win-text-secondary)', fontFamily: 'monospace' }}>{target?.type || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {importFileCols.map(col => (
                            <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importPendingRows.slice(0, 10).map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {importFileCols.map(col => (
                              <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                                {row[col] === null || row[col] === undefined
                                  ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                  : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}
          </ModalBody>

          <ModalFooter>
            <button
              className="btn btn-secondary"
              onClick={() => setShowImportModal(false)}
              style={{ padding: '0 12px' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={confirmImport}
              style={{ padding: '0 16px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              {t('dataGrid.confirmImport')}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* ─── Right-Click Context Menu ─── */}
      {contextMenu && (
        <div
          ref={cellMenuRef}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            // Vị trí chỉnh theo kích thước thật của menu (trước đây ước lượng cứng 320/230
            // nên menu dài vẫn bị cắt ở đáy cửa sổ).
            top: cellMenuPos ? cellMenuPos.top : contextMenu.y,
            left: cellMenuPos ? cellMenuPos.left : contextMenu.x,
            visibility: cellMenuPos ? 'visible' : 'hidden',
            zIndex: 99999,
            background: 'var(--win-bg-popover, #ffffff)',
            border: '1px solid var(--win-border-strong)',
            borderRadius: '8px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.15)',
            padding: '4px 0',
            minWidth: '220px',
            fontSize: '12px',
          }}
        >
          {/* Row actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxRow')}</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); handleDuplicateRow(contextMenu.row); }}>
            <span>📋</span> {t('dataGrid.ctxDuplicate')}
          </button>
          <button className="context-menu-item" style={{ color: 'var(--st-danger)' }} onClick={() => { setContextMenu(null); handleDeleteRow(contextMenu.rowId); }}>
            <span>🗑</span> {t('dataGrid.ctxDeleteRow')}
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Sort actions */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxSortBy', { col: contextMenu.colName })}</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('asc'); setPage(1); }}>
            <span>↑</span> {t('dataGrid.ctxAsc')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setSortBy(contextMenu.colName); setSortDir('desc'); setPage(1); }}>
            <span>↓</span> {t('dataGrid.ctxDesc')}
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy cell */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxCell', { col: contextMenu.colName })}</div>
          <button className="context-menu-item" onClick={() => {
            const cm = contextMenu;
            setContextMenu(null);
            startEdit(cm.rowId, cm.colName, cm.cellValue);
          }}>
            <span>✏️</span> {t('dataGrid.ctxEditCell')}
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            copyToClipboard(contextMenu.cellValue === null ? '' : String(contextMenu.cellValue));
            setSuccessMsg(t('dataGrid.copiedCell')); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📄</span> {t('dataGrid.ctxCopyCell')}
          </button>
          <button className="context-menu-item" onClick={() => {
            setContextMenu(null);
            const allVals = rows.map(r => r[contextMenu.colName]).filter(v => v !== null && v !== undefined).join('\n');
            copyToClipboard(allVals);
            setSuccessMsg(t('dataGrid.copiedColumn')); setTimeout(() => setSuccessMsg(null), 2000);
          }}>
            <span>📋</span> {t('dataGrid.ctxCopyColumn')}
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); setQuickLookCell({ colName: contextMenu.colName, value: contextMenu.cellValue }); }}>
            <span>🔍</span> {t('dataGrid.ctxQuickLook')}
          </button>

          <div style={{ borderTop: '1px solid var(--win-border)', margin: '4px 0' }} />

          {/* Copy row */}
          <div style={{ padding: '2px 8px 4px', color: 'var(--win-text-disabled)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('dataGrid.ctxCopyRowAs')}</div>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, false); }}>
            <span>📊</span> CSV
          </button>
          <button className="context-menu-item" onClick={() => { setContextMenu(null); copyRowAsCSV(contextMenu.row, true); }}>
            <span>📊</span> {t('dataGrid.ctxCsvHeader')}
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
        <Modal
          title={<>{t('dataGrid.quickLook')} — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{quickLookCell.colName}</span></>}
          onClose={() => setQuickLookCell(null)}
          width="700px"
          maxHeight="70vh"
          zIndex={99998}
        >
          <ModalBody style={{ gap: 0, flex: 1, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {quickLookCell.value === null
              ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
              : String(quickLookCell.value)
            }
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => { copyToClipboard(quickLookCell.value === null ? '' : String(quickLookCell.value)); }}>{t('common.copy')}</button>
            <button className="btn btn-primary" style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }} onClick={() => setQuickLookCell(null)}>{t('common.close')}</button>
          </ModalFooter>
        </Modal>
      )}

      {/* ─── Transaction Preview Modal (xem trước SQL trước khi commit) ─── */}
      {commitPreview && (
        <Modal
          title={t('dataGrid.commitPreviewTitle', { n: commitPreview.length })}
          onClose={() => { setCommitPreview(null); setPendingChanges([]); }}
          width="640px"
          maxWidth="92%"
          maxHeight="80vh"
          zIndex={99999}
        >
          <ModalBody style={{ padding: '16px', gap: 0, background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)', flex: 1 }}>
            {commitPreview.length === 0 ? (
              <div style={{ color: 'var(--win-text-disabled)' }}>{t('dataGrid.commitPreviewEmpty')}</div>
            ) : (
              commitPreview.map((sql, idx) => (
                <pre key={idx} style={{ margin: '0 0 10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < commitPreview.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                  {sql};
                </pre>
              ))
            )}
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => { setCommitPreview(null); setPendingChanges([]); }} disabled={loading}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={handleConfirmCommit} disabled={loading || commitPreview.length === 0} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>
              {loading ? t('dataGrid.commitRunning') : t('dataGrid.commitConfirm')}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
};
