// A setting stored **per server** (`connKey`) in localStorage, emitting an event when it changes.
//
// This is the shared shape, not one particular setting. `safeMode.ts` wrote it by hand first (it also
// needs command classification, so it keeps its own copy), and then `stmtTimeout` and "preview the SQL
// before saving" repeated it verbatim: read localStorage once and memoise, delete the entry when the
// value equals the default, drop the cache when another window writes, emit a `CustomEvent` so an open
// control updates itself. A third copy is where it has to stop — those four lines wrong in one copy is
// a setting that silently does not persist.
//
// Two rules live in this shape rather than at the call sites:
//
//  - **The default DELETES the entry** rather than writing the default value. That keeps localStorage
//    from growing a row per server the user ever opened, and an older record (from before this setting
//    existed) reads back as the default rather than `undefined`.
//  - **An empty key returns the default and writes nothing.** An empty key means "which server this is
//    is not known yet" (the `connKey` of a config that lacks the information); writing under it would
//    write for every server at once.

/** Reads and writes one per-server setting, plus the event name to listen on for changes. */
export interface ConnPref<T> {
  /** The name of the `CustomEvent` emitted after every write. */
  readonly EVENT: string;
  get(key: string): T;
  set(key: string, value: T): void;
}

/**
 * Builds one per-server setting.
 *
 * `normalize` takes the raw value out of JSON and returns `null` when it is unusable (wrong type, out
 * of range, or exactly the default) — `null` means "use the default", so a junk entry never becomes a
 * strange value, and `set` uses the very same function to decide between deleting and writing.
 */
export function createConnPref<T>(
  storageKey: string,
  event: string,
  fallback: T,
  normalize: (raw: unknown) => T | null,
): ConnPref<T> {
  let cache: Record<string, unknown> | null = null;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key === storageKey) cache = null;
    });
  }

  const readAll = (): Record<string, unknown> => {
    if (cache) return cache;
    try {
      if (typeof localStorage === 'undefined') return (cache = {});
      const raw = localStorage.getItem(storageKey);
      if (!raw) return (cache = {});
      const parsed = JSON.parse(raw);
      return (cache = parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      return (cache = {});
    }
  };

  return {
    EVENT: event,

    get(key: string): T {
      if (!key) return fallback;
      return normalize(readAll()[key]) ?? fallback;
    },

    set(key: string, value: T): void {
      if (!key) return;
      const all = { ...readAll() };
      const normalized = normalize(value);
      if (normalized === null) delete all[key];
      else all[key] = normalized;
      cache = all;
      try {
        localStorage.setItem(storageKey, JSON.stringify(all));
      } catch {
        // Out of quota means the value does not persist, but the control must not look broken.
      }
      // Under Vitest (`environment: 'node'`) there is no `window` — guarded, rather than killing the module at import.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(event));
      }
    },
  };
}
