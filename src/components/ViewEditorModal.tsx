import React, { useState } from 'react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import { Save, Copy, CheckCircle, AlertTriangle, Eye } from 'lucide-react';

interface ViewEditorModalProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, not read id ambient (§4.1). */
  connId: string;
  name: string;
  initialSql: string;
  onClose?: () => void;
  onSaved?: () => void;
  embedded?: boolean;
}

export const ViewEditorModal: React.FC<ViewEditorModalProps> = ({
  connId,
  name,
  initialSql,
  onClose,
  onSaved,
  embedded = false,
}) => {
  const [sql, setSql] = useState<string>(initialSql);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ columns: string[]; rows: any[] } | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const res = await dbHelper.saveViewDefinition(sql);
    setSaving(false);
    if (res.success) {
      setSuccessMsg(res.error || 'Đã lưu View thành công');
      onSaved?.();
      setTimeout(() => setSuccessMsg(null), 3000);
    } else {
      setErrorMsg(res.error || 'Lỗi khi lưu View');
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    const res = await dbHelper.executeQuery(connId, `SELECT * FROM ${name} LIMIT 15;`);
    setPreviewing(false);
    if (res.success && res.data) {
      setPreviewData({ columns: res.columns || [], rows: res.data });
    } else {
      setErrorMsg(res.error || 'Không thể xem trước dữ liệu của View');
    }
  };

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0 }}>
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

      <div className="rt-code-block">
        <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Mã nguồn DDL View (CREATE OR REPLACE VIEW):</label>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          spellCheck={false}
          className="rt-code-textarea"
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <button
          className="btn btn-secondary"
          onClick={handlePreview}
          disabled={previewing}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
        >
          <Eye size={13} />
          <span>{previewing ? 'Đang tải...' : 'Xem trước 15 dòng dữ liệu'}</span>
        </button>
      </div>

      {previewData && (
        <div style={{ border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden', background: 'var(--win-bg-card)', marginTop: '6px' }}>
          <div style={{ padding: '6px 10px', background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)', fontSize: '11.5px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>
            Xem trước dữ liệu ({previewData.rows.length} dòng):
          </div>
          <div style={{ maxHeight: '180px', overflow: 'auto' }}>
            <table className="structure-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
              <thead>
                <tr>
                  {previewData.columns.map(col => (
                    <th key={col} style={{ padding: '6px 10px', background: 'var(--win-bg-window)', borderBottom: '1px solid var(--win-border)', textAlign: 'left', color: 'var(--win-text-secondary)' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewData.rows.map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid var(--win-border)' }}>
                    {previewData.columns.map(col => (
                      <td key={col} style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{String(row[col] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  const actions = (
    <div className="rt-embedded-actions">
      <div className="rt-actions-left">
        <button
          className="btn btn-secondary"
          onClick={() => { navigator.clipboard.writeText(sql).catch(() => {}); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Copy size={13} />
          <span>Sao chép DDL</span>
        </button>
      </div>

      <div className="rt-actions-right">
        {!embedded && onClose && <button className="btn btn-secondary" onClick={onClose}>Hủy</button>}
        <button
          className="btn btn-primary rt-btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          <Save size={13} />
          <span>{saving ? 'Đang lưu...' : 'Lưu View'}</span>
        </button>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="rt-embedded-pane">
        <div className="rt-embedded-header">
          <h2 className="rt-embedded-title">
            Chỉnh sửa View —{' '}
            <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{name}</span>
          </h2>
        </div>
        <div className="rt-embedded-body">
          {content}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <Modal
      title={
        <>
          Chỉnh sửa View —{' '}
          <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)' }}>{name}</span>
        </>
      }
      onClose={onClose}
      width="820px"
      maxWidth="94%"
      maxHeight="88vh"
      zIndex={999999}
    >
      <ModalBody style={{ gap: '12px', padding: '16px' }}>
        {content}
      </ModalBody>
      <ModalFooter>
        {actions}
      </ModalFooter>
    </Modal>
  );
};
