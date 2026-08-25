// Splits a multi-line buffer in CLI Console into individual Redis commands.
//
// **Do not import Monaco** — same reason `src/sql/statements.ts` avoids it: anything pulling in
// `monaco-editor` fails under Vitest's `node` environment. Editor controls syntax highlighting,
// this file controls execution; keeping it pure is essential for unit testing.
//
// Rules are much simpler than SQL: Redis protocol operates on **one command per
// line**. No statement terminators, no nested blocks, no `$...$`. Using a complex parser
// like `split_sql_statements` here would add unnecessary complexity.

export interface RedisCommandLine {
  /** Command text, trimmed of leading/trailing whitespace. */
  text: string;
  /** 1-based line number in buffer for caret placement and error indicators. */
  line: number;
}

/**
 * Returns all executable commands in buffer in sequential order.
 *
 * Skips empty lines and comment lines. `#` is the native comment character for `redis.conf` and
 * `redis-cli`, matching standard Redis conventions.
 */
export function splitRedisCommands(text: string): RedisCommandLine[] {
  const out: RedisCommandLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.push({ text: trimmed, line: i + 1 });
  }
  return out;
}

/**
 * Command located under caret line, used by Ctrl+Enter.
 *
 * If caret sits on an empty line or comment line, falls back to closest preceding command.
 */
export function commandAtLine(text: string, line: number): RedisCommandLine | null {
  const cmds = splitRedisCommands(text);
  if (cmds.length === 0) return null;
  let found: RedisCommandLine | null = null;
  for (const c of cmds) {
    if (c.line > line) break;
    found = c;
  }
  return found;
}

/**
 * Command name of a line in uppercase, supporting multi-word commands (`CONFIG GET`, `CLIENT LIST`,
 * `XINFO STREAM`...).
 *
 * Uses known command dictionary to distinguish `CONFIG GET` (2-word command) from `GET key` (1-word command + arg).
 */
export function commandNameOf(line: string, known: string[]): string {
  const parts = line.trim().split(/\s+/);
  if (parts.length === 0) return '';
  const one = parts[0].toUpperCase();
  if (parts.length >= 2) {
    const two = `${one} ${parts[1].toUpperCase()}`;
    if (known.includes(two)) return two;
  }
  return one;
}
