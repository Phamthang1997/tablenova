import React from 'react';

/**
 * Placeholder shown while a lazily-imported Monaco editor chunk is being fetched.
 *
 * Deliberately wordless: the wait is one chunk fetch off local disk (~200ms once, then the
 * module is cached and every later mount resolves synchronously), and a label would mean a
 * translation key for something almost nobody reads. It fills the panel so the surrounding
 * flex layout does not collapse and then snap back when the editor arrives.
 */
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
