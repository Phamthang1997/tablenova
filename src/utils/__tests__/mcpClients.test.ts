import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import { MCP_CLIENTS, mcpClient, type McpClientId, type McpTarget } from '../mcpClients';

const TARGET: McpTarget = {
  url: 'http://127.0.0.1:45124/mcp',
  token: 'deadbeef',
  exePath: 'C:/Program Files/TableNova/tablenova.exe',
  port: 45124,
};

function built(id: McpClientId): string {
  return mcpClient(id).build(TARGET);
}

describe('mcpClients', () => {
  // Each client must reach the same server. HOW differs - two speak HTTP and carry the token, one
  // spawns this executable and carries none - so the shared assertion is only that nothing is blank.
  it('gives every client something addressable', () => {
    for (const c of MCP_CLIENTS) {
      const out = c.build(TARGET);
      expect(out.trim(), c.id).not.toBe('');
      const addressable = out.includes(TARGET.url) || out.includes(TARGET.exePath);
      expect(addressable, `${c.id} names neither the url nor the exe`).toBe(true);
    }
  });

  // The bug this table was written for: Claude Code defaults to the stdio transport when `type` is
  // absent, and it does not read MCP servers out of `settings.json` at all - so handing it JSON is
  // handing it something that fails without a message.
  it('hands Claude Code a CLI line with an explicit http transport, not JSON', () => {
    const out = built('claudeCode');
    expect(out).toContain('claude mcp add');
    expect(out).toContain('--transport http');
    expect(out).toContain(TARGET.url);
    expect(out).toContain(`Bearer ${TARGET.token}`);
    expect(out).not.toContain('mcpServers');
  });

  // `claude mcp add` does not merge onto an existing name, so the command has to be re-runnable:
  // after a Regenerate the repair is a replace, and it must be the same thing to copy. Both scopes
  // are cleared so a stale project-scoped entry cannot shadow the user-scoped one.
  it('clears both scopes first so the Claude Code command can be run again', () => {
    const lines = built('claudeCode').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('claude mcp remove tablenova -s local');
    expect(lines[1]).toBe('claude mcp remove tablenova -s user');
    expect(lines[2]).toContain('claude mcp add');
  });

  // On Windows a project-scoped entry is keyed by absolute path, and the CLI canonicalizes that key
  // to the on-disk casing while a session uses whatever its shell wrote - so the CLI reports
  // Connected while the session loads zero tools. User scope writes to the top-level `mcpServers`,
  // which no project key touches.
  it('registers Claude Code at user scope, never the default local', () => {
    expect(built('claudeCode').split('\n')[2]).toContain('--scope user');
  });

  // Antigravity gets the stdio config: its HTTP client fails before reaching us in at least one
  // install, and an absolute path to a repo script cannot travel to another machine. The exe can.
  it('points Antigravity at this executable over stdio, with the port spelled out', () => {
    const entry = JSON.parse(built('antigravity')).mcpServers.tablenova;
    expect(entry.command).toBe(TARGET.exePath);
    expect(entry.args).toEqual(['--mcp-stdio', '--port', String(TARGET.port)]);
    // The whole reason to prefer this shape: no bearer token in the client's plaintext config.
    expect(JSON.stringify(entry)).not.toContain(TARGET.token);
    expect(entry.env).toBeUndefined();
  });

  // A missing exe path must still produce a runnable-looking config rather than `"command": ""`.
  it('falls back to a bare command name when the OS will not say where we are', () => {
    const entry = JSON.parse(mcpClient('antigravity').build({ ...TARGET, exePath: '' })).mcpServers
      .tablenova;
    expect(entry.command).toBe('tablenova');
  });

  it('uses the bare url field for the generic client', () => {
    const entry = JSON.parse(built('generic')).mcpServers.tablenova;
    expect(entry.url).toBe(TARGET.url);
    expect(entry.serverUrl).toBeUndefined();
    expect(entry.headers.Authorization).toBe(`Bearer ${TARGET.token}`);
  });

  // The three spellings must stay distinct: the moment two clients produce the same text, the picker
  // has stopped earning its place and one of them is being handed a config that fails.
  it('produces a distinct payload per client', () => {
    const outs = MCP_CLIENTS.map((c) => c.build(TARGET));
    expect(new Set(outs).size).toBe(MCP_CLIENTS.length);
  });

  // A renamed key would otherwise render the raw key string into the dialog.
  it('names translation keys that exist', () => {
    for (const c of MCP_CLIENTS) {
      for (const key of [c.labelKey, c.targetKey]) {
        expect(en.mcp, key).toHaveProperty(key.replace(/^mcp\./, ''));
      }
    }
  });

  it('falls back to the first client for an unknown id', () => {
    expect(mcpClient('whatever-an-older-build-wrote').id).toBe(MCP_CLIENTS[0].id);
  });
});
