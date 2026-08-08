import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared chrome for every dialog in the app: dimmed backdrop, card, title bar.
 *
 * Every dialog used to inline its own overlay/card/header, which drifted into five
 * different looks (radius 6/8/10/14, three shadows, header with or without a filled
 * bar). This component is the single source of truth for that chrome — build new
 * dialogs from it instead of copying styles.
 *
 * Rendered through a portal on purpose: dialogs are often mounted inside panels that
 * use `backdrop-filter` (`.modal-content`, `.card`, `.connection-card`), and that
 * property creates a new containing block, so `position: fixed` would only cover the
 * panel instead of the whole window.
 */
export interface ModalProps {
  /** Title bar text. */
  title: React.ReactNode;
  /** Optional icon shown left of the title. */
  icon?: React.ReactNode;
  /** Extra controls in the title bar, placed left of the close button. */
  headerExtra?: React.ReactNode;
  onClose?: () => void;
  /** Hide the `×` button (e.g. a confirmation that must be answered). */
  showClose?: boolean;
  /** Blocks the `×`, Esc and backdrop click while an operation is running. */
  closeDisabled?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  width?: string;
  height?: string;
  maxWidth?: string;
  maxHeight?: string;
  /** Kept per call site so the existing stacking order is preserved. */
  zIndex?: number;
  cardStyle?: React.CSSProperties;
  children?: React.ReactNode;
}

const HEADER_BG = 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))';

export const Modal: React.FC<ModalProps> = ({
  title,
  icon,
  headerExtra,
  onClose,
  showClose = true,
  closeDisabled = false,
  closeOnBackdrop = true,
  closeOnEsc = true,
  width = '500px',
  height,
  maxWidth = '94vw',
  maxHeight = '90vh',
  zIndex = 10000,
  cardStyle,
  children,
}) => {
  useEffect(() => {
    if (!closeOnEsc || !onClose || closeDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeOnEsc, onClose, closeDisabled]);

  return createPortal(
    <div
      // mousedown rather than click: a text selection that starts inside the card and
      // ends on the backdrop must not close the dialog.
      onMouseDown={(e) => {
        if (!closeOnBackdrop || closeDisabled || !onClose) return;
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0, 0, 0, 0.45)',
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div style={{
        width,
        maxWidth,
        height,
        maxHeight,
        background: 'var(--win-bg-card)',
        border: '1px solid var(--win-border-strong, var(--win-border))',
        borderRadius: '6px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...cardStyle,
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 16px',
          borderBottom: '1px solid var(--win-border)',
          background: HEADER_BG,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {icon}
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
              {title}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {headerExtra}
            {showClose && onClose && (
              <button
                onClick={onClose}
                disabled={closeDisabled}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--win-text-secondary)',
                  cursor: closeDisabled ? 'default' : 'pointer',
                  fontSize: '16px',
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Scrollable content area of a dialog. */
export const ModalBody: React.FC<{
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ style, children }) => (
  <div style={{
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    overflowY: 'auto',
    minHeight: 0,
    ...style,
  }}>
    {children}
  </div>
);

/** Action bar at the bottom of a dialog. */
export const ModalFooter: React.FC<{
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ style, children }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid var(--win-border)',
    background: HEADER_BG,
    flexShrink: 0,
    ...style,
  }}>
    {children}
  </div>
);
