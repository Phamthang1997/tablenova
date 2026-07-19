import React, { useState } from 'react';
import { dbHelper } from '../utils/dbHelper';
import { Plus, Trash2, X } from 'lucide-react';

interface ColumnInfo {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  autoIncrement: boolean;
  nullable: boolean;
  defaultValue?: string;
  comment?: string;
}

interface IndexInfo {
  name: string;
  columns: string;
  unique: boolean;
}

interface FkInfo {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
}

interface CreateTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  dbType: 'sqlite' | 'postgres' | 'mysql';
  onTableCreated: (tableName: string) => void;
}

export const CreateTableModal: React.FC<CreateTableModalProps> = ({
  isOpen,
  onClose,
  dbType,
  onTableCreated,
}) => {
  const [tableName, setTableName] = useState('');
  const [activeTab, setActiveTab] = useState<'columns' | 'indexes' | 'foreignKeys'>('columns');

  // Columns state - default to first id column
  const [cols, setCols] = useState<ColumnInfo[]>([
    { name: 'id', type: dbType === 'postgres' ? 'INTEGER' : 'INTEGER', isPrimaryKey: true, autoIncrement: true, nullable: false }
  ]);

  // Indexes state
  const [idxs, setIdxs] = useState<IndexInfo[]>([]);

  // FKs state
  const [fks, setFks] = useState<FkInfo[]>([]);

  if (!isOpen) return null;

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

  const handleAddColumn = () => {
    setCols([
      ...cols,
      { name: `col_${cols.length + 1}`, type: dbTypes[0], isPrimaryKey: false, autoIncrement: false, nullable: true }
    ]);
  };

  const handleRemoveColumn = (index: number) => {
    setCols(cols.filter((_, idx) => idx !== index));
  };

  const handleColChange = (index: number, field: keyof ColumnInfo, value: any) => {
    setCols(cols.map((col, idx) => {
      if (idx === index) {
        return { ...col, [field]: value };
      }
      return col;
    }));
  };

  const handleAddIndex = () => {
    setIdxs([
      ...idxs,
      { name: `idx_${tableName || 'table'}_col_${idxs.length + 1}`, columns: '', unique: false }
    ]);
  };

  const handleRemoveIndex = (index: number) => {
    setIdxs(idxs.filter((_, idx) => idx !== index));
  };

  const handleIdxChange = (index: number, field: keyof IndexInfo, value: any) => {
    setIdxs(idxs.map((idxInfo, idx) => {
      if (idx === index) {
        return { ...idxInfo, [field]: value };
      }
      return idxInfo;
    }));
  };

  const handleAddFk = () => {
    setFks([
      ...fks,
      { name: `fk_${tableName || 'table'}_col_${fks.length + 1}`, column: '', refTable: '', refColumn: '' }
    ]);
  };

  const handleRemoveFk = (index: number) => {
    setFks(fks.filter((_, idx) => idx !== index));
  };

  const handleFkChange = (index: number, field: keyof FkInfo, value: any) => {
    setFks(fks.map((fk, idx) => {
      if (idx === index) {
        return { ...fk, [field]: value };
      }
      return fk;
    }));
  };

  const handleSubmit = async () => {
    const name = tableName.trim();
    if (!name) {
      alert('Vui lòng nhập tên bảng.');
      return;
    }
    if (cols.length === 0) {
      alert('Vui lòng tạo ít nhất 1 cột.');
      return;
    }

    try {
      // Chỉ gửi các index/khóa ngoại đã nhập đủ thông tin để tránh sinh SQL lỗi
      const validIdxs = idxs.filter(i => i.name.trim() && i.columns.trim());
      const validFks = fks.filter(f => f.column.trim() && f.refTable.trim() && f.refColumn.trim());
      const res = await dbHelper.createTable(name, cols, validIdxs, validFks);
      if (res.success) {
        alert('Tạo bảng mới thành công!');
        onTableCreated(name);
        onClose();
      } else {
        alert('Lỗi tạo bảng: ' + res.error);
      }
    } catch (e: any) {
      alert('Lỗi kết nối: ' + e.message);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 999999
    }}>
      <div style={{
        background: 'var(--win-bg-card)',
        border: '1px solid var(--win-border)',
        borderRadius: '6px',
        width: '740px',
        maxHeight: '90vh',
        boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--win-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--win-bg-tab-bar)'
        }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Tạo Bảng Mới</span>
          <button 
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer' }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Content Area */}
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto', flex: 1 }}>
          {/* Table Name Input */}
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Tên bảng:</label>
            <input
              type="text"
              className="form-input"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="nhap_ten_bang"
              autoFocus
              style={{
                fontSize: '11px',
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--win-border)',
                background: 'var(--win-bg-input)',
                color: 'var(--win-text-primary)',
                outline: 'none',
                cursor: 'text'
              }}
            />
          </div>

          {/* Tabs header */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', gap: '4px' }}>
            <button
              onClick={() => setActiveTab('columns')}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                background: activeTab === 'columns' ? 'var(--win-bg-hover)' : 'transparent',
                border: 'none',
                borderBottom: activeTab === 'columns' ? '2px solid var(--win-accent)' : 'none',
                color: activeTab === 'columns' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              Cột dữ liệu ({cols.length})
            </button>
            <button
              onClick={() => setActiveTab('indexes')}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                background: activeTab === 'indexes' ? 'var(--win-bg-hover)' : 'transparent',
                border: 'none',
                borderBottom: activeTab === 'indexes' ? '2px solid var(--win-accent)' : 'none',
                color: activeTab === 'indexes' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              Chỉ mục ({idxs.length})
            </button>
            <button
              onClick={() => setActiveTab('foreignKeys')}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                background: activeTab === 'foreignKeys' ? 'var(--win-bg-hover)' : 'transparent',
                border: 'none',
                borderBottom: activeTab === 'foreignKeys' ? '2px solid var(--win-accent)' : 'none',
                color: activeTab === 'foreignKeys' ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              Khóa ngoại ({fks.length})
            </button>
          </div>

          {/* Active Tab Panel */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {activeTab === 'columns' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddColumn}
                    style={{ height: '24px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>Thêm cột</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Tên cột</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Kiểu dữ liệu</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Cho phép Rỗng</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Khóa chính</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Tự tăng</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Mặc định</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Chú thích</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Xóa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cols.map((col, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.name} 
                            onChange={(e) => handleColChange(idx, 'name', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <select 
                            value={col.type} 
                            onChange={(e) => handleColChange(idx, 'type', e.target.value)}
                            style={{ fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px', borderRadius: '3px', cursor: 'pointer' }}
                          >
                            {dbTypes.map(t => <option key={t} value={t} style={{ background: 'var(--win-bg-card)', color: 'var(--win-text-primary)' }}>{t}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.nullable} 
                            onChange={(e) => handleColChange(idx, 'nullable', e.target.checked)}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.isPrimaryKey} 
                            onChange={(e) => {
                              handleColChange(idx, 'isPrimaryKey', e.target.checked);
                              if (e.target.checked) {
                                handleColChange(idx, 'nullable', false);
                              }
                            }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={col.autoIncrement} 
                            onChange={(e) => handleColChange(idx, 'autoIncrement', e.target.checked)}
                            disabled={col.type !== 'INTEGER' && col.type !== 'INT' && col.type !== 'BIGINT'}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.defaultValue || ''} 
                            placeholder="NULL"
                            onChange={(e) => handleColChange(idx, 'defaultValue', e.target.value)}
                            style={{ width: '80px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={col.comment || ''} 
                            onChange={(e) => handleColChange(idx, 'comment', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveColumn(idx)}
                            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'indexes' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddIndex}
                    style={{ height: '24px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>Thêm chỉ mục</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Tên Chỉ mục</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Cột Áp Dụng (cách nhau bởi dấu phẩy)</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Duy Nhất (Unique)</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Xóa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {idxs.map((idxInfo, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={idxInfo.name} 
                            onChange={(e) => handleIdxChange(idx, 'name', e.target.value)}
                            style={{ width: '200px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={idxInfo.columns} 
                            placeholder="vd: name, age"
                            onChange={(e) => handleIdxChange(idx, 'columns', e.target.value)}
                            style={{ width: '250px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            checked={idxInfo.unique} 
                            onChange={(e) => handleIdxChange(idx, 'unique', e.target.checked)}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveIndex(idx)}
                            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'foreignKeys' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleAddFk}
                    style={{ height: '24px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}
                  >
                    <Plus size={10} />
                    <span>Thêm khóa ngoại</span>
                  </button>
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Tên Khóa Ngoại</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Cột Nguồn</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Bảng Tham Chiếu</th>
                      <th style={{ padding: '6px', textAlign: 'left', fontWeight: 600 }}>Cột Tham Chiếu</th>
                      <th style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>Xóa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fks.map((fk, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.name} 
                            onChange={(e) => handleFkChange(idx, 'name', e.target.value)}
                            style={{ width: '150px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.column} 
                            placeholder="cột nguồn"
                            onChange={(e) => handleFkChange(idx, 'column', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.refTable} 
                            placeholder="bảng đích"
                            onChange={(e) => handleFkChange(idx, 'refTable', e.target.value)}
                            style={{ width: '120px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px' }}>
                          <input 
                            type="text" 
                            value={fk.refColumn} 
                            placeholder="cột đích"
                            onChange={(e) => handleFkChange(idx, 'refColumn', e.target.value)}
                            style={{ width: '100px', fontSize: '11px', background: 'var(--win-bg-input)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', padding: '2px 4px', borderRadius: '3px', cursor: 'text' }}
                          />
                        </td>
                        <td style={{ padding: '4px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleRemoveFk(idx)}
                            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--win-border)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          background: 'var(--win-bg-card)'
        }}>
          <button 
            className="btn btn-secondary" 
            onClick={onClose}
            style={{ height: '28px', fontSize: '11px', padding: '0 16px', borderRadius: '4px' }}
          >
            Hủy bỏ
          </button>
          <button 
            className="btn btn-primary" 
            onClick={handleSubmit}
            style={{ height: '28px', fontSize: '11px', padding: '0 16px', borderRadius: '4px', background: 'var(--win-accent)', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            Tạo bảng
          </button>
        </div>
      </div>
    </div>
  );
};
