import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown } from 'lucide-react';
import {
  parseCreateTable,
  parseInsert,
  parseDumpDatabase,
  parseDumpObjects,
  buildDropStatements,
  isSkippedDumpStatement,
  isCommentOnlyStatement,
  type DumpTable,
  type DumpRows,
} from '../utils/dumpPreview';
import { splitStatements } from '../sql/statements';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal, ModalFooter } from './Modal';

const ACCEPT = '.sql,.gz,.dump';

// Các mức chặn dưới đây chỉ để tệp dump khổng lồ không treo UI; dump thường sẽ hiện đủ.
/** Số câu lệnh tối đa cắt ra từ dump để xem trước. */
const MAX_STATEMENTS = 50000;
/** Số câu lệnh tối đa hiển thị ở dạng SQL. */
const PREVIEW_LIMIT = 2000;
/** Số dòng hiển thị cho mỗi bảng ở tab Dữ liệu (dạng trực quan). */
const PREVIEW_ROWS = 20;

/** Dòng dữ liệu của một bảng: chỉ giữ PREVIEW_ROWS dòng đầu, `total` là tổng thật. */
interface TablePreviewRows extends DumpRows {
  total: number;
}

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

// Dò tên bảng xuất hiện trong dump để cho phép chọn nhập một phần.
const TABLE_RE = /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE\s+IF\s+EXISTS)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?/gi;

// Bảng TẠM khai báo trong thân procedure/function — không phải bảng của database.
const TEMP_TABLE_RE = /CREATE\s+TEMPORARY\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?/gi;

function parseTableNames(sql: string): string[] {
  const temps = new Set<string>();
  TEMP_TABLE_RE.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TEMP_TABLE_RE.exec(sql)) !== null) temps.add(t[1].toLowerCase());

  const found: string[] = [];
  TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_RE.exec(sql)) !== null) {
    // Bỏ bảng tạm: chúng lọt vào danh sách qua `INSERT INTO <temp>` bên trong routine.
    if (temps.has(m[1].toLowerCase())) continue;
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** Tên bảng của một câu lệnh (dùng để lọc preview theo bảng đang chọn). */
function statementTable(stmt: string): string | null {
  TABLE_RE.lastIndex = 0;
  const m = TABLE_RE.exec(stmt);
  return m ? m[1] : null;
}

/**
 * Cắt dump thành từng câu lệnh cho phần xem trước.
 *
 * Dùng chung `splitStatements` với SQL editor — hàm này hiểu lệnh `DELIMITER` của MySQL và
 * khối `$$` của Postgres, giống splitter phía Rust dùng khi chạy thật, nên preview hiện đúng
 * những câu lệnh sẽ được thực thi (thân trigger/procedure không bị cắt vụn).
 */
function splitForPreview(sql: string, limit: number): string[] {
  const out: string[] = [];
  for (const r of splitStatements(sql)) {
    if (out.length >= limit) break;
    out.push(r.text);
  }
  return out;
}

/** Rút gọn một câu lệnh dài để preview không bị tràn. */
function clip(stmt: string, max = 600): string {
  return stmt.length > max ? stmt.slice(0, max) + ' …' : stmt;
}

/** Giải nén .sql.gz bằng DecompressionStream của WebView (Chromium) -> text SQL. */
async function gunzipToText(t: TFunction, file: File): Promise<string> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error(t('importDialog.errNoGzip'));
  const stream = file.stream().pipeThrough(new DS('gzip'));
  return await new Response(stream).text();
}

/**
 * Seconds -> "12 seconds" / "2 min 5 sec" / "1 h 3 min" for the estimate and ETA.
 * Takes `t` because it is module-level and cannot call the hook itself.
 */
function formatDuration(t: TFunction, totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return t('importDialog.etaSeconds', { s });
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest ? t('importDialog.etaMinutesSeconds', { m, s: rest }) : t('importDialog.etaMinutes', { m });
  }
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM ? t('importDialog.etaHoursMinutes', { h, m: restM }) : t('importDialog.etaHours', { h });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface ImportDatabaseDialogProps {
  open: boolean;
  onClose: () => void;
  /** Database đang kết nối (mặc định để nhập vào nếu tệp không nói database nào). */
  currentDb?: string;
  /** false với SQLite: không có khái niệm database nên ẩn phần chọn database đích. */
  canManageDatabases?: boolean;
  /** Dialect để dựng lệnh DROP đúng cú pháp khi ghi đè. */
  dbType?: string;
  /**
   * Trả về true nếu nhập xong (popup tự đóng), false để giữ popup lại.
   * targetDb: database đích — rỗng nghĩa là dùng database đang kết nối.
   * onProgress: nhận tiến độ thật từ backend (số câu lệnh đã chạy / tổng).
   */
  onSubmit: (
    sqlText: string,
    tables: string[],
    targetDb: string,
    onProgress: (msg: { type: string; done?: number; total?: number }) => void
  ) => Promise<boolean>;
}

/**
 * Popup "Nhập Cơ sở dữ liệu" — layout 2 cột giống popup Xuất: trái là tệp dump + thông tin,
 * phải là danh sách bảng dò được trong tệp để chọn nhập một phần.
 */
export const ImportDatabaseDialog: React.FC<ImportDatabaseDialogProps> = ({
  open,
  onClose,
  currentDb,
  canManageDatabases = true,
  dbType = 'mysql',
  onSubmit,
}) => {
  const { t, i18n } = useTranslation();
  const fmtNum = (n: number) => n.toLocaleString(i18n.language);

  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sqlText, setSqlText] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // Database đích: lấy từ tệp nếu tệp có `USE`/`CREATE DATABASE`, không thì người dùng tự nhập.
  const [targetDb, setTargetDb] = useState('');
  const [dbFromFile, setDbFromFile] = useState<string | null>(null);
  // Xoá đối tượng trùng tên trước khi chạy dump (nếu không sẽ lỗi "already exists")
  const [overwrite, setOverwrite] = useState(false);
  // Đang hiện bản tóm tắt xác nhận trước khi chạy
  const [confirming, setConfirming] = useState(false);
  const [tab, setTab] = useState<'tables' | 'structure' | 'data'>('tables');
  const [viewMode, setViewMode] = useState<'visual' | 'sql'>('visual');
  // Bảng đang xem ở phần trực quan (độc lập với các bảng được tick để nhập)
  const [previewTables, setPreviewTables] = useState<string[]>([]);
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setSqlText('');
    setTables([]);
    setSelected([]);
    setPreviewTables([]);
    setShowPreviewPicker(false);
    setSearch('');
    setError(null);
    setTab('tables');
    setViewMode('visual');
    setTargetDb('');
    setDbFromFile(null);
    setOverwrite(false);
    setConfirming(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  // Cắt dump một lần cho phần xem trước; giới hạn số câu lệnh để tệp lớn không treo UI.
  const parsed = React.useMemo(() => {
    if (!sqlText) {
      return {
        structure: [] as string[],
        data: [] as string[],
        createdTables: [] as DumpTable[],
        insertedRows: [] as TablePreviewRows[],
      };
    }
    const stmts = splitForPreview(sqlText, MAX_STATEMENTS);
    const structure = stmts.filter((s) => /^\s*(CREATE|ALTER|DROP)\b/i.test(s));
    const data = stmts.filter((s) => /^\s*INSERT\b/i.test(s));

    // Dạng trực quan: CREATE TABLE -> danh sách cột; INSERT -> các dòng, gộp theo bảng.
    const createdTables = structure
      .map(parseCreateTable)
      .filter((t): t is DumpTable => !!t);

    // Đếm hết số dòng của mỗi bảng nhưng chỉ giữ PREVIEW_ROWS dòng đầu để render.
    const byTable = new Map<string, TablePreviewRows>();
    for (const stmt of data) {
      const ins = parseInsert(stmt);
      if (!ins) continue;
      const cur = byTable.get(ins.table);
      if (cur) {
        if (!cur.columns && ins.columns) cur.columns = ins.columns;
        cur.total += ins.rows.length;
        if (cur.rows.length < PREVIEW_ROWS) {
          cur.rows.push(...ins.rows.slice(0, PREVIEW_ROWS - cur.rows.length));
        }
      } else {
        byTable.set(ins.table, {
          ...ins,
          rows: ins.rows.slice(0, PREVIEW_ROWS),
          total: ins.rows.length,
        });
      }
    }

    return { structure, data, createdTables, insertedRows: [...byTable.values()] };
  }, [sqlText]);

  // Số câu lệnh sẽ chạy (đúng cùng bộ lọc mà backend dùng), cho phần ước tính thời gian.
  // Phải đứng TRƯỚC `if (!open)` bên dưới: hook không được gọi sau early return.
  const plannedStatements = React.useMemo(() => {
    if (!sqlText) return 0;
    const objs = overwrite ? parseDumpObjects(sqlText) : null;
    const extra = objs ? buildDropStatements(objs, dbType).length : 0;
    const keep = splitStatements(sqlText).filter(({ text }) => {
      // Cùng luật với backend: bỏ LOCK/UNLOCK TABLES + lệnh transaction của dump...
      if (isSkippedDumpStatement(text)) return false;
      const { commentOnly, willRun } = isCommentOnlyStatement(text);
      if (commentOnly) return willRun;
      if (tables.length === 0) return true;
      const t = statementTable(text);
      // ...câu không nhắc bảng nào (SET/USE...) vẫn chạy; còn lại phải thuộc bảng đã chọn.
      return !t || selected.includes(t);
    });
    return keep.length + extra;
  }, [sqlText, overwrite, dbType, tables.length, selected]);

  if (!open) return null;

  const handlePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] || null;
    e.target.value = '';
    if (!picked) return;

    const lower = picked.name.toLowerCase();
    if (!['.sql', '.gz', '.dump'].some((ext) => lower.endsWith(ext))) {
      setError(t('importDialog.errFileType'));
      return;
    }

    setError(null);
    setFile(picked);
    setSqlText('');
    setTables([]);
    setSelected([]);
    setParsing(true);

    try {
      // restore_backup chỉ nhận SQL dạng text -> .gz phải giải nén ngay ở đây.
      setProgress({ label: lower.endsWith('.gz') ? t('importDialog.decompressing') : t('importDialog.reading') });
      const text = lower.endsWith('.gz') ? await gunzipToText(t, picked) : await picked.text();
      setSqlText(text);
      setProgress({ label: t('importDialog.parsing') });
      const found = parseTableNames(text);
      setTables(found);
      setSelected(found);
      setPreviewTables(found);
      // Tệp có nói database đích thì lấy luôn; không thì để trống cho người dùng nhập.
      const dbInFile = parseDumpDatabase(text);
      setDbFromFile(dbInFile);
      setTargetDb(dbInFile || '');
    } catch (err: any) {
      setSqlText('');
      setError(t('importDialog.errReadFile', { message: err?.message || err }));
    } finally {
      setProgress(null);
      setParsing(false);
    }
  };

  const shown = search.trim()
    ? tables.filter((t) => removeAccents(t).includes(removeAccents(search.trim())))
    : tables;
  const allShownSelected = shown.length > 0 && shown.every((t) => selected.includes(t));

  // Preview chỉ hiện câu lệnh của các bảng đang chọn (không dò được bảng nào -> hiện hết).
  const keepStatement = (s: string) => {
    if (tables.length === 0) return true;
    const t = statementTable(s);
    return !t || selected.includes(t);
  };
  const structureShown = parsed.structure.filter(keepStatement);
  const dataShown = parsed.data.filter(keepStatement);
  const previewClipped =
    (tab === 'structure' ? structureShown.length : dataShown.length) > PREVIEW_LIMIT;

  // Phần trực quan lọc theo multi-select riêng (previewTables), không theo tick nhập.
  const keepTable = (name: string) => tables.length === 0 || previewTables.includes(name);
  const visualTables = parsed.createdTables.filter((t) => keepTable(t.name));
  const visualRows = parsed.insertedRows.filter((r) => keepTable(r.table));
  const togglePreviewTable = (name: string) => {
    setPreviewTables((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  };

  const toggleAllShown = () => {
    if (allShownSelected) setSelected(selected.filter((t) => !shown.includes(t)));
    else setSelected([...new Set([...selected, ...shown])]);
  };

  const canSubmit = !!file && !parsing && !submitting && !!sqlText && (tables.length === 0 || selected.length > 0);

  // Bấm "Bắt đầu Nhập" -> hiện bản tóm tắt để xác nhận, chạy thật ở runImport().
  const askConfirm = () => {
    if (!file || !sqlText) return;
    // Không có tên database (tệp không nói, người dùng cũng chưa nhập) -> nhắc nhập.
    if (canManageDatabases && !targetDb.trim() && !currentDb) {
      setError(t('importDialog.errNoTargetDb'));
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const runImport = async () => {
    if (!file || !sqlText) return;
    setConfirming(false);
    setError(null);
    setSubmitting(true);
    setProgress({ label: t('importDialog.preparing') });
    const startedAt = Date.now();
    try {
      // Ghi đè: chèn DROP ... IF EXISTS lên đầu và cho các tên đó qua bộ lọc theo bảng
      // (backend chỉ chạy câu lệnh có nhắc tên trong danh sách này).
      const objs = overwrite ? parseDumpObjects(sqlText) : null;
      const drops = objs ? buildDropStatements(objs, dbType) : [];
      const finalSql = drops.length ? `${drops.join('\n')}\n${sqlText}` : sqlText;
      const finalTables = objs
        ? [...new Set([...selected, ...objs.views, ...objs.triggers, ...objs.procedures, ...objs.functions])]
        : selected;

      const ok = await onSubmit(finalSql, finalTables, targetDb.trim(), (msg) => {
        const done = msg.done ?? 0;
        const total = msg.total ?? 0;
        if (msg.type === 'start') {
          setProgress({ label: t('importDialog.runningStatements', { n: fmtNum(total) }), current: 0, total });
          return;
        }
        // ETA tính từ tốc độ thật đang chạy, chính xác hơn ước lượng trước khi bấm.
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done > 0 ? done / elapsed : 0;
        const remain = rate > 0 && total > done ? Math.round((total - done) / rate) : 0;
        const counts = { done: fmtNum(done), total: fmtNum(total) };
        setProgress({
          label: t('importDialog.runningOn', { db: targetDb.trim() || currentDb || 'database' }),
          current: done,
          total,
          detail: remain > 0
            ? t('importDialog.statementDetailEta', { ...counts, eta: formatDuration(t, remain) })
            : t('importDialog.statementDetail', counts),
        });
      });
      if (ok) onClose();
    } finally {
      setProgress(null);
      setSubmitting(false);
    }
  };

  const browse = () => inputRef.current?.click();

  // Ước lượng THÔ trước khi chạy (~800 câu lệnh/giây trên server local). Khi chạy thật thì
  // ETA được tính lại từ tốc độ đo được.
  const estimatedSeconds = plannedStatements > 0 ? plannedStatements / 800 : 0;

  return (
    <>
      {/* Tóm tắt trước khi chạy: nhập vào database nào, bao nhiêu bảng/câu lệnh, ước tính bao lâu */}
      <ConfirmDialog
        open={confirming}
        tone={overwrite ? 'danger' : 'info'}
        title={t('importDialog.confirmTitle')}
        message={
          <>
            <div>
              <Trans
                i18nKey="importDialog.restoreInto"
                values={{ db: targetDb.trim() || currentDb || t('importDialog.restoreIntoConnected') }}
                components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
              />
              {canManageDatabases && targetDb.trim() && targetDb.trim() !== currentDb
                ? t('importDialog.willBeCreated')
                : '.'}
            </div>
            <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowTables')}</span>
              <b>{tables.length === 0
                ? t('importDialog.allFile')
                : t('importDialog.tablesCount', { selected: selected.length, total: tables.length })}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowStatements')}</span>
              <b>{fmtNum(plannedStatements)}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowFile')}</span>
              <b>{file ? `${file.name} (${formatSize(file.size)})` : ''}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('importDialog.rowEta')}</span>
              <b>~{formatDuration(t, estimatedSeconds)}</b>
            </div>
          </>
        }
        note={overwrite ? t('importDialog.noteOverwrite') : t('importDialog.noteEstimate')}
        confirmLabel={t('importDialog.startRestore')}
        cancelLabel={t('importDialog.back')}
        onConfirm={runImport}
        onCancel={() => setConfirming(false)}
      />

    <Modal
      title={t('importDialog.title')}
      onClose={onClose}
      closeDisabled={submitting}
      width="820px"
      height="540px"
      zIndex={9999}
    >
        {/* Thân: 2 cột — tệp dump | danh sách bảng trong tệp */}
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
              <label style={labelStyle}>{t('importDialog.sourceFile')}</label>
              <input
                type="text"
                className="form-input"
                readOnly
                value={file ? file.name : ''}
                placeholder={t('importDialog.noFileSelected')}
                onClick={browse}
                style={{ height: '30px', fontSize: '11px', width: '100%', cursor: 'pointer' }}
                title={t('importDialog.pickFileTitle')}
              />
              <button
                className="btn btn-secondary"
                onClick={browse}
                disabled={submitting}
                style={{ marginTop: '6px', width: '100%' }}
              >
                {t('importDialog.pickFile')}
              </button>
              <input
                type="file"
                ref={inputRef}
                onChange={handlePicked}
                accept={ACCEPT}
                style={{ display: 'none' }}
              />
            </div>

            {/* Database đích: tệp có `USE`/`CREATE DATABASE` thì lấy sẵn, không thì phải nhập */}
            {canManageDatabases && !!file && !parsing && !!sqlText && (
              <div className="form-group">
                <label style={labelStyle}>{t('importDialog.targetDb')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={targetDb}
                  onChange={(e) => { setTargetDb(e.target.value); setError(null); }}
                  placeholder={currentDb ? t('importDialog.targetDbPlaceholderConnected', { db: currentDb }) : t('importDialog.targetDbPlaceholder')}
                  disabled={submitting}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '5px', lineHeight: 1.5 }}>
                  {dbFromFile ? (
                    <Trans i18nKey="importDialog.targetFromFile" values={{ db: dbFromFile }} components={{ code: <code style={{ fontFamily: 'monospace' }} /> }} />
                  ) : (
                    <Trans i18nKey="importDialog.targetNotInFile" components={{ strong: <b /> }} />
                  )}
                  {targetDb && currentDb && targetDb !== currentDb && (
                    <div style={{ color: 'var(--st-warn, #d98600)' }}>
                      <Trans i18nKey="importDialog.willSwitchTo" values={{ db: targetDb }} components={{ code: <b style={{ fontFamily: 'monospace' }} /> }} />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <label style={labelStyle}>{t('importDialog.allowedFormats')}</label>
              <div style={{
                padding: '10px',
                background: 'var(--win-bg-window)',
                border: '1px solid var(--win-border)',
                borderRadius: '4px',
                fontSize: '11px',
                color: 'var(--win-text-secondary)',
                lineHeight: 1.6
              }}>
                <div><Trans i18nKey="importDialog.formatSqlDump" components={{ code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} /> }} /></div>
                <div><Trans i18nKey="importDialog.formatGz" components={{ code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} /> }} /></div>
              </div>
            </div>

            {file && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.6 }}>
                {t('importDialog.fileSize')} <b style={{ color: 'var(--win-text-primary)' }}>{formatSize(file.size)}</b>
                {parsing && <div>{t('importDialog.readingTables')}</div>}
                {!parsing && sqlText && (
                  <div><Trans i18nKey="importDialog.contentChars" values={{ n: fmtNum(sqlText.length) }} components={{ strong: <b style={{ color: 'var(--win-text-primary)' }} /> }} /></div>
                )}
              </div>
            )}

            {/* Chạy lại một dump lên database đã có bảng cùng tên -> MySQL báo 1050
                "Table already exists" và cả lần nhập bị rollback. Tuỳ chọn này xoá trước. */}
            <div className="form-group">
              <label style={labelStyle}>{t('importDialog.onExisting')}</label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  disabled={submitting}
                  style={{ marginTop: '2px' }}
                />
                <span>
                  {t('importDialog.overwriteLabel')}
                  <span style={{ display: 'block', color: 'var(--win-text-secondary)', marginTop: '2px' }}>
                    {t('importDialog.overwriteHint')}
                  </span>
                </span>
              </label>
            </div>

            <div style={{
              padding: '10px',
              background: overwrite ? 'rgba(229,72,77,0.10)' : 'rgba(255,170,0,0.08)',
              border: `1px solid ${overwrite ? 'rgba(229,72,77,0.40)' : 'rgba(255,170,0,0.35)'}`,
              borderRadius: '4px',
              fontSize: '11px',
              color: 'var(--win-text-secondary)',
              lineHeight: 1.5
            }}>
              <Trans
                i18nKey={overwrite ? 'importDialog.overwriteWarn' : 'importDialog.noOverwriteWarn'}
                components={{
                  code: <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }} />,
                  strong: <b />,
                }}
              />
              <div style={{ marginTop: '4px' }}>
                <Trans i18nKey="importDialog.mysqlCommitWarn" components={{ strong: <b /> }} />
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Tab: chọn bảng | xem trước cấu trúc | xem trước dữ liệu */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '4px', flex: 1, minWidth: 0 }}>
                {([
                  { id: 'tables', label: t('importDialog.tabTables', { selected: selected.length, total: tables.length }) },
                  { id: 'structure', label: t('importDialog.tabStructure', { n: structureShown.length }) },
                  { id: 'data', label: t('importDialog.tabData', { n: dataShown.length }) },
                ] as const).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '1px solid var(--win-border)',
                      cursor: 'pointer',
                      background: tab === t.id ? 'var(--win-accent)' : 'transparent',
                      color: tab === t.id ? '#fff' : 'var(--win-text-secondary)',
                      fontWeight: 600,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === 'tables' && (
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
                  {allShownSelected ? t('importDialog.deselectAll') : t('importDialog.selectAll')}
                </button>
              )}
            </div>

            {tab === 'tables' ? (
              <>
                <input
                  type="text"
                  className="form-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('importDialog.searchTables')}
                  disabled={tables.length === 0}
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
                  {!file ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                      {t('importDialog.pickFileHint')}
                    </div>
                  ) : parsing ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('importDialog.readingFile')}</div>
                  ) : tables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                      {t('importDialog.noTablesDetected')}
                    </div>
                  ) : shown.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('importDialog.noTableMatch')}</div>
                  ) : (
                    shown.map((name) => (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(name)}
                          onChange={() => setSelected((prev) => prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name])}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                      </label>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', flex: 1, minWidth: 0 }}>
                    {tab === 'structure' ? t('importDialog.previewStructure') : t('importDialog.previewData')}
                    {viewMode === 'sql' && previewClipped && t('importDialog.previewClipped', { n: PREVIEW_LIMIT })}
                    {viewMode === 'visual' && tab === 'data' && t('importDialog.previewRowsNote', { n: PREVIEW_ROWS })}:
                  </div>

                  {/* Chọn bảng để xem (nhiều bảng) — dropdown cho gọn một dòng */}
                  {viewMode === 'visual' && tables.length > 0 && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onClick={() => setShowPreviewPicker((v) => !v)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '3px 9px',
                          fontSize: '10px',
                          borderRadius: '3px',
                          border: '1px solid var(--win-border)',
                          cursor: 'pointer',
                          background: showPreviewPicker ? 'var(--win-bg-hover)' : 'transparent',
                          color: 'var(--win-text-primary)',
                          fontWeight: 600,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {t('importDialog.previewTablesCount', { shown: previewTables.length, total: tables.length })}
                        <ChevronDown size={11} style={{ opacity: 0.7 }} />
                      </button>

                      {showPreviewPicker && (
                        <>
                          <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setShowPreviewPicker(false)} />
                          {/* Nền lấy từ .ws-menu — menu phải đủ đục để không lẫn với bảng phía sau */}
                          <div className="ws-menu" style={{
                            position: 'absolute',
                            top: 'calc(100% + 4px)',
                            right: 0,
                            zIndex: 11,
                            width: '220px',
                            maxHeight: '260px',
                            overflowY: 'auto'
                          }}>
                            <button
                              onClick={() => setPreviewTables(previewTables.length === tables.length ? [] : [...tables])}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '5px 8px',
                                marginBottom: '4px',
                                fontSize: '10px',
                                fontWeight: 600,
                                background: 'transparent',
                                border: 'none',
                                borderBottom: '1px solid var(--win-border)',
                                color: 'var(--win-accent)',
                                cursor: 'pointer'
                              }}
                            >
                              {previewTables.length === tables.length ? t('importDialog.deselectAll') : t('importDialog.selectAll')}
                            </button>
                            {tables.map((name) => (
                              <label
                                key={name}
                                className="sidebar-context-item"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer', borderRadius: '3px' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={previewTables.includes(name)}
                                  onChange={() => togglePreviewTable(name)}
                                />
                                <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Đổi giữa xem trực quan và xem SQL thô */}
                  <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                    {([
                      { id: 'visual', label: t('importDialog.viewVisual') },
                      { id: 'sql', label: 'SQL' },
                    ] as const).map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setViewMode(v.id)}
                        style={{
                          padding: '3px 9px',
                          fontSize: '10px',
                          borderRadius: '3px',
                          border: '1px solid var(--win-border)',
                          cursor: 'pointer',
                          background: viewMode === v.id ? 'var(--win-bg-hover)' : 'transparent',
                          color: viewMode === v.id ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                          fontWeight: 600
                        }}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>

                {viewMode === 'sql' ? (
                  <textarea
                    readOnly
                    value={
                      (tab === 'structure' ? structureShown : dataShown)
                        .slice(0, PREVIEW_LIMIT)
                        .map((s) => clip(s) + ';')
                        .join('\n\n') ||
                      (file
                        ? (parsing ? t('importDialog.readingFile') : t('importDialog.previewEmptyMatch'))
                        : t('importDialog.previewPickFile'))
                    }
                    style={{
                      flex: 1,
                      minHeight: 0,
                      width: '100%',
                      background: 'var(--win-bg-window)',
                      border: '1px solid var(--win-border)',
                      borderRadius: '4px',
                      color: 'var(--win-text-primary)',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      padding: '10px',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                ) : (
                  <div style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: 'auto',
                    border: '1px solid var(--win-border)',
                    borderRadius: '4px',
                    background: 'var(--win-bg-window)',
                    padding: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    {!file ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                        {t('importDialog.previewPickFile')}
                      </div>
                    ) : parsing ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('importDialog.readingFile')}</div>
                    ) : tab === 'structure' ? (
                      visualTables.length === 0 ? (
                        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                          {t('importDialog.noCreateTable')}
                          {structureShown.length > 0 && (
                            <Trans i18nKey="importDialog.noCreateTableMore" values={{ n: structureShown.length }} components={{ strong: <b /> }} />
                          )}.
                        </div>
                      ) : (
                        // Not named `t` — that is the translation function.
                        visualTables.map((vt) => (
                          <div key={vt.name} style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                              {vt.name} <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>{t('importDialog.columnsCount', { n: vt.columns.length })}</span>
                            </div>
                            <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {[t('importDialog.colColumn'), t('importDialog.colType'), t('importDialog.colNull'), t('importDialog.colKey'), t('importDialog.colDefault')].map((h) => (
                                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {vt.columns.map((c) => (
                                  <tr key={c.name} style={{ borderBottom: '1px solid var(--win-border)' }}>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)', whiteSpace: 'nowrap' }}>{c.name}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontFamily: 'monospace' }}>{c.type}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>{c.notNull ? 'NOT NULL' : 'NULL'}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: c.primaryKey ? 'var(--win-accent)' : 'var(--win-text-disabled)', whiteSpace: 'nowrap' }}>
                                      {c.primaryKey
                                        ? (c.autoIncrement ? t('importDialog.pkAuto') : t('importDialog.pk'))
                                        : (c.autoIncrement ? t('importDialog.auto') : '—')}
                                    </td>
                                    <td style={{ padding: '4px 8px', color: 'var(--win-text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                                      {c.defaultValue ?? '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                            {vt.constraints.length > 0 && (
                              <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '4px', lineHeight: 1.5 }}>
                                {vt.constraints.map((c, i) => (
                                  <div key={i} style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))
                      )
                    ) : visualRows.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                        {t('importDialog.noInsert')}
                      </div>
                    ) : (
                      visualRows.map((r) => (
                        <div key={r.table} style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                            {r.table}{' '}
                            <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>
                              {t('importDialog.showingRows', { shown: r.rows.length, total: r.total })}
                            </span>
                          </div>
                          <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {(r.columns || r.rows[0]?.map((_, i) => t('importDialog.unnamedColumn', { n: i + 1 })) || []).map((c, i) => (
                                    <th key={i} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap' }}>{c}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {r.rows.map((row, ri) => (
                                  <tr key={ri} style={{ borderBottom: '1px solid var(--win-border)' }}>
                                    {row.map((v, ci) => (
                                      <td key={ci} style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
                                        {/^NULL$/i.test(v)
                                          ? <span style={{ color: 'var(--win-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                                          : v}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <ModalFooter>
          {progress ? (
            <ProgressBar progress={progress} />
          ) : error ? (
            <span style={{ marginRight: 'auto', fontSize: '11px', color: 'var(--win-error, #ff6b6b)' }}>
              {error}
            </span>
          ) : null}
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            onClick={askConfirm}
            disabled={!canSubmit}
            style={{
              background: canSubmit ? 'var(--win-accent)' : 'var(--win-bg-hover)',
              color: canSubmit ? '#fff' : 'var(--win-text-disabled)',
              border: 'none',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              flexShrink: 0
            }}
          >
            {submitting ? t('importDialog.importing') : t('importDialog.startImport')}
          </button>
        </ModalFooter>
    </Modal>
    </>
  );
};
