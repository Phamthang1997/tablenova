// Shape of the collection editors. Kept out of the components so `CollectionTable` stays a
// dumb renderer: each Redis type declares its columns and its two write commands, and the
// table knows nothing about hashes, lists, sets or sorted sets.

export interface CollColumn {
  label: string;
  editable: boolean;
  /** Shown instead of an input on the "add" row when the column is not editable (list index). */
  addHint?: string;
  placeholder?: string;
  width?: string;
}

export interface CollRow {
  id: string;
  cells: string[];
  /** Value is not valid UTF-8, so `cells` is lossy -> editing would destroy the real bytes. */
  binary?: boolean;
  /** The element's *identity* is binary (hash field, set/zset member) -> deleting is unsafe too. */
  binaryKey?: boolean;
}

export interface CollectionEditor {
  kind: string;
  cols: CollColumn[];
  /** Maps one backend element to a row. `i` is the index within the loaded page list. */
  toRow: (el: any, i: number) => CollRow;
  /**
   * True when the server can filter the elements itself (HSCAN/SSCAN MATCH). For list, zset
   * and stream there is no such option, so the UI must say the filter only covers what is
   * already loaded instead of pretending it searched the whole key.
   */
  serverFilter: boolean;
  /**
   * Deleting shifts every later index (list only), so the loaded pages must be re-read
   * afterwards; identity-based types can just drop the row.
   */
  indexShiftsOnDelete: boolean;
  /** `prev === null` means "add a new element". Returns true when the write succeeded. */
  onCommit: (cells: string[], prev: CollRow | null) => Promise<boolean>;
  onDelete: (row: CollRow) => Promise<boolean>;
}
