import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Play, Square, Trash2 } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';


interface ProfilerProps {
  onError: (msg: string) => void;
}

/** Ring buffer for the WebView; the backend has its own hard limit on top of this. */
const LINE_CAP = 5000;

/**
 * Real-time command stream (MONITOR).
 *
 * MONITOR makes the server echo **every** command it executes, which measurably slows a busy
 * instance down — so it is behind a confirmation, runs on its own connection, and stops itself
 * after the backend's limit (60s / 50k lines). The stop reason is reported instead of the
 * stream just going quiet.
 */
export const Profiler: React.FC<ProfilerProps> = ({ onError }) => {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [dropped, setDropped] = useState(0);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [filter, setFilter] = useState('');

  const idRef = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    // `lines` is a trigger, not a read - the body only touches refs. Dropping it kills auto-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  // Never leave MONITOR running on the server because the user switched tabs.
  useEffect(() => () => { if (idRef.current) dbHelper.cancelQuery(idRef.current); }, []);

  const start = async () => {
    setConfirmStart(false);
    const id = `rmon_${crypto.randomUUID()}`;
    idRef.current = id;
    setRunning(true);
    setStopReason(null);
    const res = await dbHelper.redisMonitorStart(id, (msg: any) => {
      if (idRef.current !== id) return;
      if (msg.type === 'line') {
        setLines((prev) => {
          const next = prev.concat(String(msg.line));
          if (next.length > LINE_CAP) {
            setDropped((d) => d + (next.length - LINE_CAP));
            return next.slice(-LINE_CAP);
          }
          return next;
        });
      } else if (msg.type === 'stopped') {
        setRunning(false);
        setStopReason(String(msg.reason || ''));
      }
    });
    if (!res.success) {
      setRunning(false);
      onError(res.error || t('redis.errProfiler'));
    }
  };

  const stop = () => {
    if (idRef.current) dbHelper.cancelQuery(idRef.current);
    setRunning(false);
  };

  const reasonText = (reason: string): string => {
    // A switch of literal keys — never a computed key (i18n rule in CLAUDE.md).
    switch (reason) {
      case 'cancelled': return t('redis.profilerStoppedCancelled');
      case 'limit': return t('redis.profilerStoppedLimit');
      case 'timeout': return t('redis.profilerStoppedTimeout');
      case 'closed': return t('redis.profilerStoppedClosed');
      default: return t('redis.profilerStopped');
    }
  };

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="redis-console">
      <div className="redis-value-bar">
        <span className="redis-tool-title">
          <Activity size={14} /> {t('redis.profilerTitle')}
        </span>
        {running ? (
          <button className="btn btn-secondary redis-tool-btn danger" onClick={stop}>
            <Square size={10} /> {t('redis.profilerStop')}
          </button>
        ) : (
          <button className="btn btn-primary redis-tool-btn" onClick={() => setConfirmStart(true)}>
            <Play size={11} /> {t('redis.profilerStart')}
          </button>
        )}
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('redis.profilerFilter')}
          spellCheck={false}
          className="redis-tool-input fixed"
        />
        <label className="redis-tool-check">
          <input type="checkbox" defaultChecked onChange={(e) => { followRef.current = e.target.checked; }} />
          {t('redis.followTail')}
        </label>
        <div className="redis-keylist-spacer" />
        <span className="redis-value-meta">
          {t('redis.profilerLineCount', { n: lines.length.toLocaleString() })}
          {dropped > 0 ? ` · ${t('redis.messagesDropped', { n: dropped.toLocaleString() })}` : ''}
        </span>
        <button
          onClick={() => { setLines([]); setDropped(0); }}
          disabled={lines.length === 0}
          className="redis-ghost-btn"
        >
          <Trash2 size={10} /> {t('redis.clearLog')}
        </button>
      </div>

      <div className="redis-value-warn">
        <AlertTriangle size={12} /> {t('redis.profilerCostNote')}
      </div>

      {stopReason && (
        <div className="redis-value-label">{reasonText(stopReason)}</div>
      )}

      <div ref={logRef} className="redis-log-box">
        {shown.length === 0 && (
          <div className="redis-cell-hint">
            {running ? t('redis.profilerWaiting') : t('redis.profilerHint')}
          </div>
        )}
        {shown.map((l, i) => (
          <div key={i} className="redis-log-payload wrap">{l}</div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmStart}
        title={t('redis.profilerConfirmTitle')}
        message={t('redis.profilerConfirmMessage')}
        note={t('redis.profilerConfirmNote')}
        tone="info"
        confirmLabel={t('redis.profilerStart')}
        onConfirm={start}
        onCancel={() => setConfirmStart(false)}
      />
    </div>
  );
};
