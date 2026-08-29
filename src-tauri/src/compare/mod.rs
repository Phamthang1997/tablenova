// Comparing the STRUCTURE and the DATA of TWO databases.
//
// Phase 1 of multi-connection still opens only ONE connection, so each "side" (source/target) is resolved
// separately in `resolve_side()`: it reuses the open connection when that side points at the current
// database, and otherwise opens a TEMPORARY connection from `last_config` with the database/file
// overridden — the same way `get_all_databases_stats` does its "deep scan". The temporary connection is
// closed as soon as the command finishes (`Resolved::close`).
//
// All metadata is read through `execute_raw_sql_generic` (which already returns `{columns, data}` JSON),
// so this module does not repeat any driver's cell decoding. That this module's temporary pool can never
// be pinned as the user's transaction session is now guaranteed BY THE TYPE itself:
// every temporary pool carries `ConnId::Adhoc` and `should_route` refuses it — it no longer depends on
// remembering to call one particular funnel.
//
// The generated SQL (`syncSql`) always goes source -> target and follows the TARGET's dialect.
// Every destructive statement (DROP ...) is only emitted in executable form when
// `includeDrops = true`; by default they are commented out so a script run by accident
// deletes nothing.
//
// LANGUAGE: error messages and `warnings` are written in Vietnamese like the rest of the backend
// (the frontend translates them through `src/utils/backendErrors.ts`), but the comments INSIDE the SQL
// script are written in English — the script is an artifact taken elsewhere (a migration, DBeaver,
// the psql/mysql CLI), not UI text, so it does not go through the translation table.

pub mod read;

mod data_overview;
mod data_rows;
mod diff;
mod ident;
mod meta;
mod schemas;
mod script;
mod side;
mod sync_sql;
mod values;

pub use data_overview::*;
pub use data_rows::*;
pub use schemas::*;
