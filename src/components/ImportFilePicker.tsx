import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Định dạng tệp được phép nhập (dùng chung cho Import ở DataGrid và context menu Sidebar). */
const IMPORT_FORMATS = [
  { ext: '.csv', label: 'CSV', hint: 'Dòng đầu tiên là tên cột, các dòng sau là dữ liệu.' },
  { ext: '.json', label: 'JSON', hint: 'Phải là một mảng các đối tượng: [{ "col": "value" }, ...]' },
  { ext: '.xlsx', label: 'XLSX', hint: 'Đọc sheet đầu tiên, dòng đầu là tên cột.' },
  { ext: '.sql', label: 'SQL', hint: 'Các câu lệnh trong tệp sẽ được chạy trực tiếp trên database.' },
] as const;

type ImportExt = typeof IMPORT_FORMATS[number]['ext'];

const ALL_ACCEPT = IMPORT_FORMATS.map(f => f.ext).join(',');

interface ImportFilePickerProps {
  open: boolean;
  /** Bảng đích, nếu nhập vào bảng có sẵn. Bỏ trống = tạo bảng mới từ tên tệp. */
  targetTable?: string | null;
  onCancel: () => void;
  /** Gọi khi người dùng bấm "Bắt đầu Nhập" với một tệp hợp lệ. */
  onConfirm: (file: File) => void;
}

/**
 * Popup hiện TRƯỚC hộp thoại chọn tệp của hệ điều hành: báo bảng đích + định dạng cho phép,
 * cho xem tên tệp đã chọn ở ô input, rồi mới mở dialog gốc khi bấm "Chọn tệp".
 * Cấu trúc bám theo modal "Xuất Cơ sở dữ liệu" để hai luồng Import/Export nhìn giống nhau.
 */
export const ImportFilePicker: React.FC<ImportFilePickerProps> = ({
  open,
  targetTable,
  onCancel,
  onConfirm,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImportExt>('.csv');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mỗi lần mở lại là một lượt nhập mới -> xoá tệp/lỗi của lượt trước.
  useEffect(() => {
    if (open) {
      setFile(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const activeFormat = IMPORT_FORMATS.find(f => f.ext === format)!;

  const handleBrowse = () => inputRef.current?.click();

  const handlePickFormat = (ext: ImportExt) => {
    setFormat(ext);
    // Tệp đã chọn không còn khớp định dạng mới -> bỏ để tránh nhập sai kiểu.
    if (file && !file.name.toLowerCase().endsWith(ext)) setFile(null);
    setError(null);
  };

  const handlePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] || null;
    e.target.value = ''; // cho phép chọn lại cùng một tệp
    if (!picked) return;

    const lower = picked.name.toLowerCase();
    const matched = IMPORT_FORMATS.find(f => lower.endsWith(f.ext));
    if (!matched) {
      setFile(null);
      setError(`Định dạng không được hỗ trợ. Chỉ nhận ${ALL_ACCEPT.replace(/,/g, ', ')}.`);
      return;
    }
    // Chọn tệp khác định dạng đang bật thì chuyển định dạng theo tệp, không báo lỗi.
    if (matched.ext !== format) setFormat(matched.ext);
    setError(null);
    setFile(picked);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--win-text-secondary)',
    display: 'block',
    marginBottom: '6px',
  };

  // Portal ra body: popup này render từ trong DataGrid, nơi có panel dùng backdrop-filter —
  // thứ tạo containing block mới làm `position: fixed` chỉ phủ trong panel.
  return createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.6)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div style={{
        width: '500px',
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
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid var(--win-border)',
          background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
        }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
            Nhập dữ liệu (Import Data)
          </span>
          <button
            onClick={onCancel}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="form-group">
            <label style={labelStyle}>
              {targetTable ? 'Bảng đích (Target table):' : 'Bảng mới sẽ tạo từ tên tệp:'}
            </label>
            <input
              type="text"
              className="form-input"
              readOnly
              value={targetTable || (file ? file.name.replace(/\.[^.]+$/, '') : '')}
              placeholder="(suy ra từ tên tệp)"
              style={{ height: '30px', fontSize: '11px', width: '100%', background: 'var(--win-bg-hover)' }}
            />
          </div>

          <div>
            <label style={labelStyle}>
              Định dạng cho phép:
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {IMPORT_FORMATS.map(f => (
                <button
                  key={f.ext}
                  onClick={() => handlePickFormat(f.ext)}
                  style={{
                    padding: '6px 16px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: '1px solid var(--win-border)',
                    cursor: 'pointer',
                    background: format === f.ext ? 'var(--win-accent)' : 'transparent',
                    color: format === f.ext ? '#fff' : 'var(--win-text-secondary)',
                    fontWeight: 600
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{
            padding: '10px',
            background: 'var(--win-bg-window)',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            fontSize: '11px',
            color: 'var(--win-text-secondary)',
            lineHeight: 1.5
          }}>
            <b style={{ color: 'var(--win-text-primary)', fontFamily: 'monospace' }}>{activeFormat.ext}</b>
            {' — '}{activeFormat.hint}
          </div>

          <div className="form-group">
            <label style={labelStyle}>
              Tệp nguồn (Source file):
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="form-input"
                readOnly
                value={file ? file.name : ''}
                placeholder={`Chưa chọn tệp ${activeFormat.label}...`}
                onClick={handleBrowse}
                style={{ flex: 1, height: '30px', fontSize: '11px', cursor: 'pointer' }}
                title="Bấm để chọn tệp"
              />
              <button
                className="btn btn-secondary"
                onClick={handleBrowse}
                style={{ padding: '0 12px', whiteSpace: 'nowrap' }}
              >
                Chọn tệp...
              </button>
            </div>
            <input
              type="file"
              ref={inputRef}
              onChange={handlePicked}
              accept={format}
              style={{ display: 'none' }}
            />
            {file && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '6px' }}>
                Kích thước: <b style={{ color: 'var(--win-text-primary)' }}>{formatSize(file.size)}</b>
              </div>
            )}
          </div>

          {error && (
            <div style={{
              fontSize: '11px',
              color: 'var(--win-error, #ff6b6b)',
              background: 'rgba(255,107,107,0.08)',
              border: '1px solid rgba(255,107,107,0.35)',
              borderRadius: '4px',
              padding: '8px 10px'
            }}>
              {error}
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
          <button className="btn btn-secondary" onClick={onCancel}>
            Hủy
          </button>
          <button
            className="btn btn-primary"
            disabled={!file}
            onClick={() => file && onConfirm(file)}
            style={{
              background: file ? 'var(--win-accent)' : 'var(--win-bg-hover)',
              color: file ? '#fff' : 'var(--win-text-disabled)',
              border: 'none',
              cursor: file ? 'pointer' : 'not-allowed'
            }}
          >
            Bắt đầu Nhập
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
