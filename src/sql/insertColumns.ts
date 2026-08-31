/**
 * The column list suggested after `INSERT INTO <table> `.
 *
 * In a module of its own that **imports no monaco**, for the same reason as `joinConditions.ts`
 * and `statements.ts`: this is a pure function over schema data, so it has to be testable in a
 * node environment.
 */

/** Minimal column subset needed to decide whether a column may be written by hand. */
export interface InsertColumn {
  name: string;
  /** The database assigns it. */
  autoIncrement?: boolean;
  /** `GENERATED ALWAYS AS (…)` — writing it is MySQL error 3105. */
  generated?: boolean;
  /** Postgres `GENERATED ALWAYS AS IDENTITY` — a write needs `OVERRIDING SYSTEM VALUE`. */
  identityAlways?: boolean;
}

/**
 * Detects `INSERT INTO <table> ` immediately before the caret and returns the table name.
 *
 * Anchored at the end of the text, so it can only match when the caret sits right after the target
 * and at least one space. Returns the **bare** name: a qualified `schema.users` keeps only its last
 * segment, and any quoting (backtick, double quote, bracket) is stripped, because that is the form
 * the catalog is keyed by.
 *
 * `INSERT INTO t (` and `INSERT INTO t SELECT` are deliberately NOT matched — the user has already
 * moved past the column list, so a suggestion there would insert into the middle of their statement.
 */
export function insertTargetBeforeCaret(textBefore: string): string | null {
  const m = /\binsert\s+(?:ignore\s+)?into\s+([\w$."`[\]]+)\s+$/i.exec(textBefore);
  if (!m) return null;
  const raw = m[1];
  // A trailing dot means the user is still typing a qualified name (`schema.`), not done with it.
  if (raw.endsWith('.')) return null;
  const last = raw.split('.').pop() || '';
  const name = last.replace(/[`"[\]]/g, '').trim();
  return name || null;
}

/**
 * The columns a person may supply values for, in table order.
 *
 * Three kinds are dropped, all of them columns the database writes itself:
 * `autoIncrement`, `generated` (an error to write), and `identityAlways` (needs
 * `OVERRIDING SYSTEM VALUE`, which someone hand-writing an INSERT almost never wants).
 *
 * **This deliberately differs from `dumpBuilder.ts`, which KEEPS `identityAlways` columns** — a
 * dump has to reproduce exact keys or every foreign key pointing at them breaks. A dump and a
 * hand-typed statement have opposite requirements; do not "fix" one to match the other.
 */
export function writableInsertColumns(columns: InsertColumn[]): string[] {
  return columns
    .filter(c => !c.autoIncrement && !c.generated && !c.identityAlways)
    .map(c => c.name);
}

/**
 * The snippet body: `(a, b, c) VALUES ()` with the caret parked inside the parentheses.
 *
 * Returns `null` when there is nothing to offer — no columns at all, or every column written by the
 * database. An empty `()` is not a useful suggestion, and offering it would push a real suggestion
 * out of the top slot.
 */
export function buildInsertColumnsSnippet(columns: InsertColumn[]): { text: string; count: number } | null {
  const names = writableInsertColumns(columns);
  if (!names.length) return null;
  return { text: `(${names.join(', ')}) VALUES (${'$1'})`, count: names.length };
}
