import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Radio, Send, Square, Trash2 } from 'lucide-react';
import i18n from '../../i18n';
import { dbHelper } from '../../utils/dbHelper';
import { logBox } from './shared';

interface PubSubProps {
  readOnly: boolean;
  onError: (msg: string) => void;
  onOk: (msg: string) => void;
  onBlocked: () => boolean;
}

interface Message {
  at: number;
  channel: string;
  pattern?: string | null;
  payload: string;
  binary?: boolean;
}

/** Ring buffer: a busy channel can produce thousands of messages a second. */
const MESSAGE_CAP = 5000;

/**
 * Pub/Sub listener.
 *
 * The subscription runs on a **dedicated** connection in Rust — `SUBSCRIBE` puts a connection
 * into push mode, and the app's shared connection is used by every other Redis feature (which
 * is also why typing `SUBSCRIBE` in the CLI console is refused).
 */
export const PubSub: React.FC<PubSubProps> = ({ readOnly, onError, onOk, onBlocked }) => {
  const { t } = useTranslation();
  const [channels, setChannels] = useState('');
  const [patterns, setPatterns] = useState('');
  const [listening, setListening] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [dropped, setDropped] = useState(0);
  const [pubChannel, setPubChannel] = useState('');
  const [pubPayload, setPubPayload] = useState('');

  const idRef = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // Leaving the tab must not leave a subscription (and its connection) running in Rust.
  useEffect(() => () => { if (idRef.current) dbHelper.cancelQuery(idRef.current); }, []);

  const split = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

  const start = async () => {
    const chs = split(channels);
    const pats = split(patterns);
    if (chs.length === 0 && pats.length === 0) { onError(t('redis.errNoChannel')); return; }
    const id = `rsub_${crypto.randomUUID()}`;
    idRef.current = id;
    setListening(true);
    const res = await dbHelper.redisPubsubStart(chs, pats, id, (msg: any) => {
      if (idRef.current !== id) return;
      if (msg.type === 'message') {
        setMessages((prev) => {
          const next = prev.concat({
            at: Date.now(),
            channel: msg.channel,
            pattern: msg.pattern,
            payload: msg.payload,
            binary: msg.binary,
          });
          if (next.length > MESSAGE_CAP) {
            setDropped((d) => d + (next.length - MESSAGE_CAP));
            return next.slice(-MESSAGE_CAP);
          }
          return next;
        });
      } else if (msg.type === 'stopped') {
        setListening(false);
      }
    });
    if (!res.success) {
      setListening(false);
      onError(res.error || t('redis.errPubsub'));
    }
  };

  const stop = () => {
    if (idRef.current) dbHelper.cancelQuery(idRef.current);
    setListening(false);
  };

  const publish = async () => {
    if (onBlocked()) return;
    if (!pubChannel.trim()) { onError(t('redis.errNoChannel')); return; }
    const res = await dbHelper.redisPublish(pubChannel.trim(), pubPayload);
    if (!res.success) { onError(res.error || t('redis.errPublish')); return; }
    onOk(t('redis.published', { n: res.receivers ?? 0 }));
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, background: 'var(--win-bg-window)', border: '1px solid var(--win-border)',
    color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px',
    fontFamily: 'var(--win-font-mono)', padding: '5px 8px', outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Radio size={14} /> {t('redis.pubsubTitle')}
        </span>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.pubsubOwnConnection')}</span>
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={channels}
          onChange={(e) => setChannels(e.target.value)}
          disabled={listening}
          placeholder={t('redis.channelsPlaceholder')}
          spellCheck={false}
          style={inputStyle}
        />
        <input
          type="text"
          value={patterns}
          onChange={(e) => setPatterns(e.target.value)}
          disabled={listening}
          placeholder={t('redis.patternsPlaceholder')}
          spellCheck={false}
          style={inputStyle}
        />
        {listening ? (
          <button className="btn btn-secondary" onClick={stop} style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-danger)' }}>
            <Square size={10} /> {t('redis.unsubscribe')}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start} style={{ padding: '0 12px' }}>{t('redis.subscribe')}</button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
          {t('redis.messageCount', { n: messages.length.toLocaleString() })}
          {dropped > 0 ? ` · ${t('redis.messagesDropped', { n: dropped.toLocaleString() })}` : ''}
        </span>
        <label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'var(--win-text-secondary)' }}>
          <input
            type="checkbox"
            defaultChecked
            onChange={(e) => { followRef.current = e.target.checked; }}
          />
          {t('redis.followTail')}
        </label>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => { setMessages([]); setDropped(0); }}
          disabled={messages.length === 0}
          style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'transparent', color: 'var(--win-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <Trash2 size={10} /> {t('redis.clearLog')}
        </button>
      </div>

      <div ref={logRef} style={logBox}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--win-text-disabled)' }}>
            {listening ? t('redis.pubsubWaiting') : t('redis.pubsubHint')}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: '4px' }}>
            <span style={{ color: 'var(--win-text-disabled)' }}>
              {new Date(m.at).toLocaleTimeString(i18n.language)}{' '}
            </span>
            <span style={{ color: 'var(--win-accent)', fontWeight: 700 }}>{m.channel}</span>
            {m.pattern ? <span style={{ color: 'var(--win-text-disabled)' }}> ({m.pattern})</span> : null}
            <span style={{ color: 'var(--win-text-primary)' }}> {m.payload}</span>
            {m.binary ? <span style={{ color: '#f59e0b' }}> {t('redis.binaryTag')}</span> : null}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={pubChannel}
            onChange={(e) => setPubChannel(e.target.value)}
            placeholder={t('redis.publishChannel')}
            spellCheck={false}
            style={{ ...inputStyle, flex: '0 0 160px' }}
          />
          <input
            type="text"
            value={pubPayload}
            onChange={(e) => setPubPayload(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') publish(); }}
            placeholder={t('redis.publishPayload')}
            spellCheck={false}
            style={inputStyle}
          />
          <button className="btn btn-secondary" onClick={publish} style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Send size={11} /> {t('redis.publish')}
          </button>
        </div>
      )}
    </div>
  );
};
