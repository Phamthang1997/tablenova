import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import { MCP_CLIENTS, mcpClient, type McpClientId } from '../mcpClients';

const URL = 'http://127.0.0.1:45124/mcp';
const TOKEN = 'deadbeef';

function built(id: McpClientId): string {
  return mcpClient(id).build(URL, TOKEN);
}

describe('mcpClients', () => {
  it('gives every client the endpoint and the token', () => {
    for (const c of MCP_CLIENTS) {
      const out = c.build(URL, TOKEN);
      expect(out, c.id).toContain(URL);
      expect(out, c.id).toContain(`Bearer ${TOKEN}`);
    }
  });

  // The bug this table was written for: Claude Code defaults to the stdio transport when `type` is
  // absent, and it does not read MCP servers out of `settings.json` at all - so handing it JSON is
  // handing it something that fails without a message.
  it('hands Claude Code a CLI line with an explicit http transport, not JSON', () => {
    const out = built('claudeCode');
    expect(out).toContain('claude mcp add');
    expect(out).toContain('--transport http');
    expect(out).not.toContain('mcpServers');
  });

  // `claude mcp add` does not merge onto an existing name, so the command has to be re-runnable:
  // after a Regenerate the repair is a replace, and it must be the same thing to copy.
  it('leads with remove so the Claude Code command can be run again', () => {
    const lines = built('claudeCode').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('claude mcp remove tablenova');
    expect(lines[1]).toContain('claude mcp add');
  });

  // Antigravity's docs: `url` and `httpUrl` are not supported.
  it('uses serverUrl for Antigravity and nothing else', () => {
    const parsed = JSON.parse(built('antigravity'));
    const entry = parsed.mcpServers.tablenova;
    expect(entry.serverUrl).toBe(URL);
    expect(entry.url).toBeUndefined();
    expect(entry.httpUrl).toBeUndefined();
    expect(entry.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('uses the bare url field for the generic client', () => {
    const entry = JSON.parse(built('generic')).mcpServers.tablenova;
    expect(entry.url).toBe(URL);
    expect(entry.serverUrl).toBeUndefined();
  });

  // The three spellings must stay mutually exclusive: the moment two clients produce the same text,
  // the picker has stopped earning its place and one of them is being handed a config that fails.
  it('produces a distinct payload per client', () => {
    const outs = MCP_CLIENTS.map((c) => c.build(URL, TOKEN));
    expect(new Set(outs).size).toBe(MCP_CLIENTS.length);
  });

  // A renamed key would otherwise render the raw key string into the dialog.
  it('names translation keys that exist', () => {
    for (const c of MCP_CLIENTS) {
      for (const key of [c.labelKey, c.targetKey]) {
        const leaf = key.replace(/^mcp\./, '');
        expect(en.mcp, key).toHaveProperty(leaf);
      }
    }
  });

  it('falls back to the first client for an unknown id', () => {
    expect(mcpClient('whatever-an-older-build-wrote').id).toBe(MCP_CLIENTS[0].id);
  });
});
