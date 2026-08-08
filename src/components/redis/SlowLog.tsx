import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2, Save, Timer } from 'lucide-react';
import i18n from '../../i18n';
import { dbHelper, type RedisSlowLogEntry } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { cellStyle, formatMicros } from './shared';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Timer size={14} /> {t('redis.slowlogTitle')}
        </span>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.slowlogLen', { n: len.toLocaleString() })}</span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--win-text-secondary)' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t('redis.autoRefresh5s')}
        </label>
        <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <RefreshCw size={11} /> {t('redis.refresh')}
        </button>
        <button className="btn btn-secondary" onClick={() => setConfirmReset(true)} disabled={readOnly} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)' }}>
          <Trash2 size={11} /> {t('redis.slowlogResetBtn')}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '10px', color: 'var(--win-text-secondary)' }}>
        <span>{t('redis.slowlogThreshold')}</span>
        <input
          type="text"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          disabled={readOnly}
          style={{ width: '90px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--win-font-mono)', padding: '3px 6px' }}
        />
        <span>{t('redis.slowlogMaxLen')}</span>
        <input
          type="text"
          value={maxLen}
          onChange={(e) => setMaxLen(e.target.value)}
          disabled={readOnly}
          style={{ width: '90px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--win-font-mono)', padding: '3px 6px' }}
        />
        {!readOnly && (
          <button className="btn btn-secondary" onClick={saveConfig} style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Save size={10} /> {t('common.save')}
          </button>
        )}
        <span style={{ color: 'var(--win-text-disabled)' }}>{t('redis.slowlogConfigNote')}</span>
      </div>

      <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
        <table className="grid-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '60px' }}>ID</th>
              <th style={{ width: '150px' }}>{t('redis.colTime')}</th>
              <th style={{ width: '90px' }}>{t('redis.colDuration')}</th>
              <th>{t('redis.colCommand')}</th>
              <th style={{ width: '130px' }}>{t('redis.colClient')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: '12px', color: 'var(--win-text-disabled)' }}>{t('redis.slowlogEmpty')}</td></tr>
            )}
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={cellStyle}>{e.id}</td>
                <td style={cellStyle}>{new Date(e.timestamp * 1000).toLocaleString(i18n.language)}</td>
                <td style={{ ...cellStyle, color: e.durationUs > 100_000 ? 'var(--st-danger)' : undefined }}>{formatMicros(e.durationUs)}</td>
                <td style={cellStyle}>{e.args.join(' ')}</td>
                <td style={cellStyle}>{e.clientName ? `${e.clientAddr} (${e.clientName})` : e.clientAddr}</td>
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
