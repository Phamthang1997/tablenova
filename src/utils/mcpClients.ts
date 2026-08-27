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
     * Two lines, and the `remove` is the load-bearing one.
     *
     * `claude mcp add` on a name that already exists does not merge - so the moment the token is
     * regenerated, the fix is to replace the entry, not to add it again. Leading with `remove` makes
     * this command **re-runnable**: one thing to copy whether it is first-time setup or a repair
     * after Regenerate. On a machine with nothing registered the first line just prints "not found"
     * and the second still runs, which is a cheaper cost than two variants of the instruction that
     * the user has to choose between while something is already broken.
     */
    build: (url: string, token: string) =>
      `claude mcp remove ${SERVER_NAME}\n` +
      `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`,
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
