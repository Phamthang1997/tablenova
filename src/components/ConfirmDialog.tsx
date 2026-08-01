import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

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
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy',
  danger = false,
  tone,
  requireText,
  onConfirm,
  onCancel,
}) => {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const ready = !requireText || typed.trim() === requireText;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      // Enter để xác nhận nhanh, nhưng chỉ khi không phải nhập xác nhận bằng tay.
      if (e.key === 'Enter' && !requireText) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm, requireText]);

  if (!open) return null;

  const kind = tone || (danger ? 'danger' : 'info');
  const accent = kind === 'danger'
    ? 'var(--st-danger, #e5484d)'
    : kind === 'success'
      ? 'var(--st-ok, #10b981)'
      : 'var(--win-accent)';
  const Icon = kind === 'danger' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;

  // Portal ra body: hộp thoại này được render từ trong các panel có `backdrop-filter`
  // (ConnectionManager, Sidebar...), mà backdrop-filter tạo containing block mới nên
  // `position: fixed` chỉ phủ trong panel đó thay vì cả cửa sổ.
  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.6)',
        zIndex: 10001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div style={{
        width: '420px',
        maxWidth: '92vw',
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
          alignItems: 'center',
          gap: '8px',
          padding: '12px 16px',
          borderBottom: '1px solid var(--win-border)',
          background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
        }}>
          <Icon size={14} style={{ color: accent, flexShrink: 0 }} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{title}</span>
        </div>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '11px', color: 'var(--win-text-primary)', lineHeight: 1.6 }}>{message}</div>
          {note && (
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>{note}</div>
          )}
          {requireText && (
            <div>
              <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
                Gõ <b style={{ color: 'var(--win-text-primary)', fontFamily: 'monospace' }}>{requireText}</b> để xác nhận:
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
        </div>

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          padding: '12px 16px',
          borderTop: '1px solid var(--win-border)',
          background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
        }}>
          <button className="btn btn-secondary" onClick={onCancel}>{cancelLabel}</button>
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
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
