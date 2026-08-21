// Dialog xuất / nhập keyspace theo prefix.
//
// Toàn bộ phần "làm gì" nằm ở `utils/redisTransfer.ts` (thuần, có test); file này chỉ là giao diện
// cho nó: hai tab, một thanh tiến độ, một bản tóm tắt kết quả. Cùng cách chia như
// `dumpBuilder.ts` ↔ `ExportDatabaseDialog.tsx` bên SQL.
//
// Hai tab trong MỘT dialog chứ không phải hai dialog: chúng dùng chung định dạng tệp, và một người
// vừa xuất xong hay muốn nhập ngay sang db khác để kiểm — tách ra thì phải đóng cái này mở cái kia.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Save, Square, Upload } from 'lucide-react';
import { activeConnId, dbHelper } from '../../utils/dbHelper';
import { runApproved } from '../../utils/safeMode';
import { pickSaveFilePath, saveExportFileAtPath } from '../../utils/fileSave';
import {
  EXPORT_KEY_CAP,
  applyRedisImport,
  buildRedisExport,
  countByType,
  parseRedisExport,
  prefixPattern,
  suggestExportFileName,
  type ParsedExport,
  type RedisDumpEntry,
  type TransferProgress,
} from '../../utils/redisTransfer';
import { Modal, ModalBody, ModalFooter } from '../Modal';

/** Kiểu key mà bộ lọc của dialog biết tới — cùng danh sách với trình duyệt key. */
const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'];

/** Số key lỗi hiện ra trước khi gộp phần còn lại thành một dòng "và N nữa". */
const FAILED_SHOWN = 8;

interface RedisTransferDialogProps {
  open: boolean;
  /** Tab mở sẵn. Menu chuột phải của một nhánh cây key mở thẳng vào `export`. */
  initialTab?: 'export' | 'import';
  /** Prefix điền sẵn (nhánh cây key, hoặc suy ra từ ô tìm kiếm). */
  initialPrefix: string;
  initialTypeFilter: string;
  dbIndex: number;
  readOnly: boolean;
  onClose: () => void;
  /** Đã nhập xong -> danh sách key phải quét lại. */
  onImported: () => void;
  onError: (msg: string) => void;
}

export const RedisTransferDialog: React.FC<RedisTransferDialogProps> = ({
  open,
  initialTab = 'export',
  initialPrefix,
  initialTypeFilter,
  dbIndex,
  readOnly,
  onClose,
  onImported,
  onError,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'export' | 'import'>(initialTab);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  // Cờ dừng đọc trong vòng lặp nên phải là ref: một `useState` chỉ đổi ở lần render sau, tức là
  // vòng lặp đang chạy sẽ đọc giá trị cũ và không bao giờ dừng.
  const stopRef = useRef(false);

  // ---- Xuất ----
  const [prefix, setPrefix] = useState(initialPrefix);
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);
  const [exported, setExported] = useState<{
    text: string; keys: number; missing: number; filtered: number; capped: boolean; stopped: boolean;
  } | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // ---- Nhập ----
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [replace, setReplace] = useState(false);
  const [imported, setImported] = useState<{
    restored: number; skipped: number; failed: { key: string; error: string }[]; stopped: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setPrefix(initialPrefix);
    setTypeFilter(initialTypeFilter);
    setExported(null);
    setSavedPath(null);
    setFileName('');
    setParsed(null);
    setReplace(false);
    setImported(null);
    setProgress(null);
    setRunning(false);
    stopRef.current = false;
  }, [open, initialTab, initialPrefix, initialTypeFilter]);

  const pattern = useMemo(() => prefixPattern(prefix), [prefix]);

  const runExport = useCallback(async () => {
    stopRef.current = false;
    setRunning(true);
    setExported(null);
    setSavedPath(null);
    try {
      const res = await buildRedisExport(
        {
          pattern,
          db: dbIndex,
          typeFilter: typeFilter || undefined,
          // `createdAt` là tham số của builder (nó phải tất định để test được), nên thời điểm
          // được chốt ở đây — chỗ duy nhất biết "bây giờ" là lúc nào.
          createdAt: new Date().toISOString(),
          onProgress: setProgress,
          shouldStop: () => stopRef.current,
        },
        {
          scan: (p, cursor, count) => dbHelper.redisScanKeys(p, cursor, count),
          dump: (keys) => dbHelper.redisDumpKeys(keys),
        },
      );
      setExported({
        text: res.text,
        keys: res.keys,
        missing: res.missing.length,
        filtered: res.filtered,
        capped: res.capped,
        stopped: res.stopped,
      });
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [pattern, dbIndex, typeFilter, onError]);

  const saveFile = useCallback(async () => {
    if (!exported) return;
    const name = suggestExportFileName(dbIndex, prefix, new Date().toISOString());
    const path = await pickSaveFilePath(name, 'ndjson', t('redis.transferFileFilter'));
    if (!path) return;
    try {
      await saveExportFileAtPath(path, exported.text, 'application/x-ndjson');
      setSavedPath(path);
    } catch (e: any) {
      onError(t('redis.transferSaveErr', { message: String(e?.message ?? e) }));
    }
  }, [exported, dbIndex, prefix, t, onError]);

  const pickFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] || null;
    e.target.value = '';
    if (!picked) return;
    setFileName(picked.name);
    setParsed(null);
    setImported(null);
    try {
      const text = await picked.text();
      setParsed(parseRedisExport(text));
    } catch (err: any) {
      onError(t('redis.transferReadFileErr', { message: String(err?.message ?? err) }));
    }
  }, [onError, t]);

  const runImport = useCallback(async () => {
    if (!parsed) return;
    stopRef.current = false;
    setRunning(true);
    setImported(null);
    const detail = t(
      replace ? 'redis.transferApproveReplace' : 'redis.transferApprove',
      { n: parsed.entries.length.toLocaleString(), db: dbIndex },
    );
    try {
      // Cả vòng lặp là MỘT hành động dưới mắt Safe Mode. Không có lớp bọc này thì mỗi lô
      // `redis_restore_keys` là một hộp thoại riêng — 10.000 key thành 50 lần hỏi.
      const res = await runApproved('redis_restore_keys', activeConnId(), detail, () =>
        applyRedisImport(
          parsed.entries as RedisDumpEntry[],
          { restore: (entries, rep) => dbHelper.redisRestoreKeys(entries, rep) },
          { replace, onProgress: setProgress, shouldStop: () => stopRef.current },
        ));
      setImported(res);
      // Gọi kể cả khi bị dừng giữa chừng: những key đã nạp thì đã có thật trong db.
      if (res.restored > 0) onImported();
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [parsed, replace, dbIndex, t, onImported, onError]);

  if (!open) return null;

  const n = (v: number) => v.toLocaleString();
  const byType = parsed ? countByType(parsed.entries) : [];
  const validFile = !!parsed?.header;

  return (
    <Modal
      title={t('redis.transferTitle')}
      icon={<Upload size={14} />}
      onClose={onClose}
      closeDisabled={running}
      width="560px"
      zIndex={10000}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div className="redis-transfer-tabs">
          <button
            className={`btn btn-secondary redis-value-btn wide${tab === 'export' ? ' active' : ''}`}
            onClick={() => setTab('export')}
            disabled={running}
          >
            <Download size={11} /> {t('redis.transferTabExport')}
          </button>
          <button
            className={`btn btn-secondary redis-value-btn wide${tab === 'import' ? ' active' : ''}`}
            onClick={() => setTab('import')}
            disabled={running}
          >
            <Upload size={11} /> {t('redis.transferTabImport')}
          </button>
        </div>

        {/* Đánh đổi của DUMP/RESTORE, nói ngay chứ không để người dùng gặp lỗi checksum rồi mới
            đoán: payload mang footer phiên bản RDB nên chỉ nhập được vào Redis bằng hoặc mới hơn. */}
        <div className="redis-dialog-warn">
          <AlertTriangle size={12} className="redis-dialog-warn-icon" />
          <span>{t('redis.transferVersionNote')}</span>
        </div>

        {tab === 'export' ? (
          <>
            <label className="redis-dialog-label">{t('redis.transferPrefix')}</label>
            <input
              type="text"
              className="form-input redis-dialog-input"
              value={prefix}
              disabled={running}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={t('redis.transferPrefixPlaceholder')}
              spellCheck={false}
            />
            {/* Hiện luôn glob sẽ gửi cho SCAN. Prefix có ký tự đặc biệt (`log[1]:`) được escape,
                nên không hiện ra thì người dùng không có cách nào biết mình sắp xuất tập key nào. */}
            <div className="redis-dialog-label">
              <Trans
                i18nKey="redis.transferPatternPreview"
                values={{ pattern }}
                components={{ code: <b className="redis-dialog-code" /> }}
              />
            </div>

            <label className="redis-dialog-label">{t('redis.transferType')}</label>
            <select
              value={typeFilter}
              disabled={running}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="redis-dialog-select"
            >
              <option value="">{t('redis.allTypes')}</option>
              {TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>

            {running && (
              <div className="redis-dialog-status">
                {progress?.phase === 'dump'
                  ? t('redis.transferDumping', { n: n(progress.done) })
                  : t('redis.transferScanning', { n: n(progress?.done ?? 0) })}
              </div>
            )}

            {exported && (
              <div className={`redis-dialog-status ${exported.keys > 0 ? 'ok' : 'cancelled'}`}>
                <div>
                  {exported.keys > 0
                    ? t('redis.transferExportDone', { n: n(exported.keys) })
                    : t('redis.transferExportEmpty')}
                </div>
                {exported.filtered > 0 && (
                  <div>{t('redis.transferFiltered', { n: n(exported.filtered) })}</div>
                )}
                {exported.missing > 0 && (
                  <div>{t('redis.transferMissing', { n: n(exported.missing) })}</div>
                )}
                {exported.capped && (
                  <div>{t('redis.transferCapped', { n: n(EXPORT_KEY_CAP) })}</div>
                )}
                {exported.stopped && <div>{t('redis.transferStopped')}</div>}
              </div>
            )}

            {savedPath && (
              <div className="redis-dialog-status ok">
                {t('redis.transferSaved', { path: savedPath })}
              </div>
            )}
          </>
        ) : (
          <>
            <label className="redis-dialog-label">{t('redis.transferFile')}</label>
            <div className="redis-transfer-file">
              <label className="btn btn-secondary redis-value-btn wide">
                {t('redis.transferPickFile')}
                <input
                  type="file"
                  accept=".ndjson,.jsonl,.json"
                  onChange={pickFile}
                  disabled={running}
                  className="redis-transfer-file-input"
                />
              </label>
              <span className="redis-dialog-label">{fileName || t('redis.transferFileNone')}</span>
            </div>

            {parsed && !validFile && (
              <div className="redis-dialog-warn">
                <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                <span>{t('redis.transferFileBad')}</span>
              </div>
            )}

            {parsed && validFile && (
              <>
                <div className="redis-dialog-status">
                  <div>
                    {t('redis.transferFileSummary', {
                      n: n(parsed.entries.length),
                      db: parsed.header?.db ?? 0,
                      pattern: parsed.header?.pattern ?? '*',
                    })}
                  </div>
                  {byType.length > 0 && (
                    <div>{byType.map((b) => `${b.type} ${n(b.n)}`).join(' · ')}</div>
                  )}
                </div>

                {/* Thiếu footer = bản xuất bị dừng, chạm trần, hoặc tệp bị cắt. Vẫn nhập được
                    phần đang có, nhưng người dùng phải biết nó không đủ. */}
                {parsed.truncated && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>{t('redis.transferFileTruncated')}</span>
                  </div>
                )}
                {parsed.declaredKeys != null && parsed.declaredKeys !== parsed.entries.length && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>
                      {t('redis.transferDeclaredMismatch', {
                        declared: n(parsed.declaredKeys),
                        n: n(parsed.entries.length),
                      })}
                    </span>
                  </div>
                )}
                {parsed.badLines.length > 0 && (
                  <div className="redis-dialog-warn">
                    <AlertTriangle size={12} className="redis-dialog-warn-icon" />
                    <span>
                      {t('redis.transferFileBadLines', {
                        n: n(parsed.badLines.length),
                        lines: parsed.badLines.slice(0, 5).join(', '),
                      })}
                    </span>
                  </div>
                )}

                <label className="redis-dialog-label block">
                  <input
                    type="checkbox"
                    checked={replace}
                    disabled={running || readOnly}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  <span>{t('redis.transferReplace')}</span>
                </label>
                <div className="redis-dialog-label">{t('redis.transferReplaceHint')}</div>
              </>
            )}

            {running && (
              <div className="redis-dialog-status">
                {t('redis.transferRestoring', {
                  done: n(progress?.done ?? 0),
                  total: n(progress?.total ?? 0),
                })}
              </div>
            )}

            {imported && (
              <div className={`redis-dialog-status ${imported.failed.length ? 'cancelled' : 'ok'}`}>
                <div>
                  {t('redis.transferImportDone', {
                    restored: n(imported.restored),
                    skipped: n(imported.skipped),
                    failed: n(imported.failed.length),
                  })}
                </div>
                {imported.stopped && <div>{t('redis.transferStoppedImport')}</div>}
                {imported.failed.length > 0 && (
                  <div className="redis-mono-box redis-transfer-failed">
                    {imported.failed.slice(0, FAILED_SHOWN).map((f) => (
                      <div key={f.key}>{`${f.key} — ${f.error}`}</div>
                    ))}
                    {imported.failed.length > FAILED_SHOWN && (
                      <div>{t('redis.transferFailedMore', {
                        n: n(imported.failed.length - FAILED_SHOWN),
                      })}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        {running ? (
          <button
            className="btn btn-secondary redis-value-save danger"
            onClick={() => { stopRef.current = true; }}
          >
            <Square size={10} /> {t('redis.transferStop')}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
            {tab === 'export' ? (
              <>
                {exported && exported.keys > 0 && (
                  <button className="btn btn-secondary redis-value-save" onClick={saveFile}>
                    <Save size={11} /> {t('redis.transferSave')}
                  </button>
                )}
                <button className="btn btn-primary redis-value-save" onClick={runExport}>
                  <Download size={11} /> {t('redis.transferRunExport')}
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary redis-value-save"
                onClick={runImport}
                // Chế độ chỉ đọc: chốt thật ở Rust (`ensure_writable`), nút này chỉ để không mời
                // người dùng bấm vào một việc chắc chắn bị từ chối.
                disabled={readOnly || !validFile || parsed.entries.length === 0}
                title={readOnly ? t('redis.errReadOnly') : undefined}
              >
                <Upload size={11} /> {t('redis.transferRunImport')}
              </button>
            )}
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
