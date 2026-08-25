// Shared error/success toast notification hook for Redis panels.
//
// Scoped per panel tab to isolate notifications to the originating tab.




import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

const AUTO_HIDE_MS = 3500;

export interface RedisToast {
  /** Show error message. */
  onError: (text: string) => void;
  /** Show success message. */
  onOk: (text: string) => void;
  /**
   * The write gate on the UI side. Returns `true` (and shows a message) while the connection is
   * read-only, so the caller can `return` early. The real lock is still in Rust — the CLI sends
   * free-form command text, so a gate in the WebView is a gate on the wrong side of the IPC boundary.
   */
  blocked: () => boolean;
  /** Toast element rendered beneath tab toolbar. `null` when idle. */
  node: React.ReactNode;
}

export function useRedisToast(readOnly: boolean): RedisToast {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Clears pending timeout so consecutive messages receive full display duration.
  
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMsg({ kind, text });
    timerRef.current = setTimeout(() => setMsg(null), AUTO_HIDE_MS);
  }, []);

  const onError = useCallback((text: string) => flash('err', text), [flash]);
  const onOk = useCallback((text: string) => flash('ok', text), [flash]);

  const blocked = useCallback((): boolean => {
    if (!readOnly) return false;
    flash('err', t('redis.errReadOnly'));
    return true;
  }, [readOnly, flash, t]);

  const node = msg ? (
    <div className={`redis-toast ${msg.kind === 'ok' ? 'ok' : 'err'}`}>
      {msg.kind === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      <span>{msg.text}</span>
    </div>
  ) : null;

  return { onError, onOk, blocked, node };
}
