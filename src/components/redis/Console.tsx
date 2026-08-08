import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dbHelper } from '../../utils/dbHelper';
import { COMMANDS, commandSyntax, matchCommands, type CommandEntry } from './commandHelp';
import { logBox, pillStyle } from './shared';

interface ConsoleProps {
  /** localStorage scope for the command history — the server, never `dbName`. */
  storageScope: string;
  onError: (msg: string) => void;
  /** The backend routes `SELECT n` through the dropdown's path; keep the UI in step. */
  onSelectedDb: (index: number) => void;
}

const QUICK_CMDS = ['PING', 'INFO', 'DBSIZE', 'CLIENT LIST', 'CONFIG GET maxmemory'];
const HISTORY_MAX = 200;

/**
 * CLI console.
 *
 * Auto-complete and the syntax hint come from `commandHelp.ts` (a static table, no server
 * round trip). Two classes of command are refused by the backend rather than here — writes in
 * read-only mode, and commands that would hijack the shared connection (`SUBSCRIBE`,
 * `MONITOR`, `BLPOP`…) — so the message the user sees is the same one the IPC boundary
 * produced, not a second guess made in the UI.
 */
export const Console: React.FC<ConsoleProps> = ({ storageScope, onError, onSelectedDb }) => {
  const { t } = useTranslation();
  const historyKey = `tf_redis_cli_history_${storageScope}`;

  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState<{ cmd: string; out: string; ok: boolean }[]>([]);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(historyKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [histIdx, setHistIdx] = useState(-1); // -1 = đang gõ mới
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [showSuggest, setShowSuggest] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const suggestions: CommandEntry[] = useMemo(
    // Only while typing the command itself — once there is a space the user is on arguments
    // and the syntax hint below is the useful thing, not a list of command names.
    () => (showSuggest && !cmd.includes(' ') ? matchCommands(cmd) : []),
    [cmd, showSuggest],
  );
  const syntax = useMemo(() => commandSyntax(cmd), [cmd]);

  const pushHistory = (command: string) => {
    setHistory((prev) => {
      const next = prev[prev.length - 1] === command ? prev : [...prev, command];
      const capped = next.slice(-HISTORY_MAX);
      try { localStorage.setItem(historyKey, JSON.stringify(capped)); } catch { /* quota */ }
      return capped;
    });
  };

  const run = async (raw?: string) => {
    const command = (raw ?? cmd).trim();
    if (!command) return;
    pushHistory(command);
    setHistIdx(-1);
    setCmd('');
    setShowSuggest(false);
    const res = await dbHelper.redisExecuteCmd(command);
    const out = res.success ? JSON.stringify(res.result, null, 2) : `(error) ${res.error}`;
    if (!res.success && res.error) onError(res.error);
    if (res.selectedDb != null) onSelectedDb(res.selectedDb);
    setLog((prev) => [...prev, { cmd: command, out, ok: !!res.success }]);
    inputRef.current?.focus();
  };

  const acceptSuggestion = () => {
    const pick = suggestions[suggestIdx];
    if (!pick) return;
    setCmd(`${pick.name} `);
    setShowSuggest(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (suggestions.length > 0) {
      if (e.key === 'Tab') { e.preventDefault(); acceptSuggestion(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIdx((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' && suggestions.length === 1 && suggestions[0].name !== cmd.trim().toUpperCase()) {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
      if (e.key === 'Escape') { setShowSuggest(false); return; }
    }
    if (e.key === 'Enter') { run(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCmd(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(-1); setCmd(''); }
      else { setHistIdx(idx); setCmd(history[idx]); }
    }
  };

  const clearHistory = () => {
    setHistory([]);
    try { localStorage.removeItem(historyKey); } catch { /* ignore */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>{t('redis.quickCommands')}</span>
        {QUICK_CMDS.map((q) => (
          <button key={q} onClick={() => run(q)} style={pillStyle}>{q}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '10px', color: 'var(--win-text-disabled)' }}>
          {t('redis.commandsKnown', { n: COMMANDS.length })}
        </span>
        <button
          onClick={clearHistory}
          disabled={history.length === 0}
          style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'transparent', color: 'var(--win-text-secondary)', cursor: 'pointer' }}
        >
          {t('redis.clearHistory')}
        </button>
        <button
          onClick={() => setLog([])}
          disabled={log.length === 0}
          style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--win-border)', background: 'transparent', color: 'var(--win-text-secondary)', cursor: 'pointer' }}
        >
          {t('redis.clearLog')}
        </button>
      </div>

      <div ref={logRef} style={logBox}>
        {log.length === 0 && <div style={{ color: 'var(--win-text-disabled)' }}>{t('redis.consoleHint')}</div>}
        {log.map((l, i) => (
          <div key={i} style={{ marginBottom: '8px' }}>
            <div style={{ color: 'var(--win-accent)' }}>&gt; {l.cmd}</div>
            <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', color: l.ok ? 'var(--win-text-primary)' : 'var(--st-danger)' }}>{l.out}</pre>
          </div>
        ))}
      </div>

      {syntax && (
        <div style={{ fontSize: '10px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-secondary)' }}>
          <span style={{ color: 'var(--win-accent)', fontWeight: 700 }}>{syntax.name}</span>
          {syntax.args ? ` ${syntax.args}` : ''}
        </div>
      )}

      <div style={{ position: 'relative', display: 'flex', gap: '6px' }}>
        {suggestions.length > 0 && (
          <div style={{
            position: 'absolute', bottom: '100%', left: '18px', marginBottom: '4px', zIndex: 5,
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '4px', boxShadow: '0 8px 20px rgba(0,0,0,0.35)', minWidth: '320px', overflow: 'hidden',
          }}>
            {suggestions.map((s, i) => (
              <div
                key={s.name}
                onMouseDown={(e) => { e.preventDefault(); setSuggestIdx(i); acceptSuggestion(); }}
                style={{
                  padding: '4px 8px', fontSize: '11px', fontFamily: 'var(--win-font-mono)', cursor: 'pointer',
                  background: i === suggestIdx ? 'var(--win-bg-active)' : 'transparent',
                  display: 'flex', gap: '8px',
                }}
              >
                <span style={{ color: 'var(--win-accent)', fontWeight: 700 }}>{s.name}</span>
                <span style={{ color: 'var(--win-text-disabled)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.args}</span>
              </div>
            ))}
            <div style={{ padding: '3px 8px', fontSize: '9px', color: 'var(--win-text-disabled)', borderTop: '1px solid var(--win-border)' }}>
              {t('redis.completionHint')}
            </div>
          </div>
        )}
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono)', fontSize: '13px', fontWeight: 700 }}>&gt;</span>
        <input
          type="text"
          ref={inputRef}
          value={cmd}
          onChange={(e) => { setCmd(e.target.value); setShowSuggest(true); setSuggestIdx(0); }}
          onKeyDown={onKeyDown}
          onBlur={() => setShowSuggest(false)}
          placeholder={t('redis.consolePlaceholder')}
          spellCheck={false}
          style={{ flex: 1, background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', padding: '6px 10px', fontFamily: 'var(--win-font-mono)', fontSize: '11px', outline: 'none' }}
        />
        <button className="btn btn-primary" onClick={() => run()} style={{ padding: '0 14px', fontSize: '11px' }}>{t('redis.runCommand')}</button>
      </div>
    </div>
  );
};
