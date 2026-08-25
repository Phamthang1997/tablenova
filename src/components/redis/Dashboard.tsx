import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, RefreshCw } from 'lucide-react';
import i18n from '../../i18n';
import { dbHelper } from '../../utils/dbHelper';

interface DashboardProps {
  dbIndex: number;
  onError: (msg: string) => void;
}

/** Server overview from a single INFO call. */
export const Dashboard: React.FC<DashboardProps> = ({ dbIndex, onError }) => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<any>(null);
  const [auto, setAuto] = useState(false);

  const load = useCallback(async () => {
    const res = await dbHelper.redisInfo();
    if (res.success) setInfo(res.info);
    else onError(res.error || t('redis.errInfo'));
  }, [onError, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await dbHelper.redisInfo();
      if (cancelled) return;
      if (res.success) setInfo(res.info);
      else onError(res.error || t('redis.errInfo'));
    })();
    return () => { cancelled = true; };
  }, [onError, t]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [auto, load]);

  const g = (section: string, key: string) => info?.[section]?.[key];
  const num = (v: any) => (v == null || v === '' ? '-' : Number(v).toLocaleString(i18n.language));

  // Keyspace is reported per database (`db0:keys=1,expires=0`), so read the active index
  // rather than hardcoding db0 as this panel used to.
  const keyspace = String(g('Keyspace', `db${dbIndex}`) || '');
  const keysInDb = keyspace.split(',')[0]?.replace('keys=', '') ?? '';

  const hits = Number(g('Stats', 'keyspace_hits'));
  const misses = Number(g('Stats', 'keyspace_misses'));

  const stats = [
    { label: t('redis.statVersion'), val: g('Server', 'redis_version') },
    { label: t('redis.statMode'), val: g('Server', 'redis_mode') },
    { label: t('redis.statUptime'), val: num(g('Server', 'uptime_in_days')) },
    { label: t('redis.statClients'), val: num(g('Clients', 'connected_clients')) },
    { label: t('redis.statMemory'), val: g('Memory', 'used_memory_human') },
    { label: t('redis.statMemoryPeak'), val: g('Memory', 'used_memory_peak_human') },
    { label: t('redis.statMaxMemory'), val: g('Memory', 'maxmemory_human') },
    { label: t('redis.statEvictionPolicy'), val: g('Memory', 'maxmemory_policy') },
    { label: t('redis.statKeysInDb', { db: dbIndex }), val: keysInDb ? num(keysInDb) : '-' },
    { label: t('redis.statOps'), val: num(g('Stats', 'instantaneous_ops_per_sec')) },
    {
      label: t('redis.statHitRate'),
      val: hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : '-',
    },
    { label: t('redis.statTotalConnections'), val: num(g('Stats', 'total_connections_received')) },
    { label: t('redis.statExpiredKeys'), val: num(g('Stats', 'expired_keys')) },
    { label: t('redis.statEvictedKeys'), val: num(g('Stats', 'evicted_keys')) },
    { label: t('redis.statRole'), val: g('Replication', 'role') },
    { label: t('redis.statConnectedReplicas'), val: num(g('Replication', 'connected_slaves')) },
  ];

  return (
    <div className="redis-panel">
      <div className="redis-value-bar spread">
        <span className="redis-tool-title">
          <Layers size={14} /> {t('redis.dashboardTitle')}
        </span>
        <div className="redis-stream-bar">
          <label className="redis-tool-check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t('redis.autoRefresh5s')}
          </label>
          <button className="btn btn-secondary redis-value-save" onClick={load}>
            <RefreshCw size={11} /> {t('redis.refresh')}
          </button>
        </div>
      </div>
      {!info ? (
        <div className="redis-panel-loading">{t('redis.loadingInfo')}</div>
      ) : (
        <div className="redis-stat-grid wide">
          {stats.map((s) => (
            <div key={s.label} className="redis-stat">
              <div className="redis-stat-label">{s.label}</div>
              <div className="redis-stat-value lg">{s.val ?? '-'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
