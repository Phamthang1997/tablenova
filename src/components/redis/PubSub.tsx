import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Radio, Send, Square, Trash2 } from 'lucide-react';
import i18n from '../../i18n';
import { dbHelper } from '../../utils/dbHelper';


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
    // `messages` is a trigger, not a read - the body only touches refs. Dropping it kills auto-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <div className="redis-console">
      <div className="redis-stream-bar">
        <span className="redis-tool-title">
          <Radio size={14} /> {t('redis.pubsubTitle')}
        </span>
        <span className="redis-value-meta">{t('redis.pubsubOwnConnection')}</span>
      </div>

      <div className="redis-tool-row">
        <input
          className="redis-tool-input"
          type="text"
          value={channels}
          onChange={(e) => setChannels(e.target.value)}
          disabled={listening}
          placeholder={t('redis.channelsPlaceholder')}
          spellCheck={false}
        />
        <input
          className="redis-tool-input"
          type="text"
          value={patterns}
          onChange={(e) => setPatterns(e.target.value)}
          disabled={listening}
          placeholder={t('redis.patternsPlaceholder')}
          spellCheck={false}
        />
        {listening ? (
          <button className="btn btn-secondary redis-tool-btn danger" onClick={stop}>
            <Square size={10} /> {t('redis.unsubscribe')}
          </button>
        ) : (
          <button className="btn btn-primary redis-tool-btn" onClick={start}>{t('redis.subscribe')}</button>
        )}
      </div>

      <div className="redis-stream-bar">
        <span className="redis-value-meta">
          {t('redis.messageCount', { n: messages.length.toLocaleString() })}
          {dropped > 0 ? ` · ${t('redis.messagesDropped', { n: dropped.toLocaleString() })}` : ''}
        </span>
        <label className="redis-tool-check">
          <input
            type="checkbox"
            defaultChecked
            onChange={(e) => { followRef.current = e.target.checked; }}
          />
          {t('redis.followTail')}
        </label>
        <div className="redis-keylist-spacer" />
        <button
          onClick={() => { setMessages([]); setDropped(0); }}
          disabled={messages.length === 0}
          className="redis-ghost-btn"
        >
          <Trash2 size={10} /> {t('redis.clearLog')}
        </button>
      </div>

      <div ref={logRef} className="redis-log-box">
        {messages.length === 0 && (
          <div className="redis-cell-hint">
            {listening ? t('redis.pubsubWaiting') : t('redis.pubsubHint')}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="redis-log-line">
            <span className="redis-log-dim">
              {new Date(m.at).toLocaleTimeString(i18n.language)}{' '}
            </span>
            <span className="redis-syntax-name">{m.channel}</span>
            {m.pattern ? <span className="redis-log-dim"> ({m.pattern})</span> : null}
            <span className="redis-log-payload"> {m.payload}</span>
            {m.binary ? <span className="redis-log-binary"> {t('redis.binaryTag')}</span> : null}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="redis-tool-row">
          <input
            type="text"
            value={pubChannel}
            onChange={(e) => setPubChannel(e.target.value)}
            placeholder={t('redis.publishChannel')}
            spellCheck={false}
            className="redis-tool-input fixed"
          />
          <input
            type="text"
            value={pubPayload}
            onChange={(e) => setPubPayload(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') publish(); }}
            placeholder={t('redis.publishPayload')}
            spellCheck={false}
          />
          <button className="btn btn-secondary redis-tool-btn" onClick={publish}>
            <Send size={11} /> {t('redis.publish')}
          </button>
        </div>
      )}
    </div>
  );
};
