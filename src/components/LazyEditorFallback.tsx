import React from 'react';

/**
 * Placeholder shown while a lazily-imported Monaco editor chunk is being fetched.
 *
 * Deliberately wordless: the wait is one chunk fetch off local disk (~200ms once, then the
 * module is cached and every later mount resolves synchronously), and a label would mean a
 * translation key for something almost nobody reads. It fills the panel so the surrounding
 * flex layout does not collapse and then snap back when the editor arrives.
 */
/**
 * Cùng việc đó nhưng for một **hộp thoại** load chậm (`RowDocumentModal`).
 *
 * `LazyEditorFallback` có `flex: 1` and nền riêng, đúng for một panel — nhưng hộp thoại thì render
 * qua portal, còn fallback thì not, nên dùng bản kia will chèn một khối ando giữa layout of grid
 * rồi biến mất when chunk về. Bản này `position: fixed` nên not đẩy gì cả, and vẫn for một dấu
 * hiệu is cú bấm already is write receive.
 */
export const LazyModalFallback: React.FC = () => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      zIndex: 10000,
    }}
  >
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" className="loading-spinner">
      <circle cx="12" cy="12" r="10" stroke="var(--win-border-strong, #383b44)" strokeWidth="3" opacity="0.2" />
      <path
        d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
        stroke="var(--win-accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);

export const LazyEditorFallback: React.FC = () => (
  <div
    style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--win-bg-editor, var(--win-bg))',
    }}
  >
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" className="loading-spinner">
      <circle cx="12" cy="12" r="10" stroke="var(--win-border-strong, #383b44)" strokeWidth="3" opacity="0.2" />
      <path
        d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
        stroke="var(--win-accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  </div>
);
