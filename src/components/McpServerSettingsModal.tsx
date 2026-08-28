import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Plug, RefreshCw, Trash2 } from 'lucide-react';

import { Modal, ModalBody } from './Modal';
import { dbHelper } from '../utils/dbHelper';
import type { McpAuditEntry, McpStatus, OpenConnection } from '../utils/dbHelper';
import {
  MCP_CLIENTS,
  mcpClient,
  mcpVariant,
  type McpClientId,
  type McpTransport,
} from '../utils/mcpClients';
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

/** Which transport the user last picked. Global for the same reason `tf_mcp_client` is. */
const TRANSPORT_KEY = 'tf_mcp_transport';

/**
 * System databases, so the reach line can put the user's own first.
 *
 * **Hand-synced with `src-tauri/src/stats/system_dbs.rs`**, which owns the same two lists for the
 * dashboard - it is `pub(super)`, so there is no way to read it from here without widening it or
 * changing a command's shape for a display detail. Both lists have been stable for a decade, and the
 * cost of drift is a miscounted line rather than a wrong query.
 *
 * They are counted but NOT hidden: `mysql` holds the user table, so "the AI can read it" is exactly
 * the kind of thing this line exists to say out loud.
 */
const SYSTEM_DBS: Record<string, string[]> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgres: ['postgres', 'template0', 'template1'],
};

function readClient(): McpClientId {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved) return mcpClient(saved).id;
  } catch {
    // A blocked localStorage must not cost the user the whole dialog.
  }
  return MCP_CLIENTS[0].id;
}

/**
 * The stored transport, or `null` to mean "use whatever this client's default is".
 *
 * `null` rather than a hardcoded fallback: the two transports are not equally reliable per client, so
 * the answer lives in `defaultTransport` and not here.
 */
function readTransport(): McpTransport | null {
  try {
    const saved = localStorage.getItem(TRANSPORT_KEY); // 'tf_mcp_transport'
    if (saved === 'http' || saved === 'stdio') return saved;
  } catch {
    // As above.
  }
  return null;
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
  const [transport, setTransport] = useState<McpTransport>(
    () => readTransport() ?? mcpClient(readClient()).defaultTransport,
  );
  const [autoStart, setAutoStart] = useState(() => readMcpPrefs().autoStart);
  /** Databases each ticked connection can actually reach, keyed by `connId`. See `reachLine`. */
  const [reach, setReach] = useState<Record<string, string[]>>({});

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

  // Probe what each ticked connection reaches. One query per newly ticked connection, never for an
  // unticked one, and never twice for the same `connId` - `reach` is the memo. A failure stays absent
  // rather than showing a wrong number.
  useEffect(() => {
    for (const c of connections) {
      if (!c.mcpExposed || reach[c.connId]) continue;
      void dbHelper
        .listDatabases(c.connId)
        .then((res) => {
          if (res.success) setReach((prev) => ({ ...prev, [c.connId]: res.databases }));
        })
        .catch(() => {});
    }
    // `reach` is deliberately not a dependency: it is written by this effect, and listing it would
    // re-run on every write. The `reach[c.connId]` guard above is what stops the repeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

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
    // Re-arm the new client's proven default rather than carrying the previous choice across: the two
    // transports are not equally reliable per client, which is what `defaultTransport` encodes.
    setTransport(mcpClient(id).defaultTransport);
    try {
      localStorage.setItem(CLIENT_KEY, id); // 'tf_mcp_client' - global, see the constant above.
      localStorage.removeItem(TRANSPORT_KEY);
    } catch {
      // Losing the preference is not worth failing the click over.
    }
  };

  const pickTransport = (next: McpTransport) => {
    setTransport(next);
    try {
      localStorage.setItem(TRANSPORT_KEY, next); // 'tf_mcp_transport'
    } catch {
      // As above.
    }
  };

  const activeClient = mcpClient(clientId);
  const activeVariant = mcpVariant(clientId, transport);

  /**
   * What a ticked connection can actually reach, named.
   *
   * The warning above states the mechanism; this states the **fact** for this server. "Ticking gives
   * the AI the whole server" is true but abstract - the user cannot tell whether their "whole server"
   * is one throwaway database or the company's. Naming them turns a disclaimer into something they
   * can act on, at the moment they are clicking the tick.
   *
   * Deliberately a MEASUREMENT, not a grant analysis: `SHOW GRANTS` / `has_database_privilege` differ
   * per dialect and would have us *infer* reach. `list_databases` reports what is actually visible
   * through this very connection - the same query an AI client can run - so it cannot be wrong about
   * it. Only ticked connections are probed: an extra query against a server the user did not share is
   * work nobody asked for.
   */
  const reachLine = (c: OpenConnection) => {
    const dbs = reach[c.connId];
    // Absent while in flight or after a failure, and SQLite returns [] because one file is one
    // database - there is no cross-database reach to warn about. Say nothing in all three cases.
    if (!dbs || dbs.length === 0) return null;

    // The user's own databases decide whether this tick is a problem; the server's system schemas are
    // the same four names everywhere and would otherwise both inflate the count and push the names
    // that matter off the end of the line. Counted, not hidden - see SYSTEM_DBS.
    const sys = new Set(SYSTEM_DBS[c.dialect] ?? []);
    const own = dbs.filter((d) => !sys.has(d.toLowerCase()));
    const sysCount = dbs.length - own.length;
    const sysNote = sysCount > 0 ? ` ${t('mcp.reachSystem', { n: sysCount })}` : '';

    // One of the user's own databases is the reassuring answer, so it reads as an aside rather than a
    // warning - even when the server also carries system schemas.
    if (own.length <= 1) {
      return (
        <p className="mcp-reach ok">
          {t('mcp.reachOne')}
          {sysNote}
        </p>
      );
    }
    return (
      <p className="mcp-reach">
        {t('mcp.reachMany', { n: own.length, list: own.join(', ') })}
        {sysNote}
      </p>
    );
  };

  // Built from the port the server is ACTUALLY bound to, never from the default constant: a
  // generated snippet naming a port nothing listens on is worse than no snippet at all.
  const endpoint = status?.url || `http://127.0.0.1:${port}/mcp`;
  const configSnippet = activeVariant.build({
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
            // A sentence-long hint for a field this small belongs ON the field, not as one more line
            // of prose in a dialog that already had ten of them.
            title={t('mcp.portHint')}
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
          <p className="mcp-hint">{t('mcp.sharedReach')}</p>
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
                  {c.mcpExposed && reachLine(c)}
                </li>
              ))}
            </ul>
          )}
          {connections.length > 0 && sharedCount === 0 && (
            <p className="mcp-empty">{t('mcp.sharedNone')}</p>
          )}
          {/* Three separate lines of prose for three facts read as noise in the middle of the flow.
              One strip of short items reads as what it is: the limits currently in force. */}
          <p className="mcp-facts">
            <span>{t('mcp.readOnlyShort')}</span>
            <span>
              {t('mcp.rowLimit')}: {ROW_LIMIT_DEFAULT} ({ROW_LIMIT_MAX} max)
            </span>
            <span>{t('mcp.timeLimit', { n: TIMEOUT_CEILING_SECS })}</span>
          </p>
        </section>

        <section className="mcp-section">
          <h4 className="mcp-section-title">{t('mcp.config')}</h4>
          <p className="mcp-hint">{t('mcp.configHint')}</p>
          {/* Two labelled rows rather than two bare button strips. Unlabelled, the second row read as
              a continuation of the first - two identical-looking groups with nothing saying which
              axis each one is. The label is what makes "client" and "transport" independent choices
              instead of five buttons in a pile. */}
          <div className="mcp-pick-row">
            <span className="mcp-pick-label">{t('mcp.pickClient')}</span>
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
          {/* Transport, not a client. A separate axis because every client here speaks both, and
              which one is *reliable* differs per client while which one is *safer* does not - stdio
              never writes the token to disk. */}
          <div className="mcp-pick-row">
            <span className="mcp-pick-label">{t('mcp.pickTransport')}</span>
            {(['http', 'stdio'] as const).map((tr) => (
              <button
                key={tr}
                type="button"
                aria-pressed={tr === transport}
                className={tr === transport ? 'mcp-client-tab active' : 'mcp-client-tab'}
                onClick={() => pickTransport(tr)}
              >
                {tr === 'http' ? t('mcp.transportHttp') : t('mcp.transportStdio')}
              </button>
            ))}
          </div>
          <p className="mcp-hint">{t(activeVariant.targetKey)}</p>
          <pre className="mcp-config">{configSnippet}</pre>
          <button className="btn btn-secondary" onClick={() => copy('config', configSnippet)}>
            {copied === 'config' ? <Check size={11} /> : <Copy size={11} />}
            {copied === 'config'
              ? t('mcp.tokenCopied')
              : activeVariant.isCommand
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
