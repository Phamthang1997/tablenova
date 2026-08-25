import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { buildTableFile, buildPreview, type ExportFormat } from '../utils/exportHelper';
import { getLastExportDir, openInFileManager, pickExportFolder, saveExportFile } from '../utils/fileSave';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from './Modal';

/** Ngữ cảnh grid — chỉ có khi mở từ tab đang xem bảng (thanh dưới DataGrid). */
export interface ExportGridContext {
  columns: string[];
  visibleColumns: string[];
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filter?: string;
  /**
   * Số dòng ĐẾM CHÍNH XÁC của grid, hoặc `null` khi grid chỉ có số ước lượng.
   *
   * `fetchAllRows` dừng khi `all.length >= total`, nên một số thiếu ở đây là một tệp xuất bị cắt
   * mà không có lỗi nào. `null` thì vòng lặp lấy tổng từ lần đọc trang đầu của chính nó — lần đó
   * luôn đếm chính xác (`countMode` mặc định của `dbHelper.getTableData`).
   */
  totalCount?: number | null;
}

interface ExportTableDialogProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, không đọc id ambient (§4.1). */
  connId: string;
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
  connId,
  open,
  tableName,
  dbType,
  grid,
  onClose,
  onSuccess,
  onError,
}) => {
  const { t, i18n } = useTranslation();
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);

  const [step, setStep] = useState<'options' | 'preview'>('options');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fileName, setFileName] = useState(tableName);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [applyView, setApplyView] = useState(true); // dùng sort/filter đang áp dụng trên grid
  const [schemaCols, setSchemaCols] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]); // chỉ là dòng mẫu để xem trước
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState(getLastExportDir());
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [done, setDone] = useState<
    { message: string; path?: string; dir?: string; viaDownload: boolean } | null
  >(null);

  // Each open is a new export pass.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setStep('options');
      setFileName(tableName);
      setRows([]);
    });
  }, [open, tableName]);

  // Không có ngữ cảnh grid -> lấy cột từ schema để dựng header CSV/SQL đúng thứ tự.
  useEffect(() => {
    if (!open || grid) return;
    let cancelled = false;
    (async () => {
      const s = await dbHelper.getTableSchema(connId, tableName);
      if (!cancelled) setSchemaCols((s.columns || []).map((c) => c.name));
    })();
    return () => { cancelled = true; };
  }, [connId, open, grid, tableName]);

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
    queueMicrotask(() => {
      setLoading(true);
    });
    (async () => {
      const useView = !!grid && applyView;
      const data = await dbHelper.getTableData(connId, 
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
  }, [connId, open, step, tableName, grid, applyView]);

  /** Tải TOÀN BỘ dòng theo trang, báo tiến độ thật theo số dòng đã lấy. */
  const fetchAllRows = async (): Promise<any[]> => {
    const useView = !!grid && applyView;
    const all: any[] = [];
    let total = totalRows;
    let page = 1;
    for (;;) {
      setProgress({
        label: t('exportDialog.loadingTable', { table: tableName }),
        current: all.length,
        total: total || undefined,
        detail: total
          ? t('exportDialog.rowsOfTotal', { rows: fmtNum(all.length), total: fmtNum(total) })
          : t('exportDialog.rows', { rows: fmtNum(all.length) }),
      });
      const data = await dbHelper.getTableData(connId, 
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
      label: t('exportDialog.loadingTable', { table: tableName }),
      current: all.length,
      total: all.length,
      detail: t('exportDialog.rows', { rows: fmtNum(all.length) }),
    });
    return all;
  };

  // Builds preview on format or rows / columns change.
  const preview = React.useMemo(() => {
    if (!open || step !== 'preview' || loading) return '';
    const cols = colNames.length ? colNames : (rows[0] ? Object.keys(rows[0]) : []);
    return buildPreview(format, tableName, cols, rows, dbType, PREVIEW_ROWS);
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
      setProgress({ label: t('exportDialog.building', { format: format.toUpperCase() }) });
      const file = buildTableFile(tableName, cols, allRows, format, dbType, fileName);
      setProgress({ label: t('exportDialog.writing') });
      const res = await saveExportFile(dir || null, file.name, file.data, file.mime);
      setProgress(null);
      setDone({
        message: t('exportDialog.exportedTable', { table: tableName, rows: allRows.length, format: format.toUpperCase() }),
        path: res.path || file.name,
        dir: res.dir,
        viaDownload: res.savedTo === 'download',
      });
    } catch (err: any) {
      setProgress(null);
      onError?.(t('exportDialog.errExport', { message: err?.message || err }));
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
        title={t('app.exportDoneTitle')}
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
        note={done.viaDownload ? t('app.exportDoneNoteWebView') : undefined}
        confirmLabel={done.dir ? t('app.openFolder') : t('common.close')}
        cancelLabel={t('common.close')}
        onConfirm={() => closeDone(true)}
        onCancel={() => closeDone(false)}
      />
    );
  }

  return (
    <Modal
      title={step === 'options'
        ? t('exportDialog.titleOptions', { table: tableName })
        : t('exportDialog.titlePreview', { table: tableName })}
      onClose={onClose}
      width={step === 'options' ? '500px' : '640px'}
      zIndex={10000}
    >
        {step === 'options' ? (
          <>
            <ModalBody>
              <div className="form-group">
                <label style={labelStyle}>{t('exportDialog.fileName')}</label>
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
                <label style={labelStyle}>{t('exportDialog.saveFolder')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="form-input"
                    readOnly
                    value={dir}
                    placeholder={t('exportDialog.folderPlaceholder')}
                    onClick={chooseFolder}
                    title={dir || t('exportDialog.pickFolderTitle')}
                    style={{ flex: 1, minWidth: 0, height: '30px', fontSize: '11px', cursor: 'pointer' }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={chooseFolder}
                    style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                  >
                    <FolderOpen size={13} />
                    {t('exportDialog.pick')}
                  </button>
                  {dir && (
                    <button className="btn btn-secondary" onClick={() => setDir('')} style={{ padding: '0 10px', whiteSpace: 'nowrap' }}>
                      {t('exportDialog.clear')}
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label style={labelStyle}>{t('exportDialog.formatLabel')}</label>
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
                    <span>{t('exportDialog.visibleColumnsOnly', { shown: grid.visibleColumns.length, total: grid.columns.length })}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={applyView} onChange={(e) => setApplyView(e.target.checked)} />
                    <span>{t('exportDialog.applyGridView')}</span>
                  </label>
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                {t('exportDialog.exportAllRowsNote')}
                {grid?.totalCount
                  ? <Trans i18nKey="exportDialog.exportAllRowsCount" values={{ n: grid.totalCount }} components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }} />
                  : null}.
                {' '}{t('exportDialog.previewOnlyNote', { n: PREVIEW_ROWS })}
              </div>
            </ModalBody>

            <ModalFooter>
              <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
              <button
                className="btn btn-primary"
                onClick={() => setStep('preview')}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none' }}
              >
                {t('exportDialog.previewAndExport')}
              </button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalBody style={{ gap: '12px' }}>
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
                  {t('exportDialog.sampleRows', { n: Math.min(rows.length, PREVIEW_ROWS) })}
                  {!loading && (
                    <Trans
                      i18nKey="exportDialog.sampleRowsNote"
                      values={{ rows: totalRows || rows.length, cols: colNames.length || '?' }}
                      components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }}
                    />
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
                    {t('exportDialog.loadingPreview')}
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
            </ModalBody>

            <ModalFooter style={{ gap: '12px' }}>
              {progress ? (
                <ProgressBar progress={progress} />
              ) : (
                <button className="btn btn-secondary" onClick={() => setStep('options')} style={{ marginRight: 'auto' }}>
                  {t('exportDialog.backToOptions')}
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={() => navigator.clipboard.writeText(preview)}
                disabled={loading || !!progress || !preview || format === 'xlsx'}
                title={format === 'xlsx' ? t('exportDialog.copyPreviewDisabled') : undefined}
                style={{ flexShrink: 0 }}
              >
                {t('exportDialog.copyPreview')}
              </button>
              <button
                className="btn btn-primary"
                onClick={download}
                disabled={loading || !!progress}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
              >
                {dir ? t('exportDialog.exportToFolder') : t('exportDialog.downloadFile')}
              </button>
            </ModalFooter>
          </>
        )}
    </Modal>
  );
};
