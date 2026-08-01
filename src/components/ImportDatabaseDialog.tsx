import React, { useEffect, useRef, useState } from 'react';
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
async function gunzipToText(file: File): Promise<string> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error('WebView không hỗ trợ giải nén gzip, hãy giải nén tệp trước.');
  const stream = file.stream().pipeThrough(new DS('gzip'));
  return await new Response(stream).text();
}

/** Giây -> "12 giây" / "2 phút 5 giây" / "1 giờ 3 phút" cho phần ước tính và ETA. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest ? `${m} phút ${rest} giây` : `${m} phút`;
  }
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM ? `${h} giờ ${restM} phút` : `${h} giờ`;
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
      setError('Chỉ nhận tệp dump .sql, .sql.gz hoặc .dump.');
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
      setProgress({ label: lower.endsWith('.gz') ? 'Đang giải nén tệp...' : 'Đang đọc tệp...' });
      const text = lower.endsWith('.gz') ? await gunzipToText(picked) : await picked.text();
      setSqlText(text);
      setProgress({ label: 'Đang phân tích câu lệnh trong tệp...' });
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
      setError('Không đọc được tệp: ' + (err?.message || err));
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
      setError('Nhập tên database đích trước khi nhập dữ liệu.');
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
    setProgress({ label: 'Đang chuẩn bị...' });
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
          setProgress({ label: `Đang chạy ${total.toLocaleString()} câu lệnh...`, current: 0, total });
          return;
        }
        // ETA tính từ tốc độ thật đang chạy, chính xác hơn ước lượng trước khi bấm.
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done > 0 ? done / elapsed : 0;
        const remain = rate > 0 && total > done ? Math.round((total - done) / rate) : 0;
        setProgress({
          label: `Đang chạy câu lệnh trên ${targetDb.trim() || currentDb || 'database'}...`,
          current: done,
          total,
          detail: `${done.toLocaleString()}/${total.toLocaleString()} câu lệnh${remain > 0 ? ` · còn ~${formatDuration(remain)}` : ''}`,
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
        title="Xác nhận khôi phục dữ liệu"
        message={
          <>
            <div>
              Khôi phục vào database{' '}
              <b style={{ fontFamily: 'monospace' }}>{targetDb.trim() || currentDb || '(đang kết nối)'}</b>
              {canManageDatabases && targetDb.trim() && targetDb.trim() !== currentDb && (
                <> — chưa tồn tại thì sẽ được tạo mới.</>
              )}
            </div>
            <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
              <span style={{ color: 'var(--win-text-secondary)' }}>Bảng:</span>
              <b>{tables.length === 0 ? 'toàn bộ tệp' : `${selected.length}/${tables.length} bảng`}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>Câu lệnh sẽ chạy:</span>
              <b>{plannedStatements.toLocaleString()}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>Tệp:</span>
              <b>{file ? `${file.name} (${formatSize(file.size)})` : ''}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>Ước tính:</span>
              <b>~{formatDuration(estimatedSeconds)}</b>
            </div>
          </>
        }
        note={
          overwrite
            ? 'Các đối tượng trùng tên sẽ bị DROP rồi tạo lại — dữ liệu hiện có của chúng mất hẳn.'
            : 'Ước tính chỉ là tương đối; khi chạy sẽ hiện tiến độ và thời gian còn lại thật.'
        }
        confirmLabel="Bắt đầu khôi phục"
        cancelLabel="Quay lại"
        onConfirm={runImport}
        onCancel={() => setConfirming(false)}
      />

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
            Nhập Cơ sở dữ liệu (Import Database)
          </span>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', fontSize: '16px' }}
          >
            ×
          </button>
        </div>

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
              <label style={labelStyle}>Tệp dump (Source file):</label>
              <input
                type="text"
                className="form-input"
                readOnly
                value={file ? file.name : ''}
                placeholder="Chưa chọn tệp..."
                onClick={browse}
                style={{ height: '30px', fontSize: '11px', width: '100%', cursor: 'pointer' }}
                title="Bấm để chọn tệp"
              />
              <button
                className="btn btn-secondary"
                onClick={browse}
                disabled={submitting}
                style={{ marginTop: '6px', width: '100%' }}
              >
                Chọn tệp...
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
                <label style={labelStyle}>Database đích:</label>
                <input
                  type="text"
                  className="form-input"
                  value={targetDb}
                  onChange={(e) => { setTargetDb(e.target.value); setError(null); }}
                  placeholder={currentDb ? `Nhập tên database (đang kết nối: ${currentDb})` : 'Nhập tên database'}
                  disabled={submitting}
                  style={{ height: '30px', fontSize: '11px', width: '100%' }}
                />
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '5px', lineHeight: 1.5 }}>
                  {dbFromFile ? (
                    <>Lấy từ tệp (<code style={{ fontFamily: 'monospace' }}>USE {dbFromFile}</code>) — sửa được nếu muốn nhập sang database khác.</>
                  ) : (
                    <>Tệp không nói database nào. Nhập tên database để nhập vào; <b>chưa có thì sẽ được tạo mới</b>.</>
                  )}
                  {targetDb && currentDb && targetDb !== currentDb && (
                    <div style={{ color: 'var(--st-warn, #d98600)' }}>
                      Sẽ chuyển kết nối sang <b style={{ fontFamily: 'monospace' }}>{targetDb}</b> trước khi nhập.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <label style={labelStyle}>Định dạng cho phép:</label>
              <div style={{
                padding: '10px',
                background: 'var(--win-bg-window)',
                border: '1px solid var(--win-border)',
                borderRadius: '4px',
                fontSize: '11px',
                color: 'var(--win-text-secondary)',
                lineHeight: 1.6
              }}>
                <div><code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>.sql</code> / <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>.dump</code> — dump SQL dạng text.</div>
                <div><code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>.sql.gz</code> — tự giải nén trước khi chạy.</div>
              </div>
            </div>

            {file && (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.6 }}>
                Kích thước: <b style={{ color: 'var(--win-text-primary)' }}>{formatSize(file.size)}</b>
                {parsing && <div>Đang đọc danh sách bảng...</div>}
                {!parsing && sqlText && (
                  <div>Nội dung: <b style={{ color: 'var(--win-text-primary)' }}>{sqlText.length.toLocaleString()}</b> ký tự SQL</div>
                )}
              </div>
            )}

            {/* Chạy lại một dump lên database đã có bảng cùng tên -> MySQL báo 1050
                "Table already exists" và cả lần nhập bị rollback. Tuỳ chọn này xoá trước. */}
            <div className="form-group">
              <label style={labelStyle}>Khi đối tượng đã tồn tại:</label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  disabled={submitting}
                  style={{ marginTop: '2px' }}
                />
                <span>
                  Ghi đè: xoá bảng/view/trigger/routine trùng tên trước khi tạo lại
                  <span style={{ display: 'block', color: 'var(--win-text-secondary)', marginTop: '2px' }}>
                    Không bật thì gặp bảng đã tồn tại sẽ lỗi và huỷ toàn bộ lần nhập.
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
              {overwrite ? (
                <>
                  Sẽ chạy <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>DROP … IF EXISTS</code>{' '}
                  cho các đối tượng có trong tệp, <b>xoá sạch dữ liệu hiện có của chúng</b>, rồi mới tạo lại.
                </>
              ) : (
                <>
                  Câu lệnh trong tệp chạy trực tiếp trên database đích.
                  Nếu dump có <code style={{ fontFamily: 'monospace', color: 'var(--win-text-primary)' }}>DROP TABLE</code> thì
                  dữ liệu hiện có của các bảng đó sẽ bị ghi đè.
                </>
              )}
              <div style={{ marginTop: '4px' }}>
                Có transaction, nhưng MySQL <b>tự commit ngầm</b> ở mỗi lệnh DDL — lỗi giữa đường vẫn
                có thể để lại một phần cấu trúc đã tạo.
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Tab: chọn bảng | xem trước cấu trúc | xem trước dữ liệu */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '4px', flex: 1, minWidth: 0 }}>
                {([
                  { id: 'tables', label: `Bảng (${selected.length}/${tables.length})` },
                  { id: 'structure', label: `Cấu trúc (${structureShown.length})` },
                  { id: 'data', label: `Dữ liệu (${dataShown.length})` },
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
                  {allShownSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
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
                  placeholder="Tìm bảng..."
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
                      Chọn tệp dump ở cột bên trái để xem các bảng có trong tệp.
                    </div>
                  ) : parsing ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Đang đọc tệp...</div>
                  ) : tables.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                      Không dò được tên bảng nào trong tệp — toàn bộ câu lệnh trong tệp sẽ được chạy.
                    </div>
                  ) : shown.length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>Không có bảng khớp từ khoá.</div>
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
                    {tab === 'structure' ? 'Cấu trúc trong tệp' : 'Dữ liệu trong tệp'}
                    {viewMode === 'sql' && previewClipped && <> — {PREVIEW_LIMIT} câu lệnh đầu</>}
                    {viewMode === 'visual' && tab === 'data' && <> — {PREVIEW_ROWS} dòng đầu mỗi bảng</>}:
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
                        Bảng: {previewTables.length}/{tables.length}
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
                              {previewTables.length === tables.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
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
                      { id: 'visual', label: 'Trực quan' },
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
                        ? (parsing ? 'Đang đọc tệp...' : 'Không có câu lệnh nào khớp lựa chọn hiện tại.')
                        : 'Chọn tệp dump ở cột bên trái để xem trước.')
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
                        Chọn tệp dump ở cột bên trái để xem trước.
                      </div>
                    ) : parsing ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>Đang đọc tệp...</div>
                    ) : tab === 'structure' ? (
                      visualTables.length === 0 ? (
                        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', lineHeight: 1.5 }}>
                          Tệp không có câu lệnh CREATE TABLE nào cho các bảng đang chọn
                          {structureShown.length > 0 && <> — xem tab <b>SQL</b> để đọc {structureShown.length} câu lệnh cấu trúc khác (ALTER/DROP/CREATE INDEX)</>}.
                        </div>
                      ) : (
                        visualTables.map((t) => (
                          <div key={t.name} style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                              {t.name} <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>({t.columns.length} cột)</span>
                            </div>
                            <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {['Cột', 'Kiểu', 'NULL', 'Khoá', 'Mặc định'].map((h) => (
                                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, borderRight: '1px solid var(--win-border)', whiteSpace: 'nowrap' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {t.columns.map((c) => (
                                  <tr key={c.name} style={{ borderBottom: '1px solid var(--win-border)' }}>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', fontFamily: 'monospace', color: 'var(--win-text-primary)', whiteSpace: 'nowrap' }}>{c.name}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontFamily: 'monospace' }}>{c.type}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>{c.notNull ? 'NOT NULL' : 'NULL'}</td>
                                    <td style={{ padding: '4px 8px', borderRight: '1px solid var(--win-border)', color: c.primaryKey ? 'var(--win-accent)' : 'var(--win-text-disabled)', whiteSpace: 'nowrap' }}>
                                      {c.primaryKey ? (c.autoIncrement ? 'PK, tự tăng' : 'PK') : (c.autoIncrement ? 'tự tăng' : '—')}
                                    </td>
                                    <td style={{ padding: '4px 8px', color: 'var(--win-text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                                      {c.defaultValue ?? '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                            {t.constraints.length > 0 && (
                              <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)', marginTop: '4px', lineHeight: 1.5 }}>
                                {t.constraints.map((c, i) => (
                                  <div key={i} style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))
                      )
                    ) : visualRows.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>
                        Tệp không có câu lệnh INSERT nào cho các bảng đang chọn.
                      </div>
                    ) : (
                      visualRows.map((r) => (
                        <div key={r.table} style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)', marginBottom: '4px', fontFamily: 'monospace' }}>
                            {r.table}{' '}
                            <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)', fontFamily: 'inherit' }}>
                              (hiện {r.rows.length}/{r.total} dòng)
                            </span>
                          </div>
                          <div style={{ overflowX: 'auto', minWidth: 0 }}>
                            <table style={{ minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ background: 'var(--win-bg-hover)', borderBottom: '1px solid var(--win-border)' }}>
                                  {(r.columns || r.rows[0]?.map((_, i) => `cột ${i + 1}`) || []).map((c, i) => (
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
            {submitting ? 'Đang nhập...' : 'Bắt đầu Nhập'}
          </button>
        </div>
      </div>
    </div>
    </>
  );
};
