import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plug, RefreshCw, Trash2 } from 'lucide-react';

import { Modal, ModalBody } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import type { McpAuditEntry, McpStatus, OpenConnection } from '../utils/dbHelper';
import { MCP_CLIENTS, mcpClient, type McpClientId } from '../utils/mcpClients';
import { readMcpPrefs, setMcpAutoStart, setMcpPort } from '../utils/mcpPrefs';

/** Mirrors `policy::DEFAULT_ROW_LIMIT` / `MAX_ROW_LIMIT`. Shown, not configurable in this build. */
const ROW_LIMIT_DEFAULT = 100;
const ROW_LIMIT_MAX = 1000;

/**
 * Mirrors `policy::MAX_TIMEOUT`, in seconds.
 *
 * Worth stating in the dialog rather than leaving as a surprise: an AI's heavy query being cut at 30s
 * looks like a bug from the client side, and the user is the only one who can see why. A lower
 * per-server statement timeout still wins - this is the ceiling, not the value.
 */
const TIMEOUT_CEILING_SECS = 30;

/** How many rows the list keeps. The log itself is capped in `mcp/audit.rs`, not here. */
const LOG_VIEW_CAP = 200;

/**
 * Remembers the picked client so re-opening this dialog does not land on someone else's client.
 *
 * `tf_mcp_client` is global on purpose: which AI client the user runs is not a property of any
 * connection, so it takes no `connKey`/`scopeKey` scope.
 */
const CLIENT_KEY = 'tf_mcp_client';

function readClient(): McpClientId {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved) return mcpClient(saved).id;
  } catch {
    // A blocked localStorage must not cost the user the whole dialog.
  }
  return MCP_CLIENTS[0].id;
}

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
  const [clientId, setClientId] = useState<McpClientId>(readClient);
  const [autoStart, setAutoStart] = useState(() => readMcpPrefs().autoStart);

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
    // set-state-in-effect: the rule's alternatives - derive during render, initialise state directly -
    // cannot reach the backend. Status, token and log all come from `invoke()`, so the first paint has
    // nothing to show and an effect is the only place the call can live.
    // eslint-disable-next-line react/set-state-in-effect
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
      if (status?.running) {
        await dbHelper.mcpStop();
        return;
      }
      const wanted = Number(port) || undefined;
      await dbHelper.mcpStart(wanted);
      // Remembered only after the start SUCCEEDED, so a port that cannot bind is never the one
      // autostart tries on the next run.
      setMcpPort(wanted);
    });

  const toggleAutoStart = (on: boolean) => {
    setAutoStart(on);
    setMcpAutoStart(on);
  };

  const running = !!status?.running;
  const sharedCount = connections.filter((c) => c.mcpExposed).length;

  const pickClient = (id: McpClientId) => {
    setClientId(id);
    try {
      localStorage.setItem(CLIENT_KEY, id); // 'tf_mcp_client' - global, see the constant above.
    } catch {
      // Losing the preference is not worth failing the click over.
    }
  };

  const activeClient = mcpClient(clientId);

  // Built from the port the server is ACTUALLY bound to, never from the default constant: a
  // generated snippet naming a port nothing listens on is worse than no snippet at all.
  const endpoint = status?.url || `http://127.0.0.1:${port}/mcp`;
  const configSnippet = activeClient.build({
    url: endpoint,
    token,
    exePath: status?.exePath ?? '',
    port: Number(port) || status?.port || 0,
  });

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
      case 'badOrigin':
        return t('mcp.denialBadOrigin');
      case 'badToken':
        return t('mcp.denialBadToken');
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
      // Wider than the other dialogs on purpose: the two cautions and the per-client target line are
      // full sentences, and at 720px each one wrapped to two lines - which is what pushed the
      // Requests section below the fold and made the whole body scroll.
      width="880px"
      maxHeight="90vh"
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
        <label className="mcp-check">
          <input
            type="checkbox"
            checked={autoStart}
            disabled={busy}
            onChange={(e) => toggleAutoStart(e.target.checked)}
          />
          {t('mcp.autoStart')}
        </label>
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
          {/* The tick is per connection, but the REACH is the whole server: `information_schema`,
              `SHOW DATABASES` and a qualified `other_db.tbl` are all read statements, so `policy.rs`
              passes them. Saying "per connection, not per server" here - which this used to - is the
              one wrong sentence a security screen cannot afford. */}
          <p className="mcp-warn">{t('mcp.sharedReach')}</p>
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
            {t('mcp.rowLimit')}: {ROW_LIMIT_DEFAULT} (max {ROW_LIMIT_MAX}) &middot;{' '}
            {t('mcp.timeLimit', { n: TIMEOUT_CEILING_SECS })}
          </p>
        </section>

        <section className="mcp-section">
          <h4 className="mcp-section-title">{t('mcp.config')}</h4>
          <p className="mcp-hint">{t('mcp.configHint')}</p>
          <div className="mcp-client-tabs">
            {MCP_CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === activeClient.id}
                className={c.id === activeClient.id ? 'mcp-client-tab active' : 'mcp-client-tab'}
                onClick={() => pickClient(c.id)}
              >
                {t(c.labelKey)}
              </button>
            ))}
          </div>
          <p className="mcp-hint">{t(activeClient.targetKey)}</p>
          <pre className="mcp-config">{configSnippet}</pre>
          <button className="btn btn-secondary" onClick={() => copy('config', configSnippet)}>
            {copied === 'config' ? <Check size={11} /> : <Copy size={11} />}
            {copied === 'config'
              ? t('mcp.tokenCopied')
              : activeClient.isCommand
                ? t('mcp.copyCommand')
                : t('mcp.copyConfig')}
          </button>
          <p className="mcp-warn">{t('mcp.configMismatch')}</p>
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
