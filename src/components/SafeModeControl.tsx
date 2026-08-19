import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Lock, LockOpen, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  getSafeModeForKey,
  SAFE_MODE_CHANGED_EVENT,
  SAFE_MODES,
  setSafeModeForKey,
  type SafeMode,
} from '../utils/safeMode';

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
}

export const SafeModeControl: React.FC<SafeModeControlProps> = ({
  connected,
  connKey,
  readOnly,
  onToggleReadOnly,
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SafeMode>('silent');
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
            </div>
          </>,
          document.body
        )}
    </>
  );
};
