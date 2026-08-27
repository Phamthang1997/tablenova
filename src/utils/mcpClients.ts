/**
 * How each AI client wants the built-in MCP server spelled out.
 *
 * Every client here speaks the same Streamable HTTP endpoint and takes an identical `Authorization`
 * header - only the field naming the URL differs, and each client **ignores the others' spelling
 * without reporting an error**. That silence is the whole reason this table exists instead of one
 * snippet: a config meant for another client looks accepted and simply never connects.
 *
 * - **Claude Code** needs `"type": "http"`; absent it the transport defaults to stdio and the client
 *   goes looking for a `command` that does not exist. It also does not read MCP servers out of
 *   `settings.json` at all - that schema sets `additionalProperties: true`, so a block pasted there
 *   is accepted by the editor and ignored by the client, the worst of both. Handing over the CLI line
 *   instead of JSON closes both traps at once: `claude mcp add` picks the file and the transport
 *   itself.
 * - **Antigravity** requires `serverUrl`; its docs state `url` and `httpUrl` are not supported. The
 *   file is `~/.gemini/config/mcp_config.json`.
 * - **generic** is the bare `url` form the remaining clients (Cursor and friends) infer from.
 *
 * Kept here rather than in `McpServerSettingsModal.tsx` for the same reason `src/sql/statements.ts`
 * is kept out of the Monaco integration: this module imports nothing, so the exact spelling per
 * client is pinned by `__tests__/mcpClients.test.ts` instead of by whoever opens the dialog next.
 */

/** The server name every client registers us under. */
const SERVER_NAME = 'tablenova';

/** The `mcpServers` wrapper the JSON clients share. Only the field naming the URL differs. */
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

export const MCP_CLIENTS = [
  {
    id: 'claudeCode',
    labelKey: 'mcp.clientClaudeCode',
    targetKey: 'mcp.targetClaudeCode',
    /** Shell lines, so the button offers to copy a command rather than a config. */
    isCommand: true,
    /**
     * Three lines, and every one of them is load-bearing on a machine that is not this one.
     *
     * **`--scope user`, never the default `local`.** A project-scoped entry lives under an absolute
     * path key in `~/.claude.json`, and on Windows the CLI and the session runtime disagree about
     * that key: `claude mcp add`/`list` canonicalize to the on-disk casing (`C:/…`) while a session
     * opened from Git Bash or an IDE uses `c:/…`. Both entries then exist, only one carries
     * `mcpServers`, and the result is the worst shape a setup bug can take - the CLI reports
     * **✔ Connected** while the session loads **zero** tools, with nothing anywhere to explain it.
     * User scope writes to the top-level `mcpServers`, which no project key touches. Cost, stated in
     * the dialog: the server is then offered in every project.
     *
     * **The two `remove` lines** make this re-runnable and leave no shadow. `claude mcp add` does not
     * merge onto an existing name, so after a Regenerate the repair is a *replace*; and clearing
     * `local` too is what stops a stale project-scoped entry from shadowing the user-scoped one on a
     * machine that was set up before this. On a fresh machine both lines just print "not found" and
     * the third still runs - cheaper than making the user choose between two variants of the
     * instruction while something is already broken.
     */
    build: (url: string, token: string) =>
      `claude mcp remove ${SERVER_NAME} -s local\n` +
      `claude mcp remove ${SERVER_NAME} -s user\n` +
      `claude mcp add --transport http ${SERVER_NAME} ${url} ` +
      `--header "Authorization: Bearer ${token}" --scope user`,
  },
  {
    id: 'antigravity',
    labelKey: 'mcp.clientAntigravity',
    targetKey: 'mcp.targetAntigravity',
    isCommand: false,
    build: (url: string, token: string) => serverJson({ serverUrl: url }, token),
  },
  {
    id: 'generic',
    labelKey: 'mcp.clientGeneric',
    targetKey: 'mcp.targetGeneric',
    isCommand: false,
    build: (url: string, token: string) => serverJson({ url }, token),
  },
] as const;

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
