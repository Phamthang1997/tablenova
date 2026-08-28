/**
 * How each AI client wants the built-in MCP server spelled out, over each transport.
 *
 * **Two transports, and they are not equivalent.**
 *
 * - **stdio** (`tablenova --mcp-stdio`) has exactly ONE shape - `{ command, args }` - and every client
 *   here accepts it. It carries **no token**, because the spawned process reads the keyring itself,
 *   which is the only way this app closes the "token sits in a plaintext client config" risk
 *   (`docs/mcp-server-plan.md` §8). Its cost is a child process per client session.
 * - **HTTP** has THREE different field names for the same endpoint, and each client ignores the
 *   others' spelling **without reporting an error**: Claude Code needs `"type": "http"` (absent it
 *   defaults to stdio and hunts for a `command`), Antigravity requires `serverUrl` (its docs state
 *   `url` and `httpUrl` are unsupported), and the rest infer from a bare `url`. That silence is why
 *   this table exists rather than one snippet: a config meant for another client looks accepted and
 *   simply never connects.
 *
 * So stdio is the portable answer and HTTP is the one that needs a per-client table. Each client keeps
 * a `defaultTransport` pointing at whichever is actually proven for it rather than at whichever is
 * tidier in the abstract - Claude Code's HTTP path works and is tested, Antigravity's is broken in at
 * least one install (§6 Bước 3, bẫy 6).
 *
 * Kept out of `McpServerSettingsModal.tsx` for the same reason `src/sql/statements.ts` is kept out of
 * the Monaco integration: this module imports nothing, so the exact spelling per client and transport
 * is pinned by `__tests__/mcpClients.test.ts` instead of by whoever opens the dialog next.
 */

/** The server name every client registers us under. */
const SERVER_NAME = 'tablenova';

export type McpTransport = 'http' | 'stdio';

/** What every builder is handed. One object, so adding a field does not touch six signatures. */
export interface McpTarget {
  /** The endpoint the server is actually bound to. */
  url: string;
  token: string;
  /** This app's own executable, for the `--mcp-stdio` config. */
  exePath: string;
  port: number;
}

/** The `mcpServers` wrapper the HTTP JSON clients share. Only the field naming the URL differs. */
function serverJson(urlField: Record<string, string>, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: { ...urlField, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

/**
 * The stdio config, identical for every JSON client.
 *
 * `--port` is written out rather than left to the default: the default lives in `mcp/server.rs`, and a
 * config that silently disagrees with the bound port is the exact failure this dialog exists to
 * prevent. `exePath` falls back to a bare name so a config is never emitted with `"command": ""`.
 */
function stdioJson({ exePath, port }: McpTarget): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: exePath || SERVER_NAME,
          args: ['--mcp-stdio', '--port', String(port)],
        },
      },
    },
    null,
    2,
  );
}

interface Variant {
  /** Says where the text goes, and what to watch out for, for this client+transport. */
  targetKey:
    | 'mcp.targetClaudeCode'
    | 'mcp.targetClaudeCodeStdio'
    | 'mcp.targetAntigravity'
    | 'mcp.targetAntigravityHttp'
    | 'mcp.targetGeneric'
    | 'mcp.targetGenericStdio';
  /** A shell line rather than a config file, so the button offers to copy a command. */
  isCommand: boolean;
  build: (target: McpTarget) => string;
}

/**
 * The `remove` lines that make a `claude mcp add` re-runnable.
 *
 * `claude mcp add` does not merge onto an existing name, so after a Regenerate - or a switch between
 * transports - the repair is a *replace*. Clearing `local` too is what stops a stale project-scoped
 * entry from shadowing the user-scoped one on a machine set up before `--scope user` was used here. On
 * a fresh machine both lines just print "not found" and the `add` still runs, which is cheaper than
 * making the user choose between two variants of the instruction while something is already broken.
 */
const CLAUDE_RESET = `claude mcp remove ${SERVER_NAME} -s local\nclaude mcp remove ${SERVER_NAME} -s user\n`;

/**
 * `--scope user`, never the default `local`.
 *
 * A project-scoped entry lives under an absolute path key in `~/.claude.json`, and on Windows the CLI
 * and the session runtime disagree about that key: `claude mcp add`/`list` canonicalize to the on-disk
 * casing (`C:/…`) while a session opened from Git Bash or an IDE uses `c:/…`. Both entries then exist,
 * only one carries `mcpServers`, and the result is the worst shape a setup bug can take - the CLI
 * reports **✔ Connected** while the session loads **zero** tools, with nothing anywhere to explain it.
 * User scope writes to the top-level `mcpServers`, which no project key touches. Cost, stated in the
 * dialog: the server is then offered in every project.
 */
const CLAUDE_SCOPE = '--scope user';

export const MCP_CLIENTS = [
  {
    id: 'claudeCode',
    labelKey: 'mcp.clientClaudeCode',
    /** HTTP is proven for this client and stdio is the newer option, so the default stays put. */
    defaultTransport: 'http' as McpTransport,
    variants: {
      http: {
        targetKey: 'mcp.targetClaudeCode',
        isCommand: true,
        build: ({ url, token }: McpTarget) =>
          `${CLAUDE_RESET}claude mcp add --transport http ${SERVER_NAME} ${url} ` +
          `--header "Authorization: Bearer ${token}" ${CLAUDE_SCOPE}`,
      },
      stdio: {
        // `--` separates the CLI's own flags from the command it should spawn; without it `claude`
        // would try to parse `--mcp-stdio` as one of its own options.
        targetKey: 'mcp.targetClaudeCodeStdio',
        isCommand: true,
        build: ({ exePath, port }: McpTarget) =>
          `${CLAUDE_RESET}claude mcp add ${SERVER_NAME} ${CLAUDE_SCOPE} ` +
          `-- "${exePath || SERVER_NAME}" --mcp-stdio --port ${port}`,
      },
    },
  },
  {
    id: 'antigravity',
    labelKey: 'mcp.clientAntigravity',
    /**
     * stdio by default for this one, and not out of preference: Antigravity's HTTP client began
     * failing before any request reached the server (its own log, at every IDE startup: `failed to
     * get server directory`), identically across five server configurations and a cleared tool cache.
     * Its HTTP variant is kept because that path did work here once and may be fine elsewhere.
     */
    defaultTransport: 'stdio' as McpTransport,
    variants: {
      http: {
        targetKey: 'mcp.targetAntigravityHttp',
        isCommand: false,
        build: ({ url, token }: McpTarget) => serverJson({ serverUrl: url }, token),
      },
      stdio: { targetKey: 'mcp.targetAntigravity', isCommand: false, build: stdioJson },
    },
  },
  {
    id: 'generic',
    labelKey: 'mcp.clientGeneric',
    defaultTransport: 'http' as McpTransport,
    variants: {
      http: {
        targetKey: 'mcp.targetGeneric',
        isCommand: false,
        build: ({ url, token }: McpTarget) => serverJson({ url }, token),
      },
      stdio: { targetKey: 'mcp.targetGenericStdio', isCommand: false, build: stdioJson },
    },
  },
] as const satisfies readonly {
  id: string;
  labelKey: string;
  defaultTransport: McpTransport;
  variants: Record<McpTransport, Variant>;
}[];

export type McpClientId = (typeof MCP_CLIENTS)[number]['id'];

/**
 * The table entry for an id, falling back to the first client.
 *
 * Total on purpose: the id is persisted in `localStorage`, so a value written by an older build must
 * render *something* rather than an empty section.
 */
export function mcpClient(id: string): (typeof MCP_CLIENTS)[number] {
  return MCP_CLIENTS.find((c) => c.id === id) ?? MCP_CLIENTS[0];
}

/** The variant for a client+transport. Total for the same reason `mcpClient` is. */
export function mcpVariant(id: string, transport: McpTransport): Variant {
  const client = mcpClient(id);
  return client.variants[transport] ?? client.variants[client.defaultTransport];
}
