import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { dbHelper } from '../utils/dbHelper';
import type { SequenceInfo } from '../utils/dbHelper';
import { RefreshCw, Trash2, Edit3, AlertTriangle, CheckCircle } from 'lucide-react';

interface SequenceManagerModalProps {
  onClose: () => void;
}

export const SequenceManagerModal: React.FC<SequenceManagerModalProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const [sequences, setSequences] = useState<SequenceInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [restartTarget, setRestartTarget] = useState<{ name: string; val: string } | null>(null);
  /** Sequence awaiting drop confirmation — see handleDrop. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const fetchSequences = async () => {
    setLoading(true);
    setErrorMsg(null);
    const list = await dbHelper.getSequences();
    setSequences(list);
    setLoading(false);
  };

  useEffect(() => {
    fetchSequences();
  }, []);

  const handleRestart = async () => {
    if (!restartTarget || !restartTarget.val.trim()) return;
    const sql = `ALTER SEQUENCE "${restartTarget.name}" RESTART WITH ${restartTarget.val.trim()};`;
    const res = await dbHelper.alterSequence(sql);
    if (res.success) {
      setSuccessMsg(`Đã cập nhật Sequence ${restartTarget.name} thành công`);
      setRestartTarget(null);
      fetchSequences();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi cập nhật sequence');
    }
  };

  // window.confirm() shows nothing inside the Tauri webview (the dialog plugin ships no
  // `confirm` command), so the trash button only arms the dialog below.
  const handleDrop = (name: string) => setDropTarget(name);

  const doDrop = async (name: string) => {
    const res = await dbHelper.dropSequence(name);
    if (res.success) {
      setSuccessMsg(`Đã xóa Sequence ${name}`);
      fetchSequences();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi xóa sequence');
    }
  };

  return (
    <>
    <Modal
      title="Quản lý Chuỗi Tự tăng (Sequences)"
      onClose={onClose}
      width="760px"
      maxWidth="94%"
      maxHeight="86vh"
      zIndex={999999}
    >
      <ModalBody style={{ gap: '12px', padding: '16px' }}>
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--win-text-secondary)' }}>Danh sách các Sequence trong Database:</span>
          <button className="btn btn-secondary" onClick={fetchSequences} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px' }}>
            <RefreshCw size={12} />
            <span>Làm mới</span>
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--win-text-secondary)', fontSize: '12px' }}>Đang tải danh sách Sequence...</div>
        ) : sequences.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>Không có Sequence nào trong Database hiện tại.</div>
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
                  <th style={{ padding: '8px 10px', textAlign: 'center', width: '110px' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((s) => (
                  <tr key={s.name} style={{ borderBottom: '1px solid var(--win-border)' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{s.name}</td>
                    <td style={{ padding: '8px 10px' }}>{s.dataType}</td>
                    <td style={{ padding: '8px 10px' }}>{s.startValue}</td>
                    <td style={{ padding: '8px 10px' }}>+{s.incrementBy}</td>
                    <td style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>{s.minVal} .. {s.maxVal || '∞'}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
                        <button
                          className="cm-icon-btn sm"
                          title="Đặt lại giá trị (RESTART WITH)"
                          onClick={() => setRestartTarget({ name: s.name, val: s.startValue })}
                        >
                          <Edit3 size={13} />
                        </button>
                        <button
                          className="cm-icon-btn sm danger"
                          title="Xóa Sequence"
                          onClick={() => handleDrop(s.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {restartTarget && (
          <div style={{ padding: '12px', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              Đặt lại giá trị bắt đầu cho sequence: <strong style={{ color: 'var(--win-accent)' }}>{restartTarget.name}</strong>
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="number"
                value={restartTarget.val}
                onChange={(e) => setRestartTarget({ ...restartTarget, val: e.target.value })}
                placeholder="Giá trị khởi tạo mới (RESTART WITH)"
                style={{ flex: 1, padding: '6px 10px', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'var(--win-bg-input)', color: 'var(--win-text-primary)', outline: 'none' }}
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

    {/* zIndex above this modal's own 999999, otherwise the confirmation renders behind it. */}
    {dropTarget && (
      <ConfirmDialog
        open
        danger
        zIndex={1000000}
        title={t('sidebar.confirmDropSequenceTitle')}
        message={t('sidebar.confirmDropSequenceMessage', { name: dropTarget })}
        onConfirm={() => { const name = dropTarget; setDropTarget(null); doDrop(name); }}
        onCancel={() => setDropTarget(null)}
      />
    )}
    </>
  );
};
