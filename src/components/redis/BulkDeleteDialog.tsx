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
      icon={<Trash2 size={14} style={{ color: 'var(--st-danger)' }} />}
      onClose={onClose}
      closeDisabled={running}
      width="480px"
      zIndex={10000}
    >
      <ModalBody style={{ gap: '10px' }}>
        <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('redis.bulkDeleteDesc')}</div>

        <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('redis.bulkDeletePattern')}</label>
        <input
          type="text"
          className="form-input"
          value={pattern}
          disabled={running}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
          style={{ height: '30px', fontSize: '11px', fontFamily: 'var(--win-font-mono)' }}
        />

        <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('redis.bulkDeleteType')}</label>
        <select
          value={typeFilter}
          disabled={running}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{ height: '30px', fontSize: '11px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px' }}
        >
          <option value="">{t('redis.allTypes')}</option>
          <option value="string">string</option>
          <option value="hash">hash</option>
          <option value="list">list</option>
          <option value="set">set</option>
          <option value="zset">zset</option>
          <option value="stream">stream</option>
        </select>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '10px', color: '#f59e0b', lineHeight: 1.5 }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>{t('redis.bulkDeleteWarning')}</span>
        </div>

        {!running && !result && (
          <div>
            <label style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'block', marginBottom: '6px' }}>
              <Trans
                i18nKey="redis.bulkDeleteTypeToConfirm"
                values={{ text: pattern }}
                components={{ code: <b style={{ color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-mono)' }} /> }}
              />
            </label>
            <input
              type="text"
              className="form-input"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              style={{ height: '30px', fontSize: '11px', width: '100%', fontFamily: 'var(--win-font-mono)' }}
            />
          </div>
        )}

        {running && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-primary)' }}>
            {t('redis.bulkDeleteProgress', {
              scanned: progress.scanned.toLocaleString(),
              deleted: progress.deleted.toLocaleString(),
            })}
          </div>
        )}

        {result && (
          <div style={{ fontSize: '11px', color: result.cancelled ? '#f59e0b' : 'var(--st-ok, #10b981)' }}>
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
          <button className="btn btn-secondary" onClick={cancel} style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)' }}>
            <Square size={10} /> {t('common.cancel')}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>
            {!result && (
              <button
                className="btn btn-primary"
                onClick={start}
                disabled={!ready}
                style={{
                  background: ready ? 'var(--st-danger)' : 'var(--win-bg-hover)',
                  color: ready ? '#fff' : 'var(--win-text-disabled)',
                  border: 'none',
                  cursor: ready ? 'pointer' : 'not-allowed',
                }}
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
