import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BarChart3, Play, Square } from 'lucide-react';
import { dbHelper, type RedisAnalysis } from '../../utils/dbHelper';
import { formatBytes } from './shared';

interface AnalysisProps {
  onError: (msg: string) => void;
}

/**
 * Memory/keyspace report over a sample of the keyspace.
 *
 * Everything here is honest about being a sample: the backend stops at 10k keys (the same
 * ceiling RedisInsight uses), returns a warning saying so, and the extrapolated total is
 * labelled as an estimate rather than shown next to the measured numbers as if it were one.
 */
export const Analysis: React.FC<AnalysisProps> = ({ onError }) => {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ sampled: 0, total: 0 });
  const [report, setReport] = useState<RedisAnalysis | null>(null);
  const idRef = useRef('');

  const run = async () => {
    const id = `rana_${crypto.randomUUID()}`;
    idRef.current = id;
    setRunning(true);
    setProgress({ sampled: 0, total: 0 });
    setReport(null);
    const res = await dbHelper.redisAnalyzeDb(undefined, id, (msg: any) => {
      if (idRef.current !== id) return;
      if (msg.type === 'progress') setProgress({ sampled: msg.sampled ?? 0, total: msg.total ?? 0 });
    });
    setRunning(false);
    if (!res.success) { onError(res.error || t('redis.errAnalyze')); return; }
    setReport(res);
  };

  const stop = () => {
    if (idRef.current) dbHelper.cancelQuery(idRef.current);
  };

  const bars = (rows: { name: string; count: number; bytes: number }[], titleLabel: string) => {
    const max = rows.reduce((m, r) => Math.max(m, r.bytes), 0) || 1;
    return (
      <div className="redis-section">
        <div className="redis-stream-subtitle">{titleLabel}</div>
        <div className="redis-table-wrap">
          <table className="grid-table redis-table">
            <thead>
              <tr>
                <th>{t('redis.colName')}</th>
                <th className="redis-col-90">{t('redis.colKeys')}</th>
                <th className="redis-col-110">{t('redis.colMemory')}</th>
                <th className="redis-col-bar" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="redis-table-empty">{t('redis.analysisNoData')}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="redis-cell">{r.name}</td>
                  <td className="redis-cell">{r.count.toLocaleString()}</td>
                  <td className="redis-cell">{formatBytes(r.bytes)}</td>
                  <td>
                    {/* Bar width is bytes/max ratio: dynamic based on data, cannot use static CSS class. */}
                    <div className="redis-bar" style={{ width: `${Math.max(2, (r.bytes / max) * 100)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="redis-panel">
      <div className="redis-value-bar">
        <span className="redis-tool-title">
          <BarChart3 size={14} /> {t('redis.analysisTitle')}
        </span>
        {running ? (
          <button className="btn btn-secondary redis-tool-btn danger" onClick={stop}>
            <Square size={10} /> {t('common.cancel')}
          </button>
        ) : (
          <button className="btn btn-primary redis-tool-btn" onClick={run}>
            <Play size={11} /> {t('redis.analysisRun')}
          </button>
        )}
        {running && (
          <span className="redis-value-label">
            {t('redis.analysisProgress', {
              n: progress.sampled.toLocaleString(),
              total: progress.total.toLocaleString(),
            })}
          </span>
        )}
      </div>

      {!report && !running && (
        <div className="redis-unsupported-hint">{t('redis.analysisHint')}</div>
      )}

      {report && (
        <>
          {(report.warnings || []).map((w, i) => (
            <div key={i} className="redis-value-warn">
              <AlertTriangle size={12} /> {w}
            </div>
          ))}

          <div className="redis-stat-grid">
            {[
              { label: t('redis.analysisDbsize'), val: report.dbsize.toLocaleString() },
              { label: t('redis.analysisSampled'), val: report.sampled.toLocaleString() },
              { label: t('redis.analysisSampledBytes'), val: formatBytes(report.sampledBytes) },
              {
                label: t('redis.analysisEstimatedBytes'),
                val: report.estimatedBytes != null ? formatBytes(Math.round(report.estimatedBytes)) : '-',
              },
            ].map((s) => (
              <div key={s.label} className="redis-stat">
                <div className="redis-stat-label">{s.label}</div>
                <div className="redis-stat-value">{s.val}</div>
              </div>
            ))}
          </div>

          {bars(report.byType, t('redis.analysisByType'))}
          {bars(report.byNamespace, t('redis.analysisByNamespace'))}

          <div className="redis-section">
            <div className="redis-stream-subtitle">{t('redis.analysisTtl')}</div>
            <div className="redis-stat-grid narrow">
              {[
                { label: t('redis.ttlNoExpiry'), val: report.ttlBuckets.noExpiry },
                { label: t('redis.ttlUnder1h'), val: report.ttlBuckets.under1h },
                { label: t('redis.ttlUnder1d'), val: report.ttlBuckets.under1d },
                { label: t('redis.ttlUnder7d'), val: report.ttlBuckets.under7d },
                { label: t('redis.ttlOver7d'), val: report.ttlBuckets.over7d },
              ].map((b) => (
                <div key={b.label} className="redis-stat small">
                  <div className="redis-stat-label">{b.label}</div>
                  <div className="redis-stat-value sm">{b.val.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="redis-section">
            <div className="redis-stream-subtitle">{t('redis.analysisTopKeys')}</div>
            <div className="redis-table-wrap">
              <table className="grid-table redis-table">
                <thead>
                  <tr>
                    <th>{t('redis.colKey')}</th>
                    <th className="redis-col-80">{t('redis.colType')}</th>
                    <th className="redis-col-110">{t('redis.colMemory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topKeys.map((k) => (
                    <tr key={k.key}>
                      <td className="redis-cell">{k.key}</td>
                      <td className="redis-cell">{k.type}</td>
                      <td className="redis-cell">{formatBytes(k.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
