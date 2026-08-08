import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BarChart3, Play, Square } from 'lucide-react';
import { dbHelper, type RedisAnalysis } from '../../utils/dbHelper';
import { cellStyle, formatBytes } from './shared';

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{titleLabel}</div>
        <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
          <table className="grid-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('redis.colName')}</th>
                <th style={{ width: '90px' }}>{t('redis.colKeys')}</th>
                <th style={{ width: '110px' }}>{t('redis.colMemory')}</th>
                <th style={{ width: '30%' }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.analysisNoData')}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.name}>
                  <td style={cellStyle}>{r.name}</td>
                  <td style={cellStyle}>{r.count.toLocaleString()}</td>
                  <td style={cellStyle}>{formatBytes(r.bytes)}</td>
                  <td>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'var(--win-accent)', width: `${Math.max(2, (r.bytes / max) * 100)}%` }} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <BarChart3 size={14} /> {t('redis.analysisTitle')}
        </span>
        {running ? (
          <button className="btn btn-secondary" onClick={stop} style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)' }}>
            <Square size={10} /> {t('common.cancel')}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={run} style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Play size={11} /> {t('redis.analysisRun')}
          </button>
        )}
        {running && (
          <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>
            {t('redis.analysisProgress', {
              n: progress.sampled.toLocaleString(),
              total: progress.total.toLocaleString(),
            })}
          </span>
        )}
      </div>

      {!report && !running && (
        <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', lineHeight: 1.6 }}>{t('redis.analysisHint')}</div>
      )}

      {report && (
        <>
          {(report.warnings || []).map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: '#f59e0b' }}>
              <AlertTriangle size={12} /> {w}
            </div>
          ))}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
            {[
              { label: t('redis.analysisDbsize'), val: report.dbsize.toLocaleString() },
              { label: t('redis.analysisSampled'), val: report.sampled.toLocaleString() },
              { label: t('redis.analysisSampledBytes'), val: formatBytes(report.sampledBytes) },
              {
                label: t('redis.analysisEstimatedBytes'),
                val: report.estimatedBytes != null ? formatBytes(Math.round(report.estimatedBytes)) : '-',
              },
            ].map((s) => (
              <div key={s.label} style={{ border: '1px solid var(--win-border)', borderRadius: '6px', padding: '10px 12px', background: 'var(--win-bg-window)' }}>
                <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{s.label}</div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--win-text-primary)', marginTop: '2px' }}>{s.val}</div>
              </div>
            ))}
          </div>

          {bars(report.byType, t('redis.analysisByType'))}
          {bars(report.byNamespace, t('redis.analysisByNamespace'))}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{t('redis.analysisTtl')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
              {[
                { label: t('redis.ttlNoExpiry'), val: report.ttlBuckets.noExpiry },
                { label: t('redis.ttlUnder1h'), val: report.ttlBuckets.under1h },
                { label: t('redis.ttlUnder1d'), val: report.ttlBuckets.under1d },
                { label: t('redis.ttlUnder7d'), val: report.ttlBuckets.under7d },
                { label: t('redis.ttlOver7d'), val: report.ttlBuckets.over7d },
              ].map((b) => (
                <div key={b.label} style={{ border: '1px solid var(--win-border)', borderRadius: '4px', padding: '8px', background: 'var(--win-bg-window)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>{b.label}</div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{b.val.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{t('redis.analysisTopKeys')}</div>
            <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'auto', background: 'var(--win-bg-window)' }}>
              <table className="grid-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{t('redis.colKey')}</th>
                    <th style={{ width: '80px' }}>{t('redis.colType')}</th>
                    <th style={{ width: '110px' }}>{t('redis.colMemory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topKeys.map((k) => (
                    <tr key={k.key}>
                      <td style={cellStyle}>{k.key}</td>
                      <td style={cellStyle}>{k.type}</td>
                      <td style={cellStyle}>{formatBytes(k.bytes)}</td>
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
