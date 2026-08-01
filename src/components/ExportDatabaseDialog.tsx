import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { getLastExportDir, pickExportFolder } from '../utils/fileSave';
import { ProgressBar, type ProgressState } from './ProgressBar';

export type DatabaseExportFormat = 'sql' | 'json' | 'csv' | 'xlsx';

export interface DatabaseExportOptions {
  format: DatabaseExportFormat;
  tables: string[];
  filename: string;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  compressGzip: boolean;
  /** Thư mục lưu tệp; null = tải qua WebView về thư mục tải xuống của hệ thống. */
  dir: string | null;
  /** Báo tiến độ ngược lại cho popup. */
  onProgress: (p: ProgressState | null) => void;
}

interface ExportDatabaseDialogProps {
  open: boolean;
  onClose: () => void;
  /** Trả về true nếu xuất xong (popup tự đóng), false để giữ popup lại cho người dùng sửa. */
  onSubmit: (options: DatabaseExportOptions) => Promise<boolean>;
}

const FORMAT_LABEL: Record<DatabaseExportFormat, string> = {
  sql: 'SQL',
  json: 'JSON',
  csv: 'CSV (ZIP)',
  xlsx: 'XLSX',
};

const FORMAT_HINT: Record<DatabaseExportFormat, string> = {
  sql: 'Một tệp .sql chứa DDL/INSERT của các bảng đã chọn — dùng để phục hồi lại database.',
  json: 'Một tệp .json dạng { "tên_bảng": [ ...dòng ] }.',
  csv: 'Một bảng -> tệp .csv; nhiều bảng -> gói .zip, mỗi bảng một tệp .csv.',
  xlsx: 'Một tệp .xlsx, mỗi bảng là một sheet.',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

// Bỏ dấu để tìm bảng không phân biệt dấu (giống ô tìm kiếm ở Sidebar).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const removeAccents = (s: string) =>
  s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/**
 * Popup "Xuất Cơ sở dữ liệu" — layout 2 cột: trái là cấu hình (tên tệp, định dạng,
 * tuỳ chọn SQL), phải là danh sách bảng chiếm hết chiều cao nên không phải cuộn cả popup.
 */
export const ExportDatabaseDialog: React.FC<ExportDatabaseDialogProps> = ({ open, onClose, onSubmit }) => {
  const [filename, setFilename] = useState('database_dump');
  const [format, setFormat] = useState<DatabaseExportFormat>('sql');
  const [dropTable, setDropTable] = useState(true);
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeContent, setIncludeContent] = useState(true);
  const [compressGzip, setCompressGzip] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [tablesLoading, setTablesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState(getLastExportDir());
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setError(null);
    setTablesLoading(true);
    let cancelled = false;
    (async () => {
      const list = await dbHelper.getTables();
      if (cancelled) return;
      const names = list.map((t) => t.name);
      setTables(names);
      setSelected(names);
      setTablesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const shown = search.trim()
    ? tables.filter((t) => removeAccents(t).includes(removeAccents(search.trim())))
    : tables;
  const allShownSelected = shown.length > 0 && shown.every((t) => selected.includes(t));

  const toggleAllShown = () => {
    if (allShownSelected) setSelected(selected.filter((t) => !shown.includes(t)));
    else setSelected([...new Set([...selected, ...shown])]);
  };

  const toggleOne = (name: string) => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  };

  const submit = async () => {
    if (selected.length === 0) {
      setError('Chọn ít nhất một bảng để xuất.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const ok = await onSubmit({
        format,
        tables: selected,
        filename: filename.trim() || 'database_dump',
        sqlOptions: { dropTable, includeStructure, includeContent },
        compressGzip,
        dir: dir || null,
        onProgress: setProgress,
      });
      if (ok) onClose();
    } finally {
      setProgress(null);
      setSubmitting(false);
    }
  };

  const chooseFolder = async () => {
    const picked = await pickExportFolder(dir || undefined);
    if (picked) setDir(picked);
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0,0,0,0.6)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div style={{
        width: '820px',
        maxWidth: '94vw',
        height: '540px',
        maxHeight: '90vh',
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
          background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))',
          flexShrink: 0
        }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
            Xuất Cơ sở dữ liệu (Export Database)
          </span>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
          >
            ×
          </button>
        </div>

        {/* Thân: 2 cột — cấu hình | danh sách bảng */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{
            width: '340px',
            flexShrink: 0,
            borderRight: '1px solid var(--win-border)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            overflowY: 'auto'
          }}>
            <div className="form-group">
              <label style={labelStyle}>Tên tệp xuất (File name):</label>
              <input
                type="text"
                className="form-input"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="database_dump"
                style={{ height: '30px', fontSize: '11px', width: '100%' }}
              />
            </div>

            <div className="form-group">
              <label style={labelStyle}>Thư mục lưu:</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  className="form-input"
                  readOnly
                  value={dir}
                  placeholder="Thư mục tải xuống của hệ thống"
                  onClick={chooseFolder}
                  title={dir || 'Bấm để chọn thư mục'}
                  style={{ flex: 1, minWidth: 0, height: '30px', fontSize: '11px', cursor: 'pointer' }}
                />
                <button
                  className="btn btn-secondary"
                  onClick={chooseFolder}
                  disabled={submitting}
                  style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                >
                  <FolderOpen size={13} />
                  Chọn...
                </button>
                {dir && (
                  <button className="btn btn-secondary" onClick={() => setDir('')} disabled={submitting} style={{ padding: '0 10px' }}>
                    Bỏ
                  </button>
                )}
              </div>
            </div>

            <div>
              <label style={labelStyle}>Định dạng xuất:</label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {(['sql', 'json', 'csv', 'xlsx'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setFormat(fmt)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--win-border)',
                      cursor: 'pointer',
                      background: format === fmt ? 'var(--win-accent)' : 'transparent',
                      color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: 600
                    }}
                  >
                    {FORMAT_LABEL[fmt]}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '8px', lineHeight: 1.5 }}>
                {FORMAT_HINT[format]}
              </div>
            </div>

            {format === 'sql' && (
              <div>
                <label style={labelStyle}>Tuỳ chọn SQL:</label>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '4px'
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={dropTable} onChange={(e) => setDropTable(e.target.checked)} />
                    <span>DROP TABLE IF EXISTS trước mỗi bảng</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={includeStructure} onChange={(e) => setIncludeStructure(e.target.checked)} />
                    <span>Kèm cấu trúc (CREATE TABLE)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
                    <span>Kèm dữ liệu (INSERT INTO)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={compressGzip} onChange={(e) => setCompressGzip(e.target.checked)} />
                    <span>Nén tệp bằng Gzip (.sql.gz)</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>
                Bảng cần xuất ({selected.length}/{tables.length}):
              </label>
              <button
                onClick={toggleAllShown}
                disabled={shown.length === 0}
                style={{
                  padding: '2px 8px',
                  fontSize: '10px',
                  cursor: 'pointer',
                  background: 'var(--win-bg-card)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '3px',
                  color: 'var(--win-text-primary)',
                  whiteSpace: 'nowrap'
                }}
              >
                {allShownSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
              </button>
            </div>

            <input
              type="text"
              className="form-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm bảng..."
              style={{ height: '28px', fontSize: '11px', width: '100%' }}
            />

            <div style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              border: '1px solid var(--win-border)',
              borderRadius: '4px',
              background: 'var(--win-bg-window)',
              padding: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              {tablesLoading ? (
                <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Đang tải danh sách bảng...</div>
              ) : shown.length === 0 ? (
                <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                  {tables.length === 0 ? 'Không có bảng nào.' : 'Không có bảng khớp từ khoá.'}
                </div>
              ) : (
                shown.map((name) => (
                  <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(name)} onChange={() => toggleOne(name)} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 16px',
          borderTop: '1px solid var(--win-border)',
          background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))',
          flexShrink: 0
        }}>
          {progress ? (
            <ProgressBar progress={progress} />
          ) : error ? (
            <span style={{ marginRight: 'auto', fontSize: '11px', color: 'var(--win-error, #ff6b6b)' }}>
              {error}
            </span>
          ) : null}
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>Hủy</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || tablesLoading || selected.length === 0}
            style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
          >
            {submitting ? 'Đang xuất...' : 'Bắt đầu Xuất'}
          </button>
        </div>
      </div>
    </div>
  );
};
