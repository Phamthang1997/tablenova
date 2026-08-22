// When the data grid has to ask the backend for a row count, and when it must not.
//
// Counting is the expensive half of `get_table_data`: the page itself reads `pageSize` rows while
// `SELECT COUNT(*)` re-scans the table (or the whole filter). Flipping a page, changing the page
// size or clicking a column header cannot change that number, so re-counting on those is pure
// waste — on a 20M-row table it is the difference between a page flip and a full index scan.
//
// This lives here, as two pure functions with tests, because the failure mode is silent: forget to
// invalidate after a write and the grid keeps showing a stale total, which looks like data that
// went missing. Nothing about it needs React or Tauri.

/** What the backend should do about the count on this request. See `get_table_data`. */
export type CountMode = 'exact' | 'auto' | 'skip';

/**
 * Identity of "the thing being counted": one table, under one filter, at one revision of the data.
 *
 * `dataVersion` is a counter the grid bumps after every write it performs (commit, import) and on
 * an explicit refresh — the three ways the answer can change while table and filter stay the same.
 *
 * `JSON.stringify` rather than joining on a separator: a filter clause is arbitrary user SQL, so
 * any delimiter chosen would also be a delimiter someone can type — and two different states
 * hashing to one key means a count that never refreshes.
 */
export function countKey(table: string, filter: string, dataVersion: number): string {
  return JSON.stringify([table, filter, dataVersion]);
}

/**
 * `'skip'` while the counted thing is unchanged, `'auto'` when it changed, `'exact'` when the user
 * asked for the real number.
 *
 * `lastCountedKey` is the key of the last request that actually **came back with a count** — not
 * the last request sent. A count that failed or was skipped must not mark the key as done, or the
 * grid would sit on `null` forever.
 */
export function nextCountMode(
  lastCountedKey: string | null,
  key: string,
  forceExact = false
): CountMode {
  if (forceExact) return 'exact';
  return lastCountedKey === key ? 'skip' : 'auto';
}

/**
 * The column a page can be sought on, or `null` when this view has to page by `OFFSET`.
 *
 * Naming a column also asks the backend to `ORDER BY` it when nothing else is sorted — that order
 * is what makes a `> last` boundary mean anything — so each condition below is a reason it would
 * either be wrong or cost more than the `OFFSET` it replaces:
 *
 *  - **Exactly one primary-key column.** A composite key needs row-value comparison, and a
 *    non-unique column repeats values, so a single `>` boundary would skip or repeat rows.
 *  - **No sort on a different column.** A sort on the key itself is fine in either direction; the
 *    backend flips the comparison to match.
 *  - **No filter.** This one is about the query plan, not correctness. Today a filtered page runs
 *    with no `ORDER BY`, so the engine stops as soon as it has `LIMIT` matching rows; adding
 *    `ORDER BY pk` to a filter on an unindexed column makes it a full scan plus a top-N sort
 *    instead — slower than what it replaced, on exactly the big tables this is meant to help.
 *    Deep paging through a filter is also the rare case: the filter is what people use *instead*
 *    of paging deep.
 */
export function seekColumn(pkColumns: string[], sortBy?: string, filter?: string): string | null {
  if (pkColumns.length !== 1) return null;
  const pk = pkColumns[0];
  if (!pk) return null;
  if (sortBy && sortBy !== pk) return null;
  if (filter && filter.trim()) return null;
  return pk;
}

/**
 * Identity of the ordered sequence the cursors walk along.
 *
 * Cursors from one sequence are meaningless in another: a cursor taken under `ORDER BY id ASC` is
 * not a boundary under `DESC`, and a page-size change re-cuts where every boundary falls. Keying
 * the stored cursors by this and dropping them on a mismatch beats resetting them by hand at each
 * of the four places that can change it — the failure mode of a missed reset is a page of the
 * *wrong rows*, with nothing on screen to say so.
 *
 * `dataVersion` is deliberately **not** part of it: a write does not move the boundaries, and
 * rebuilding the stack would kick the user back to page 1 after every save.
 */
export function seekViewKey(
  table: string,
  filter: string,
  sortBy: string | undefined,
  sortDir: string,
  pageSize: number
): string {
  return JSON.stringify([table, filter, sortBy ?? null, sortDir, pageSize]);
}
