// Premium Database Table Structure Viewer & Editor Component
import React, { useState, useEffect, useRef } from 'react';
import type { SchemaInfo, ColumnInfo } from '../utils/dbHelper';
import { dbHelper } from '../utils/dbHelper';
import { Save, Plus, Trash2, RotateCcw, AlertTriangle, CheckCircle2, Code } from 'lucide-react';

interface StructureViewerProps {
  tableName: string;
  schema: SchemaInfo;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  onSchemaChanged: () => void;
  readOnly?: boolean;
}

export const StructureViewer: React.FC<StructureViewerProps> = ({
  tableName,
  schema,
  dbType,
  onSchemaChanged,
  readOnly = false,
}) => {
  // Columns state
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [deletedColNames, setDeletedColNames] = useState<string[]>([]);
  const [editingColCell, setEditingColCell] = useState<{ rowIndex: number; field: 'name' | 'type' | 'nullable' | 'defaultValue' | 'comment' } | null>(null);
  const [editColValue, setEditColValue] = useState<string>('');

  // Indexes state
  const [idxs, setIdxs] = useState<{ name: string; columns: string; unique: boolean }[]>([]);
  const [deletedIdxNames, setDeletedIdxNames] = useState<string[]>([]);
  const [editingIdxCell, setEditingIdxCell] = useState<{ rowIndex: number; field: 'name' | 'columns' | 'unique' } | null>(null);
  const [editIdxValue, setEditIdxValue] = useState<string>('');

  // Foreign Keys state
  const [fks, setFks] = useState<{ name: string; column: string; refTable: string; refColumn: string }[]>([]);
  const [deletedFkNames, setDeletedFkNames] = useState<string[]>([]);
  const [editingFkCell, setEditingFkCell] = useState<{ rowIndex: number; field: 'column' | 'refTable' | 'refColumn' } | null>(null);
  const [editFkValue, setEditFkValue] = useState<string>('');

  // Status messages
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [previewSqls, setPreviewSqls] = useState<string[] | null>(null);
  const [definitionSql, setDefinitionSql] = useState<string | null>(null);
  const [allTables, setAllTables] = useState<string[]>([]);
  const [refColumns, setRefColumns] = useState<string[]>([]);

  // Load all tables for foreign key referenced table dropdown selection
  useEffect(() => {
    const fetchAllTables = async () => {
      try {
        const list = await dbHelper.getTables();
        setAllTables(list.map(t => t.name));
      } catch (err) {
        console.error("Lỗi lấy danh sách bảng:", err);
      }
    };
    fetchAllTables();
  }, []);

  // Database specific type lists
  const getTypesForDb = () => {
    switch (dbType) {
      case 'postgres':
        return [
          'INTEGER', 'BIGINT', 'SMALLINT', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 
          'BOOLEAN', 'NUMERIC(10,2)', 'REAL', 'DOUBLE PRECISION', 'DATE', 
          'TIME', 'TIMESTAMP', 'UUID', 'JSONB', 'BYTEA'
        ];
      case 'mysql':
        return [
          'INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'DECIMAL(10,2)', 'FLOAT', 
          'DOUBLE', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'LONGTEXT', 'BLOB', 
          'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'JSON'
        ];
      case 'sqlite':
      default:
        return ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR(255)', 'BOOLEAN', 'TIMESTAMP'];
    }
  };

  const dbTypes = getTypesForDb();

  // Initialize from schema
  useEffect(() => {
    setCols(schema.columns.map(c => ({ ...c })));
    setDeletedColNames([]);
    setEditingColCell(null);

    setIdxs((schema.indexes || []).map(i => ({ ...i })));
    setDeletedIdxNames([]);
    setEditingIdxCell(null);

    setFks((schema.foreignKeys || []).map((f, index) => ({
      name: f.name || `fk_${tableName}_col_${f.column}_${index}`,
      column: f.column,
      refTable: f.refTable,
      refColumn: f.refColumn
    })));
    setDeletedFkNames([]);
    setEditingFkCell(null);
    // tableName được dùng bên trong effect để đặt tên khóa ngoại chưa có tên
    // (`fk_${tableName}_col_...`), nên phải nằm trong deps. Thực tế đổi bảng thì
    // schema cũng được nạp lại nên effect vẫn chạy, nhưng khai đủ deps mới đúng ý
    // định và bỏ được cảnh báo exhaustive-deps.
  }, [schema, tableName]);

  // Track pending changes
  const hasChanges = () => {
    if (deletedColNames.length > 0 || deletedIdxNames.length > 0 || deletedFkNames.length > 0) return true;
    if (cols.length !== schema.columns.length) return true;
    if (idxs.length !== (schema.indexes || []).length) return true;
    if (fks.length !== (schema.foreignKeys || []).length) return true;

    // Check columns
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const orig = schema.columns[i];
      if (
        !orig || 
        col.name !== orig.name || 
        col.type.toLowerCase() !== orig.type.toLowerCase() || 
        col.nullable !== orig.nullable || 
        String(col.defaultValue) !== String(orig.defaultValue) ||
        !!col.autoIncrement !== !!orig.autoIncrement ||
        col.comment !== orig.comment ||
        col.isPrimaryKey !== orig.isPrimaryKey
      ) {
        return true;
      }
    }

    // Check indexes
    const origIndexes = schema.indexes || [];
    for (let i = 0; i < idxs.length; i++) {
      const idx = idxs[i];
      const orig = origIndexes[i];
      if (!orig || idx.name !== orig.name || idx.columns !== orig.columns || idx.unique !== orig.unique) {
        return true;
      }
    }

    // Check foreign keys
    const origFks = schema.foreignKeys || [];
    for (let i = 0; i < fks.length; i++) {
      const fk = fks[i];
      const orig = origFks[i];
      if (!orig || fk.column !== orig.column || fk.refTable !== orig.refTable || fk.refColumn !== orig.refColumn) {
        return true;
      }
    }

    return false;
  };

  const handleDiscard = () => {
    setCols(schema.columns.map(c => ({ ...c })));
    setDeletedColNames([]);
    setEditingColCell(null);

    setIdxs((schema.indexes || []).map(i => ({ ...i })));
    setDeletedIdxNames([]);
    setEditingIdxCell(null);

    setFks((schema.foreignKeys || []).map((f, index) => ({
      name: f.name || `fk_${tableName}_col_${f.column}_${index}`,
      column: f.column,
      refTable: f.refTable,
      refColumn: f.refColumn
    })));
    setDeletedFkNames([]);
    setEditingFkCell(null);

    setErrorMsg(null);
    setSuccessMsg('Đã khôi phục lại cấu trúc gốc.');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // -------------------------------------------------------------
  // COLUMNS HANDLERS
  // -------------------------------------------------------------
  const handleAddColumn = () => {
    let baseName = 'new_column';
    let counter = 1;
    while (cols.some(c => c.name === `${baseName}_${counter}`)) {
      counter++;
    }
    const newCol: ColumnInfo = {
      name: `${baseName}_${counter}`,
      type: dbTypes[0],
      nullable: true,
      isPrimaryKey: false,
      defaultValue: null
    };
    const newCols = [...cols, newCol];
    setCols(newCols);
    // Mở sẵn ô nhập tên cột như handleAddIndex vẫn làm — bấm "Thêm cột" mà dòng
    // mới chỉ nằm im ở dưới thì người dùng không biết phải nhấp đôi để sửa.
    setTimeout(() => startEditCol(newCols.length - 1, 'name', newCol.name), 50);
  };

  const handleDeleteColumn = (colName: string, isNewColumn: boolean) => {
    setCols(cols.filter(c => c.name !== colName));
    if (!isNewColumn) {
      setDeletedColNames([...deletedColNames, colName]);
    }
  };

  const startEditCol = (rowIndex: number, field: 'name' | 'type' | 'nullable' | 'defaultValue' | 'comment', val: any) => {
    setEditingColCell({ rowIndex, field });
    setEditColValue(val === null ? '' : String(val));
  };

  const saveEditCol = (rowIndex: number, field: 'name' | 'type' | 'nullable' | 'defaultValue' | 'comment') => {
    if (!editingColCell) return;
    setCols(prev => prev.map((col, idx) => {
      if (idx === rowIndex) {
        let updatedVal: any = editColValue;
        if (field === 'nullable') {
          updatedVal = editColValue === 'true';
        } else if (field === 'defaultValue') {
          updatedVal = editColValue.trim() === '' ? null : editColValue;
        } else if (field === 'comment') {
          updatedVal = editColValue.trim() === '' ? null : editColValue;
        }
        return { ...col, [field]: updatedVal };
      }
      return col;
    }));
    setEditingColCell(null);
  };

  const handleTogglePrimaryKey = (rowIndex: number) => {
    setCols(prev => prev.map((col, idx) => {
      if (idx === rowIndex) {
        return { ...col, isPrimaryKey: !col.isPrimaryKey };
      }
      return col;
    }));
  };

  const handleToggleAutoIncrement = (rowIndex: number) => {
    setCols(prev => prev.map((col, idx) => {
      if (idx === rowIndex) {
        return { ...col, autoIncrement: !col.autoIncrement };
      }
      return col;
    }));
  };

  // -------------------------------------------------------------
  // INDEXES HANDLERS
  // -------------------------------------------------------------
  const handleAddIndex = () => {
    let baseName = `idx_${tableName}_new`;
    let counter = 1;
    while (idxs.some(i => i.name === `${baseName}_${counter}`)) {
      counter++;
    }
    const newIdx = {
      name: `${baseName}_${counter}`,
      columns: cols[0]?.name || '',
      unique: false
    } as any;
    const newIdxs = [...idxs, newIdx];
    setIdxs(newIdxs);
    // Auto-start editing the name cell of the new row
    setTimeout(() => {
      setEditingIdxCell({ rowIndex: newIdxs.length - 1, field: 'name' });
      setEditIdxValue(newIdx.name);
    }, 50);
  };

  const handleDeleteIndex = (idxName: string, isNewIndex: boolean) => {
    setIdxs(idxs.filter(i => i.name !== idxName));
    if (!isNewIndex) {
      setDeletedIdxNames([...deletedIdxNames, idxName]);
    }
  };

  const startEditIdx = (rowIndex: number, field: 'name' | 'columns' | 'unique', val: any) => {
    setEditingIdxCell({ rowIndex, field });
    setEditIdxValue(String(val));
  };

  const saveEditIdx = (rowIndex: number, field: 'name' | 'columns' | 'unique') => {
    if (!editingIdxCell) return;
    setIdxs(prev => prev.map((idx, idxVal) => {
      if (idxVal === rowIndex) {
        let updatedVal: any = editIdxValue;
        if (field === 'unique') {
          updatedVal = editIdxValue === 'true';
        }
        return { ...idx, [field]: updatedVal };
      }
      return idx;
    }));
    setEditingIdxCell(null);
  };

  // -------------------------------------------------------------
  // FOREIGN KEYS HANDLERS
  // -------------------------------------------------------------
  const handleAddFK = () => {
    let baseName = `fk_${tableName}_new`;
    let counter = 1;
    while (fks.some(f => f.name === `${baseName}_${counter}`)) {
      counter++;
    }
    setFks([...fks, {
      name: `${baseName}_${counter}`,
      column: cols[0]?.name || '',
      refTable: '',
      refColumn: ''
    }]);
  };

  const handleDeleteFK = (fkName: string, isNewFk: boolean) => {
    setFks(fks.filter(f => f.name !== fkName));
    if (!isNewFk) {
      setDeletedFkNames([...deletedFkNames, fkName]);
    }
  };

  // Lấy danh sách cột của một bảng để chọn "Cột tham chiếu".
  // Bản cũ gọi getTableSchema(refTable) MỖI LẦN nhấp đôi vào ô — mỗi lần là một
  // vòng round-trip tới DB, và getTableSchema còn lấy cả index + khóa ngoại dù ở
  // đây chỉ cần tên cột. Với DB ở xa thì mỗi lần mở dropdown phải chờ.
  // Nay dùng getFullCatalog(): lấy cột của TẤT CẢ bảng trong ít truy vấn rồi cache
  // lại, nên chỉ chậm đúng một lần đầu, sau đó mọi bảng đều tức thì.
  const catalogRef = useRef<Record<string, string[]> | null>(null);
  const [loadingRefCols, setLoadingRefCols] = useState(false);

  const getColumnsOf = async (table: string): Promise<string[]> => {
    if (!table) return [];
    const cached = catalogRef.current?.[table];
    if (cached && cached.length) return cached;

    setLoadingRefCols(true);
    try {
      if (!catalogRef.current) {
        const cat = await dbHelper.getFullCatalog();
        const map: Record<string, string[]> = {};
        for (const [tbl, cols] of Object.entries(cat.columns || {})) {
          map[tbl] = (cols as any[]).map(c => c?.name).filter(Boolean);
        }
        catalogRef.current = map;
      }
      let cols = catalogRef.current[table] || [];
      // Catalog lỗi hoặc không có bảng này (view, schema khác...) -> lùi về cách cũ
      // cho đúng một bảng, rồi cache lại để lần sau không phải gọi nữa.
      if (cols.length === 0) {
        const schemaInfo = await dbHelper.getTableSchema(table);
        cols = schemaInfo.columns.map(c => c.name);
        catalogRef.current[table] = cols;
      }
      return cols;
    } catch {
      return [];
    } finally {
      setLoadingRefCols(false);
    }
  };

  const startEditFk = async (rowIndex: number, field: 'column' | 'refTable' | 'refColumn', val: any) => {
    setEditingFkCell({ rowIndex, field });
    setEditFkValue(String(val));

    if (field === 'refColumn') {
      const fkRow = fks[rowIndex];
      setRefColumns(await getColumnsOf(fkRow?.refTable || ''));
    }
  };

  const saveEditFk = async (rowIndex: number, field: 'column' | 'refTable' | 'refColumn', specificVal?: string) => {
    if (!editingFkCell) return;
    const finalVal = specificVal !== undefined ? specificVal : editFkValue;
    setFks(prev => prev.map((fk, idxVal) => {
      if (idxVal === rowIndex) {
        return { ...fk, [field]: finalVal };
      }
      return fk;
    }));
    setEditingFkCell(null);

    // Vừa chọn bảng tham chiếu -> nạp sẵn cột của nó ngay, để khi người dùng mở ô
    // "Cột tham chiếu" thì danh sách đã có, không phải chờ.
    if (field === 'refTable' && finalVal) {
      void getColumnsOf(finalVal).then(setRefColumns);
    }
  };

  // -------------------------------------------------------------
  // SAVE SCHEMA
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // SAVE SCHEMA
  // -------------------------------------------------------------
  const buildPayload = () => {
    const added: any[] = [];
    const renamed: any[] = [];
    const modified: any[] = [];
    const dropped = [...deletedColNames];

    const addedIndexes: any[] = [];
    const droppedIndexes = [...deletedIdxNames];

    const addedFKs: any[] = [];
    const droppedFKs: any[] = [];

    const warnings: string[] = [];

    // Columns DDL preparation
    cols.forEach((col, index) => {
      // Match by name first (unchanged or same-name columns)
      // Fall back to positional match only if name not found (user renamed the column)
      const origByName = schema.columns.find(c => c.name === col.name);
      const origByPos = index < schema.columns.length ? schema.columns[index] : undefined;
      const orig = origByName || origByPos;
      const isNew = !origByName && !origByPos;

      if (isNew) {
        added.push({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          defaultValue: col.defaultValue,
          autoIncrement: col.autoIncrement,
          comment: col.comment
        });
      } else if (orig) {
        if (col.name !== orig.name) {
          renamed.push({ oldName: orig.name, newName: col.name });
        }

        const typeChanged = col.type.toLowerCase() !== orig.type.toLowerCase();
        const nullabilityChanged = col.nullable !== orig.nullable;
        
        const normColDefault = col.defaultValue === null || col.defaultValue === undefined ? null : String(col.defaultValue);
        const normOrigDefault = orig.defaultValue === null || orig.defaultValue === undefined ? null : String(orig.defaultValue);
        const defaultChanged = normColDefault !== normOrigDefault;
        
        const autoIncrementChanged = !!col.autoIncrement !== !!orig.autoIncrement;
        const commentChanged = (col.comment || null) !== (orig.comment || null);

        if (typeChanged || nullabilityChanged || defaultChanged || autoIncrementChanged || commentChanged) {
          if (dbType === 'sqlite' && (typeChanged || nullabilityChanged || autoIncrementChanged || commentChanged)) {
            warnings.push(`Cột "${col.name}": SQLite không hỗ trợ thay đổi trực tiếp thuộc tính này.`);
          } else {
            modified.push({
              name: col.name,
              type: col.type,
              nullable: col.nullable,
              defaultValue: col.defaultValue,
              autoIncrement: col.autoIncrement,
              comment: col.comment
            });
          }
        }
      }
    });

    // Primary Keys Alteration check
    const origPks = schema.columns.filter(c => c.isPrimaryKey).map(c => c.name).sort();
    const newPks = cols.filter(c => c.isPrimaryKey).map(c => c.name).sort();
    const pkChanged = origPks.join(',') !== newPks.join(',');
    const primaryKeys = pkChanged ? cols.filter(c => c.isPrimaryKey).map(c => c.name) : undefined;

    // Indexes DDL preparation
    const origIndexes = schema.indexes || [];
    idxs.forEach(idx => {
      const orig = origIndexes.find(i => i.name === idx.name);
      const isMethodChanged = orig ? (idx as any).method !== (orig as any).method : false;
      const isTypeChanged = orig ? (idx as any).type !== (orig as any).type : false;

      if (!orig) {
        addedIndexes.push({
          name: idx.name,
          columns: idx.columns,
          unique: idx.unique,
          type: (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX'),
          method: (idx as any).method || 'BTREE'
        });
      } else if (idx.columns !== orig.columns || idx.unique !== orig.unique || isMethodChanged || isTypeChanged) {
        // Edit index is simulated by dropping and recreating it
        droppedIndexes.push(orig.name);
        addedIndexes.push({
          name: idx.name,
          columns: idx.columns,
          unique: idx.unique,
          type: (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX'),
          method: (idx as any).method || 'BTREE'
        });
      }
    });

    // Foreign Keys DDL preparation
    const origFks = schema.foreignKeys || [];
    fks.forEach(fk => {
      const orig = origFks.find(f => (f.name && f.name === fk.name) || (f.column === fk.column && f.refTable === fk.refTable));
      if (!orig) {
        addedFKs.push({
          column: fk.column,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
          onUpdate: (fk as any).onUpdate || 'NO ACTION',
          onDelete: (fk as any).onDelete || 'NO ACTION'
        });
      } else if (fk.column !== orig.column || fk.refTable !== orig.refTable || fk.refColumn !== orig.refColumn) {
        // Edit FK is simulated by dropping and recreating it
        const origName = orig.name || fk.name;
        droppedFKs.push({ name: origName, column: orig.column });
        addedFKs.push({
          column: fk.column,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
          onUpdate: (fk as any).onUpdate || 'NO ACTION',
          onDelete: (fk as any).onDelete || 'NO ACTION'
        });
      }
    });

    // Process dropped FKs from deletion array
    deletedFkNames.forEach(fkName => {
      const orig = origFks.find((f, idx) => (f.name === fkName) || `fk_${tableName}_col_${f.column}_${idx}` === fkName);
      if (orig) {
        const origName = orig.name || fkName;
        droppedFKs.push({ name: origName, column: orig.column });
      }
    });

    return {
      payload: {
        added, dropped, renamed, modified,
        addedIndexes, droppedIndexes,
        addedFKs, droppedFKs,
        primaryKeys
      },
      warnings
    };
  };

  const handleSaveStructure = async () => {
    if (readOnly) {
      setErrorMsg('Đang ở chế độ Chỉ đọc: không thể thay đổi cấu trúc bảng.');
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const { payload, warnings } = buildPayload();

    if (warnings.length > 0) {
      setErrorMsg(warnings.join('\n'));
      setLoading(false);
      return;
    }

    if (
      payload.added.length === 0 && payload.dropped.length === 0 && payload.renamed.length === 0 && payload.modified.length === 0 &&
      payload.addedIndexes.length === 0 && payload.droppedIndexes.length === 0 &&
      payload.addedFKs.length === 0 && payload.droppedFKs.length === 0
    ) {
      setSuccessMsg('Không phát hiện thay đổi cấu trúc nào.');
      setLoading(false);
      return;
    }

    try {
      const res = await dbHelper.previewAlterTableSchema(tableName, payload);
      if (res.success && res.sqls) {
        setPreviewSqls(res.sqls);
      } else {
        throw new Error(res.error || 'Lỗi lấy bản xem trước SQL.');
      }
    } catch (err: any) {
      setErrorMsg(`Lỗi cập nhật cấu trúc: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteAlter = async () => {
    if (!previewSqls) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setPreviewSqls(null);

    const { payload } = buildPayload();

    try {
      const res = await dbHelper.alterTableSchema(tableName, payload);
      if (res.success) {
        setSuccessMsg(res.message || 'Thay đổi cấu trúc bảng thành công!');
        setTimeout(() => setSuccessMsg(null), 3000);
        onSchemaChanged();
      } else {
        throw new Error(res.error || 'Lỗi không xác định.');
      }
    } catch (err: any) {
      setErrorMsg(`Lỗi thực thi SQL: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleShowDefinition = async () => {
    setErrorMsg(null);
    const res = await dbHelper.getTableDefinition(tableName);
    if (res.success && res.sql) {
      setDefinitionSql(res.sql);
    } else {
      setErrorMsg(res.error || 'Không lấy được định nghĩa bảng.');
    }
  };

  // Dựng các dump script theo dialect (dùng trong modal Definition)
  const q = dbType === 'mysql' ? '`' : '"';
  const dropScript = `DROP TABLE ${q}${tableName}${q};`;
  const truncateScript = dbType === 'sqlite'
    ? `DELETE FROM ${q}${tableName}${q};`
    : `TRUNCATE TABLE ${q}${tableName}${q};`;

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setSuccessMsg(`Đã sao chép ${label}.`);
    setTimeout(() => setSuccessMsg(null), 2500);
  };

  const isOriginalColumn = (colName: string) => schema.columns.some(c => c.name === colName);
  const isOriginalIndex = (idxName: string) => (schema.indexes || []).some(i => i.name === idxName);
  const isOriginalFk = (fkName: string) => (schema.foreignKeys || []).some((f, idx) => (f.name || `fk_${tableName}_col_${f.column}_${idx}`) === fkName);

  return (
    <div className="structure-view-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header Toolbar */}
      <div className="sql-toolbar" style={{ borderBottom: '1px solid var(--win-border)', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Tên bảng:</span>
            <input
              type="text"
              key={tableName}
              defaultValue={tableName}
              onBlur={async (e) => {
                const newName = e.target.value.trim();
                if (!newName || newName === tableName) return;
                if (readOnly) {
                  setErrorMsg('Đang ở chế độ Chỉ đọc: không thể đổi tên bảng.');
                  e.target.value = tableName;
                  return;
                }
                if (confirm(`Bạn có chắc muốn đổi tên bảng "${tableName}" thành "${newName}"?`)) {
                  try {
                    const res = await dbHelper.renameTable(tableName, newName);
                    if (res.success) {
                      alert('Đổi tên bảng thành công!');
                      window.dispatchEvent(new CustomEvent('table-renamed', { detail: { oldName: tableName, newName } }));
                    } else {
                      alert('Lỗi đổi tên: ' + res.error);
                      e.target.value = tableName;
                    }
                  } catch (err: any) {
                    alert('Lỗi kết nối: ' + err.message);
                    e.target.value = tableName;
                  }
                } else {
                  e.target.value = tableName;
                }
              }}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid var(--win-border)',
                background: 'var(--win-bg-input)',
                color: 'var(--win-text-primary)',
                width: '140px',
                height: '24px',
                cursor: 'text'
              }}
            />
          </div>
          <div style={{ width: '1px', height: '16px', background: 'var(--win-border)' }} />

          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className="btn btn-secondary" 
              onClick={handleAddColumn}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <Plus size={12} />
              <span>Thêm cột</span>
            </button>
            <button 
              className="btn btn-secondary" 
              onClick={handleAddIndex}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <Plus size={12} />
              <span>Thêm chỉ mục</span>
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleAddFK}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <Plus size={12} />
              <span>Thêm khóa ngoại</span>
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleShowDefinition}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              title="Xem câu lệnh CREATE TABLE và các dump script (CREATE/DROP/TRUNCATE)"
            >
              <Code size={12} />
              <span>Definition</span>
            </button>
          </div>
        </div>

        {hasChanges() && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className="btn btn-secondary" 
              onClick={handleDiscard}
              disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <RotateCcw size={12} />
              <span>Hủy bỏ</span>
            </button>
            <button 
              className="btn btn-primary" 
              onClick={handleSaveStructure}
              disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}
            >
              <Save size={12} />
              <span>{loading ? 'Đang lưu...' : 'Lưu cấu trúc'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      {successMsg && (
        <div className="info-bar" style={{ background: 'rgba(16, 185, 129, 0.1)', borderLeftColor: 'var(--st-ok)', margin: '8px 16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} style={{ color: 'var(--st-ok)' }} />
            <span>{successMsg}</span>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="info-bar" style={{ background: 'rgba(239, 68, 68, 0.1)', borderLeftColor: 'var(--st-danger)', margin: '8px 16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} style={{ color: 'var(--st-danger)' }} />
            <span style={{ whiteSpace: 'pre-line' }}>{errorMsg}</span>
          </div>
        </div>
      )}

      {/* Grid Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* COLUMNS SECTION */}
        <div className="structure-section" style={{ margin: 0 }}>
          <h3>Cột Dữ Liệu</h3>
          <table className="structure-table">
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>#</th>
                <th>Tên Cột</th>
                <th>Kiểu Dữ Liệu</th>
                <th>Cho phép Rỗng</th>
                <th>Khóa Chính</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Tự tăng</th>
                <th>Giá trị mặc định</th>
                <th>Chú thích (Comment)</th>
                <th style={{ width: '60px', textAlign: 'center' }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((col, index) => {
                const isNew = !isOriginalColumn(col.name);
                const isEditing = editingColCell?.rowIndex === index;

                return (
                  <tr key={col.name + '_' + index} className={isNew ? 'structure-row-new' : ''}>
                    <td style={{ textAlign: 'center', color: 'var(--win-text-secondary)', fontWeight: 600 }}>{index + 1}</td>
                    
                    {/* Column Name */}
                    <td 
                      onDoubleClick={() => startEditCol(index, 'name', col.name)}
                      style={{ fontWeight: 600, color: 'var(--win-text-primary)', cursor: 'pointer' }}
                    >
                      {isEditing && editingColCell?.field === 'name' ? (
                        <input
                          type="text"
                          className="form-input"
                          value={editColValue}
                          onChange={e => setEditColValue(e.target.value)}
                          onBlur={() => saveEditCol(index, 'name')}
                          onKeyDown={e => e.key === 'Enter' && saveEditCol(index, 'name')}
                          autoFocus
                          style={{ width: '100%', padding: '2px 6px', fontSize: '12px' }}
                        />
                      ) : (
                        <span>{col.name}</span>
                      )}
                    </td>

                    {/* Data Type */}
                    <td 
                      onDoubleClick={() => startEditCol(index, 'type', col.type)}
                      style={{ fontFamily: 'var(--win-font-mono)', color: 'var(--win-accent)', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isEditing && editingColCell?.field === 'type' ? (
                        <select
                          className="form-input"
                          value={editColValue.toUpperCase()}
                          onChange={e => setEditColValue(e.target.value)}
                          onBlur={() => saveEditCol(index, 'type')}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          {dbTypes.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      ) : (
                        <span>{col.type.toUpperCase()}</span>
                      )}
                    </td>

                    {/* Nullable */}
                    <td 
                      onDoubleClick={() => startEditCol(index, 'nullable', col.nullable)}
                      style={{ cursor: 'pointer' }}
                    >
                      {isEditing && editingColCell?.field === 'nullable' ? (
                        <select
                          className="form-input"
                          value={editColValue}
                          onChange={e => setEditColValue(e.target.value)}
                          onBlur={() => saveEditCol(index, 'nullable')}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="true">NULLABLE (NULL)</option>
                          <option value="false">NOT NULL</option>
                        </select>
                      ) : (
                        col.nullable ? (
                          <span className="badge-nullable">NULLABLE</span>
                        ) : (
                          <span className="badge-not-nullable">NOT NULL</span>
                        )
                      )}
                    </td>

                    {/* Primary Key Status */}
                    <td 
                      onClick={() => handleTogglePrimaryKey(index)}
                      style={{ cursor: 'pointer', textAlign: 'center' }}
                      title="Click để bật/tắt Khóa Chính"
                    >
                      {col.isPrimaryKey ? (
                        <span className="badge-pk" style={{ userSelect: 'none', background: 'rgba(239, 68, 68, 0.12)', color: 'var(--st-danger)', borderColor: 'rgba(239, 68, 68, 0.25)' }}>PRIMARY KEY</span>
                      ) : (
                        <span style={{ color: 'var(--win-text-disabled)', userSelect: 'none' }}>-</span>
                      )}
                    </td>

                    {/* Auto Increment */}
                    <td 
                      onClick={() => handleToggleAutoIncrement(index)}
                      style={{ cursor: 'pointer', textAlign: 'center' }}
                      title="Click để bật/tắt Tự Tăng"
                    >
                      {col.autoIncrement ? (
                        <span className="badge-pk" style={{ userSelect: 'none', background: 'rgba(77, 139, 244, 0.12)', color: 'var(--win-accent)', borderColor: 'rgba(77, 139, 244, 0.25)' }}>AUTO_INCREMENT</span>
                      ) : (
                        <span style={{ color: 'var(--win-text-disabled)', userSelect: 'none' }}>-</span>
                      )}
                    </td>

                    {/* Default Value */}
                    <td 
                      onDoubleClick={() => startEditCol(index, 'defaultValue', col.defaultValue)}
                      style={{ color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-mono)', cursor: 'pointer' }}
                    >
                      {isEditing && editingColCell?.field === 'defaultValue' ? (
                        <select
                          className="form-input"
                          value={editColValue === null || editColValue === '' ? 'NULL' : editColValue}
                          onChange={e => {
                            const val = e.target.value;
                            if (val === 'NULL') {
                              setEditColValue('');
                              saveEditCol(index, 'defaultValue');
                            } else if (val === 'CUSTOM') {
                              // Nếu chọn CUSTOM, cho phép người dùng tự gõ qua prompt
                              const customVal = prompt('Nhập giá trị mặc định tùy chỉnh:', '');
                              if (customVal !== null) {
                                setEditColValue(customVal);
                                saveEditCol(index, 'defaultValue');
                              }
                            } else {
                              setEditColValue(val);
                              saveEditCol(index, 'defaultValue');
                            }
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="NULL">NULL (Mặc định trống)</option>
                          <option value="CURRENT_TIMESTAMP">CURRENT_TIMESTAMP (Thời gian thực)</option>
                          <option value="''">'' (Chuỗi rỗng)</option>
                          <option value="0">0 (Số không)</option>
                          <option value="false">FALSE (Boolean)</option>
                          <option value="true">TRUE (Boolean)</option>
                          <option value="CUSTOM">Tùy chỉnh khác...</option>
                        </select>
                      ) : (
                        col.defaultValue === null ? (
                          <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                        ) : (
                          <span>{String(col.defaultValue)}</span>
                        )
                      )}
                    </td>

                    {/* Comment */}
                    <td 
                      onDoubleClick={() => startEditCol(index, 'comment', col.comment)}
                      style={{ color: 'var(--win-text-secondary)', cursor: 'pointer' }}
                      title="Double click để nhập chú thích"
                    >
                      {isEditing && editingColCell?.field === 'comment' ? (
                        <input
                          type="text"
                          className="form-input"
                          value={editColValue}
                          onChange={e => setEditColValue(e.target.value)}
                          onBlur={() => saveEditCol(index, 'comment')}
                          onKeyDown={e => e.key === 'Enter' && saveEditCol(index, 'comment')}
                          autoFocus
                          placeholder="Nhập chú thích..."
                          style={{ width: '100%', padding: '2px 6px', fontSize: '12px' }}
                        />
                      ) : (
                        col.comment ? (
                          <span>{col.comment}</span>
                        ) : (
                          <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>-</span>
                        )
                      )}
                    </td>

                    {/* Delete Column Action */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => handleDeleteColumn(col.name, isNew)}
                        disabled={col.isPrimaryKey}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: col.isPrimaryKey ? 'var(--win-text-disabled)' : 'var(--st-danger)',
                          cursor: col.isPrimaryKey ? 'not-allowed' : 'pointer',
                          padding: '4px'
                        }}
                        title={col.isPrimaryKey ? "Không thể xóa Khóa Chính" : "Xóa cột"}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* INDEXES SECTION */}
        <div className="structure-section" style={{ margin: 0 }}>
          <h3>Chỉ Mục (Indexes)</h3>
          <table className="structure-table">
            <thead>
              <tr>
                <th>Tên Chỉ Mục</th>
                <th>Cột Áp Dụng</th>
                <th>Loại Chỉ Mục (Type)</th>
                <th style={{ width: '60px', textAlign: 'center' }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {idxs.map((idx, index) => {
                const isNew = !isOriginalIndex(idx.name);
                const isEditing = editingIdxCell?.rowIndex === index;
                // Add default type/method properties if missing
                const idxType = (idx as any).type || (idx.unique ? 'UNIQUE' : 'INDEX');

                return (
                  <tr key={idx.name + '_' + index} className={isNew ? 'structure-row-new' : ''}>
                    {/* Index Name */}
                    <td 
                      onDoubleClick={() => startEditIdx(index, 'name', idx.name)}
                      style={{ fontWeight: 600, color: 'var(--st-warn)', cursor: 'pointer' }}
                    >
                      {isEditing && editingIdxCell?.field === 'name' ? (
                        <input
                          type="text"
                          className="form-input"
                          value={editIdxValue}
                          onChange={e => setEditIdxValue(e.target.value)}
                          onBlur={() => saveEditIdx(index, 'name')}
                          onKeyDown={e => e.key === 'Enter' && saveEditIdx(index, 'name')}
                          autoFocus
                          style={{ width: '100%', padding: '2px 6px', fontSize: '12px' }}
                        />
                      ) : (
                        <span>{idx.name}</span>
                      )}
                    </td>

                    {/* Target Columns */}
                    <td 
                      onDoubleClick={() => startEditIdx(index, 'columns', idx.columns)}
                      style={{ fontFamily: 'var(--win-font-mono)', cursor: 'pointer' }}
                    >
                      {isEditing && editingIdxCell?.field === 'columns' ? (
                        <select
                          className="form-input"
                          value={editIdxValue}
                          onChange={e => setEditIdxValue(e.target.value)}
                          onBlur={() => saveEditIdx(index, 'columns')}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          {cols.map(c => (
                            <option key={c.name} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span>{idx.columns}</span>
                      )}
                    </td>

                    {/* Index Type */}
                    <td 
                      onDoubleClick={() => startEditIdx(index, 'unique', idxType)}
                      style={{ cursor: 'pointer' }}
                    >
                      {isEditing && editingIdxCell?.field === 'unique' ? (
                        <select
                          className="form-input"
                          value={editIdxValue}
                          onChange={e => {
                            setEditIdxValue(e.target.value);
                          }}
                          onBlur={() => {
                            // Update unique boolean state based on selection
                            const val = editIdxValue;
                            setIdxs(prev => prev.map((item, i) => {
                              if (i === index) {
                                return {
                                  ...item,
                                  unique: val === 'UNIQUE',
                                  type: val
                                } as any;
                              }
                              return item;
                            }));
                            setEditingIdxCell(null);
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="INDEX">INDEX (Thường)</option>
                          <option value="UNIQUE">UNIQUE (Duy nhất)</option>
                          {dbType === 'mysql' && <option value="FULLTEXT">FULLTEXT</option>}
                          {dbType === 'mysql' && <option value="SPATIAL">SPATIAL</option>}
                        </select>
                      ) : (
                        <span 
                          className="badge-pk" 
                          style={{ 
                            background: idxType === 'UNIQUE' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', 
                            color: idxType === 'UNIQUE' ? '#10b981' : 'var(--st-warn)', 
                            borderColor: idxType === 'UNIQUE' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(245, 158, 11, 0.25)' 
                          }}
                        >
                          {idxType}
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => handleDeleteIndex(idx.name, isNew)}
                        style={{ border: 'none', background: 'transparent', color: 'var(--st-danger)', cursor: 'pointer', padding: '4px' }}
                        title="Xóa chỉ mục"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {idxs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--win-text-secondary)', padding: '12px' }}>
                    Không có chỉ mục nào được thiết lập.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* FOREIGN KEYS SECTION */}
        <div className="structure-section" style={{ margin: 0 }}>
          <h3>Khóa Ngoại (Foreign Keys)</h3>
          <table className="structure-table">
            <thead>
              <tr>
                <th>Tên Khóa Ngoại</th>
                <th>Cột Nguồn</th>
                <th>Bảng Tham Chiếu</th>
                <th>Cột Tham Chiếu</th>
                <th>On Update</th>
                <th>On Delete</th>
                <th style={{ width: '60px', textAlign: 'center' }}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {fks.map((fk, index) => {
                const isNew = !isOriginalFk(fk.name);
                const isEditing = editingFkCell?.rowIndex === index;
                // Default actions if missing
                const onUpdateAct = (fk as any).onUpdate || 'NO ACTION';
                const onDeleteAct = (fk as any).onDelete || 'NO ACTION';

                return (
                  <tr key={fk.name + '_' + index} className={isNew ? 'structure-row-new' : ''}>
                    {/* FK Name */}
                    <td style={{ fontWeight: 600, color: 'var(--win-text-secondary)' }}>{fk.name}</td>

                    {/* Local Source Column */}
                    <td 
                      onDoubleClick={() => startEditFk(index, 'column', fk.column)}
                      style={{ fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isEditing && editingFkCell?.field === 'column' ? (
                        <select
                          className="form-input"
                          value={editFkValue}
                          onChange={e => setEditFkValue(e.target.value)}
                          onBlur={() => saveEditFk(index, 'column')}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          {cols.map(c => (
                            <option key={c.name} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span>{fk.column}</span>
                      )}
                    </td>

                    {/* Referenced Table */}
                    <td 
                      onDoubleClick={() => startEditFk(index, 'refTable', fk.refTable)}
                      style={{ color: 'var(--win-accent)', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {isEditing && editingFkCell?.field === 'refTable' ? (
                        <select
                          className="form-input"
                          value={editFkValue}
                          onChange={e => {
                            setEditFkValue(e.target.value);
                            saveEditFk(index, 'refTable', e.target.value);
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="">-- Chọn bảng --</option>
                          {allTables.map(tblName => (
                            <option key={tblName} value={tblName}>{tblName}</option>
                          ))}
                        </select>
                      ) : (
                        <span>{fk.refTable || <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>Chưa nhập</span>}</span>
                      )}
                    </td>

                    {/* Referenced Column */}
                    <td 
                      onDoubleClick={() => startEditFk(index, 'refColumn', fk.refColumn)}
                      style={{ fontFamily: 'var(--win-font-mono)', cursor: 'pointer' }}
                    >
                      {isEditing && editingFkCell?.field === 'refColumn' ? (
                        <select
                          className="form-input"
                          value={editFkValue}
                          onChange={e => {
                            setEditFkValue(e.target.value);
                            saveEditFk(index, 'refColumn', e.target.value);
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          {/* Cho biết đang nạp, thay vì dropdown trống trơn khiến
                              người dùng tưởng bảng không có cột nào. */}
                          <option value="">{loadingRefCols ? 'Đang nạp danh sách cột...' : '-- Chọn cột --'}</option>
                          {refColumns.map(colName => (
                            <option key={colName} value={colName}>{colName}</option>
                          ))}
                        </select>
                      ) : (
                        <span>{fk.refColumn || <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>Chưa nhập</span>}</span>
                      )}
                    </td>

                    {/* On Update Action */}
                    <td 
                      onDoubleClick={() => startEditFk(index, 'onUpdate' as any, onUpdateAct)}
                      style={{ cursor: 'pointer', fontSize: '11px' }}
                    >
                      {isEditing && editingFkCell?.field === ('onUpdate' as any) ? (
                        <select
                          className="form-input"
                          value={editFkValue}
                          onChange={e => setEditFkValue(e.target.value)}
                          onBlur={() => {
                            const val = editFkValue;
                            setFks(prev => prev.map((item, i) => {
                              if (i === index) {
                                return { ...item, onUpdate: val } as any;
                              }
                              return item;
                            }));
                            setEditingFkCell(null);
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="NO ACTION">NO ACTION</option>
                          <option value="RESTRICT">RESTRICT</option>
                          <option value="CASCADE">CASCADE</option>
                          <option value="SET NULL">SET NULL</option>
                          <option value="SET DEFAULT">SET DEFAULT</option>
                        </select>
                      ) : (
                        <span style={{ color: onUpdateAct === 'CASCADE' ? '#10b981' : 'var(--win-text-secondary)' }}>{onUpdateAct}</span>
                      )}
                    </td>

                    {/* On Delete Action */}
                    <td 
                      onDoubleClick={() => startEditFk(index, 'onDelete' as any, onDeleteAct)}
                      style={{ cursor: 'pointer', fontSize: '11px' }}
                    >
                      {isEditing && editingFkCell?.field === ('onDelete' as any) ? (
                        <select
                          className="form-input"
                          value={editFkValue}
                          onChange={e => setEditFkValue(e.target.value)}
                          onBlur={() => {
                            const val = editFkValue;
                            setFks(prev => prev.map((item, i) => {
                              if (i === index) {
                                return { ...item, onDelete: val } as any;
                              }
                              return item;
                            }));
                            setEditingFkCell(null);
                          }}
                          autoFocus
                          style={{ width: '100%', padding: '2px', fontSize: '12px', height: '24px' }}
                        >
                          <option value="NO ACTION">NO ACTION</option>
                          <option value="RESTRICT">RESTRICT</option>
                          <option value="CASCADE">CASCADE</option>
                          <option value="SET NULL">SET NULL</option>
                          <option value="SET DEFAULT">SET DEFAULT</option>
                        </select>
                      ) : (
                        <span style={{ color: onDeleteAct === 'CASCADE' ? '#ef4444' : 'var(--win-text-secondary)' }}>{onDeleteAct}</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => handleDeleteFK(fk.name, isNew)}
                        style={{ border: 'none', background: 'transparent', color: 'var(--st-danger)', cursor: 'pointer', padding: '4px' }}
                        title="Xóa khóa ngoại"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {fks.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--win-text-secondary)', padding: '12px' }}>
                    Không có khóa ngoại nào được thiết lập.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>

      {/* SQL Preview Modal */}
      {previewSqls && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border)',
            borderRadius: '8px',
            width: '600px',
            maxWidth: '90%',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            overflow: 'hidden'
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--win-border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Xem trước câu lệnh SQL trước khi thực thi</span>
            </div>
            <div style={{ padding: '16px', flex: 1, overflowY: 'auto', background: 'var(--win-bg-window)', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
              {previewSqls.length === 0 ? (
                <div style={{ color: 'var(--win-text-disabled)' }}>Không phát hiện thay đổi SQL nào.</div>
              ) : (
                previewSqls.map((sql, idx) => (
                  <pre key={idx} style={{ margin: '0 0 12px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingBottom: '8px', borderBottom: idx < previewSqls.length - 1 ? '1px dashed var(--win-border)' : 'none' }}>
                    {sql}
                  </pre>
                ))
              )}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'var(--win-bg-card)' }}>
              <button className="btn btn-secondary" onClick={() => setPreviewSqls(null)} disabled={loading}>Hủy</button>
              <button className="btn btn-primary" onClick={handleExecuteAlter} disabled={loading || previewSqls.length === 0} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>
                {loading ? 'Đang thực thi...' : 'Xác nhận thực thi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Definition Modal — CREATE TABLE + dump scripts */}
      {definitionSql !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999 }}
          onClick={() => setDefinitionSql(null)}
        >
          <div
            style={{ background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '8px', width: '680px', maxWidth: '92%', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--win-border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Định nghĩa bảng — <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{tableName}</span></span>
              <button onClick={() => setDefinitionSql(null)} style={{ background: 'none', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}>✕</button>
            </div>
            <div style={{ padding: '16px', flex: 1, overflowY: 'auto', background: 'var(--win-bg-window)' }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--win-font-mono)', fontSize: '12px', color: 'var(--win-text-primary)' }}>
                {definitionSql}
              </pre>
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--win-border)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: 'var(--win-bg-card)', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => copyText(definitionSql, 'CREATE TABLE')}>Copy CREATE</button>
              <button className="btn btn-secondary" onClick={() => copyText(dropScript, 'DROP TABLE')}>Copy DROP</button>
              <button className="btn btn-secondary" onClick={() => copyText(truncateScript, 'TRUNCATE')}>Copy TRUNCATE</button>
              <button className="btn btn-primary" onClick={() => setDefinitionSql(null)} style={{ background: 'var(--st-ok)', borderColor: 'var(--st-ok)' }}>Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
