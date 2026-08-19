// Dòng thông báo ok/lỗi mà mọi panel Redis đều cần.
//
// Trước đây `RedisBrowser` giữ đúng một dòng này cho cả workspace và truyền `onError`/`onOk`/
// `onBlocked` xuống từng panel. Giờ mỗi panel là một tab độc lập, nên hoặc mỗi tab tự có dòng của
// nó, hoặc phải dựng một toast toàn cục. Chọn cái thứ nhất: thông báo "đã lưu key" thuộc về tab vừa
// lưu, và một toast toàn cục sẽ hiện trên tab khác với thứ nó không làm.

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

const AUTO_HIDE_MS = 3500;

export interface RedisToast {
  /** Báo lỗi. */
  onError: (text: string) => void;
  /** Báo thành công. */
  onOk: (text: string) => void;
  /**
   * Cổng chặn ghi phía UI. Trả `true` (và hiện thông báo) khi kết nối đang chỉ đọc, để chỗ gọi
   * `return` sớm. Chốt thật vẫn ở Rust — CLI gửi lệnh dạng văn bản tự do nên cổng ở WebView là cổng
   * đặt sai phía biên IPC.
   */
  blocked: () => boolean;
  /** Dòng thông báo, render ngay dưới toolbar của tab. `null` khi không có gì để hiện. */
  node: React.ReactNode;
}

export function useRedisToast(readOnly: boolean): RedisToast {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Hẹn giờ được huỷ trước khi đặt lại: hai thông báo liền nhau thì cái sau phải được xem đủ
  // AUTO_HIDE_MS, chứ không bị bộ đếm của cái trước tắt sớm.
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
