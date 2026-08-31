import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import {
  MCP_CLIENTS,
  mcpClient,
  mcpVariant,
  type McpTarget,
  type McpTransport,
} from '../mcpClients';

const TARGET: McpTarget = {
  url: 'http://127.0.0.1:45124/mcp',
  token: 'deadbeef',
  exePath: 'C:/Program Files/TableGrid/tablegrid.exe',
  port: 45124,
};

const TRANSPORTS: McpTransport[] = ['http', 'stdio'];

function built(id: string, transport: McpTransport): string {
  return mcpVariant(id, transport).build(TARGET);
}

describe('mcpClients', () => {
  it('gives every client, on both transports, something addressable', () => {
    for (const c of MCP_CLIENTS) {
      for (const tr of TRANSPORTS) {
        const out = built(c.id, tr);
        expect(out.trim(), `${c.id}/${tr}`).not.toBe('');
        const addressable = out.includes(TARGET.url) || out.includes(TARGET.exePath);
        expect(addressable, `${c.id}/${tr} names neither the url nor the exe`).toBe(true);
      }
    }
  });

  // The whole reason stdio is offered for every client: the token stays in the keyring. If it ever
  // leaks into a stdio config, the §8 risk this closes is back and nobody would notice.
  it('never puts the token in a stdio config, for any client', () => {
    for (const c of MCP_CLIENTS) {
      const out = built(c.id, 'stdio');
      expect(out, c.id).not.toContain(TARGET.token);
      expect(out, c.id).toContain('--mcp-stdio');
    }
  });

  // And the mirror of that: every HTTP config MUST carry it, or the client cannot authenticate.
  it('always puts the token in an http config, for any client', () => {
    for (const c of MCP_CLIENTS) {
      expect(built(c.id, 'http'), c.id).toContain(TARGET.token);
    }
  });

  // stdio has ONE shape across clients - that is what makes it the portable answer. HTTP does not.
  it('emits one identical stdio JSON for the two JSON clients', () => {
    expect(built('antigravity', 'stdio')).toBe(built('generic', 'stdio'));
    const entry = JSON.parse(built('generic', 'stdio')).mcpServers.tablegrid;
    expect(entry.command).toBe(TARGET.exePath);
    expect(entry.args).toEqual(['--mcp-stdio', '--port', String(TARGET.port)]);
    expect(entry.env).toBeUndefined();
  });

  it('falls back to a bare command name when the OS will not say where we are', () => {
    const entry = JSON.parse(
      mcpVariant('generic', 'stdio').build({ ...TARGET, exePath: '' }),
    ).mcpServers.tablegrid;
    expect(entry.command).toBe('tablegrid');
  });

  // Claude Code defaults to the stdio transport when `type` is absent, and does not read MCP servers
  // out of `settings.json` at all - so handing it JSON is handing it something that fails silently.
  it('hands Claude Code a CLI line on both transports, never JSON', () => {
    for (const tr of TRANSPORTS) {
      const out = built('claudeCode', tr);
      expect(out, tr).toContain('claude mcp add');
      expect(out, tr).not.toContain('mcpServers');
      expect(mcpVariant('claudeCode', tr).isCommand, tr).toBe(true);
    }
    expect(built('claudeCode', 'http')).toContain('--transport http');
    // `--` separates claude's own flags from the command to spawn; without it `--mcp-stdio` would be
    // parsed as an option of `claude`.
    expect(built('claudeCode', 'stdio')).toContain('-- "');
  });

  // `claude mcp add` does not merge onto an existing name, so the command has to be re-runnable -
  // after a Regenerate, and after switching transport. Both scopes are cleared so a stale
  // project-scoped entry cannot shadow the user-scoped one.
  it('clears both scopes and registers at user scope, on both transports', () => {
    for (const tr of TRANSPORTS) {
      const lines = built('claudeCode', tr).split('\n');
      expect(lines, tr).toHaveLength(3);
      expect(lines[0], tr).toBe('claude mcp remove tablegrid -s local');
      expect(lines[1], tr).toBe('claude mcp remove tablegrid -s user');
      expect(lines[2], tr).toContain('--scope user');
    }
  });

  // Antigravity's docs: `url` and `httpUrl` are not supported, only `serverUrl`.
  it('uses serverUrl for Antigravity over http, and the bare url for the generic client', () => {
    const ag = JSON.parse(built('antigravity', 'http')).mcpServers.tablegrid;
    expect(ag.serverUrl).toBe(TARGET.url);
    expect(ag.url).toBeUndefined();
    expect(ag.httpUrl).toBeUndefined();

    const gen = JSON.parse(built('generic', 'http')).mcpServers.tablegrid;
    expect(gen.url).toBe(TARGET.url);
    expect(gen.serverUrl).toBeUndefined();
  });

  // The three HTTP spellings must stay distinct: the moment two clients produce the same text, the
  // picker has stopped earning its place and one of them is being handed a config that fails.
  it('produces a distinct http payload per client', () => {
    const outs = MCP_CLIENTS.map((c) => built(c.id, 'http'));
    expect(new Set(outs).size).toBe(MCP_CLIENTS.length);
  });

  // Antigravity defaults to stdio because its HTTP client is broken in at least one install; the
  // others default to the transport actually proven for them.
  it('defaults each client to the transport proven for it', () => {
    expect(mcpClient('claudeCode').defaultTransport).toBe('http');
    expect(mcpClient('antigravity').defaultTransport).toBe('stdio');
    expect(mcpClient('generic').defaultTransport).toBe('http');
  });

  // A renamed key would otherwise render the raw key string into the dialog.
  it('names translation keys that exist, for every client and transport', () => {
    for (const c of MCP_CLIENTS) {
      expect(en.mcp, c.labelKey).toHaveProperty(c.labelKey.replace(/^mcp\./, ''));
      for (const tr of TRANSPORTS) {
        const key = mcpVariant(c.id, tr).targetKey;
        expect(en.mcp, key).toHaveProperty(key.replace(/^mcp\./, ''));
      }
    }
  });

  it('falls back to the first client for an unknown id', () => {
    expect(mcpClient('whatever-an-older-build-wrote').id).toBe(MCP_CLIENTS[0].id);
  });
});
