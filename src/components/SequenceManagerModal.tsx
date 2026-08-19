import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { dbHelper } from '../utils/dbHelper';
import type { SequenceInfo } from '../utils/dbHelper';
import { RefreshCw, Trash2, Edit3, AlertTriangle, CheckCircle, Plus, Search, Layers } from 'lucide-react';

interface SequenceManagerModalProps {
  connId: string;
  dbType?: string;
  onClose: () => void;
}

export const SequenceManagerModal: React.FC<SequenceManagerModalProps> = ({ connId, dbType = 'postgres', onClose }) => {
  const { t } = useTranslation();
  const [sequences, setSequences] = useState<SequenceInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');
  
  // State for restarting / modifying a sequence
  const [restartTarget, setRestartTarget] = useState<{ name: string; val: string } | null>(null);
  
  // State for creating a new sequence
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newSeq, setNewSeq] = useState<{
    name: string;
    dataType: string;
    startValue: string;
    incrementBy: string;
    minVal: string;
    maxVal: string;
    cycle: boolean;
  }>({
    name: '',
    dataType: 'bigint',
    startValue: '1',
    incrementBy: '1',
    minVal: '1',
    maxVal: '',
    cycle: false,
  });

  // State for dropping sequence
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const fetchSequences = useCallback(async () => {
    if (!connId) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await dbHelper.getSequences(connId);
      setSequences(list);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Không thể nạp danh sách Sequences');
    } finally {
      setLoading(false);
    }
  }, [connId]);

  useEffect(() => {
    fetchSequences();
  }, [fetchSequences]);

  const handleRestart = async () => {
    if (!restartTarget || !restartTarget.val.trim()) return;
    const name = restartTarget.name;
    const val = restartTarget.val.trim();
    const sql = dbType === 'mysql'
      ? `ALTER SEQUENCE \`${name}\` RESTART WITH ${val};`
      : `ALTER SEQUENCE "${name}" RESTART WITH ${val};`;

    const res = await dbHelper.alterSequence(connId, sql);
    if (res.success) {
      setSuccessMsg(`Đã cập nhật Sequence ${name} thành công`);
      setRestartTarget(null);
      fetchSequences();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi cập nhật sequence');
    }
  };

  const handleCreateSequence = async () => {
    if (!newSeq.name.trim()) return;
    const name = newSeq.name.trim();
    let sql = '';
    
    if (dbType === 'mysql') {
      sql = `CREATE SEQUENCE \`${name}\` START WITH ${newSeq.startValue || '1'} INCREMENT BY ${newSeq.incrementBy || '1'}`;
      if (newSeq.minVal) sql += ` MINVALUE ${newSeq.minVal}`;
      if (newSeq.maxVal) sql += ` MAXVALUE ${newSeq.maxVal}`;
      sql += newSeq.cycle ? ' CYCLE;' : ' NOCYCLE;';
    } else {
      sql = `CREATE SEQUENCE "${name}" AS ${newSeq.dataType || 'bigint'} START WITH ${newSeq.startValue || '1'} INCREMENT BY ${newSeq.incrementBy || '1'}`;
      if (newSeq.minVal) sql += ` MINVALUE ${newSeq.minVal}`;
      if (newSeq.maxVal) sql += ` MAXVALUE ${newSeq.maxVal}`;
      sql += newSeq.cycle ? ' CYCLE;' : ' NO CYCLE;';
    }

    const res = await dbHelper.executeQuery(connId, sql);
    if (res.success) {
      setSuccessMsg(`Đã tạo Sequence ${name} thành công`);
      setShowCreateModal(false);
      setNewSeq({
        name: '',
        dataType: 'bigint',
        startValue: '1',
        incrementBy: '1',
        minVal: '1',
        maxVal: '',
        cycle: false,
      });
      fetchSequences();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi tạo Sequence');
    }
  };

  const handleDrop = (name: string) => setDropTarget(name);

  const doDrop = async (name: string) => {
    const res = await dbHelper.dropSequence(connId, name);
    if (res.success) {
      setSuccessMsg(`Đã xóa Sequence ${name}`);
      fetchSequences();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi xóa sequence');
    }
  };

  const filteredSequences = sequences.filter(s =>
    !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <>
      <Modal
        title="Quản lý Chuỗi Tự tăng (Sequences)"
        onClose={onClose}
        width="800px"
        maxWidth="94%"
        maxHeight="88vh"
        zIndex={999999}
      >
        <ModalBody style={{ gap: '14px', padding: '16px 20px' }}>
          {errorMsg && (
            <div className="rt-banner-error">
              <AlertTriangle size={14} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="rt-banner-success">
              <CheckCircle size={14} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Controls toolbar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: '280px' }}>
              <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-disabled)' }} />
              <input
                type="text"
                placeholder="Lọc sequence theo tên..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ width: '100%', padding: '6px 10px 6px 28px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={fetchSequences}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', height: '30px' }}
              >
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                <span>Làm mới</span>
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowCreateModal(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', height: '30px', background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                <Plus size={13} />
                <span>Thêm Sequence</span>
              </button>
            </div>
          </div>

          {/* Main List */}
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--win-text-secondary)', fontSize: '12px' }}>
              Đang tải danh sách Sequences...
            </div>
          ) : filteredSequences.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
              <Layers size={28} style={{ opacity: 0.4 }} />
              <span>{sequences.length === 0 ? 'Chưa có Sequence nào trong Database hiện tại.' : 'Không tìm thấy Sequence nào phù hợp.'}</span>
            </div>
          ) : (
            <div style={{ maxHeight: '360px', overflow: 'auto', border: '1px solid var(--win-border)', borderRadius: '6px' }}>
              <table className="structure-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '8px 10px', textAlign: 'left' }}>Tên Sequence</th>
                    <th style={{ padding: '8px 10px', textAlign: 'left' }}>Kiểu dữ liệu</th>
                    <th style={{ padding: '8px 10px', textAlign: 'left' }}>Bắt đầu</th>
                    <th style={{ padding: '8px 10px', textAlign: 'left' }}>Bước tăng</th>
                    <th style={{ padding: '8px 10px', textAlign: 'left' }}>Min / Max</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center' }}>Quay vòng</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center', width: '90px' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSequences.map((s) => (
                    <tr key={s.name} style={{ borderBottom: '1px solid var(--win-border)' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{s.name}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--win-font-mono)', fontSize: '11px' }}>{s.dataType}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--win-font-mono)' }}>{s.startValue}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--win-font-mono)' }}>+{s.incrementBy}</td>
                      <td style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--win-text-secondary)', fontFamily: 'var(--win-font-mono)' }}>{s.minVal} .. {s.maxVal || '∞'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        <span className={`st-badge ${s.cycle ? 'st-badge-enforced' : ''}`} style={{ fontSize: '10px' }}>
                          {s.cycle ? 'CYCLE' : 'NO'}
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <button
                            className="st-row-edit"
                            title="Đặt lại giá trị (RESTART WITH)"
                            onClick={() => setRestartTarget({ name: s.name, val: s.startValue })}
                          >
                            <Edit3 size={13} />
                          </button>
                          <button
                            className="st-row-del"
                            title="Xóa Sequence"
                            onClick={() => handleDrop(s.name)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Inline restart panel */}
          {restartTarget && (
            <div style={{ padding: '12px', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                Đặt lại giá trị bắt đầu cho sequence: <strong style={{ color: 'var(--win-accent)' }}>{restartTarget.name}</strong>
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="number"
                  value={restartTarget.val}
                  onChange={(e) => setRestartTarget({ ...restartTarget, val: e.target.value })}
                  placeholder="Giá trị khởi tạo mới (RESTART WITH)"
                  style={{ flex: 1, padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                />
                <button className="btn btn-secondary" onClick={() => setRestartTarget(null)}>Hủy</button>
                <button className="btn btn-primary" onClick={handleRestart} style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}>Xác nhận</button>
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          <button className="btn btn-secondary" onClick={onClose}>Đóng</button>
        </ModalFooter>
      </Modal>

      {/* Sub-modal: Tạo Sequence Mới */}
      {showCreateModal && (
        <Modal
          title="Tạo Sequence Mới"
          onClose={() => setShowCreateModal(false)}
          width="500px"
          zIndex={1000000}
        >
          <ModalBody style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Tên Sequence:</label>
              <input
                type="text"
                placeholder="vd: seq_orders_id"
                value={newSeq.name}
                onChange={e => setNewSeq({ ...newSeq, name: e.target.value })}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            {dbType !== 'mysql' && (
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Kiểu dữ liệu:</label>
                <select
                  value={newSeq.dataType}
                  onChange={e => setNewSeq({ ...newSeq, dataType: e.target.value })}
                  style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                >
                  <option value="bigint">bigint (Mặc định)</option>
                  <option value="integer">integer</option>
                  <option value="smallint">smallint</option>
                </select>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Bắt đầu từ (Start):</label>
              <input
                type="number"
                value={newSeq.startValue}
                onChange={e => setNewSeq({ ...newSeq, startValue: e.target.value })}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Bước tăng (Increment):</label>
              <input
                type="number"
                value={newSeq.incrementBy}
                onChange={e => setNewSeq({ ...newSeq, incrementBy: e.target.value })}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)', textAlign: 'right' }}>Min / Max:</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="number"
                  placeholder="Min (vd: 1)"
                  value={newSeq.minVal}
                  onChange={e => setNewSeq({ ...newSeq, minVal: e.target.value })}
                  style={{ flex: 1, padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                />
                <span style={{ color: 'var(--win-text-secondary)' }}>-</span>
                <input
                  type="number"
                  placeholder="Max (tùy chọn)"
                  value={newSeq.maxVal}
                  onChange={e => setNewSeq({ ...newSeq, maxVal: e.target.value })}
                  style={{ flex: 1, padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)' }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: '10px' }}>
              <span />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', color: 'var(--win-text-primary)' }}>
                <input
                  type="checkbox"
                  checked={newSeq.cycle}
                  onChange={e => setNewSeq({ ...newSeq, cycle: e.target.checked })}
                />
                <span>Quay vòng khi chạm giới hạn (CYCLE)</span>
              </label>
            </div>
          </ModalBody>
          <ModalFooter>
            <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>Hủy</button>
            <button
              className="btn btn-primary"
              disabled={!newSeq.name.trim()}
              onClick={handleCreateSequence}
              style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
            >
              Tạo Sequence
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* Confirmation for dropping sequence */}
      {dropTarget && (
        <ConfirmDialog
          open
          danger
          zIndex={1000001}
          title={t('sidebar.confirmDropSequenceTitle') || 'Xóa Sequence'}
          message={t('sidebar.confirmDropSequenceMessage', { name: dropTarget }) || `Bạn có chắc chắn muốn xóa sequence "${dropTarget}" không?`}
          onConfirm={() => { const name = dropTarget; setDropTarget(null); doDrop(name); }}
          onCancel={() => setDropTarget(null)}
        />
      )}
    </>
  );
};
