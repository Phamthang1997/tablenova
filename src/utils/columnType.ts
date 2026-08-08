// Splitting a SQL column type into "the type" and "its length/precision", so the
// structure editor can offer a plain dropdown for one and a small text box for the
// other instead of making the user hand-type `varchar(255)` into a combobox.
//
// The parens are NOT always at the end — MySQL puts modifiers after them
// (`int(10) unsigned`) — and the type itself may contain spaces
// (`character varying(45)`, `timestamp without time zone`), so what comes before the
// paren and what comes after it are kept separately and re-joined in place.

export interface TypeParts {
  /** Text before the paren: `int`, `character varying`, `enum` */
  head: string;
  /** Inside the paren: `255`, `10,2`, `'M','F'` — empty when the type takes none */
  args: string;
  /** Text after the paren: `unsigned`, `unsigned zerofill` */
  tail: string;
}

export function splitType(raw: string | null | undefined): TypeParts {
  const s = (raw || '').trim();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  // lastIndexOf so `enum('a(1)','b')` keeps its inner paren inside args
  if (open < 0 || close < open) return { head: s, args: '', tail: '' };
  return {
    head: s.slice(0, open).trim(),
    args: s.slice(open + 1, close).trim(),
    tail: s.slice(close + 1).trim(),
  };
}

export function joinType(head: string, args: string, tail: string): string {
  const h = (head || '').trim();
  const a = (args || '').trim();
  const t = (tail || '').trim();
  return `${h}${a ? `(${a})` : ''}${t ? ` ${t}` : ''}`;
}

/** What the "Data type" cell shows — the type without its length: `int unsigned` */
export function typeBase(raw: string | null | undefined): string {
  const { head, tail } = splitType(raw);
  return tail ? `${head} ${tail}` : head;
}
