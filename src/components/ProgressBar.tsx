import React from 'react';

export interface ProgressState {
  /** Nhãn mô tả bước currently run. */
  label: string;
  /** already xong bao nhiêu phần việc. Bỏ trống -> thanh run vô định (not biết tiến độ). */
  current?: number;
  /** Tổng số phần việc. */
  total?: number;
  /** row phụ: chi tiết bên in phần việc currently run (ví dụ % row of table hiện tại). */
  detail?: string;
}

interface ProgressBarProps {
  progress: ProgressState;
}

/**
 * Thanh tiến độ dùng chung for các luồng Import/Export.
 *
 * Dùng thẳng <progress> of HTML (dự án not có UI library nào; WebView2 is Chromium
 * nên tự có animation for status vô định when bỏ thuộc tính value). Phần create hình
 * nằm at .tn-progress in index.css.
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
      {/* not truyền value -> <progress> tự run vô định */}
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
