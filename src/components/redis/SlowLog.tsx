import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2, Save, Timer } from 'lucide-react';
import i18n from '../../i18n';
import { dbHelper, type RedisSlowLogEntry } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatMicros } from './shared';

interface SlowLogProps {
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
}

/**
 * SLOWLOG viewer: the commands the server itself flagged as slow.
 *
 * The two thresholds are server configuration (`slowlog-log-slower-than`, `slowlog-max-len`),
 * so changing them is a write and obeys read-only mode — as does RESET, which discards the
 * server's log for every client, not just this one.
 */
export const SlowLog: React.FC<SlowLogProps> = ({ readOnly, onError, onOk, onBlocked }) => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RedisSlowLogEntry[]>([]);
  const [len, setLen] = useState(0);
  const [threshold, setThreshold] = useState('');
  const [maxLen, setMaxLen] = useState('');
  const [auto, setAuto] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await dbHelper.redisSlowlogGet(128);
    setLoading(false);
    if (!res.success) { onError(res.error || t('redis.errSlowlog')); return; }
    setEntries(res.entries);
    setLen(res.len);
    if (res.thresholdUs != null) setThreshold(String(res.thresholdUs));
    if (res.maxLen != null) setMaxLen(String(res.maxLen));
  }, [onError, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [auto, load]);

  const saveConfig = async () => {
    if (onBlocked()) return;
    const th = parseInt(threshold, 10);
    const ml = parseInt(maxLen, 10);
    const res = await dbHelper.redisSlowlogConfig(
      Number.isNaN(th) ? undefined : th,
      Number.isNaN(ml) ? undefined : ml,
    );
    if (!res.success) { onError(res.error || t('redis.errSlowlogConfig')); return; }
    onOk(t('redis.slowlogConfigSaved'));
    load();
  };

  const doReset = async () => {
    setConfirmReset(false);
    if (onBlocked()) return;
    const res = await dbHelper.redisSlowlogReset();
    if (!res.success) { onError(res.error || t('redis.errSlowlog')); return; }
    onOk(t('redis.slowlogReset'));
    load();
  };

  return (
    <div className="redis-panel tight">
      <div className="redis-value-bar">
        <span className="redis-tool-title">
          <Timer size={14} /> {t('redis.slowlogTitle')}
        </span>
        <span className="redis-value-meta">{t('redis.slowlogLen', { n: len.toLocaleString() })}</span>
        <div className="redis-keylist-spacer" />
        <label className="redis-tool-check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t('redis.autoRefresh5s')}
        </label>
        <button className="btn btn-secondary redis-value-save" onClick={load} disabled={loading}>
          <RefreshCw size={11} /> {t('redis.refresh')}
        </button>
        <button className="btn btn-secondary redis-value-save danger" onClick={() => setConfirmReset(true)} disabled={readOnly}>
          <Trash2 size={11} /> {t('redis.slowlogResetBtn')}
        </button>
      </div>

      <div className="redis-value-bar config">
        <span>{t('redis.slowlogThreshold')}</span>
        <input
          type="text"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          disabled={readOnly}
          className="redis-tool-input narrow"
        />
        <span>{t('redis.slowlogMaxLen')}</span>
        <input
          type="text"
          value={maxLen}
          onChange={(e) => setMaxLen(e.target.value)}
          disabled={readOnly}
          className="redis-tool-input narrow"
        />
        {!readOnly && (
          <button className="btn btn-secondary redis-keylist-mode" onClick={saveConfig}>
            <Save size={10} /> {t('common.save')}
          </button>
        )}
        <span className="redis-cell-hint">{t('redis.slowlogConfigNote')}</span>
      </div>

      <div className="redis-table-wrap">
        <table className="grid-table redis-table">
          <thead>
            <tr>
              <th className="redis-col-60">ID</th>
              <th className="redis-col-150">{t('redis.colTime')}</th>
              <th className="redis-col-90">{t('redis.colDuration')}</th>
              <th>{t('redis.colCommand')}</th>
              <th className="redis-col-130">{t('redis.colClient')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={5} className="redis-table-empty">{t('redis.slowlogEmpty')}</td></tr>
            )}
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="redis-cell">{e.id}</td>
                <td className="redis-cell">{new Date(e.timestamp * 1000).toLocaleString(i18n.language)}</td>
                <td className={`redis-cell${e.durationUs > 100_000 ? ' slow' : ''}`}>{formatMicros(e.durationUs)}</td>
                <td className="redis-cell">{e.args.join(' ')}</td>
                <td className="redis-cell">{e.clientName ? `${e.clientAddr} (${e.clientName})` : e.clientAddr}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title={t('redis.slowlogResetTitle')}
        message={t('redis.slowlogResetConfirm')}
        note={t('redis.slowlogResetNote')}
        danger
        confirmLabel={t('redis.slowlogResetBtn')}
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
};
