import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Lock, LockOpen, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  getSafeModeForKey,
  SAFE_MODE_CHANGED_EVENT,
  SAFE_MODES,
  setSafeModeForKey,
  type SafeMode,
} from '../utils/safeMode';
import {
  getStmtTimeoutForKey,
  STMT_TIMEOUT_CHANGED_EVENT,
  STMT_TIMEOUT_PRESETS,
  setStmtTimeoutForKey,
} from '../utils/stmtTimeout';
import {
  COMMIT_PREVIEW_CHANGED_EVENT,
  getCommitPreviewForKey,
  setCommitPreviewForKey,
} from '../utils/commitPreview';
import { dbHelper } from '../utils/dbHelper';

/**
 * One control, four escalating levels — three "ask" levels plus read-only, which blocks instead of
 * asking. They were two adjacent buttons at first (a padlock and a shield) and that was wrong: both
 * answer the same question, "how much does this connection protect me", so the user had to reason
 * about two switches to know what would happen to a DELETE.
 */
type Level = SafeMode | 'readonly';

const LEVELS: readonly Level[] = [...SAFE_MODES, 'readonly'] as const;

/** Must match `.sm-pop { width }` in index.css — the anchor is computed from it. */
const POP_WIDTH = 316;

interface SafeModeControlProps {
  connected: boolean;
  /**
   * `connKey(config)` of the connection on screen — the ask-level is stored per server.
   *
   * A key, not a `connId`: the frontend has the config in hand, and Redis has no connection id at
   * all, so going through the id would leave its own server unreachable from this menu.
   */
  connKey: string;
  /** Read-only is App state (and the backend's own flag), not part of Safe Mode's storage. */
  readOnly: boolean;
  onToggleReadOnly?: () => void;
  /**
   * Kết nối currently xem — cần for lệnh đổi limit time statement, thứ áp ando *phiên* currently run
   * chứ not must ando một server nào đó already save.
   */
  connId?: string;
  /**
   * Dialect of kết nối. row "limit time" chỉ hiện with `postgres`/`mysql`: SQLite run
   * sync on tệp cục bộ nên not có chỗ chen một hạn chót ando, and bày ra một ô cài đặt not
   * có tác dụng thì tệ hơn is not bày.
   */
  dbType?: string;
}

export const SafeModeControl: React.FC<SafeModeControlProps> = ({
  connected,
  connKey,
  readOnly,
  onToggleReadOnly,
  connId,
  dbType,
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SafeMode>('silent');
  const [stmtSecs, setStmtSecs] = useState(0);
  const [previewOn, setPreviewOn] = useState(true);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // The mode is stored in localStorage and `setSafeModeForKey` announces changes, so a second mount
  // or the other window stays in step instead of showing a stale icon.
  useEffect(() => {
    const read = () => setMode(getSafeModeForKey(connKey));
    read();
    window.addEventListener(SAFE_MODE_CHANGED_EVENT, read);
    return () => window.removeEventListener(SAFE_MODE_CHANGED_EVENT, read);
  }, [connKey]);

  // Cùng lối with Safe Mode at on: nguồn sự thật is localStorage, nên hai window or hai lần mount
  // not hiện hai con số khác nhau.
  useEffect(() => {
    const read = () => setStmtSecs(getStmtTimeoutForKey(connKey));
    read();
    window.addEventListener(STMT_TIMEOUT_CHANGED_EVENT, read);
    return () => window.removeEventListener(STMT_TIMEOUT_CHANGED_EVENT, read);
  }, [connKey]);

  // Cái ô "đừng hiện lại" nằm in chính hộp thoại preview, tức is nó is tắt from chỗ khác — nghe
  // sự kiện to row at đây not hiện status cũ when popover open lại.
  useEffect(() => {
    const read = () => setPreviewOn(getCommitPreviewForKey(connKey));
    read();
    window.addEventListener(COMMIT_PREVIEW_CHANGED_EVENT, read);
    return () => window.removeEventListener(COMMIT_PREVIEW_CHANGED_EVENT, read);
  }, [connKey]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchor(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor]);

  // Read-only wins the display: while it is on, writes never reach the point of being asked about.
  const level: Level = readOnly ? 'readonly' : mode;

  const label = (l: Level): string => {
    switch (l) {
      case 'silent':
        return t('safeMode.modeSilent');
      case 'writes':
        return t('safeMode.modeWrites');
      case 'all':
        return t('safeMode.modeAll');
      case 'readonly':
        return t('safeMode.modeReadOnly');
    }
  };

  const description = (l: Level): string => {
    switch (l) {
      case 'silent':
        return t('safeMode.modeSilentDesc');
      case 'writes':
        return t('safeMode.modeWritesDesc');
      case 'all':
        return t('safeMode.modeAllDesc');
      case 'readonly':
        return t('safeMode.modeReadOnlyDesc');
    }
  };

  // The padlock stays at both ends of the scale so the button keeps the meaning it had when it was
  // only a read-only toggle.
  const icon = (l: Level, size: number) => {
    switch (l) {
      case 'silent':
        return <LockOpen size={size} />;
      case 'writes':
        return <ShieldAlert size={size} color="#f59e0b" />;
      case 'all':
        return <ShieldCheck size={size} color="#ef4444" />;
      case 'readonly':
        return <Lock size={size} color="#f59e0b" />;
    }
  };

  // Anchored with `top`/`left` like `openDbPopover` and `.qs-pop`, the app's only other title-bar
  // popover — a `right`-anchored fixed box painted its blurred layer offset from its own content.
  // Right-aligned to the button, then clamped so a button near either edge still shows the whole menu.
  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = Math.max(10, window.innerWidth - POP_WIDTH - 10);
    setAnchor({ top: rect.bottom + 6, left: Math.min(maxLeft, Math.max(10, rect.right - POP_WIDTH)) });
  };

  const pick = (l: Level) => {
    setAnchor(null);
    if (l === 'readonly') {
      if (!readOnly) onToggleReadOnly?.();
      return;
    }
    // Leaving read-only is part of choosing an ask-level: the stored level is remembered across the
    // toggle, so coming back from read-only restores the level that was set before it.
    if (readOnly) onToggleReadOnly?.();
    setSafeModeForKey(connKey, l);
    setMode(getSafeModeForKey(connKey));
  };

  /**
   * Đặt limit. write ando localStorage (to lần kết nối sau vẫn còn) **and** đẩy sang phiên currently run
   * — hai chỗ, vì một cái is bộ nhớ còn cái kia is hiệu lực. Popover not close lại: người ta hay
   * thử một mức rồi đổi ngay sang mức khác.
   */
  const pickTimeout = (secs: number) => {
    setStmtTimeoutForKey(connKey, secs);
    setStmtSecs(getStmtTimeoutForKey(connKey));
    if (connId) void dbHelper.setStatementTimeout(connId, secs);
  };

  const timeoutLabel = (secs: number): string =>
    secs === 0
      ? t('stmtTimeout.off')
      : secs % 60 === 0
        ? t('stmtTimeout.minutes', { n: secs / 60 })
        : t('stmtTimeout.seconds', { n: secs });

  return (
    <>
      <button
        ref={btnRef}
        className={`tb-capsule-btn ${level !== 'silent' ? 'is-active-warn' : ''}`}
        onClick={() => (anchor ? setAnchor(null) : open())}
        disabled={!connected}
        title={t('safeMode.controlTitle', { mode: label(level) })}
      >
        {icon(level, 13)}
      </button>

      {anchor &&
        createPortal(
          <>
            <div className="sm-backdrop" onClick={() => setAnchor(null)} />
            <div className="sm-pop" style={{ top: anchor.top, left: anchor.left }} role="dialog">
              <div className="sm-pop-title">{t('safeMode.menuTitle')}</div>
              {LEVELS.map((l) => (
                <React.Fragment key={l}>
                  {l === 'readonly' && <div className="sm-divider" />}
                  <button
                    className={`sm-item ${level === l ? 'is-on' : ''}`}
                    onClick={() => pick(l)}
                    // Nothing to store the ask-level in without a key; read-only needs no storage.
                    disabled={l !== 'readonly' && !connKey}
                  >
                    <span style={{ display: 'flex', flexShrink: 0, marginTop: '1px' }}>{icon(l, 14)}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="sm-item-label">{label(l)}</span>
                      <span className="sm-item-desc">{description(l)}</span>
                    </span>
                  </button>
                </React.Fragment>
              ))}
              {/* limit time statement — cùng popover vì nó trả lời cùng một câu hỏi with Safe
                  Mode ("kết nối này bảo vệ mình tới đâu") and cũng save theo server. Các mức đặt sẵn
                  chứ not must ô nhập số: gõ số in một menu is thao tác lạc, and sáu mức already phủ
                  hết khoảng người ta thực sự select. */}
              {(dbType === 'postgres' || dbType === 'mysql') && (
                <>
                  <div className="sm-divider" />
                  <div className="sm-pop-title">{t('stmtTimeout.menuTitle')}</div>
                  <div className="sm-seg">
                    {STMT_TIMEOUT_PRESETS.map((secs) => (
                      <button
                        key={secs}
                        className={stmtSecs === secs ? 'is-on' : ''}
                        onClick={() => pickTimeout(secs)}
                        disabled={!connKey}
                      >
                        {timeoutLabel(secs)}
                      </button>
                    ))}
                  </div>
                  <div className="sm-item-desc sm-pop-note">{t('stmtTimeout.hint')}</div>
                </>
              )}

              {/* preview SQL trước when grid save. at đây vì đây is đường BẬT LẠI: nó is tắt from ô
                  "đừng hiện lại" in chính hộp thoại đó, and một công tắc tắt is mà not bật
                  lại is thì chỉ is một cái bẫy. */}
              <div className="sm-divider" />
              <button
                className={`sm-item ${previewOn ? 'is-on' : ''}`}
                onClick={() => {
                  setCommitPreviewForKey(connKey, !previewOn);
                  setPreviewOn(getCommitPreviewForKey(connKey));
                }}
                disabled={!connKey}
              >
                <span style={{ display: 'flex', flexShrink: 0, marginTop: '1px' }}>
                  {previewOn ? <Eye size={14} /> : <EyeOff size={14} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="sm-item-label">{t('commitPreview.label')}</span>
                  <span className="sm-item-desc">
                    {previewOn ? t('commitPreview.onDesc') : t('commitPreview.offDesc')}
                  </span>
                </span>
              </button>
            </div>
          </>,
          document.body
        )}
    </>
  );
};
