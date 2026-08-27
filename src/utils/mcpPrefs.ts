/**
 * The two MCP server settings that must outlive one app run: whether to start it, and on which port.
 *
 * **Frontend-durable, Rust-effective, pushed down at startup** — the same shape `read_only` and Safe
 * Mode already use. Rust deliberately gains no settings file of its own for this: the app's only
 * persistent stores are `localStorage` and the OS keyring, and a third one would be a third place to
 * look when a setting does not take.
 *
 * **Only the server switch is persisted, never which connections are shared.** A running server with
 * nothing ticked exposes nothing — `list_mcp_exposed()` returns an empty list and every other tool
 * refuses an unshared `conn_id` — so bringing the listener back up on its own leaks nothing. The flag
 * that decides what an AI may actually read is `mcp_exposed`, and it stays per-run on purpose: see
 * its doc comment in `state/entry.rs` and `docs/mcp-server-plan.md` §3.3. Persisting the harmless
 * half and not the load-bearing half is the whole point of splitting them.
 */

/** Global keys: which port the server listens on is not a property of any database connection. */
const AUTOSTART_KEY = 'tf_mcp_autostart';
const PORT_KEY = 'tf_mcp_port';

export interface McpPrefs {
  autoStart: boolean;
  /**
   * `undefined` means "whatever the backend's default is".
   *
   * The default port is a constant in `mcp/server.rs` and is deliberately NOT copied here: passing
   * `undefined` to `mcp_start` makes Rust apply its own, so the two can never disagree about which
   * port the generated client config should name.
   */
  port?: number;
}

/**
 * A stored port, or `undefined` when there is nothing usable to use.
 *
 * Exported for its own test: this is the one part with a wrong answer available. A `0`, a `70000` or
 * a leftover `"default"` must fall back rather than reach `bind()`, where the failure surfaces as
 * "port already in use" or a listener nobody asked for.
 */
export function parsePort(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

export function readMcpPrefs(): McpPrefs {
  try {
    return {
      autoStart: localStorage.getItem(AUTOSTART_KEY) === 'true',
      port: parsePort(localStorage.getItem(PORT_KEY)),
    };
  } catch {
    // A blocked localStorage means the server simply does not autostart. Never a thrown error at
    // app boot, where nothing is mounted yet to show one.
    return { autoStart: false };
  }
}

export function setMcpAutoStart(on: boolean): void {
  try {
    localStorage.setItem(AUTOSTART_KEY, String(on)); // 'tf_mcp_autostart'
  } catch {
    // Losing the preference is not worth failing the click over.
  }
}

/** Remembers the port the user actually started on; `undefined` forgets it back to the default. */
export function setMcpPort(port: number | undefined): void {
  try {
    if (port === undefined) localStorage.removeItem(PORT_KEY); // 'tf_mcp_port'
    else localStorage.setItem(PORT_KEY, String(port));
  } catch {
    // As above.
  }
}
