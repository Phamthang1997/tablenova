import React, { useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { ConnectionManager } from './components/ConnectionManager';
import { Sidebar } from './components/Sidebar';
import { TabManager } from './components/TabManager';
import type { TabInfo } from './components/TabManager';
import { DataGrid } from './components/DataGrid';
import { SqlEditor } from './components/SqlEditor';
import { AiAssistant } from './components/AiAssistant';
import { TerminalPanel } from './components/TerminalPanel';
import { Bot, Sun, Moon, Database, Lock, LockOpen } from 'lucide-react';
import { dbHelper } from './utils/dbHelper';
import type { DbConnectionConfig } from './utils/dbHelper';
import appIcon from './assets/icon.png';

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
          i++;
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

export const App: React.FC = () => {
  const [connection, setConnection] = useState<{
    dbName: string;
    dbType: 'sqlite' | 'postgres' | 'mysql';
  } | null>(null);
  // Cấu hình kết nối đang dùng (gồm cả SSH) để Terminal kế thừa -> mở shell vào đúng máy chủ/VM
  const [activeConnConfig, setActiveConnConfig] = useState<DbConnectionConfig | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [queryCount, setQueryCount] = useState(1);
  const [showAi, setShowAi] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [readOnly, setReadOnly] = useState(false); // Chế độ chỉ đọc: chặn mọi thao tác ghi
  const [dbReloadKey, setDbReloadKey] = useState(0);

  // Global Import/Export States
  const [showGlobalExportModal, setShowGlobalExportModal] = useState(false);
  const [globalExportTables, setGlobalExportTables] = useState<string[]>([]);
  const [selectedExportTables, setSelectedExportTables] = useState<string[]>([]);
  const [globalExportFormat, setGlobalExportFormat] = useState<'sql' | 'json' | 'csv'>('sql');
  const [globalExportLoading, setGlobalExportLoading] = useState(false);

  // Advanced SQL and Gzip options
  const [globalExportFilename, setGlobalExportFilename] = useState('database_dump');
  const [globalExportDropTable, setGlobalExportDropTable] = useState(true);
  const [globalExportIncludeStructure, setGlobalExportIncludeStructure] = useState(true);
  const [globalExportIncludeContent, setGlobalExportIncludeContent] = useState(true);
  const [globalExportCompressGzip, setGlobalExportCompressGzip] = useState(false);

  const [globalImportSqlMode, setGlobalImportSqlMode] = useState<'both' | 'structure' | 'data'>('both');

  const [showGlobalImportModal, setShowGlobalImportModal] = useState(false);
  const [globalImportFileName, setGlobalImportFileName] = useState('');
  const [globalImportTableName, setGlobalImportTableName] = useState('');
  const [globalImportFileType, setGlobalImportFileType] = useState<'csv' | 'json' | 'sql'>('csv');
  const [globalImportPendingRows, setGlobalImportPendingRows] = useState<any[]>([]);
  const [globalImportSqlContent, setGlobalImportSqlContent] = useState('');
  const [globalImportLoading, setGlobalImportLoading] = useState(false);
  const [globalImportTargetTable, setGlobalImportTargetTable] = useState<string | null>(null);

  // Backup & Restore States
  const [showBackupRestoreModal, setShowBackupRestoreModal] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [backupRestoreTab, setBackupRestoreTab] = useState<'backup' | 'restore'>('backup');
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [activeConnectionColor, setActiveConnectionColor] = useState<string | undefined>(undefined);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreSqlText, setRestoreSqlText] = useState<string>('');
  const [restoreParsedTables, setRestoreParsedTables] = useState<string[]>([]);
  const [restoreSelectedTables, setRestoreSelectedTables] = useState<string[]>([]);
  const [restoreParsing, setRestoreParsing] = useState(false);

  React.useEffect(() => {
    const parseTables = async () => {
      if (!restoreFile) {
        setRestoreParsedTables([]);
        setRestoreSelectedTables([]);
        setRestoreSqlText('');
        return;
      }
      setRestoreParsing(true);
      try {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const text = event.target?.result as string;
            setRestoreSqlText(text);

            // Tìm danh sách bảng trực tiếp bằng javascript hoặc gọi Rust
            const tables: string[] = [];
            const re = /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE\s+IF\s+EXISTS)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?/gi;
            let match;
            while ((match = re.exec(text)) !== null) {
              const table = match[1];
              if (!tables.includes(table)) {
                tables.push(table);
              }
            }
            setRestoreParsedTables(tables);
            setRestoreSelectedTables(tables);
          } catch (e) {
            console.error(e);
          } finally {
            setRestoreParsing(false);
          }
        };
        reader.readAsText(restoreFile);
      } catch (err: any) {
        console.error('Lỗi phân tích file phục hồi:', err);
        setRestoreParsing(false);
      }
    };
    parseTables();
  }, [restoreFile]);

  const globalFileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!showGlobalExportModal) return;
    const loadTables = async () => {
      const list = await dbHelper.getTables();
      const names = list.map(t => t.name);
      setGlobalExportTables(names);
      setSelectedExportTables(names);
    };
    loadTables();
  }, [showGlobalExportModal]);



  const handleImportToTableTrigger = (tableName: string) => {
    setGlobalImportTargetTable(tableName);
    globalFileInputRef.current?.click();
  };

  const handleExportTableTrigger = (tableName: string) => {
    setSelectedExportTables([tableName]);
    setShowGlobalExportModal(true);
  };

  const handleGlobalFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setGlobalImportFileName(file.name);
    const guessedTableName = file.name.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    setGlobalImportTableName(guessedTableName);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;

        if (file.name.endsWith('.json')) {
          const parsedJson = JSON.parse(text);
          if (!Array.isArray(parsedJson)) {
            throw new Error('Định dạng JSON phải là một mảng các đối tượng.');
          }
          setGlobalImportFileType('json');
          setGlobalImportPendingRows(parsedJson);
          setShowGlobalImportModal(true);
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
          setGlobalImportFileType('csv');
          setGlobalImportPendingRows(rowsToImport);
          setShowGlobalImportModal(true);
        } else if (file.name.endsWith('.sql')) {
          setGlobalImportFileType('sql');
          setGlobalImportSqlContent(text);
          setShowGlobalImportModal(true);
        } else {
          throw new Error('Chỉ hỗ trợ import tệp .csv, .json, hoặc .sql');
        }
      } catch (err: any) {
        alert('Lỗi đọc file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleGlobalExportSubmit = async () => {
    if (selectedExportTables.length === 0) {
      alert('Vui lòng chọn ít nhất một bảng để xuất.');
      return;
    }

    setGlobalExportLoading(true);
    try {
      const res = await dbHelper.exportMultiTables({
        format: globalExportFormat,
        tables: selectedExportTables,
        filename: globalExportFilename,
        sqlOptions: {
          dropTable: globalExportDropTable,
          includeStructure: globalExportIncludeStructure,
          includeContent: globalExportIncludeContent
        },
        compressGzip: globalExportCompressGzip
      });

      if (res.success) {
        alert('Sao lưu cơ sở dữ liệu thành công!');
        setShowGlobalExportModal(false);
        setShowBackupRestoreModal(false);
      } else {
        alert('Lỗi xuất dữ liệu: ' + res.error);
      }
    } catch (err: any) {
      alert('Lỗi xuất dữ liệu: ' + err.message);
    } finally {
      setGlobalExportLoading(false);
    }
  };

  const splitSqlQueries = (sqlStr: string): string[] => {
    const queries: string[] = [];
    let currentQuery = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    
    for (let i = 0; i < sqlStr.length; i++) {
      const char = sqlStr[i];
      if (char === "'" && !inDoubleQuote && !inBacktick) {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote && !inBacktick) {
        inDoubleQuote = !inDoubleQuote;
      } else if (char === '`' && !inSingleQuote && !inDoubleQuote) {
        inBacktick = !inBacktick;
      }
      
      if (char === ';' && !inSingleQuote && !inDoubleQuote && !inBacktick) {
        if (currentQuery.trim()) {
          queries.push(currentQuery.trim());
        }
        currentQuery = '';
      } else {
        currentQuery += char;
      }
    }
    if (currentQuery.trim()) {
      queries.push(currentQuery.trim());
    }
    return queries;
  };

  const extractTableNameFromSql = (sql: string): string | null => {
    const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (createMatch && createMatch[1]) return createMatch[1];
    
    const dropMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[`"']?([a-zA-Z0-9_]+)[`"']?)/i);
    if (dropMatch && dropMatch[1]) return dropMatch[1];

    return null;
  };

  const filterSqlQueries = (sqlText: string, mode: 'both' | 'structure' | 'data'): string => {
    if (mode === 'both') return sqlText;
    const queries = splitSqlQueries(sqlText);
    const filtered = queries.filter(q => {
      const trimmed = q.trim().toUpperCase();
      if (!trimmed) return false;
      const isStructure = trimmed.startsWith('CREATE TABLE') || 
                          trimmed.startsWith('DROP TABLE') || 
                          trimmed.startsWith('ALTER TABLE') || 
                          trimmed.startsWith('CREATE INDEX') || 
                          trimmed.startsWith('CREATE UNIQUE INDEX') || 
                          trimmed.startsWith('DROP INDEX');
      const isData = trimmed.startsWith('INSERT INTO') || 
                     trimmed.startsWith('UPDATE') || 
                     trimmed.startsWith('DELETE FROM') || 
                     trimmed.startsWith('TRUNCATE TABLE') || 
                     trimmed.startsWith('TRUNCATE') ||
                     trimmed.startsWith('INSERT');
      if (mode === 'structure') {
        return isStructure || (!isData && !trimmed.startsWith('REPLACE'));
      }
      if (mode === 'data') {
        return isData || (!isStructure && !trimmed.startsWith('CREATE') && !trimmed.startsWith('DROP') && !trimmed.startsWith('ALTER'));
      }
      return true;
    });
    return filtered.join(';\n');
  };

  const confirmGlobalImport = async () => {
    if (!globalImportTargetTable && !globalImportTableName.trim()) {
      alert('Vui lòng nhập tên bảng.');
      return;
    }

    setShowGlobalImportModal(false);
    setGlobalImportLoading(true);

    try {
      if (globalImportFileType === 'sql') {
        let filteredSql = filterSqlQueries(globalImportSqlContent, globalImportSqlMode);
        
        if (globalImportTargetTable) {
          const originalTable = extractTableNameFromSql(globalImportSqlContent);
          if (originalTable && originalTable !== globalImportTargetTable) {
            const escapedOrig = originalTable.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`([\\s\`"'])${escapedOrig}([\\s\`"';(])`, 'gi');
            filteredSql = filteredSql.replace(regex, `$1${globalImportTargetTable}$2`);
          }
        }

        const res = await dbHelper.executeQuery(filteredSql);
        if (res.success) {
          alert('Đã thực thi câu lệnh SQL import thành công!');
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert('Lỗi thực thi SQL: ' + res.error);
        }
      } else {
        const isExisting = !!globalImportTargetTable;
        let resData;
        if (isExisting) {
          resData = await dbHelper.importTableData(globalImportTargetTable, globalImportPendingRows);
        } else {
          resData = await dbHelper.importNewTable(globalImportTableName, globalImportPendingRows);
        }

        if (resData.success) {
          if (isExisting) {
            alert(`Đã nhập thành công bản ghi vào bảng "${globalImportTargetTable}"!`);
          } else {
            alert(`Đã tạo bảng "${globalImportTableName}" và nhập thành công bản ghi!`);
          }
          window.dispatchEvent(new CustomEvent('database-restored'));
        } else {
          alert('Import thất bại: ' + resData.error);
        }
      }
    } catch (err: any) {
      alert('Lỗi kết nối: ' + err.message);
    } finally {
      setGlobalImportLoading(false);
    }
  };

  const handleRestoreBackup = async () => {
    if (!restoreFile || !restoreSqlText) return;
    setRestoreLoading(true);
    try {
      const resData = await dbHelper.restoreBackup(restoreSqlText, restoreSelectedTables);
      if (resData.success) {
        alert(`Khôi phục cơ sở dữ liệu thành công! Đã chạy ${resData.statementsCount || 0} câu lệnh SQL.`);
        if (resData.activeDatabase) {
          const activeDb = resData.activeDatabase;
          setConnection(prev => prev ? { ...prev, dbName: activeDb } : null);
        }
        setShowBackupRestoreModal(false);
        setRestoreFile(null);
        setRestoreSqlText('');
        window.dispatchEvent(new CustomEvent('database-restored'));
      } else {
        alert('Khôi phục thất bại: ' + resData.error);
      }
    } catch (e: any) {
      alert('Lỗi khôi phục: ' + e.message);
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleTableRenamed = (oldName: string, newName: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.type === 'table' && t.name === oldName) {
          return { ...t, name: newName, label: newName };
        }
        return t;
      })
    );
  };

  const handleTableDropped = (tableName: string) => {
    setTabs((prev) => {
      const remaining = prev.filter((t) => !(t.type === 'table' && t.name === tableName));
      if (remaining.length === 0) {
        return [
          {
            id: 'query_1',
            type: 'query',
            name: 'SQL Query',
            label: 'Truy vấn 1',
          },
        ];
      }
      return remaining;
    });
  };

  React.useEffect(() => {
    const handleGlobalRename = (e: any) => {
      const { oldName, newName } = e.detail;
      handleTableRenamed(oldName, newName);
    };
    window.addEventListener('table-renamed', handleGlobalRename);
    return () => window.removeEventListener('table-renamed', handleGlobalRename);
  }, []);

  React.useEffect(() => {
    const handleGlobalReload = () => {
      setDbReloadKey((prev) => prev + 1);
    };
    window.addEventListener('database-restored', handleGlobalReload);
    return () => window.removeEventListener('database-restored', handleGlobalReload);
  }, []);

  React.useEffect(() => {
    const savedTheme = localStorage.getItem('tf_theme') as 'dark' | 'light';
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('tf_theme', nextTheme);
  };

  React.useEffect(() => {
    if (connection) {
      const storageKey = `tn_tabs_${connection.dbType}_${connection.dbName}`;
      // Không lưu tab terminal: phiên PTY không tồn tại sau khi reload
      const persistTabs = tabs.filter(t => t.type !== 'terminal');
      const persistActive = persistTabs.some(t => t.id === activeTabId) ? activeTabId : (persistTabs[0]?.id ?? null);
      localStorage.setItem(storageKey, JSON.stringify({ tabs: persistTabs, activeTabId: persistActive, queryCount }));
    }
  }, [tabs, activeTabId, connection, queryCount]);

  // Handle successful database connection
  const handleConnect = (dbName: string, dbType: 'sqlite' | 'postgres' | 'mysql', color?: string, config?: DbConnectionConfig) => {
    setConnection({ dbName, dbType });
    setActiveConnectionColor(color);
    setActiveConnConfig(config || null);

    // Try to restore tabs from localStorage
    const storageKey = `tn_tabs_${dbType}_${dbName}`;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const { tabs: savedTabs, activeTabId: savedActiveId, queryCount: savedQueryCount } = JSON.parse(saved);
        if (Array.isArray(savedTabs) && savedTabs.length > 0) {
          setTabs(savedTabs);
          setActiveTabId(savedActiveId || savedTabs[0].id);
          setQueryCount(savedQueryCount || (savedTabs.length + 1));
          return;
        }
      } catch (e) {
        console.error('Lỗi phục hồi tab history:', e);
      }
    }

    // Open an initial SQL Query tab on connect
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: 'Truy vấn 1',
      },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  // Disconnect from database
  // Hỏi xác nhận nếu bảng đang mở còn thay đổi chưa lưu (cờ do DataGrid đặt: window.__gridDirty)
  const guardDirty = () =>
    !(window as any).__gridDirty || window.confirm('Bảng hiện tại còn thay đổi CHƯA LƯU. Bỏ các thay đổi đó và tiếp tục?');

  const handleSelectTab = (id: string) => {
    if (id !== activeTabId && !guardDirty()) return;
    setActiveTabId(id);
  };

  const handleDisconnect = async () => {
    if (!guardDirty()) return;
    await dbHelper.disconnect();
    setConnection(null);
    setTabs([]);
    setActiveTabId(null);
    setQueryCount(1);
    setShowSidebar(true);
  };

  // Sau khi đổi database đang dùng: cập nhật tên DB, đóng các tab (thuộc DB cũ), làm mới
  const handleDatabaseChanged = (newName: string) => {
    const nextConn = connection ? { ...connection, dbName: newName } : null;
    setConnection(nextConn);
    setDbReloadKey((k) => k + 1);

    if (nextConn) {
      const storageKey = `tn_tabs_${nextConn.dbType}_${newName}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const { tabs: savedTabs, activeTabId: savedActiveId, queryCount: savedQueryCount } = JSON.parse(saved);
          if (Array.isArray(savedTabs) && savedTabs.length > 0) {
            setTabs(savedTabs);
            setActiveTabId(savedActiveId || savedTabs[0].id);
            setQueryCount(savedQueryCount || (savedTabs.length + 1));
            return;
          }
        } catch (e) {
          console.error('Lỗi phục hồi tab history khi đổi db:', e);
        }
      }
    }

    // Fallback
    const initialTabId = 'query_1';
    setTabs([
      {
        id: initialTabId,
        type: 'query',
        name: 'SQL Query',
        label: 'Truy vấn 1',
      },
    ]);
    setActiveTabId(initialTabId);
    setQueryCount(2);
  };

  // Open a specific table in a new or existing tab
  const handleSelectTable = (tableName: string, initialViewMode: 'data' | 'structure' = 'data') => {
    const tabId = `table_${tableName}`;
    if (tabId !== activeTabId && !guardDirty()) return;
    const exists = tabs.find((t) => t.id === tabId);

    if (!exists) {
      const newTab: TabInfo = {
        id: tabId,
        type: 'table',
        name: tableName,
        label: tableName,
        initialViewMode,
      } as any;
      setTabs([...tabs, newTab]);
    } else {
      if (initialViewMode) {
        setTabs(tabs.map(t => t.id === tabId ? { ...t, initialViewMode } as any : t));
      }
    }
    setActiveTabId(tabId);
  };

  // Create a new SQL Query tab
  const handleNewQueryTab = () => {
    const tabId = `query_${Date.now()}`;
    const newTab: TabInfo = {
      id: tabId,
      type: 'query',
      name: 'SQL Query',
      label: `Truy vấn ${queryCount}`,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(tabId);
    setQueryCount(queryCount + 1);
  };

  // Close tab
  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    // Đóng tab bảng đang sửa dở -> hỏi xác nhận
    if (id === activeTabId && !guardDirty()) return;
    const tabIndex = tabs.findIndex((t) => t.id === id);
    const newTabs = tabs.filter((t) => t.id !== id);

    setTabs(newTabs);

    // If closing active tab, switch to another
    if (activeTabId === id) {
      if (newTabs.length > 0) {
        // select next or previous tab
        const nextActiveIndex = Math.min(tabIndex, newTabs.length - 1);
        setActiveTabId(newTabs[nextActiveIndex].id);
      } else {
        setActiveTabId(null);
      }
    }
  };

  const handleCloseOthers = (id: string) => {
    const newTabs = tabs.filter((t) => t.id === id);
    setTabs(newTabs);
    setActiveTabId(id);
  };

  const handleCloseTabsToRight = (id: string) => {
    const tabIndex = tabs.findIndex((t) => t.id === id);
    if (tabIndex !== -1) {
      const newTabs = tabs.slice(0, tabIndex + 1);
      setTabs(newTabs);

      const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
      if (activeIndex > tabIndex) {
        setActiveTabId(id);
      }
    }
  };

  const handleCloseAll = () => {
    setTabs([]);
    setActiveTabId(null);
  };


  // Insert SQL generated by AI into current query editor
  const handleInsertSql = (sql: string) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);

    if (activeTab && activeTab.type === 'query') {
      // Update existing SQL tab
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id === activeTabId) {
            return { ...t, sql }; // Update initialSql prop
          }
          return t;
        })
      );
      
      // Force remount or change value by passing key to Monaco
      // We can append a timestamp or change tab ID, but simple update is fine.
    } else {
      // Create a new SQL query tab with the generated SQL
      const tabId = `query_${Date.now()}`;
      const newTab: TabInfo = {
        id: tabId,
        type: 'query',
        name: 'SQL Query',
        label: `Truy vấn ${queryCount}`,
      };
      // Pre-populate sql property
      (newTab as any).sql = sql;
      
      setTabs([...tabs, newTab]);
      setActiveTabId(tabId);
      setQueryCount(queryCount + 1);
    }
  };

  // Config cho Terminal: nếu kết nối hiện tại dùng SSH -> kế thừa để mở shell VÀO MÁY CHỦ/VM đó;
  // ngược lại mở shell máy cục bộ.
  const terminalConfig = (): DbConnectionConfig => {
    const c = activeConnConfig;
    if (c?.sshEnabled && c.sshHost) {
      return {
        type: connection?.dbType || 'sqlite',
        sshEnabled: true,
        sshHost: c.sshHost,
        sshPort: c.sshPort,
        sshUser: c.sshUser,
        sshAuthType: c.sshAuthType,
        sshPassword: c.sshPassword,
        sshKeyPath: c.sshKeyPath,
        sshKeyContent: c.sshKeyContent,
        sshPassphrase: c.sshPassphrase,
      };
    }
    return { type: connection?.dbType || 'sqlite' };
  };

  const handleOpenTerminal = () => {
    if (!connection) return;
    const id = `terminal_${Date.now()}`;
    const newTab: TabInfo = {
      id,
      type: 'terminal',
      name: 'Terminal',
      label: 'Terminal',
      config: terminalConfig(),
      floating: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
  };

  const getActiveTab = () => {
    return tabs.find((t) => t.id === activeTabId) || null;
  };

  const activeTab = getActiveTab();
  const activeTable = activeTab?.type === 'table' ? activeTab.name : null;

  return (
    <>
      <TitleBar
        hasConnection={!!connection}
        onNewConnection={handleDisconnect}
        onDisconnect={handleDisconnect}
        onNewQuery={handleNewQueryTab}
        onBackupRestore={() => setShowBackupRestoreModal(true)}
        onToggleSidebar={() => setShowSidebar(prev => !prev)}
        onToggleTheme={toggleTheme}
        onShowShortcuts={() => setShowShortcuts(true)}
        onShowAbout={() => setShowAbout(true)}
      />

      {!connection ? (
        <ConnectionManager onConnect={handleConnect} />
      ) : (
        <div className="workspace-container" style={{ borderTop: activeConnectionColor ? `3px solid ${activeConnectionColor}` : 'none' }}>
          {showSidebar && (
            <Sidebar
              dbName={connection.dbName}
              dbType={connection.dbType}
              onSelectTable={handleSelectTable}
              onNewQuery={handleNewQueryTab}
              onOpenTerminal={handleOpenTerminal}
              terminalConfig={terminalConfig()}
              onDisconnect={handleDisconnect}
              activeTable={activeTable}
              onImportToTable={handleImportToTableTrigger}
              onExportTable={handleExportTableTrigger}
              onBackupRestore={() => setShowBackupRestoreModal(true)}
              onTableRenamed={handleTableRenamed}
              onTableDropped={handleTableDropped}
              onDatabaseChanged={handleDatabaseChanged}
            />
          )}

          <div className="main-workspace-area">
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--win-bg-tab-bar)', paddingRight: '8px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TabManager
                  tabs={tabs}
                  activeTabId={activeTabId}
                  onSelectTab={handleSelectTab}
                  onCloseTab={handleCloseTab}
                  onCloseOthers={handleCloseOthers}
                  onCloseTabsToRight={handleCloseTabsToRight}
                  onCloseAll={handleCloseAll}
                  onNewQueryTab={handleNewQueryTab}
                />
              </div>
              <button 
                className="tab-new-btn" 
                onClick={toggleTheme}
                style={{ 
                  color: 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', gap: '4px', width: 'auto', padding: '0 8px', fontSize: '11px', marginRight: '6px'
                }}
                title={theme === 'dark' ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
              >
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                <span>{theme === 'dark' ? 'Sáng' : 'Tối'}</span>
              </button>
              <button
                className="tab-new-btn"
                onClick={() => setReadOnly(r => !r)}
                style={{
                  color: readOnly ? '#f59e0b' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', gap: '4px', width: 'auto', padding: '0 8px', fontSize: '11px', marginRight: '6px'
                }}
                title={readOnly ? 'Chế độ Chỉ đọc đang BẬT — nhấn để tắt' : 'Bật chế độ Chỉ đọc (chặn mọi thao tác ghi)'}
              >
                {readOnly ? <Lock size={14} /> : <LockOpen size={14} />}
                <span>{readOnly ? 'Chỉ đọc' : 'Ghi'}</span>
              </button>
              <button
                className="tab-new-btn"
                onClick={() => setShowAi(!showAi)}
                style={{ 
                  color: showAi ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '24px', padding: 0 
                }}
                title="Bật/Tắt AI Copilot"
              >
                <Bot size={14} />
              </button>
            </div>

            <div className="active-panel-container" style={{ position: 'relative' }}>
              {!activeTab ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                  Chọn một bảng từ Sidebar hoặc tạo Truy vấn SQL để bắt đầu làm việc.
                </div>
              ) : activeTab.type === 'terminal' ? (
                (activeTab as any).floating ? (
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--win-text-secondary)', fontSize: '13px' }}>
                    Terminal đang ở chế độ cửa sổ nổi — bấm nút ghim trên cửa sổ để đưa về tab.
                  </div>
                ) : null
              ) : (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  {activeTab.type === 'table' ? (
                    <DataGrid
                      key={activeTab.id + '_' + ((activeTab as any).initialViewMode || 'data') + '_' + dbReloadKey}
                      tableName={activeTab.name}
                      dbType={connection.dbType}
                      initialViewMode={(activeTab as any).initialViewMode || 'data'}
                      readOnly={readOnly}
                    />
                  ) : (
                    <SqlEditor
                      key={activeTab.id}
                      dbType={connection?.dbType}
                      initialSql={(activeTab as any).sql || ''}
                      initialSql2={(activeTab as any).sql2 || ''}
                      initialSplitMode={(activeTab as any).splitMode || 'none'}
                      theme={theme}
                      readOnly={readOnly}
                      onSqlChange={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, sql: val } as any) : t));
                      }}
                      onSql2Change={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, sql2: val } as any) : t));
                      }}
                      onSplitModeChange={(val) => {
                        const id = activeTab.id;
                        setTabs(prev => prev.map(t => t.id === id ? ({ ...t, splitMode: val } as any) : t));
                      }}
                    />
                  )}
                </div>
              )}

              {/* Terminal: mount thường trực (ẩn/hiện bằng CSS) để phiên PTY sống khi chuyển tab */}
              {tabs.filter(t => t.type === 'terminal').map(t => (
                <TerminalPanel
                  key={t.id}
                  config={((t as any).config || { type: connection.dbType }) as DbConnectionConfig}
                  profileName={t.label}
                  floating={!!(t as any).floating}
                  active={activeTabId === t.id}
                  onToggleFloat={() => setTabs(prev => prev.map(x => x.id === t.id ? ({ ...x, floating: !(x as any).floating } as any) : x))}
                  onClose={() => handleCloseTab(t.id)}
                />
              ))}

              {showAi && (
                <AiAssistant
                  onInsertSql={handleInsertSql}
                  tableNameContext={activeTable}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Hidden input for global table imports */}
      <input 
        type="file" 
        ref={globalFileInputRef} 
        onChange={handleGlobalFileImport} 
        accept=".csv,.json,.sql,.dump" 
        style={{ display: 'none' }} 
      />

      {/* Global Export Multi-Table Modal */}
      {showGlobalExportModal && (
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
            width: '500px',
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
                Xuất Cơ sở dữ liệu (Export Database)
              </span>
              <button 
                onClick={() => setShowGlobalExportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group">
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
                  Tên tệp xuất (File name):
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={globalExportFilename}
                  onChange={(e) => setGlobalExportFilename(e.target.value)}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
                  Định dạng xuất:
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {(['sql', 'json', 'csv'] as const).map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => setGlobalExportFormat(fmt)}
                      style={{
                        padding: '6px 16px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: globalExportFormat === fmt ? 'var(--win-accent)' : 'transparent',
                        color: globalExportFormat === fmt ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {fmt.toUpperCase()} {fmt === 'csv' ? '(ZIP)' : ''}
                    </button>
                  ))}
                </div>
              </div>

              {globalExportFormat === 'sql' && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px'
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input 
                      type="checkbox"
                      checked={globalExportDropTable}
                      onChange={(e) => setGlobalExportDropTable(e.target.checked)}
                    />
                    <span>Drop table if exists</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input 
                      type="checkbox"
                      checked={globalExportIncludeStructure}
                      onChange={(e) => setGlobalExportIncludeStructure(e.target.checked)}
                    />
                    <span>Include table structure</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input 
                      type="checkbox"
                      checked={globalExportIncludeContent}
                      onChange={(e) => setGlobalExportIncludeContent(e.target.checked)}
                    />
                    <span>Include table content</span>
                  </label>
                </div>
              )}

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input 
                    type="checkbox"
                    checked={globalExportCompressGzip}
                    onChange={(e) => setGlobalExportCompressGzip(e.target.checked)}
                  />
                  <span>Compress the file using Gzip</span>
                </label>
              </div>

              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
                  Chọn các bảng cần xuất:
                </label>
                <div style={{
                  maxHeight: '150px',
                  overflowY: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)',
                  padding: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}>
                  {globalExportTables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>Không có bảng nào.</div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '6px', borderBottom: '1px solid var(--win-border)', marginBottom: '4px' }}>
                        <input 
                          type="checkbox"
                          checked={selectedExportTables.length === globalExportTables.length}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedExportTables([...globalExportTables]);
                            else setSelectedExportTables([]);
                          }}
                        />
                        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Chọn tất cả</span>
                      </div>
                      {globalExportTables.map(name => (
                        <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                          <input 
                            type="checkbox"
                            checked={selectedExportTables.includes(name)}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedExportTables([...selectedExportTables, name]);
                              else setSelectedExportTables(selectedExportTables.filter(t => t !== name));
                            }}
                          />
                          <span>{name}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
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
                onClick={() => setShowGlobalExportModal(false)}
                style={{ height: '26px', fontSize: '11px' }}
              >
                Hủy
              </button>
              <button
                className="btn btn-primary"
                onClick={handleGlobalExportSubmit}
                disabled={globalExportLoading || selectedExportTables.length === 0}
                style={{ height: '26px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px' }}
              >
                {globalExportLoading ? 'Đang xuất...' : 'Bắt đầu Xuất'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Import Table Modal (Import New Table) */}
      {showGlobalImportModal && (
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
                {globalImportTargetTable 
                  ? `Nhập Dữ Liệu vào Bảng: ${globalImportTargetTable} - Tệp: ${globalImportFileName}`
                  : `Tạo Bảng Mới & Nhập Dữ Liệu - Tệp: ${globalImportFileName}`}
              </span>
              <button 
                onClick={() => setShowGlobalImportModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group">
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
                  {globalImportTargetTable ? 'Bảng đích (Nhập vào bảng hiện có)' : 'Tên bảng mới sẽ tạo'}
                </label>
                <input 
                  type="text" 
                  className="form-input"
                  value={globalImportTargetTable || globalImportTableName} 
                  onChange={(e) => !globalImportTargetTable && setGlobalImportTableName(e.target.value)}
                  disabled={!!globalImportTargetTable}
                  placeholder="nhap_ten_bang"
                  style={{ height: '30px', fontSize: '11px', background: globalImportTargetTable ? 'var(--win-bg-hover)' : undefined }}
                />
              </div>

              {globalImportFileType === 'sql' && (
                <div className="form-group">
                  <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', marginBottom: '6px', display: 'block' }}>
                    Chọn nội dung thực thi từ tệp SQL
                  </label>
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'both'} 
                        onChange={() => setGlobalImportSqlMode('both')} 
                      />
                      <span>Cấu trúc & Dữ liệu</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'structure'} 
                        onChange={() => setGlobalImportSqlMode('structure')} 
                      />
                      <span>Chỉ cấu trúc (Structure)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="sqlImportMode" 
                        checked={globalImportSqlMode === 'data'} 
                        onChange={() => setGlobalImportSqlMode('data')} 
                      />
                      <span>Chỉ dữ liệu (Data)</span>
                    </label>
                  </div>
                </div>
              )}

              <div>
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                  {globalImportFileType === 'sql' ? (
                    <span>SQL Script: Câu lệnh SQL sẽ chạy trực tiếp.</span>
                  ) : (
                    <span>
                      Định dạng {globalImportFileType.toUpperCase()}: Phát hiện <b>{globalImportPendingRows.length} dòng dữ liệu</b>.
                      Các cột: <b>{Object.keys(globalImportPendingRows[0] || {}).join(', ')}</b>.
                    </span>
                  )}
                </span>
              </div>

              {globalImportFileType === 'sql' ? (
                <textarea
                  readOnly
                  value={globalImportSqlContent.slice(0, 5000)}
                  style={{
                    width: '100%',
                    height: '200px',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    padding: '10px',
                    borderRadius: '4px',
                    resize: 'none'
                  }}
                />
              ) : (
                <div style={{
                  height: '200px',
                  overflow: 'auto',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px',
                  background: 'var(--win-bg-window)'
                }}>
                  {globalImportPendingRows.length > 0 ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                          {Object.keys(globalImportPendingRows[0]).map(col => (
                            <th key={col} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {globalImportPendingRows.slice(0, 5).map((row, rIdx) => (
                          <tr key={rIdx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                            {Object.keys(globalImportPendingRows[0]).map(col => (
                              <td key={col} style={{ padding: '6px 8px', color: 'var(--win-text-primary)', borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px' }}>
                                {row[col] === null ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span> : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
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
                onClick={() => setShowGlobalImportModal(false)}
                style={{ height: '26px', fontSize: '11px' }}
              >
                Hủy
              </button>
              <button
                className="btn btn-primary"
                onClick={confirmGlobalImport}
                disabled={globalImportLoading || (!globalImportTableName.trim() && globalImportFileType !== 'sql')}
                style={{ height: '26px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px' }}
              >
                {globalImportLoading ? 'Đang xử lý...' : 'Xác nhận Tạo & Nhập'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backup & Restore Modal */}
      {showBackupRestoreModal && (
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
            width: '500px',
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
                Sao lưu & Phục hồi (Backup & Restore)
              </span>
              <button 
                onClick={() => setShowBackupRestoreModal(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>

            {/* Modal Tabs */}
            <div style={{
              display: 'flex',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.05))',
              borderBottom: '1px solid var(--win-border)'
            }}>
              <button
                onClick={() => setBackupRestoreTab('backup')}
                style={{
                  flex: 1,
                  padding: '10px',
                  border: 'none',
                  background: backupRestoreTab === 'backup' ? 'var(--win-bg-card)' : 'transparent',
                  color: backupRestoreTab === 'backup' ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Tạo bản sao lưu (Backup)
              </button>
              <button
                onClick={() => setBackupRestoreTab('restore')}
                style={{
                  flex: 1,
                  padding: '10px',
                  border: 'none',
                  background: backupRestoreTab === 'restore' ? 'var(--win-bg-card)' : 'transparent',
                  color: backupRestoreTab === 'restore' ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Khôi phục dữ liệu (Restore)
              </button>
            </div>

            <div style={{ padding: '16px' }}>
              {backupRestoreTab === 'backup' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div className="form-group">
                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
                      Tên tệp sao lưu (Backup Name):
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      value={globalExportFilename}
                      onChange={(e) => setGlobalExportFilename(e.target.value)}
                      style={{ height: '30px', fontSize: '11px', width: '100%' }}
                    />
                  </div>

                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    padding: '10px',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px'
                  }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={globalExportDropTable}
                        onChange={(e) => setGlobalExportDropTable(e.target.checked)}
                      />
                      <span>Drop table if exists</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={globalExportIncludeStructure}
                        onChange={(e) => setGlobalExportIncludeStructure(e.target.checked)}
                      />
                      <span>Include table structure</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={globalExportIncludeContent}
                        onChange={(e) => setGlobalExportIncludeContent(e.target.checked)}
                      />
                      <span>Include table content</span>
                    </label>
                  </div>

                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={globalExportCompressGzip}
                        onChange={(e) => setGlobalExportCompressGzip(e.target.checked)}
                      />
                      <span>Nén tệp sao lưu bằng Gzip (.sql.gz)</span>
                    </label>
                  </div>

                  <button
                    className="btn btn-primary"
                    disabled={globalExportLoading}
                    onClick={async () => {
                      const list = await dbHelper.getTables();
                      setSelectedExportTables(list.map(t => t.name));
                      setGlobalExportFormat('sql');
                      handleGlobalExportSubmit();
                    }}
                    style={{ height: '32px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px', marginTop: '8px' }}
                  >
                    {globalExportLoading ? 'Đang tạo bản sao lưu...' : 'Tạo bản Sao lưu'}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {!restoreFile ? (
                    <div style={{
                      border: '2px dashed var(--win-border)',
                      borderRadius: '6px',
                      padding: '24px',
                      textAlign: 'center',
                      background: 'var(--win-bg-window)'
                    }}>
                      <input 
                        type="file" 
                        accept=".sql,.dump,.gz" 
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) setRestoreFile(file);
                        }} 
                        style={{ display: 'none' }}
                        id="backup-file-upload"
                      />
                      <label 
                        htmlFor="backup-file-upload" 
                        style={{ cursor: 'pointer', display: 'block' }}
                      >
                        <Database size={32} style={{ color: 'var(--win-accent)', marginBottom: '8px' }} />
                        <span style={{ fontSize: '11px', color: 'var(--win-text-primary)', display: 'block' }}>
                          Nhấp vào đây để chọn tệp .sql hoặc .sql.gz
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)', display: 'block', marginTop: '4px' }}>
                          Hỗ trợ khôi phục tự động qua định dạng SQL nén
                        </span>
                      </label>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px 12px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{restoreFile.name}</span>
                        <button
                          type="button"
                          onClick={() => setRestoreFile(null)}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#ef4444', fontSize: '11px' }}
                        >
                          Xóa
                        </button>
                      </div>

                      {restoreParsing && (
                        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                          Đang đọc danh sách bảng từ file...
                        </div>
                      )}

                      {restoreParsedTables.length > 0 && (
                        <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '10px', background: 'rgba(0,0,0,0.1)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', borderBottom: '1px solid var(--win-border)', paddingBottom: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Chọn bảng muốn import ({restoreSelectedTables.length}/{restoreParsedTables.length})</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (restoreSelectedTables.length === restoreParsedTables.length) {
                                  setRestoreSelectedTables([]);
                                } else {
                                  setRestoreSelectedTables([...restoreParsedTables]);
                                }
                              }}
                              style={{ padding: '2px 6px', fontSize: '9px', cursor: 'pointer', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '3px', color: 'var(--win-text-primary)' }}
                            >
                              {restoreSelectedTables.length === restoreParsedTables.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                            </button>
                          </div>
                          <div style={{ maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {restoreParsedTables.map(t => {
                              const isChecked = restoreSelectedTables.includes(t);
                              return (
                                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => {
                                      if (isChecked) {
                                        setRestoreSelectedTables(restoreSelectedTables.filter(x => x !== t));
                                      } else {
                                        setRestoreSelectedTables([...restoreSelectedTables, t]);
                                      }
                                    }}
                                  />
                                  <span>{t}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <button
                        className="btn btn-primary"
                        onClick={handleRestoreBackup}
                        disabled={restoreLoading || (restoreParsedTables.length > 0 && restoreSelectedTables.length === 0)}
                        style={{ height: '32px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px', marginTop: '6px' }}
                      >
                        {restoreLoading ? 'Đang khôi phục dữ liệu...' : 'Bắt đầu Khôi phục (Restore)'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* About Modal */}
      {showAbout && (
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
            width: '380px',
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '6px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '24px',
            alignItems: 'center',
            position: 'relative'
          }}>
            <button 
              onClick={() => setShowAbout(false)}
              style={{ position: 'absolute', top: '12px', right: '16px', background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
            >
              ×
            </button>
            <img src={appIcon} alt="TableNova" style={{ width: 64, height: 64, borderRadius: '12px', marginBottom: '16px', objectFit: 'contain' }} />
            <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600, color: 'var(--win-text-primary)' }}>TableNova</h3>
            <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginBottom: '16px' }}>Phiên bản 0.1.0(Build 2026)</span>
            
            <p style={{ margin: '0 0 8px 0', fontSize: '12px', color: 'var(--win-text-primary)', textAlign: 'center', lineHeight: '1.5' }}>
              Công cụ quản lý cơ sở dữ liệu nhẹ, nhanh và trực quan.
            </p>
            <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: 'var(--win-text-primary)', textAlign: 'center', lineHeight: '1.5' }}>
              Kết nối, duyệt dữ liệu, chỉnh sửa cấu trúc và thực thi truy vấn trong một giao diện thống nhất.
            </p>

            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginBottom: '12px', textAlign: 'center' }}>
              Phát triển bởi <strong style={{ color: 'var(--win-text-primary)' }}>MeoMeo</strong>
              <div style={{ marginTop: '4px' }}>
                <a href="#" onClick={(e) => { e.preventDefault(); dbHelper.openUrl('mailto:pthang888@gmail.com'); }} style={{ color: '#0066cc', textDecoration: 'none', marginRight: '12px' }}>Email</a>
                <a href="#" onClick={(e) => { e.preventDefault(); dbHelper.openUrl('https://www.linkedin.com/in/thangpx/'); }} style={{ color: '#0066cc', textDecoration: 'none' }}>LinkedIn</a>
              </div>
            </div>

            <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginBottom: '16px' }}>
              © 2026 MeoMeo · MIT License
            </span>
            
            <div style={{ borderTop: '1px solid var(--win-border)', width: '100%', paddingTop: '12px', display: 'flex', justifyContent: 'center' }}>
              <button 
                className="btn" 
                onClick={() => setShowAbout(false)}
                style={{ padding: '6px 20px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer', background: 'var(--win-bg-btn-secondary)', border: '1px solid var(--win-border-btn-secondary)', color: 'var(--win-text-btn-secondary)' }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shortcuts Modal */}
      {showShortcuts && (
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
            width: '450px',
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
                Phím tắt bàn phím (Keyboard Shortcuts)
              </span>
              <button 
                onClick={() => setShowShortcuts(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
              >
                ×
              </button>
            </div>
            
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '380px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Chung</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Tìm kiếm bảng/View</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + P / Ctrl + K</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Bảng Dữ liệu (Grid)</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Mở bộ lọc dữ liệu (Filter)</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + F</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Thêm dòng mới</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + I</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Lưu thay đổi xuống DB</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + S</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Xóa dòng đã chọn</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Delete / Backspace</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Trang tiếp theo</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + ]</kbd>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Trang trước đó</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + [</kbd>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-accent)', borderBottom: '1px solid var(--win-border)', paddingBottom: '3px' }}>Trình soạn thảo SQL</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', alignItems: 'center' }}>
                  <span style={{ color: 'var(--win-text-primary)' }}>Chạy truy vấn SQL</span>
                  <kbd style={{ fontSize: '10px', background: 'var(--win-bg-tab-bar)', padding: '2px 6px', borderRadius: '3px', border: '1px solid var(--win-border-strong)', color: 'var(--win-text-primary)' }}>Ctrl + Enter / F5</kbd>
                </div>
              </div>
            </div>
            
            <div style={{ borderTop: '1px solid var(--win-border)', padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.05))' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowShortcuts(false)}
                style={{ padding: '6px 20px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer' }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default App;
