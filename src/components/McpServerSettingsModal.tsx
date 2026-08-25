import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plug, RefreshCw, Trash2 } from 'lucide-react';

import { Modal, ModalBody } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import type { McpAuditEntry, McpStatus, OpenConnection } from '../utils/dbHelper';

/** Mirrors `policy::DEFAULT_ROW_LIMIT` / `MAX_ROW_LIMIT`. Shown, not configurable in this build. */
const ROW_LIMIT_DEFAULT = 100;
const ROW_LIMIT_MAX = 1000;

/** How many rows the list keeps. The log itself is capped in `mcp/audit.rs`, not here. */
const LOG_VIEW_CAP = 200;

interface Props {
  onClose: () => void;
}

export function McpServerSettingsModal({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState('');
  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [connections, setConnections] = useState<OpenConnection[]>([]);
  const [log, setLog] = useState<McpAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'token' | 'config' | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, conns] = await Promise.all([dbHelper.mcpStatus(), dbHelper.listConnections()]);
      setStatus(s);
      setPort(String(s.port));
      // Redis is out of MCP scope, so listing it here would offer a switch that does nothing.
      setConnections(conns.filter((c) => c.dialect !== 'redis'));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void dbHelper.mcpGetToken().then(setToken).catch(() => {});
    void dbHelper.mcpAuditLog().then(setLog).catch(() => {});
  }, [refresh]);

  // The log is born in Rust and arrives by event. Polling would show a request seconds after it
  // ran, which on a security screen is the wrong side of "did something just happen".
  useEffect(() => {
    const un = listen<McpAuditEntry>('mcp-request', (e) => {
      setLog((prev) => [e.payload, ...prev].slice(0, LOG_VIEW_CAP));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const copyTimer = useRef<number | undefined>(undefined);
  const copy = (what: 'token' | 'config', text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  };
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleServer = () =>
    run(async () => {
      if (status?.running) await dbHelper.mcpStop();
      else await dbHelper.mcpStart(Number(port) || undefined);
    });

  const running = !!status?.running;
  const sharedCount = connections.filter((c) => c.mcpExposed).length;

  // Built from the port the server is ACTUALLY bound to, never from the default constant: a
  // generated snippet naming a port nothing listens on is worse than no snippet at all.
  const configSnippet = JSON.stringify(
    {
      mcpServers: {
        tablenova: {
          url: status?.url || `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  /**
   * What one log row says on its right-hand side.
   *
   * Lives inside the component so `t` keeps its real type: the key tree is type-checked, and a
   * dynamic key (`t(`mcp.denial${x}`)`) would defeat that silently the first time a variant is
   * renamed. A `switch` returning literals is what the i18n notes in CLAUDE.md ask for.
   */
  const outcomeLabel = (e: McpAuditEntry): string => {
    if (e.ok) return `${e.ms} ms`;
    switch (e.denial) {
      case 'notShared':
        return t('mcp.denialNotShared');
      case 'notReadOnly':
        return t('mcp.denialNotReadOnly');
      case 'manualTransaction':
        return t('mcp.denialManualTransaction');
      case 'failed':
        return t('mcp.denialFailed');
      default:
        return e.layer ? t('mcp.logDenied', { n: e.layer }) : t('mcp.logFailed');
    }
  };

  return (
    <Modal
      title={t('mcp.title')}
      icon={<Plug size={13} />}
      onClose={onClose}
      width="720px"
      maxHeight="82vh"
      zIndex={10000}
    >
      <ModalBody>
        <div className="mcp-row">
          <span className={running ? 'mcp-dot on' : 'mcp-dot'} />
          <span className="mcp-status-text">
            {running ? t('mcp.statusRunning', { url: status?.url }) : t('mcp.statusStopped')}
          </span>
          <div className="mcp-spacer" />
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
            disabled={running || busy}
            aria-label={t('mcp.port')}
            className="mcp-port"
          />
          <button
            className={running ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={toggleServer}
            disabled={busy}
          >
            {running ? t('mcp.stop') : t('mcp.start')}
          </button>
        </div>
        <p className="mcp-hint">{t('mcp.portHint')}</p>
        {error && <p className="mcp-error">{error}</p>}

        <section className="mcp-section">
          <h4 className="mcp-section-title">{t('mcp.token')}</h4>
          <div className="mcp-row">
            <input
              type="text"
              readOnly
              className="mcp-token"
              value={revealed ? token : '\u2022'.repeat(Math.min(token.length, 32))}
              onFocus={() => setRevealed(true)}
              onBlur={() => setRevealed(false)}
            />
            <button className="btn btn-secondary" onClick={() => copy('token', token)}>
              {copied === 'token' ? <Check size={11} /> : <Copy size={11} />}
              {copied === 'token' ? t('mcp.tokenCopied') : t('mcp.copyToken')}
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy}
              title={t('mcp.regenerateWarning')}
              onClick={() => run(async () => setToken(await dbHelper.mcpRegenerateToken()))}
            >
              <RefreshCw size={11} /> {t('mcp.regenerate')}
            </button>
          </div>
          <p className="mcp-hint">{t('mcp.tokenInConfigWarning')}</p>
        </section>

        <section className="mcp-section">
          <h4 className="mcp-section-title">{t('mcp.shared')}</h4>
          <p className="mcp-hint">{t('mcp.sharedHint')}</p>
          {connections.length === 0 ? (
            <p className="mcp-empty">{t('mcp.sharedEmpty')}</p>
          ) : (
            <ul className="mcp-conn-list">
              {connections.map((c) => (
                <li key={c.connId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={c.mcpExposed}
                      disabled={busy}
                      onChange={(e) =>
                        run(() => dbHelper.setConnectionMcpExposed(c.connId, e.target.checked))
                      }
                    />
                    <span className="mcp-conn-db">{c.db}</span>
                    <span className="mcp-conn-meta">{c.dialect}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {connections.length > 0 && sharedCount === 0 && (
            <p className="mcp-empty">{t('mcp.sharedNone')}</p>
          )}
          <p className="mcp-hint">{t('mcp.readOnlyNote')}</p>
          <p className="mcp-hint">
            {t('mcp.rowLimit')}: {ROW_LIMIT_DEFAULT} (max {ROW_LIMIT_MAX})
          </p>
        </section>

        <section className="mcp-section">
          <h4 className="mcp-section-title">{t('mcp.config')}</h4>
          <p className="mcp-hint">{t('mcp.configHint')}</p>
          <pre className="mcp-config">{configSnippet}</pre>
          <button className="btn btn-secondary" onClick={() => copy('config', configSnippet)}>
            {copied === 'config' ? <Check size={11} /> : <Copy size={11} />}
            {copied === 'config' ? t('mcp.tokenCopied') : t('mcp.copyConfig')}
          </button>
        </section>

        <section className="mcp-section">
          <div className="mcp-row">
            <h4 className="mcp-section-title">{t('mcp.log')}</h4>
            <div className="mcp-spacer" />
            <button
              className="redis-ghost-btn"
              disabled={log.length === 0}
              onClick={() =>
                run(async () => {
                  await dbHelper.mcpAuditClear();
                  setLog([]);
                })
              }
            >
              <Trash2 size={11} /> {t('mcp.logClear')}
            </button>
          </div>
          <p className="mcp-hint">{t('mcp.logMemoryOnly')}</p>
          {log.length === 0 ? (
            <p className="mcp-empty">{t('mcp.logEmpty')}</p>
          ) : (
            <ul className="mcp-log">
              {log.map((e) => (
                <li key={e.id} className={e.ok ? undefined : 'denied'}>
                  <span className="mcp-log-time">
                    {new Date(e.at).toLocaleTimeString(i18n.language)}
                  </span>
                  <span className="mcp-log-tool">{e.tool}</span>
                  {e.sql && <span className="mcp-log-sql">{e.sql}</span>}
                  <span className="mcp-log-outcome">{outcomeLabel(e)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </ModalBody>
    </Modal>
  );
}
