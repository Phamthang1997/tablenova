# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

TableNova is a desktop database GUI client (Tauri 2 + React 19) similar in spirit to DBeaver/TablePlus. It connects to SQLite, PostgreSQL, and MySQL, and lets the user browse/edit table data, alter schemas, run raw SQL, and backup/restore databases. The window uses a custom title bar (`decorations: false` in `src-tauri/tauri.conf.json`) with its own drag/min/max/close controls in `TitleBar.tsx`.

Many user-facing strings, backend error messages, and Rust comments are written in Vietnamese — preserve this convention when touching existing strings/comments.

## Commands

Development requires a native toolchain on Windows: Rust (cargo), a MinGW64 GCC toolchain on PATH (for linking), and Node.js.

- `npm run dev` / `npm start` — run the full Tauri app (spawns Vite dev server + Rust backend with hot reload). Equivalent to `tauri dev`.
- `.\dev-start.bat` — same as above but also sets `PATH` (cargo, MinGW64, node) and `CARGO_TARGET_DIR=C:\cargo-targets\tableforge`. The target dir is deliberately pointed **outside** the workspace so rust-analyzer doesn't try to watch/index the huge `target/` tree. Use this script (or replicate its env vars) if `cargo`/link errors occur when running `npm run dev` directly.
- `npm run vite-dev` — frontend only, no Tauri/Rust (useful for fast UI iteration, but `@tauri-apps/api` calls will fail/reject since there's no Rust backend listening).
- `npm run build-frontend` — type-check (`tsc -b`) and build the Vite frontend only.
- `npm run build` — full production build via `tauri build` (produces installers/binaries under `src-tauri/target`).
- Rust-only checks: run `cargo check` / `cargo build` from `src-tauri/` (set `CARGO_TARGET_DIR` first as above to avoid a slow first build). Don't run these while `tauri dev` is up — both fight over the same target dir. On this machine cargo has also been seen crashing (`STATUS_ACCESS_VIOLATION`) inside Tauri's build script, which is unrelated to app code.
- Verifying a **pure** Rust helper without cargo (works even when the build script crashes): extract the function(s) into a standalone `.rs` file in a temp dir, append a `fn main()` with assertions, then `rustc --edition 2024 -o check.exe check.rs && ./check.exe`. Linking needs the MinGW64 `bin` from `dev-start.bat` on `PATH`, otherwise it fails with `unable to find library -lgcc`. This is how `split_sql_statements` was tested (27 cases: quoting, comments, `$$` blocks, `DELIMITER`, CRLF, UTF-8).
- Lint: `npx oxlint` (config in `.oxlintrc.json`; `react/rules-of-hooks` and `react/only-export-components` are errors, and oxlint's default set — including `react-hooks/exhaustive-deps` — still reports as warnings, so keep the output clean rather than assuming only those two rules run).
- Tests: `npm test` (Vitest, `npm run test:watch` / `test:coverage`). Only pure helpers are covered — parsers/formatters under `src/utils/__tests__/`. Anything importing `monaco-editor` or `@tauri-apps/api` is not testable in the node environment, which is why SQL text helpers live in `src/sql/statements.ts` (no monaco import) rather than next to the Monaco integration code.

`demo.db` / `demo1.db` at the repo root are sample SQLite databases used for manual testing via the Connection Manager — not fixtures wired into any automated test.

## Architecture

### Process split

- **Frontend** (`src/`): React 19 + TypeScript, built with Vite. All UI, state, and SQL/CSV parsing logic lives here. No direct DB drivers — every DB operation goes through Tauri's `invoke()`.
- **Backend** (`src-tauri/src/`): Rust, exposes `#[tauri::command]` functions as the only bridge to the frontend. Holds the actual DB connections and does all SQL execution, schema introspection, and file I/O (export/backup/restore).

The frontend never talks to a database directly — `src/utils/dbHelper.ts` is the single wrapper around every `invoke()` call and is the de facto contract between the two sides. When adding a new backend capability, add the `#[tauri::command]` in `database.rs`, register it in the `invoke_handler!` list in `lib.rs`, then add a corresponding method to `dbHelper`.

### Backend (`src-tauri/src/`)

- `lib.rs` — Tauri app bootstrap: builds the native Edit menu (Undo/Redo/Cut/Copy/Paste/Select All), registers `AppState`, and lists every command in `invoke_handler!`. Any new command must be added to this list or the frontend call will fail at runtime with an "unknown command" error.
- `database.rs` — the core of the app (~1700 lines), single-file, organized as one Tauri command per DB operation. Key pieces:
  - `DbConnection` enum unifies `rusqlite::Connection` (wrapped in `Arc<Mutex<_>>`), `sqlx::PgPool`, and `sqlx::MySqlPool` behind one type. `DatabaseManager` (held in `AppState` behind a `Mutex`, one instance for the whole app — only one DB connection is active at a time) stores the active connection, `db_type` string, and the last-used connection config (`last_config`) so it can transparently reconnect when a restore script issues a `USE <db>` (MySQL) statement.
  - The universal pattern in every command: lock `state.db_manager`, clone the connection handle out (`Arc`/pool clones are cheap), and **drop the lock before any `.await`** — `MutexGuard` is not held across awaits. Follow this pattern for new commands.
  - `execute_raw_sql_generic()` is the common dispatcher that runs a raw SQL string against whichever backend is active and normalizes the result into `{ columns, data }` JSON. Most commands build a SQL string and funnel it through this function rather than talking to `rusqlite`/`sqlx` directly.
  - SQL is assembled via string formatting (not parameterized queries) throughout — identifiers/values are manually quoted and escaped (e.g. `.replace("'", "''")`). This is inherent to a "raw DB browser" tool where table/column names are dynamic, but be careful preserving the escaping when touching this code.
  - Quoting is inconsistent by design across dialects: MySQL uses backticks, Postgres/SQLite use double quotes; several code paths build with backticks and `.replace("`", "\"")` for Postgres. Check the surrounding dialect-switch (`match db_type`/`match &conn_type`) before changing quoting logic.
  - `generate_alter_sqls()` translates a structured diff payload (added/dropped/renamed/modified columns, indexes, foreign keys) from the frontend's schema editor into a list of `ALTER TABLE`/`CREATE INDEX`/etc. statements, branching per dialect. `alter_table_schema` executes them; `preview_alter_schema` returns the same SQL as text without running it (used by the UI's "preview SQL" step before committing schema changes).
  - `split_sql_statements()` is the splitter used by `execute_multi_query` and `execute_query_stream` (i.e. "run all statements" from the SQL editor). It tracks quoting/escapes, `--`/`#`/`/* */` comments, Postgres `$$…$$` / `$tag$…$tag$` bodies, and MySQL's client-side `DELIMITER <token>` command (whose lines are consumed, never sent to the server). Its frontend twin is `src/sql/statements.ts` — **keep the two in sync**: the editor decides what Ctrl+Enter runs and what gets highlighted, the Rust one decides what actually executes, and a mismatch means the user runs something other than what was highlighted.
  - `restore_backup()` contains a *separate, older* hand-rolled SQL statement splitter (character-by-character state machine tracking single/double/backtick quotes, `--`/`#` line comments, and `/* */` block comments) so multi-statement `.sql`/`.sql.gz` dumps can be replayed statement-by-statement, filtered to only the selected tables, inside a transaction — with MySQL handled as a distinct branch (uses a single acquired connection + `SET FOREIGN_KEY_CHECKS`) vs. Postgres/SQLite (`SET CONSTRAINTS DEFERRED`/`PRAGMA foreign_keys OFF`). It splits only on `;`, so it still **mis-splits Postgres `$$…$$` bodies and MySQL `DELIMITER` blocks** — restoring a `mysqldump --routines` / `pg_dump` file containing functions, triggers or procedures will fail there. The fix is to reuse `split_sql_statements()` instead of the two inline scanners (which would also collapse the four copies of the "filter by table + execute" logic), but that touches a destructive code path, so it is deliberately still pending.
  - `ai_chat` is currently a stub that just echoes the prompt back — the "AI Copilot" UI (`AiAssistant.tsx`) is not yet wired to a real model.
  - `export_table` and `import_new_table`/`import_table_data`/`restore_backup_old` are no-op stubs; real export logic lives in `export_multi_tables` and real import logic is driven from the frontend (`App.tsx` parses CSV/JSON client-side, then calls `execute_query`/table-write commands).
- `export.rs` — standalone helpers (CSV/JSON/SQL row serialization, gzip) currently only used for lower-level export needs; most export flow today goes through `export_multi_tables` in `database.rs` directly.
- `ssh_tunnel.rs` — currently just a plain data struct (`host`/`port`/`user`); SSH tunneling config fields exist end-to-end in `dbHelper.ts`'s `DbConnectionConfig`/`connect()` mapping but are not yet implemented on the Rust side (no `russh` usage wired up despite the dependency).

### Frontend (`src/`)

- `App.tsx` — top-level state owner: active connection, the tab list (`TabInfo[]`, each tab is either a `table` or a `query`), theme, and all the global Import/Export/Backup-Restore modals (these are large inline JSX blocks rather than separate components — follow that pattern if extending them, or consider extracting if they grow further). Cross-component signals that don't fit the props tree use `window` `CustomEvent`s: `table-renamed` and `database-restored` (dispatched after imports/restores so `Sidebar`/`DataGrid` can refetch).
- `utils/dbHelper.ts` — the only place that calls `invoke()`. Defines the shared TypeScript types (`DbConnectionConfig`, `TableItem`, `ColumnInfo`, `SchemaInfo`, `GridChange`) that describe the JSON contract with `database.rs`. When the Rust side's JSON shape changes, update the corresponding method here.
- `components/`:
  - `ConnectionManager.tsx` — connection form (SQLite file / Postgres / MySQL, with SSH/SSL fields already in the UI/types even though SSH isn't implemented backend-side yet).
  - `Sidebar.tsx` — table/view list, search, per-table context menu (rename/drop/import/export), "new query" and "backup/restore" entry points.
  - `TabManager.tsx` — tab strip; tabs are either a table view or a SQL query editor, keyed by `TabInfo.id` (`table_<name>` or `query_<timestamp>`).
  - `DataGrid.tsx` — paginated table data view+editor; edits are buffered client-side as `GridChange[]` and flushed via `dbHelper.commitChanges`.
  - `StructureViewer.tsx` — schema editor (columns/indexes/foreign keys) that builds the diff payload consumed by `alter_table_schema`/`preview_alter_schema`.
  - `SqlEditor.tsx` — Monaco-based SQL editor/runner (`@monaco-editor/react`). Owns the two panes, results grids, history/saved queries and all toolbars; the editor *intelligence* lives in `src/sql/` (below). Note: content is pushed to React state / `onSqlChange` through a 150ms trailing debounce (each keystroke otherwise re-renders `App` and every tab) — read the live text with `getPaneSql()`/`getCurrentStatement()`, which go straight to the Monaco instance, never from the `sql`/`sql2` state.
  - `AiAssistant.tsx` — chat panel calling the stubbed `ai_chat` command.
  - `CreateTableModal.tsx`, `TitleBar.tsx` — as named.
- `sql/` — everything that makes the SQL editor "smart". Split from `SqlEditor.tsx` so each piece is separately replaceable, and so the pure-text ones stay testable:
  - `sqlLanguage.ts` — wires `monaco-sql-languages` (ANTLR parser per dialect) to the app's catalog via a `completionService`: keywords from the parser, tables/columns from `catalog.ts`, alias-scope awareness, `JOIN ... ON` conditions derived from foreign keys, `*` right after `SELECT`, dialect snippets, and usage-frequency ranking (`usageStats.ts`). `LANG_IDS` lists the three language ids in use (`mysql`, `pgsql`, `genericsql` — the last one covers SQLite).
  - `catalog.ts` — cached table/column/FK metadata for completion+hover (one `get_full_catalog` call warms it). `invalidateCatalog()` on connection change, DDL, rename and restore; `getCachedSchema()` is the no-backend read used on paths that may scan every table.
  - `statements.ts` — pure text helpers, **no monaco import**: statement splitting that respects strings, comments and Postgres `$$…$$` blocks; `analyzeStatements()` (list + statement under the cursor in one pass, used by the highlight that runs on every keystroke); `resolveAliases()`; `isSchemaChangingSql()`.
  - `format.ts` — beautify via `sql-formatter` (per-dialect) and a string-safe one-line minifier. Returns the input unchanged when the parser throws (half-typed SQL) so it can never destroy content.
  - `theme.ts` / `editorOptions.ts` — the two Monaco themes (own token palette, app colors, translucent background) and the shared editor options for both panes.
  - `intellisense.ts` — hover (table → column list, column → type/PK/FK) and Ctrl+Click / F12 "open this table", which dispatches the `open-table-tab` `CustomEvent` handled in `App.tsx`.

### Build/config notes

- `vite.config.mts` pins the dev server to port `5173` (`strictPort: true`, matching `devUrl` in `tauri.conf.json`) and ignores `*.db`/`*.sqlite`/`*.dump`/`*.gz`/`*.sql` files from its watcher so local test databases don't trigger reloads.
- Tauri capabilities are minimal (`src-tauri/capabilities/default.json`): `core:default`, `dialog:default`, `fs:default` — extend this file if a new command needs a broader permission.
- Cargo edition 2024; DB drivers are `rusqlite` (bundled SQLite) and `sqlx` (Postgres + MySQL via `runtime-tokio` + `tls-rustls`).
- Fonts are **bundled**, not fetched: `public/fonts/` holds Inter (variable) + JetBrains Mono (400/500/600/700 + italics), declared as `@font-face` at the top of `src/index.css` with the OFL licenses alongside them. Do not reintroduce a Google Fonts `<link>`/`@import` — the app must render correctly offline. When changing the editor font, keep `SQL_EDITOR_OPTIONS.lineHeight` and the `.sql-run-glyph::before` `line-height` in `index.css` in sync, or the gutter run-arrow drifts off-center.
