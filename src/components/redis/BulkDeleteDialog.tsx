import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Square, Trash2 } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { Modal, ModalBody, ModalFooter } from '../Modal';

interface BulkDeleteDialogProps {
  open: boolean;
  initialPattern: string;
  initialTypeFilter: string;
  onClose: () => void;
  /** Called once the run finished (or was cancelled) so the key list can refresh. */
  onDone: (deleted: number) => void;
  onError: (msg: string) => void;
}

/**
 * Deletes every key matching a pattern, with progress and a cancel button.
 *
 * The count is reported as it goes because it cannot be known in advance — the backend scans
 * and unlinks in batches. Confirmation requires retyping the pattern: this is the one action in
 * the Redis panel that can remove millions of keys from a single click.
 */
export const BulkDeleteDialog: React.FC<BulkDeleteDialogProps> = ({
  open, initialPattern, initialTypeFilter, onClose, onDone, onError,
}) => {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState(initialPattern);
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ scanned: 0, deleted: 0 });
  const [result, setResult] = useState<{ scanned: number; deleted: number; cancelled: boolean } | null>(null);
  const idRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setPattern(initialPattern);
    setTypeFilter(initialTypeFilter);
    setTyped('');
    setRunning(false);
    setProgress({ scanned: 0, deleted: 0 });
    setResult(null);
  }, [open, initialPattern, initialTypeFilter]);

  if (!open) return null;

  const ready = typed.trim() === pattern.trim() && pattern.trim() !== '';

  const start = async () => {
    const id = `rdel_${crypto.randomUUID()}`;
    idRef.current = id;
    setRunning(true);
    setResult(null);
    await dbHelper.redisDeleteByPattern(pattern.trim(), typeFilter || undefined, id, (msg: any) => {
      if (idRef.current !== id) return;
      if (msg.type === 'progress') {
        setProgress({ scanned: msg.scanned ?? 0, deleted: msg.deleted ?? 0 });
      } else if (msg.type === 'done') {
        setRunning(false);
        setResult({ scanned: msg.scanned ?? 0, deleted: msg.deleted ?? 0, cancelled: !!msg.cancelled });
        onDone(msg.deleted ?? 0);
      } else if (msg.type === 'error') {
        setRunning(false);
        onError(msg.message || t('redis.errDelete'));
      }
    }).catch((e) => {
      setRunning(false);
      onError(String(e));
    });
  };

  const cancel = () => {
    if (idRef.current) dbHelper.cancelQuery(idRef.current);
  };

  return (
    <Modal
      title={t('redis.bulkDeleteTitle')}
      icon={<Trash2 size={14} className="redis-dialog-danger-icon" />}
      onClose={onClose}
      closeDisabled={running}
      width="480px"
      zIndex={10000}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div className="redis-dialog-label">{t('redis.bulkDeleteDesc')}</div>

        <label className="redis-dialog-label">{t('redis.bulkDeletePattern')}</label>
        <input
          type="text"
          className="form-input redis-dialog-input"
          value={pattern}
          disabled={running}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
        />

        <label className="redis-dialog-label">{t('redis.bulkDeleteType')}</label>
        <select
          value={typeFilter}
          disabled={running}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="redis-dialog-select"
        >
          <option value="">{t('redis.allTypes')}</option>
          <option value="string">string</option>
          <option value="hash">hash</option>
          <option value="list">list</option>
          <option value="set">set</option>
          <option value="zset">zset</option>
          <option value="stream">stream</option>
        </select>

        <div className="redis-dialog-warn">
          <AlertTriangle size={12} className="redis-dialog-warn-icon" />
          <span>{t('redis.bulkDeleteWarning')}</span>
        </div>

        {!running && !result && (
          <div>
            <label className="redis-dialog-label block">
              <Trans
                i18nKey="redis.bulkDeleteTypeToConfirm"
                values={{ text: pattern }}
                components={{ code: <b className="redis-dialog-code" /> }}
              />
            </label>
            <input
              type="text"
              className="form-input redis-dialog-input"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        {running && (
          <div className="redis-dialog-status">
            {t('redis.bulkDeleteProgress', {
              scanned: progress.scanned.toLocaleString(),
              deleted: progress.deleted.toLocaleString(),
            })}
          </div>
        )}

        {result && (
          <div className={'redis-dialog-status ' + (result.cancelled ? 'cancelled' : 'ok')}>
            {result.cancelled
              ? t('redis.bulkDeleteCancelled', {
                  scanned: result.scanned.toLocaleString(),
                  deleted: result.deleted.toLocaleString(),
                })
              : t('redis.bulkDeleteDone', {
                  scanned: result.scanned.toLocaleString(),
                  deleted: result.deleted.toLocaleString(),
                })}
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        {running ? (
          <button className="btn btn-secondary redis-value-save danger" onClick={cancel}>
            <Square size={10} /> {t('common.cancel')}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
            {!result && (
              <button
                className="btn btn-primary redis-danger-btn"
                onClick={start}
                disabled={!ready}
                // Four properties previously calculated via `ready` were refactored into `.redis-danger-btn` +
                // `:disabled` — `ready` binds to `disabled` attribute directly, allowing CSS to infer state.
              >
                {t('redis.bulkDeleteRun')}
              </button>
            )}
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
