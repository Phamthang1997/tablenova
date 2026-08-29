//! Manual transaction mode — **one pinned session per connection**.
//!
//! Why a module-level static instead of `AppState`: the ~60 call sites that reach the database go
//! through `database::execute_raw_sql_generic`, which receives a `&DbConnection` and no `AppState`.
//! Threading a session handle down to all of them would mean changing hundreds of signatures. The
//! handle already carries its own identity (`DbConnection::id`, §4.4a), so this module can look the
//! session up itself — that is exactly what the id inside the handle bought.
//!
//! **Keyed by `conn_id`, and both `meta` and `pinned` are per session.** A single global `pinned`
//! was correct only while the app held one connection: with N, the first statement issued in manual
//! mode pins whichever connection asked first and every later statement of every *other* connection
//! then runs on it — the wrong database, not merely a slow one. See §4.2 of the plan.
//!
//! The five rules that make this correct:
//!
//! 1. **Every** SQL path asks the session first (`execute_raw_sql_generic`, `run_bound_query`,
//!    `stream_one_statement`). Routing only the SQL editor would make the grid re-read through a
//!    different pooled connection, which cannot see uncommitted rows — the user would read that as
//!    lost data.
//! 2. Auto-commit OFF issues `BEGIN` from the client (JDBC-style). Postgres has no server-side
//!    autocommit flag, so following the server's own switch is not portable across the three
//!    dialects we support.
//! 3. The state machine also watches statements the *user* typed (`COMMIT`, `ROLLBACK`) and the
//!    ones MySQL commits implicitly (DDL). Without that the pending counter lies.
//! 4. `should_route` uses `get_session`, which never creates. It runs on EVERY statement, including
//!    each of the 50k in a restore, so the check path must not write to the map. No entry reads as
//!    auto-commit, which is the right answer for a connection never switched to manual mode.
//! 5. `reset` **removes** the entry rather than resetting its fields. Leaving it leaks one entry per
//!    connect/disconnect cycle, and a later connection reusing the id would inherit
//!    `autocommit = false` and open a transaction the user never asked for.
//!
//! SQLite needs no pinning: `DbKind::Sqlite` is a single `Arc<Mutex<Connection>>` shared by
//! the whole app, so it is already one session. Only the state machine applies there.

mod commands;
mod effect;
mod route;
mod session;

pub use commands::*;
pub use effect::*;
pub use route::*;
pub use session::*;
