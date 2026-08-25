import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Nội dung chính — mô tả hành động will xảy ra. */
  message: React.ReactNode;
  /** row nhỏ phía under, ví dụ "not thể hoàn tác." */
  note?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Nút confirm màu đỏ (hành động phá cancel dữ liệu). */
  danger?: boolean;
  /** Sắc thái icon/nút: 'danger' (default when danger), 'success' or 'info'. */
  tone?: 'danger' | 'success' | 'info';
  /** if có: user must gõ đúng string này mới bấm is nút confirm. */
  requireText?: string;
  /** Override the stacking order. The default sits above the 9999/10000 dialogs, but a
   *  caller opened from a modal that raised itself higher (Sidebar, SequenceManagerModal
   *  use 999999) must pass a bigger value or the confirmation renders behind it. */
  zIndex?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Hộp confirm in app for các hành động phá cancel dữ liệu (Drop / Truncate / Flush...),
 * thay for window.confirm() to trông sync with các popup còn lại.
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
  zIndex = 10001,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const ready = !requireText || typed.trim() === requireText;

  // Escape already do Modal handle; at đây chỉ cần Enter to confirm nhanh,
  // and chỉ when not must nhập confirm bằng tay.
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
      zIndex={zIndex}
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
