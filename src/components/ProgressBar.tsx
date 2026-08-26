import React from 'react';

export interface ProgressState {
  /** A label describing the running step. */
  label: string;
  /** How many units are done. Omitted -> the bar runs indeterminately (no progress known). */
  current?: number;
  /** The total number of units. */
  total?: number;
  /** The sub-line: detail within the running unit (the current table's row percentage, say). */
  detail?: string;
}

interface ProgressBarProps {
  progress: ProgressState;
}

/**
 * The progress bar shared by the import/export flows.
 *
 * It uses HTML's <progress> directly (this project has no UI library; WebView2 is Chromium, so it
 * animates the indeterminate state itself when the value attribute is omitted). The styling lives in
 * .tn-progress in index.css.
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({ progress }) => {
  const { label, current, total, detail } = progress;
  const determinate = typeof current === 'number' && typeof total === 'number' && total > 0;
  const percent = determinate ? Math.min(100, Math.round((current! / total!) * 100)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '10px', color: 'var(--win-text-secondary)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {determinate && (
          <span style={{ flexShrink: 0, fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>
            {percent}%
          </span>
        )}
      </div>
      {/* With no value passed, <progress> runs indeterminately by itself */}
      <progress
        className="tn-progress"
        {...(determinate ? { value: current, max: total } : {})}
        aria-label={label}
      />
      {detail && (
        <div style={{
          fontSize: '10px',
          fontFamily: 'monospace',
          color: 'var(--win-text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>
          {detail}
        </div>
      )}
    </div>
  );
};
