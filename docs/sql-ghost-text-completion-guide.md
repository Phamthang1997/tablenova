# INSERT Column List Completion — and why not ghost text

**Decision: build one suggestion item in the existing popup. Do not build an inline ghost-text
engine.** This document records both the small thing to build and the larger thing that was
considered and rejected, so the rejected design is not proposed again from scratch.

The filename still says `ghost-text` because that is where the question was first written down and
where [`sql-smart-completion-plan.md`](sql-smart-completion-plan.md) points; §5 is the ghost-text
record.

---

## 0. Summary

| | |
|---|---|
| **Ships** | One completion item: after `INSERT INTO <table> `, offer that table's real column list |
| **Files touched** | [`sqlLanguage.ts`](../src/sql/sqlLanguage.ts), [`catalog.ts`](../src/sql/catalog.ts), 3 locale files |
| **Rust changes** | **None** |
| **Monaco option changes** | **None** |
| **New providers / settings / storage keys** | **None** |
| **Rejected** | Inline ghost-text provider, history prefix matching, `suppressSuggestions` (§5) |

The reasoning behind the size: the only part of the original ghost-text plan with real value was the
column list. Everything else was either already shipped (`JOIN … ON` by FK, `SELECT *` expansion —
stage **B3** of the smart-completion plan), already available elsewhere (query history has a
searchable drawer with saved queries), or a convenience worth a few keystrokes. A plan that risks a
working feature to deliver a few keystrokes is the wrong trade.

---

## 1. What ships

After `INSERT INTO users `, the popup offers one item ranked at the top:

```
(name, email, status, created_at)        list 4 columns · users
```

Accepting inserts the column list, `VALUES (…)` included, as a snippet so `Tab` walks the value
positions.

Build it exactly where its twin already lives — the `SELECT *` expansion at
[`sqlLanguage.ts:249-266`](../src/sql/sqlLanguage.ts#L249-L266), inside the same
`completionService`:

- Trigger: `/\binsert\s+into\s+([`"\[\]\w.]+)\s+$/i` against the same `textBefore` the
  neighbouring rules use.
- Rank `'00_insertcols'` — the `00_` tier, above the FK JOIN conditions at `'0_'`, matching how
  `'00_starlist'` already outranks them.
- `kind: Snippet`, `detail` from a new i18n key, `documentation` showing the SQL in a fenced block —
  copy the shape of the `'00_starlist'` item rather than inventing a presentation.

**Why the popup and not ghost text**: it inherits incremental prefix filtering, it uses the `Tab`
that already works, and an unwanted suggestion costs `Esc` instead of competing for a keybinding.

---

## 2. The one obstacle, and its frontend fix

`catalog.getSchema()` returns the **primed** entry when one exists, and
[`primeCatalog`](../src/sql/catalog.ts#L38-L45) fabricates most of a column: `nullable: true`
hardcoded, `defaultValue: null`, `indexes: []`, and `autoIncrement` / `generated` /
`identityAlways` absent entirely. Only `name`, `type` and `isPrimaryKey` are real, because
`get_full_catalog` returns only those three.

The per-table path already has everything needed — `get_table_schema` returns `autoIncrement`,
`generated` and `identityAlways` for all three dialects
([`introspect.rs`](../src-tauri/src/database/introspect.rs#L288-L297) for Postgres,
[`:391-395`](../src-tauri/src/database/introspect.rs#L391-L395) for MySQL). So **no backend change is
required**; the primed entry is merely shadowing it.

Add to [`catalog.ts`](../src/sql/catalog.ts) a second, separate cache:

```ts
// Full per-table schema — every flag the backend reports, unlike the primed entry from
// `get_full_catalog`, which carries only name/type/isPrimaryKey and fabricates the rest.
export async function getSchemaDetailed(connId: string, table: string): Promise<SchemaInfo | null>
```

- Its own `Map` on `ConnCache`, so it never overwrites or is overwritten by the primed schemas.
- One `dbHelper.getTableSchema` call per table, then cached — the user has already typed a table
  name, so this is one round trip on a deliberate action, not per keystroke.
- Cleared by the existing `invalidateCatalog()` alongside the other maps.

This is the whole reason the plan carries no Rust work: **nothing that reads the primed cache today
changes behaviour.**

---

## 3. Which columns to include

Omit from the suggested list:

- `autoIncrement` — the database assigns it.
- `generated` — writing it is MySQL error 3105.
- `identityAlways` — a Postgres `GENERATED ALWAYS AS IDENTITY` write fails without
  `OVERRIDING SYSTEM VALUE`, and a person hand-writing an `INSERT` almost never wants to override
  the sequence.

**Do not "fix" this to match `dumpBuilder.ts`.** That module deliberately *keeps* `identityAlways`
columns, because a dump must reproduce exact keys or every foreign key pointing at them breaks. A
dump and a hand-typed statement have opposite requirements; the divergence is intentional and this
paragraph is why.

If every column would be omitted, **offer nothing** — an empty `()` is not a helpful suggestion.
Quote identifiers per dialect only where the name requires it.

---

## 4. Risk

What this change **cannot** affect, by construction:

- The suggest widget's behaviour anywhere else — the item is additive and gated on a regex that only
  matches after `INSERT INTO <name> `.
- Every other consumer of the catalog — `getSchemaDetailed` writes to a new map; `getSchema` and
  `getCachedSchema` are untouched.
- Editor options, keybindings, and the popup/ghost-text interaction — none are modified.
- Any backend command, any dialect branch, any Rust file.

The three bounded risks that remain:

1. **One extra IPC call per table** the first time an `INSERT` is typed for it. Bounded by the cache
   and by the fact that the user typed a table name to get here.
2. **A stale cache after DDL** shows a dropped column. Same exposure the existing completion already
   has, and cleared by the same `invalidateCatalog()`.
3. **SQLite tables absent from the primed cache** simply take the per-table path — which is what
   `getSchemaDetailed` does for every dialect anyway, so SQLite needs no special case here.

---

## 5. Rejected: the inline ghost-text engine

Recorded so it is not re-derived. The original plan proposed a
`registerInlineCompletionsProvider` with four rules, `Tab` to accept, and three settings keys.

- **Two of its four rules were already shipped.** FK-derived `JOIN … ON`
  ([`sqlLanguage.ts:155-167`](../src/sql/sqlLanguage.ts#L155-L167)) and `SELECT *` expansion
  ([`:249-266`](../src/sql/sqlLanguage.ts#L249-L266)) are stage **B3** of
  [`sql-smart-completion-plan.md`](sql-smart-completion-plan.md), live in the popup — where they also
  get prefix filtering that ghost text cannot provide.
- **`Tab` was already taken, and unavoidably so.** `tabCompletion: 'on'`
  ([`editorOptions.ts:41-43`](../src/sql/editorOptions.ts#L41-L43)) gives `Tab` to the suggest
  widget, which wins whenever it is open — and `triggerCharacters` includes **the space**
  ([`sqlLanguage.ts:398`](../src/sql/sqlLanguage.ts#L398)), so the widget is open at precisely the
  carets the ghost text would fire on. The only clean fix is
  `inlineSuggest: { suppressSuggestions: true }`, a **global** change to the shipped completion. That
  is the decisive objection: it puts the feature carrying all the weight at risk to deliver a column
  list.
- **The safety argument did not hold.** An earlier draft justified `UPDATE users ` →
  `SET  WHERE id = ` as protection against full-table writes. It is not: ghost text prevents nothing,
  and the app already has three real guards — Safe Mode gating every write
  ([`safeMode.ts`](../src/utils/safeMode.ts)), read-only mode, and manual transaction mode with
  rollback ([`tx/`](../src-tauri/src/tx/)). Net saving on `UPDATE`/`DELETE`: about twelve characters.
- **History prefix matching was the weakest rule.** The history drawer is already searchable, has
  saved queries, and re-running the top entry reuses its row. Ghost text would save opening a
  drawer while adding the one way this feature could cause harm: `Tab`-accepting a stale query
  against a changed schema.
- **`mode: 'subMode'`**, from the original §4.2, is not a valid Monaco value
  (`'prefix' | 'subword' | 'subwordSmart'`) and would have failed `tsc -b`. Noted because it shows
  the draft was never checked against the API.
- **The `'hybrid'` / `'ai_only'` modes** with `ghostTextDelayMs: 0` meant one model call per
  keystroke — unbounded cost, on the user's account.

If ghost text is ever revisited, the entry cost is the `Tab` conflict, and nothing below that.

---

## 6. Steps

| Step | Content | Done when |
|---|---|---|
| **1** | `getSchemaDetailed()` + its cache map in `catalog.ts` | An `INSERT` target reports real `autoIncrement` / `generated` / `identityAlways` |
| **2** | The `'00_insertcols'` item in `sqlLanguage.ts` | `INSERT INTO users ` offers the real column list, top of the popup |
| **3** | One i18n key in `en.ts` + `vi.ts` + `ja.ts`, named `sqlEditor.cmplInsertColumns` per the existing `cmpl*` convention | Three languages compile (`typeof en` enforces it) |
| **4** | Test the pure part in `src/utils/__tests__/` beside `completionOrder.test.ts` | Pinned: auto-increment/generated/identity omitted; no columns → no item; tier ranks above `'0_'` |

## 7. Optional, independent cleanup

`primeCatalog`'s fabricated `nullable: true` and `defaultValue: null` are a latent trap for any
future reader of the warm cache — the values are not unknown, they are **wrong**. Two ways out,
neither needed by this plan: widen `get_full_catalog`'s payload, or drop the fabricated keys so a
consumer reads `undefined` and has to ask. Worth doing on its own merits, not as a prerequisite.
