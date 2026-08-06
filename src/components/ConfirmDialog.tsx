import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Nội dung chính — mô tả hành động sẽ xảy ra. */
  message: React.ReactNode;
  /** Dòng nhỏ phía dưới, ví dụ "Không thể hoàn tác." */
  note?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Nút xác nhận màu đỏ (hành động phá huỷ dữ liệu). */
  danger?: boolean;
  /** Sắc thái icon/nút: 'danger' (mặc định khi danger), 'success' hoặc 'info'. */
  tone?: 'danger' | 'success' | 'info';
  /** Nếu có: người dùng phải gõ đúng chuỗi này mới bấm được nút xác nhận. */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Hộp xác nhận trong app cho các hành động phá huỷ dữ liệu (Drop / Truncate / Flush...),
 * thay cho window.confirm() để trông đồng bộ với các popup còn lại.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  note,
  confirmLabel,
  cancelLabel,
  danger = false,
  tone,
  requireText,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const ready = !requireText || typed.trim() === requireText;

  // Escape đã do Modal xử lý; ở đây chỉ cần Enter để xác nhận nhanh,
  // và chỉ khi không phải nhập xác nhận bằng tay.
  useEffect(() => {
    if (!open || requireText) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, requireText]);

  if (!open) return null;

  const kind = tone || (danger ? 'danger' : 'info');
  const accent = kind === 'danger'
    ? 'var(--st-danger, #e5484d)'
    : kind === 'success'
      ? 'var(--st-ok, #10b981)'
      : 'var(--win-accent)';
  const Icon = kind === 'danger' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;

  return (
    <Modal
      title={title}
      icon={<Icon size={14} style={{ color: accent, flexShrink: 0 }} />}
      onClose={onCancel}
      showClose={false}
      width="420px"
      maxWidth="92vw"
      zIndex={10001}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div style={{ fontSize: '11px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>{message}</div>
        {note && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>{note}</div>
        )}
        {requireText && (
          <div>
            <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
              <Trans
                i18nKey="confirmDialog.typeToConfirm"
                values={{ text: requireText }}
                components={{ code: <b style={{ color: 'var(--win-text-primary)', fontFamily: 'monospace' }} /> }}
              />
            </label>
            <input
              type="text"
              className="form-input"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) onConfirm(); }}
              style={{ height: '30px', fontSize: '11px', width: '100%' }}
            />
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={!ready}
          style={{
            background: ready ? accent : 'var(--win-bg-hover)',
            color: ready ? '#fff' : 'var(--win-text-disabled)',
            border: 'none',
            cursor: ready ? 'pointer' : 'not-allowed'
          }}
        >
          {confirmLabel ?? t('common.confirm')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
