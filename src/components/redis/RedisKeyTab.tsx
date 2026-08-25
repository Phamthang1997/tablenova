// View/edit tab for a Redis key.
//
// Value rendering remains in `ValuePanel` — this file provides its tab container: loads key,
// manages key modals (rename / TTL / delete), and handles toast alerts. Previously these
// resided in `RedisBrowser` globally; now each key tab owns its lifecycle.


import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { dbHelper, type RedisValueDetail } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { ValuePanel } from './ValuePanel';
import { useRedisToast } from './useRedisToast';
import { notifyRedisKeysChanged } from './redisTabs';

interface RedisKeyTabProps {
  /** Tab connection — also represents db index, see §2.1. */
  connId: string;
  keyName: string;
  /** localStorage scope for ValuePanel display options — SERVER identifier, not dbName. */
  storageScope: string;
  readOnly: boolean;
  /** Key renamed -> tab must update its title. */
  onRenamed: (next: string) => void;
  /** Key gone -> close tab (user clicked action in empty state). */
  onClose: () => void;
}

export const RedisKeyTab: React.FC<RedisKeyTabProps> = ({
  connId,
  keyName,
  storageScope,
  readOnly,
  onRenamed,
  onClose,
}) => {
  const { t } = useTranslation();
  const { onError, onOk, blocked, node: toast } = useRedisToast(readOnly);

  const [detail, setDetail] = useState<RedisValueDetail | null>(null);
  // Three states rather than two: `loading` differs from `gone`. Merging them would cause the initial render
  // of a valid key to flash a "key no longer exists" warning.
  const [state, setState] = useState<'loading' | 'ready' | 'gone'>('loading');

  const [renaming, setRenaming] = useState(false);
  const [settingTtl, setSettingTtl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const d = await dbHelper.redisGetKey(keyName);
    if (!d.success) {
      // Missing key is NOT an error (§2.5): it may have expired by TTL or been deleted externally
      // between sessions. Renders empty state rather than an error banner.
      setDetail(null);
      setState('gone');
      return;
    }
    setDetail(d);
    setState('ready');
  }, [keyName]);

  // `connId` in deps: identical key name on two db indices represents two distinct keys, and tab is
  // reconstructed by connId, requiring effect to re-run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState('loading');
      const d = await dbHelper.redisGetKey(keyName);
      if (cancelled) return;
      if (!d.success) {
        setDetail(null);
        setState('gone');
        return;
      }
      setDetail(d);
      setState('ready');
    })();
    return () => { cancelled = true; };
  }, [keyName, connId]);

  const doRename = async (next: string) => {
    setRenaming(false);
    if (!next.trim() || next === keyName || blocked()) return;
    const res = await dbHelper.redisRenameKey(keyName, next);
    if (!res.success) { onError(res.error || t('redis.errRename')); return; }
    notifyRedisKeysChanged({ connId, removed: keyName, renamedTo: next });
    onRenamed(next);
  };

  const doSetTtl = async (raw: string) => {
    setSettingTtl(false);
    if (blocked()) return;
    const ttl = parseInt(raw, 10);
    if (Number.isNaN(ttl)) { onError(t('redis.errTtlNotNumber')); return; }
    const res = await dbHelper.redisSetTtl(keyName, ttl);
    if (!res.success) { onError(res.error || t('redis.errTtl')); return; }
    onOk(t('redis.ttlSet'));
    void load();
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    if (blocked()) return;
    const res = await dbHelper.redisDeleteKeys([keyName]);
    if (!res.success) { onError(res.error || t('redis.errDelete')); return; }
    notifyRedisKeysChanged({ connId, removed: keyName });
    setDetail(null);
    setState('gone');
  };

  return (
    <div className="redis-tab">
      {toast}
      <div className="redis-tab-body">
        {state === 'loading' ? null : state === 'gone' ? (
          <div className="redis-empty">
            <KeyRound size={22} />
            <div className="redis-empty-title">{t('redis.keyGone', { key: keyName })}</div>
            <div className="redis-empty-hint">{t('redis.keyGoneHint')}</div>
            <div className="redis-empty-actions">
              <button className="btn btn-secondary" onClick={() => { setState('loading'); void load(); }}>
                {t('redis.retry')}
              </button>
              <button className="btn btn-secondary" onClick={onClose}>{t('redis.closeTab')}</button>
            </div>
          </div>
        ) : detail ? (
          <ValuePanel
            detail={detail}
            storageScope={storageScope}
            readOnly={readOnly}
            onRename={() => setRenaming(true)}
            onSetTtl={() => setSettingTtl(true)}
            onDelete={() => setConfirmDelete(true)}
            onError={onError}
            onOk={onOk}
            onBlocked={blocked}
            onReload={load}
          />
        ) : null}
      </div>

      <PromptDialog
        open={renaming}
        title={t('redis.rename')}
        label={t('redis.promptRename')}
        defaultValue={keyName}
        onSubmit={doRename}
        onCancel={() => setRenaming(false)}
      />
      <PromptDialog
        open={settingTtl}
        title={t('redis.ttlTitle')}
        label={t('redis.promptTtl')}
        defaultValue={String(detail?.ttl ?? -1)}
        note={t('redis.promptTtlNote')}
        onSubmit={doSetTtl}
        onCancel={() => setSettingTtl(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={t('redis.delete')}
        message={t('redis.confirmDeleteKey', { key: keyName })}
        danger
        confirmLabel={t('redis.delete')}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
};
