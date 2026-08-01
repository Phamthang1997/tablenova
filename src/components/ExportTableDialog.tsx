import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { buildTableFile, buildPreview, type ExportFormat } from '../utils/exportHelper';
import { getLastExportDir, openInFileManager, pickExportFolder, saveExportFile } from '../utils/fileSave';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';

/** Ngữ cảnh grid — chỉ có khi mở từ tab đang xem bảng (thanh dưới DataGrid). */
export interface ExportGridContext {
  columns: string[];
  visibleColumns: string[];
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filter?: string;
  totalCount?: number;
}

interface ExportTableDialogProps {
  open: boolean;
  tableName: string;
  dbType: string;
  /** Bỏ trống (mở từ context menu Sidebar) -> tự đọc danh sách cột từ schema. */
  grid?: ExportGridContext;
  onClose: () => void;
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
}

const FORMATS: ExportFormat[] = ['csv', 'json', 'sql', 'xlsx'];

/** Số dòng mỗi lần gọi khi tải toàn bộ bảng để xuất (để báo được tiến độ). */
const FETCH_PAGE_SIZE = 2000;
/** Số dòng mẫu lấy cho bước xem trước. */
const PREVIEW_ROWS = 20;

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

/**
 * Xuất MỘT bảng: bước 1 chọn tuỳ chọn, bước 2 xem trước rồi tải tệp.
 * Dùng chung cho nút Export ở thanh dưới grid và mục "Xuất dữ liệu (Export...)"
 * trong menu chuột phải ở Sidebar, để hai đường đi cho ra cùng một popup.
 */
export const ExportTableDialog: React.FC<ExportTableDialogProps> = ({
  open,
  tableName,
  dbType,
  grid,
  onClose,
  onSuccess,
  onError,
}) => {
  const [step, setStep] = useState<'options' | 'preview'>('options');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fileName, setFileName] = useState(tableName);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [applyView, setApplyView] = useState(true); // dùng sort/filter đang áp dụng trên grid
  const [schemaCols, setSchemaCols] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]); // chỉ là dòng mẫu để xem trước
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState('');
  const [dir, setDir] = useState(getLastExportDir());
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [done, setDone] = useState<
    { message: string; path?: string; dir?: string; viaDownload: boolean } | null
  >(null);

  // Mỗi lần mở là một lượt xuất mới.
  useEffect(() => {
    if (!open) return;
    setStep('options');
    setFileName(tableName);
    setRows([]);
    setPreview('');
  }, [open, tableName]);

  // Không có ngữ cảnh grid -> lấy cột từ schema để dựng header CSV/SQL đúng thứ tự.
  useEffect(() => {
    if (!open || grid) return;
    let cancelled = false;
    (async () => {
      const s = await dbHelper.getTableSchema(tableName);
      if (!cancelled) setSchemaCols((s.columns || []).map((c) => c.name));
    })();
    return () => { cancelled = true; };
  }, [open, grid, tableName]);

  const colNames = React.useMemo(() => {
    const all = grid ? grid.columns : schemaCols;
    if (!grid || !visibleOnly || grid.visibleColumns.length === 0) return all;
    return all.filter((n) => grid.visibleColumns.includes(n));
  }, [grid, schemaCols, visibleOnly]);

  // Bước xem trước chỉ lấy ÍT DÒNG LÀM MẪU cho nhanh; toàn bộ dữ liệu chỉ được tải
  // khi bấm xuất (xem fetchAllRows) — lúc đó mới có thanh tiến độ.
  useEffect(() => {
    if (!open || step !== 'preview') return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const useView = !!grid && applyView;
      const data = await dbHelper.getTableData(
        tableName,
        1,
        PREVIEW_ROWS,
        useView ? grid?.sortBy : undefined,
        useView ? grid?.sortDir : undefined,
        useView ? grid?.filter : undefined
      );
      if (cancelled) return;
      setRows(data.rows || []);
      setTotalRows(grid?.totalCount || data.totalCount || 0);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, step, tableName, grid, applyView]);

  /** Tải TOÀN BỘ dòng theo trang, báo tiến độ thật theo số dòng đã lấy. */
  const fetchAllRows = async (): Promise<any[]> => {
    const useView = !!grid && applyView;
    const all: any[] = [];
    let total = totalRows;
    let page = 1;
    for (;;) {
      setProgress({
        label: `Đang tải dữ liệu bảng ${tableName}...`,
        current: all.length,
        total: total || undefined,
        detail: total
          ? `${all.length.toLocaleString()}/${total.toLocaleString()} dòng`
          : `${all.length.toLocaleString()} dòng`,
      });
      const data = await dbHelper.getTableData(
        tableName,
        page,
        FETCH_PAGE_SIZE,
        useView ? grid?.sortBy : undefined,
        useView ? grid?.sortDir : undefined,
        useView ? grid?.filter : undefined
      );
      const batch = data.rows || [];
      all.push(...batch);
      if (!total && data.totalCount) total = data.totalCount;
      if (batch.length < FETCH_PAGE_SIZE) break;
      if (total && all.length >= total) break;
      page++;
    }
    setProgress({
      label: `Đang tải dữ liệu bảng ${tableName}...`,
      current: all.length,
      total: all.length,
      detail: `${all.length.toLocaleString()} dòng`,
    });
    return all;
  };

  // Dựng lại preview khi đổi format hoặc khi dữ liệu/cột thay đổi.
  useEffect(() => {
    if (!open || step !== 'preview' || loading) return;
    const cols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
    setPreview(buildPreview(format, tableName, cols, rows, dbType, PREVIEW_ROWS));
  }, [open, step, loading, format, rows, colNames, tableName, dbType]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const chooseFolder = async () => {
    const picked = await pickExportFolder(dir || undefined);
    if (picked) setDir(picked);
  };

  const download = async () => {
    try {
      // Tới đây mới tải hết dữ liệu — trước đó preview chỉ dùng vài dòng mẫu.
      const allRows = await fetchAllRows();
      const cols = colNames.length ? colNames : (allRows[0] ? Object.keys(allRows[0]) : []);
      setProgress({ label: `Đang dựng tệp ${format.toUpperCase()}...` });
      const file = buildTableFile(tableName, cols, allRows, format, dbType, fileName);
      setProgress({ label: 'Đang ghi tệp...' });
      const res = await saveExportFile(dir || null, file.name, file.data, file.mime);
      setProgress(null);
      setDone({
        message: `Đã xuất bảng "${tableName}" (${allRows.length} dòng) sang ${format.toUpperCase()}.`,
        path: res.path || file.name,
        dir: res.dir,
        viaDownload: res.savedTo === 'download',
      });
    } catch (err: any) {
      setProgress(null);
      onError?.('Lỗi xuất dữ liệu: ' + (err?.message || err));
    }
  };

  const closeDone = (openFolder: boolean) => {
    const dirToOpen = done?.dir;
    const msg = done?.message;
    setDone(null);
    if (openFolder && dirToOpen) openInFileManager(dirToOpen);
    if (msg) onSuccess?.(msg + (dirToOpen ? ` (${dirToOpen})` : ''));
    onClose();
  };

  // Xuất xong: hỏi luôn có mở thư mục chứa tệp không (thay vì đóng ngay).
  if (done) {
    return (
      <ConfirmDialog
        open
        tone="success"
        title="Xuất dữ liệu xong"
        message={
          <>
            {done.message}
            {done.path && (
              <div style={{ marginTop: '6px', fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--win-text-secondary)' }}>
                {done.dir && done.viaDownload ? `${done.dir}` : done.path}
              </div>
            )}
          </>
        }
        note={done.viaDownload ? 'Tệp được tải qua WebView nên nằm ở thư mục tải xuống của hệ thống.' : undefined}
        confirmLabel={done.dir ? 'Mở thư mục' : 'Đóng'}
        cancelLabel="Đóng"
        onConfirm={() => closeDone(true)}
        onCancel={() => closeDone(false)}
      />
    );
  }

  // Portal ra body: popup này render từ trong DataGrid, nơi có panel dùng backdrop-filter —
  // thứ tạo containing block mới làm `position: fixed` chỉ phủ trong panel.
  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
        width: step === 'options' ? '500px' : '640px',
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
            {step === 'options'
              ? `Xuất dữ liệu (Export Data) - Bảng: ${tableName}`
              : `Xem trước & Tải tệp - Bảng: ${tableName}`}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
          >
            ×
          </button>
        </div>

        {step === 'options' ? (
          <>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div className="form-group">
                <label style={labelStyle}>Tên tệp xuất (File name):</label>
                <input
                  type="text"
                  className="form-input"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder={tableName}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
              </div>

              <div className="form-group">
                <label style={labelStyle}>Thư mục lưu:</label>
                <div style={{ display: 'flex', gap: '8px' }}>
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
                    style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                  >
                    <FolderOpen size={13} />
                    Chọn...
                  </button>
                  {dir && (
                    <button className="btn btn-secondary" onClick={() => setDir('')} style={{ padding: '0 10px', whiteSpace: 'nowrap' }}>
                      Bỏ
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Định dạng xuất:</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {FORMATS.map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setFormat(fmt)}
                      style={{
                        padding: '6px 16px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid var(--win-border)',
                        cursor: 'pointer',
                        background: format === fmt ? 'var(--win-accent)' : 'transparent',
                        color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                        fontWeight: 600
                      }}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {grid && (
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
                    <input type="checkbox" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} />
                    <span>Chỉ xuất các cột đang hiện ({grid.visibleColumns.length}/{grid.columns.length} cột)</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={applyView} onChange={(e) => setApplyView(e.target.checked)} />
                    <span>Áp dụng sắp xếp &amp; bộ lọc đang dùng trên grid</span>
                  </label>
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                Xuất toàn bộ dòng của bảng (không chỉ trang hiện tại)
                {grid?.totalCount ? <> — khoảng <b style={{ color: 'var(--win-text-primary)' }}>{grid.totalCount}</b> dòng</> : null}.
                Bước sau chỉ xem {PREVIEW_ROWS} dòng làm mẫu; dữ liệu chỉ được tải hết khi bấm xuất.
              </div>
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              padding: '12px 16px',
              borderTop: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              <button className="btn btn-secondary" onClick={onClose}>Hủy</button>
              <button
                className="btn btn-primary"
                onClick={() => setStep('preview')}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                Xem trước &amp; Xuất
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--win-border)', paddingBottom: '8px' }}>
                {FORMATS.map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setFormat(fmt)}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid transparent',
                      cursor: 'pointer',
                      background: format === fmt ? 'var(--win-accent)' : 'transparent',
                      color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: format === fmt ? 600 : 500
                    }}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>

              <div>
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
                  Mẫu {Math.min(rows.length, PREVIEW_ROWS)} dòng đầu
                  {!loading && (
                    <> — tệp xuất sẽ có đủ <b style={{ color: 'var(--win-text-primary)' }}>{totalRows || rows.length}</b> dòng, {colNames.length || '?'} cột</>
                  )}:
                </div>
                {loading ? (
                  <div style={{
                    height: '240px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: 'var(--win-text-secondary)'
                  }}>
                    Đang tải dữ liệu xem trước...
                  </div>
                ) : format === 'xlsx' ? (
                  <div
                    style={{
                      height: '240px',
                      overflow: 'auto',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      borderRadius: '4px',
                      padding: '8px',
                      fontSize: '11px'
                    }}
                    dangerouslySetInnerHTML={{ __html: preview }}
                  />
                ) : (
                  <textarea
                    readOnly
                    value={preview}
                    style={{
                      width: '100%',
                      height: '240px',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      color: 'var(--win-text-primary)',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '10px',
                      borderRadius: '4px',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                )}
              </div>
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '12px 16px',
              borderTop: '1px solid var(--win-border)',
              background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))'
            }}>
              {progress ? (
                <ProgressBar progress={progress} />
              ) : (
                <button className="btn btn-secondary" onClick={() => setStep('options')} style={{ marginRight: 'auto' }}>
                  ← Tuỳ chọn
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={() => navigator.clipboard.writeText(preview)}
                disabled={loading || !!progress || !preview || format === 'xlsx'}
                title={format === 'xlsx' ? 'Preview XLSX là bảng HTML, không sao chép được' : undefined}
                style={{ flexShrink: 0 }}
              >
                Sao chép Preview
              </button>
              <button
                className="btn btn-primary"
                onClick={download}
                disabled={loading || !!progress}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
              >
                {dir ? 'Xuất vào thư mục' : 'Tải xuống tệp đầy đủ'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
