import React from 'react';

export interface ProgressState {
  /** Nhãn mô tả bước đang chạy. */
  label: string;
  /** Đã xong bao nhiêu phần việc. Bỏ trống -> thanh chạy vô định (không biết tiến độ). */
  current?: number;
  /** Tổng số phần việc. */
  total?: number;
  /** Dòng phụ: chi tiết bên trong phần việc đang chạy (ví dụ % dòng của bảng hiện tại). */
  detail?: string;
}

interface ProgressBarProps {
  progress: ProgressState;
}

/**
 * Thanh tiến độ dùng chung cho các luồng Import/Export.
 *
 * Dùng thẳng <progress> của HTML (dự án không có UI library nào; WebView2 là Chromium
 * nên tự có animation cho trạng thái vô định khi bỏ thuộc tính value). Phần tạo hình
 * nằm ở .tn-progress trong index.css.
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
      {/* Không truyền value -> <progress> tự chạy vô định */}
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
