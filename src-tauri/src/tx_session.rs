//! Manual transaction mode — one pinned session for the whole app.
//!
//! Why a module-level static instead of `AppState`: the ~60 call sites that reach the database go
//! through `database::execute_raw_sql_generic`, which receives a `&DbConnection` and no `AppState`.
//! Threading a session handle down to all of them would mean changing hundreds of signatures for a
//! value that is always the same one — Phase 1 of multi-connection keeps `AppState::connections` at
//! exactly ONE entry, so there is exactly one session. Reset by `connect_db` / `disconnect_db`.
//!
//! **This static is what Phase 2 replaces**, and it is a hard ordering constraint rather than a
//! preference: with N entries in the registry and one global session, the first statement issued in
//! manual mode pins whichever connection asked first, and every later statement of every other
//! connection then runs on it — the wrong database, not merely a slow one. See
//! `docs/multi-connection-plan.md` §4.2.
//!
//! The three rules that make this correct:
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
//!
//! SQLite needs no pinning: `DbKind::Sqlite` is a single `Arc<Mutex<Connection>>` shared by
//! the whole app, so it is already one session. Only the state machine applies there.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::Emitter;
use tauri::ipc::Channel;

use crate::database::{self, DbConnection, DbKind};

/// What a statement does to the transaction around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxEffect {
    None,
    Begin,
    Commit,
    Rollback,
    Savepoint(String),
    RollbackTo(String),
    Release(String),
    /// MySQL commits the open transaction before running the statement (DDL, LOCK TABLES, ...).
    /// Not an error, but the pending counter must drop to zero or the UI promises a rollback that
    /// cannot undo what already went in.
    ImplicitCommit,
}

// ---------------------------------------------------------------------------
// Pure helpers (verified with the standalone-rustc trick, see docs/implementation_plan17)
// ---------------------------------------------------------------------------

/// Word tokens of a statement, with leading comments already stripped by the caller. Punctuation
/// that can glue itself to a keyword (`;`, `(`) is a separator so `COMMIT;` and `COMMIT` classify
/// the same.
///
/// Returns the tokens twice: uppercased for keyword matching, and as typed for the ones that are
/// *names*. Uppercasing a savepoint name would show `S1` in the UI for a savepoint the user called
/// `s1`.
fn tokens(stmt: &str) -> (Vec<String>, Vec<String>) {
    // `=` is a separator too, or `SET AUTOCOMMIT=1` tokenizes as one word and misses the check
    // for MySQL's implicit commit.
    //
    // Only the first 4 tokens are ever read (`ROLLBACK TO SAVEPOINT <name>` is the longest form),
    // and this runs on EVERY statement — including a bulk INSERT whose text can be megabytes. The
    // cap keeps that from allocating a token per value.
    let raw: Vec<String> = stmt
        .split(|c: char| c.is_whitespace() || c == ';' || c == '(' || c == ')' || c == ',' || c == '=')
        .filter(|w| !w.is_empty())
        .take(4)
        .map(|w| w.to_string())
        .collect();
    let upper = raw.iter().map(|w| w.to_uppercase()).collect();
    (upper, raw)
}

/// Savepoint names are identifiers: case-insensitive on both Postgres and MySQL unless quoted, and
/// this app never quotes them (see `sanitize_savepoint`).
fn same_savepoint(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Strip the quoting a savepoint name may carry so `RELEASE SAVEPOINT \`s1\`` and
/// `RELEASE SAVEPOINT s1` name the same savepoint.
fn unquote(name: &str) -> String {
    name.trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == ';').to_string()
}

/// MySQL statements that commit the open transaction before they run.
///
/// The negative cases matter as much as the positive ones: `CREATE TEMPORARY TABLE` and
/// `DROP TEMPORARY TABLE` do NOT commit, and treating them as if they did would zero the pending
/// counter while the user's changes are still rollback-able.
fn mysql_implicit_commit(w: &[String]) -> bool {
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    let second = w.get(1).map(|s| s.as_str()).unwrap_or("");
    match first {
        "CREATE" | "DROP" => {
            if second == "TEMPORARY" {
                return false;
            }
            // CREATE/DROP of any schema object commits. The exhaustive list is long and grows per
            // MySQL version, so match the shape instead: anything that is not a temporary table.
            true
        }
        "ALTER" | "RENAME" | "TRUNCATE" => true,
        "LOCK" | "UNLOCK" => second == "TABLES",
        "GRANT" | "REVOKE" | "FLUSH" | "ANALYZE" | "OPTIMIZE" | "REPAIR" => true,
        "SET" => second == "AUTOCOMMIT",
        _ => false,
    }
}

/// Classify one statement. `stmt` must already have gone through
/// `database::strip_leading_comments` — a mysqldump statement carries its comment header inside
/// the statement text, and classifying the raw text would miss every keyword.
pub fn tx_effect(dialect: &str, stmt: &str) -> TxEffect {
    let (w, raw) = tokens(stmt);
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    let second = w.get(1).map(|s| s.as_str()).unwrap_or("");

    match first {
        "BEGIN" => TxEffect::Begin,
        "START" if second == "TRANSACTION" => TxEffect::Begin,
        "COMMIT" => TxEffect::Commit,
        // SQLite spells COMMIT as END too. Only SQLite: in MySQL a bare `END` belongs to a routine
        // body and never arrives here as a standalone statement.
        "END" if dialect == "sqlite" => TxEffect::Commit,
        "ROLLBACK" => {
            // ROLLBACK TO [SAVEPOINT] name — keeps the transaction open, unlike a plain ROLLBACK.
            if second == "TO" {
                let name = if w.get(2).map(|s| s.as_str()) == Some("SAVEPOINT") { raw.get(3) } else { raw.get(2) };
                match name {
                    Some(n) => TxEffect::RollbackTo(unquote(n)),
                    None => TxEffect::Rollback,
                }
            } else {
                TxEffect::Rollback
            }
        }
        "SAVEPOINT" => match raw.get(1) {
            Some(n) => TxEffect::Savepoint(unquote(n)),
            None => TxEffect::None,
        },
        "RELEASE" => {
            let name = if second == "SAVEPOINT" { raw.get(2) } else { raw.get(1) };
            match name {
                Some(n) => TxEffect::Release(unquote(n)),
                None => TxEffect::None,
            }
        }
        _ if dialect == "mysql" && mysql_implicit_commit(&w) => TxEffect::ImplicitCommit,
        _ => TxEffect::None,
    }
}

/// Does this statement change anything the user would want committed?
///
/// A `SELECT` inside a manual transaction is normal and even necessary — that is how you read back
/// what you just wrote, and how an isolation level means anything at all — so it still opens the
/// transaction. But counting it would be a lie: the pending counter next to the Commit button
/// promises "this many changes are waiting", and "2 statements" after two SELECTs reads as two
/// unsaved edits that do not exist.
///
/// Unknown shapes count as writes on purpose. Reporting a change that is not there costs one
/// needless rollback; reporting none when there is one loses data.
///
/// Like `tx_effect`, `stmt` must already have gone through `database::strip_leading_comments`:
/// a statement whose text starts with its own comment header would classify on the comment.
pub fn is_write_stmt(stmt: &str) -> bool {
    let (w, _) = tokens(stmt);
    let first = w.first().map(|s| s.as_str()).unwrap_or("");
    !matches!(
        first,
        // Reads and session/metadata statements. `WITH` is deliberately absent: a CTE can end in
        // INSERT/UPDATE/DELETE, so it is treated as a write.
        "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "PRAGMA" | "USE" | "SET" | "VALUES"
            | "TABLE" | "HELP" | ""
    )
}

/// Isolation levels this app offers, per dialect. SQLite has no isolation levels — the equivalent
/// knob is the locking mode of `BEGIN`, so its values are DEFERRED/IMMEDIATE/EXCLUSIVE and the UI
/// shows a different list rather than a shared list with items disabled.
pub fn isolation_allowed(dialect: &str, level: &str) -> bool {
    let up = level.to_uppercase();
    match dialect {
        "postgres" => matches!(up.as_str(), "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"),
        "mysql" => matches!(
            up.as_str(),
            "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
        ),
        "sqlite" => matches!(up.as_str(), "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"),
        _ => false,
    }
}

/// The statement(s) that open a transaction, per dialect.
///
/// `isolation` is re-checked against the whitelist here even though the UI only offers valid
/// values: this string ends up inside SQL by formatting, like the rest of this app, and a
/// whitelist is the escaping.
pub fn begin_statements(dialect: &str, isolation: Option<&str>, read_only: bool) -> Vec<String> {
    let level = isolation
        .map(|s| s.to_uppercase())
        .filter(|s| isolation_allowed(dialect, s));

    match dialect {
        "postgres" => {
            let mut s = String::from("BEGIN");
            if let Some(l) = &level {
                s.push_str(&format!(" ISOLATION LEVEL {}", l));
            }
            if read_only {
                s.push_str(" READ ONLY");
            }
            vec![s]
        }
        "mysql" => {
            // MySQL cannot carry the isolation level on START TRANSACTION. `SET TRANSACTION`
            // without SESSION/GLOBAL applies to the NEXT transaction only, which is exactly the
            // scope wanted here.
            let mut out = Vec::new();
            if let Some(l) = &level {
                out.push(format!("SET TRANSACTION ISOLATION LEVEL {}", l));
            }
            out.push(if read_only {
                "START TRANSACTION READ ONLY".to_string()
            } else {
                "START TRANSACTION".to_string()
            });
            out
        }
        // SQLite: the level select carries the locking mode instead. READ ONLY has no equivalent.
        _ => vec![format!("BEGIN {}", level.unwrap_or_else(|| "DEFERRED".to_string()))],
    }
}

/// Postgres marks the whole transaction unusable after one failed statement; everything after it
/// fails with 25P02 until ROLLBACK. That is a distinct UI state (only Rollback is offered), so it
/// is detected here rather than by the frontend comparing error text.
pub fn is_aborted_error(err: &str) -> bool {
    err.contains("25P02") || err.contains("current transaction is aborted")
}

pub fn dialect_of(conn: &DbConnection) -> &'static str {
    match &conn.kind {
        DbKind::Sqlite(_) => "sqlite",
        DbKind::Postgres(_) => "postgres",
        DbKind::Mysql(_) => "mysql",
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// The connection a manual transaction is pinned to. Holding it out of the pool for the whole
/// transaction is the entire point — `execute_raw_sql_generic` acquires a NEW connection per call,
/// so a `BEGIN` sent through it lands on a different session than the statements it should wrap.
enum Pinned {
    /// SQLite already shares one handle app-wide; there is nothing to take out of a pool.
    Sqlite,
    Postgres(sqlx::pool::PoolConnection<sqlx::Postgres>),
    Mysql(sqlx::pool::PoolConnection<sqlx::MySql>),
}

/// One recorded statement is trimmed to this before being kept, and the whole log stops growing
/// past `PENDING_LOG_MAX_BYTES`. A bulk INSERT can be megabytes and the transaction can hold
/// thousands of them; the dialog only has to *show* the work, not archive it.
const PENDING_STMT_MAX_CHARS: usize = 4000;
const PENDING_LOG_MAX_BYTES: usize = 2_000_000;

struct Meta {
    autocommit: bool,
    open: bool,
    aborted: bool,
    /// Number of write statements in the transaction. May exceed `pending.len()` once the log stops
    /// recording — the count is what the UI promises, so it must stay exact.
    statements: usize,
    /// The SQL of those statements, for the pending-changes dialog.
    pending: Vec<String>,
    pending_bytes: usize,
    /// The log stopped recording (size cap); the dialog says so instead of quietly showing less.
    log_truncated: bool,
    started_at: Option<Instant>,
    isolation: Option<String>,
    read_only: bool,
    /// Savepoint name + the value of `statements` when it was set, so `ROLLBACK TO` can put the
    /// counter and the log back exactly instead of guessing.
    savepoints: Vec<(String, usize)>,
    /// Set when a statement implicitly committed, so the UI can say why the counter dropped.
    last_implicit_commit: bool,
}

impl Meta {
    fn new() -> Meta {
        Meta {
            autocommit: true,
            open: false,
            aborted: false,
            statements: 0,
            pending: Vec::new(),
            pending_bytes: 0,
            log_truncated: false,
            started_at: None,
            isolation: None,
            read_only: false,
            savepoints: Vec::new(),
            last_implicit_commit: false,
        }
    }

    fn close(&mut self) {
        self.open = false;
        self.aborted = false;
        self.statements = 0;
        self.pending.clear();
        self.pending_bytes = 0;
        self.log_truncated = false;
        self.started_at = None;
        self.savepoints.clear();
    }

    fn record(&mut self, sql: &str) {
        self.statements += 1;
        if self.pending_bytes >= PENDING_LOG_MAX_BYTES {
            self.log_truncated = true;
            return;
        }
        let trimmed = sql.trim();
        let text = if trimmed.chars().count() > PENDING_STMT_MAX_CHARS {
            let cut: String = trimmed.chars().take(PENDING_STMT_MAX_CHARS).collect();
            self.log_truncated = true;
            format!("{cut} …")
        } else {
            trimmed.to_string()
        };
        self.pending_bytes += text.len();
        self.pending.push(text);
    }

    /// Undo the bookkeeping back to a savepoint mark.
    fn rewind_to(&mut self, mark: usize) {
        self.statements = self.statements.min(mark);
        self.pending.truncate(self.pending.len().min(mark));
        self.pending_bytes = self.pending.iter().map(|s| s.len()).sum();
    }
}

struct Global {
    /// Small and synchronous — never locked across an `.await`.
    meta: Mutex<Meta>,
    /// Held across the whole statement on purpose: one session means one statement at a time.
    pinned: tokio::sync::Mutex<Option<Pinned>>,
    app: Mutex<Option<tauri::AppHandle>>,
}

static G: OnceLock<Global> = OnceLock::new();

fn g() -> &'static Global {
    G.get_or_init(|| Global {
        meta: Mutex::new(Meta::new()),
        pinned: tokio::sync::Mutex::new(None),
        app: Mutex::new(None),
    })
}

/// Called once from `lib.rs` setup. The state changes from inside the SQL funnels, which have no
/// `AppHandle`, so the handle is parked here and the UI is told by event instead of by threading a
/// `tx` field through every command's response shape.
pub fn set_app_handle(app: tauri::AppHandle) {
    if let Ok(mut slot) = g().app.lock() {
        *slot = Some(app);
    }
}

pub fn status_json() -> Value {
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    json!({
        "autocommit": m.autocommit,
        "open": m.open,
        "aborted": m.aborted,
        "statements": m.statements,
        "pendingSql": m.pending,
        "sqlTruncated": m.log_truncated,
        "sinceMs": m.started_at.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0),
        "isolation": m.isolation,
        "readOnly": m.read_only,
        "savepoints": m.savepoints.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        "implicitCommit": m.last_implicit_commit,
    })
}

fn emit_state() {
    let payload = status_json();
    let handle = match g().app.lock() {
        Ok(h) => h.clone(),
        Err(e) => e.into_inner().clone(),
    };
    if let Some(app) = handle {
        let _ = app.emit("tx-state-changed", payload);
    }
}

/// True when a transaction is open and holding changes the user has not committed.
pub fn has_pending() -> bool {
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    m.open && m.statements > 0
}

pub fn is_open() -> bool {
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    m.open
}

/// Auto-commit is off, whether or not a transaction happens to be open right now.
pub fn manual_mode() -> bool {
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    !m.autocommit
}

/// Should a command that writes run on the pinned session?
///
/// **Not** `is_open()`: a transaction only opens when the first statement runs, so a command that
/// checks `is_open()` and finds `false` would happily commit on its own connection — manual commit
/// that commits by itself. Every write path outside the three SQL funnels must ask *this*.
pub fn use_session() -> bool {
    manual_mode() || is_open()
}

/// Guard for the batch commands that must own their connection and their own transaction
/// (Data Generator, restore): they issue periodic commits by design, so they cannot join the
/// user's transaction, and they would block on the locks it holds. Refusing beats freezing —
/// and beats committing behind the user's back while the mode says "manual".
pub fn reject_if_manual_or_open(action: &str) -> Result<(), String> {
    if use_session() {
        return Err(format!(
            "Đang bật commit thủ công — hãy kết thúc transaction và chuyển về tự động trước khi {}",
            action
        ));
    }
    Ok(())
}

/// For operations that only break when a transaction is actually *open* (switching database drops
/// the pool underneath it). Manual mode with nothing open is harmless here.
/// Guard for operations that replace the connection underneath the session (switching database).
///
/// Keys on `has_pending()`, **not** `is_open()`, and that distinction is the whole point. In manual
/// mode `should_route` sends every statement through the session and `run_raw` calls `ensure_begin`
/// on the first one *whatever it is* — a plain `SELECT` from a grid refresh opens a transaction. So
/// `is_open()` is true almost all the time once manual mode is on, and guarding on it made switching
/// database impossible: right after a Discard the next grid read reopened the transaction and the
/// refusal came back, with nothing pending to commit or roll back.
///
/// `has_pending()` is `open && statements > 0`, and `statements` counts *writes* only. So an open
/// transaction with nothing pending has done nothing but read, and rolling it back to swap the pool
/// loses nothing — which is why the caller may do that itself instead of asking the user.
///
/// Reuses the wording of the old `reject_if_open` verbatim: with pending writes it is exactly as
/// true as before, and keeping the literal identical costs `src/utils/backendErrors.ts` nothing.
pub fn reject_if_pending(action: &str) -> Result<(), String> {
    if has_pending() {
        return Err(format!(
            "Transaction đang mở — hãy commit hoặc rollback trước khi {}",
            action
        ));
    }
    Ok(())
}

/// Should this statement run on the pinned session instead of a pooled connection?
///
/// Three reasons, and the third is what makes a hand-typed `BEGIN` work: before this existed, a
/// `BEGIN` typed into the SQL editor went to a pooled connection, the next statement went to
/// another one, and the connection carrying the open transaction went back to the pool holding
/// locks. The statement that opens a transaction has to create the session it belongs to.
pub fn should_route(conn: &DbConnection, sql: &str) -> bool {
    // A pool this process opened for itself is never the user's session. This check is FIRST because
    // everything below answers from global session state without looking at the connection: with
    // manual commit on, an ad-hoc pool used to be pinned as the session and `BEGIN` ran on it, so
    // every later statement of the user went to the compare database — and the pool was then closed
    // under the session. See `ConnId::Adhoc` and §0 of docs/multi-connection-plan.md.
    if matches!(conn.id, crate::state::ConnId::Adhoc) {
        return false;
    }
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    if !m.autocommit || m.open {
        return true;
    }
    drop(m);
    tx_effect(dialect_of(conn), database::strip_leading_comments(sql)) == TxEffect::Begin
}

// ---------------------------------------------------------------------------
// Running statements through the session
// ---------------------------------------------------------------------------

/// Take the session lock, pinning a connection on first use.
async fn lock_pinned(
    conn: &DbConnection,
) -> Result<tokio::sync::MutexGuard<'static, Option<Pinned>>, String> {
    let mut guard = g().pinned.lock().await;
    if guard.is_none() {
        *guard = Some(match &conn.kind {
            DbKind::Sqlite(_) => Pinned::Sqlite,
            DbKind::Postgres(pool) => {
                Pinned::Postgres(pool.acquire().await.map_err(|e| e.to_string())?)
            }
            DbKind::Mysql(pool) => {
                Pinned::Mysql(pool.acquire().await.map_err(|e| e.to_string())?)
            }
        });
    }
    Ok(guard)
}

/// Run one statement on the pinned connection, without touching transaction state.
async fn raw_on_pinned(
    pinned: &mut Pinned,
    conn: &DbConnection,
    sql: &str,
) -> Result<Vec<Value>, String> {
    match pinned {
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => database::sqlite_raw(arc, sql),
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => database::pg_raw(&mut **c, sql).await,
        Pinned::Mysql(c) => database::mysql_raw(&mut **c, sql).await,
    }
}

/// Issue BEGIN if the transaction is not open yet.
///
/// Skipped when the statement about to run is itself a BEGIN — otherwise Postgres warns about a
/// nested BEGIN and MySQL silently commits the one we just opened.
async fn ensure_begin(
    pinned: &mut Pinned,
    conn: &DbConnection,
    effect: &TxEffect,
) -> Result<(), String> {
    let (already_open, isolation, read_only) = {
        let m = g().meta.lock().map_err(|e| e.to_string())?;
        (m.open, m.isolation.clone(), m.read_only)
    };
    if already_open || *effect == TxEffect::Begin {
        return Ok(());
    }
    for stmt in begin_statements(dialect_of(conn), isolation.as_deref(), read_only) {
        raw_on_pinned(pinned, conn, &stmt).await?;
    }
    let mut m = g().meta.lock().map_err(|e| e.to_string())?;
    m.open = true;
    m.aborted = false;
    m.statements = 0;
    m.started_at = Some(Instant::now());
    m.savepoints.clear();
    Ok(())
}

/// Fold the statement's outcome into the transaction state.
///
/// `is_write` decides whether the pending counter moves — see `is_write_stmt`.
fn apply_effect(effect: &TxEffect, is_write: bool, sql: &str, failed_with: Option<&str>) {
    let mut m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    m.last_implicit_commit = false;

    if let Some(err) = failed_with {
        // A failed statement changes nothing except that Postgres may have poisoned the
        // transaction. Everything after it will fail until ROLLBACK.
        if m.open && is_aborted_error(err) {
            m.aborted = true;
        }
        drop(m);
        emit_state();
        return;
    }

    match effect {
        TxEffect::Begin => {
            m.open = true;
            m.aborted = false;
            m.statements = 0;
            m.started_at = Some(Instant::now());
            m.savepoints.clear();
        }
        TxEffect::Commit | TxEffect::Rollback => m.close(),
        TxEffect::ImplicitCommit => {
            m.close();
            m.last_implicit_commit = true;
        }
        // Savepoint statements steer the transaction, they do not add a change of their own.
        TxEffect::Savepoint(name) => {
            // Re-declaring a savepoint name moves it: the old one is no longer reachable.
            let mark = m.statements;
            m.savepoints.retain(|(s, _)| !same_savepoint(s, name));
            m.savepoints.push((name.clone(), mark));
        }
        TxEffect::RollbackTo(name) => {
            // Rolling back to a savepoint clears the abort flag: that is exactly what it is for on
            // Postgres. Savepoints created after it are gone, and so are the statements they cover
            // — the mark recorded with each savepoint is what makes that exact rather than a guess.
            if let Some(pos) = m.savepoints.iter().position(|(s, _)| same_savepoint(s, name)) {
                let mark = m.savepoints[pos].1;
                m.savepoints.truncate(pos + 1);
                m.rewind_to(mark);
            }
            m.aborted = false;
        }
        TxEffect::Release(name) => {
            if let Some(pos) = m.savepoints.iter().position(|(s, _)| same_savepoint(s, name)) {
                m.savepoints.truncate(pos);
            }
        }
        TxEffect::None => {
            if is_write {
                m.record(sql);
            }
        }
    }
    drop(m);
    emit_state();
}

fn check_not_aborted(effect: &TxEffect) -> Result<(), String> {
    let m = match g().meta.lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    if !m.aborted {
        return Ok(());
    }
    // Only the statements that can end or unwind the transaction are still allowed.
    match effect {
        TxEffect::Rollback | TxEffect::RollbackTo(_) => Ok(()),
        _ => Err("Transaction đã bị huỷ do lỗi trước đó, chỉ có thể rollback".to_string()),
    }
}

/// `execute_raw_sql_generic` routed through the session.
pub(crate) async fn run_raw(conn: &DbConnection, sql: String) -> Result<Vec<Value>, String> {
    let stripped = database::strip_leading_comments(&sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    check_not_aborted(&effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = raw_on_pinned(pinned, conn, &sql).await;
    drop(guard);

    match &out {
        Ok(_) => apply_effect(&effect, is_write, &sql, None),
        Err(e) => apply_effect(&effect, is_write, &sql, Some(e)),
    }
    // A COMMIT/ROLLBACK frees the connection back to the pool; holding it after the transaction
    // ended would starve the pool for no reason.
    release_if_closed().await;
    out
}

/// `run_bound_query` routed through the session (parameterized single statement).
pub(crate) async fn run_bound(
    conn: &DbConnection,
    sql: String,
    params: &[Value],
) -> Result<Vec<Value>, String> {
    let stripped = database::strip_leading_comments(&sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    check_not_aborted(&effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = match pinned {
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => database::sqlite_bound(arc, &sql, params),
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => database::pg_bound(&mut **c, &sql, params).await,
        Pinned::Mysql(c) => database::mysql_bound(&mut **c, &sql, params).await,
    };
    drop(guard);

    match &out {
        Ok(_) => apply_effect(&effect, is_write, &sql, None),
        Err(e) => apply_effect(&effect, is_write, &sql, Some(e)),
    }
    release_if_closed().await;
    out
}

/// `stream_one_statement` routed through the session.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_stream(
    conn: &DbConnection,
    sql: &str,
    params: &[Value],
    stmt_index: usize,
    channel: &Channel<Value>,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let stripped = database::strip_leading_comments(sql);
    let effect = tx_effect(dialect_of(conn), stripped);
    let is_write = is_write_stmt(stripped);
    check_not_aborted(&effect)?;

    let mut guard = lock_pinned(conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    ensure_begin(pinned, conn, &effect).await?;

    let out = match pinned {
        // SQLite streams off the shared handle exactly as it does outside a transaction — the
        // handle IS the session. Calling the dialect helper directly (not `stream_one_statement`)
        // matters: that one routes back here and would recurse.
        Pinned::Sqlite => match &conn.kind {
            DbKind::Sqlite(arc) => {
                database::sqlite_stream(arc, sql, params, stmt_index, channel, cancel).await
            }
            _ => Err("Kết nối không khớp với phiên transaction".to_string()),
        },
        Pinned::Postgres(c) => {
            database::pg_stream(&mut **c, sql, params, stmt_index, channel, cancel).await
        }
        Pinned::Mysql(c) => {
            database::mysql_stream(&mut **c, sql, params, stmt_index, channel, cancel).await
        }
    };
    drop(guard);

    match &out {
        Ok(_) => apply_effect(&effect, is_write, sql, None),
        Err(e) => apply_effect(&effect, is_write, sql, Some(e)),
    }
    release_if_closed().await;
    out
}

/// Give the pinned connection back once no transaction is open and the user is in auto-commit.
/// In manual mode the connection is kept: the next statement opens a new transaction on it anyway,
/// and re-acquiring per statement would reintroduce the session-hopping this module exists to fix.
async fn release_if_closed() {
    let (open, autocommit) = {
        let m = match g().meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        (m.open, m.autocommit)
    };
    if !open && autocommit {
        let mut guard = g().pinned.lock().await;
        *guard = None;
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Roll back and drop the pinned connection. Used when the connection underneath is about to
/// disappear (disconnect, connect elsewhere, IAM pool swap): the transaction would die anyway, and
/// dying silently is what makes users lose work without knowing it.
pub async fn abandon(conn: Option<&DbConnection>) {
    let was_open = is_open();
    let mut guard = g().pinned.lock().await;
    if was_open {
        if let (Some(pinned), Some(c)) = (guard.as_mut(), conn) {
            let _ = raw_on_pinned(pinned, c, "ROLLBACK").await;
        }
    }
    *guard = None;
    drop(guard);
    {
        let mut m = match g().meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        m.close();
        m.last_implicit_commit = false;
    }
    emit_state();
}

/// Full reset on a new connection: auto-commit preference included, because isolation levels are
/// dialect-specific and carrying "REPEATABLE READ" over to SQLite would be meaningless.
pub async fn reset(conn: Option<&DbConnection>) {
    abandon(conn).await;
    {
        let mut m = match g().meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        m.autocommit = true;
        m.isolation = None;
        m.read_only = false;
    }
    emit_state();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn current_conn(
    state: &tauri::State<'_, crate::AppState>,
    conn_id: &str,
) -> Result<DbConnection, String> {
    Ok(state.connections.acquire(conn_id)?.conn().clone())
}

#[tauri::command]
pub async fn tx_status() -> Result<Value, String> {
    Ok(status_json())
}

/// Turn auto-commit on or off. Turning it ON while a transaction is open is rejected rather than
/// resolved for the user — committing and rolling back are both destructive in one direction, and
/// guessing which one was meant is not ours to do.
#[tauri::command]
pub async fn tx_set_autocommit(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    enabled: bool,
) -> Result<Value, String> {
    if enabled && has_pending() {
        return Err("Transaction đang mở — hãy commit hoặc rollback trước khi bật lại auto-commit".to_string());
    }
    // An open-but-empty transaction has nothing to lose, so close it quietly.
    if enabled && is_open() {
        let conn = current_conn(&state, &conn_id).ok();
        if let Some(c) = &conn {
            let mut guard = lock_pinned(c).await?;
            if let Some(pinned) = guard.as_mut() {
                let _ = raw_on_pinned(pinned, c, "ROLLBACK").await;
            }
            *guard = None;
        }
        let mut m = g().meta.lock().map_err(|e| e.to_string())?;
        m.close();
    }
    {
        let mut m = g().meta.lock().map_err(|e| e.to_string())?;
        m.autocommit = enabled;
    }
    if enabled {
        release_if_closed().await;
    }
    emit_state();
    Ok(status_json())
}

#[tauri::command]
pub async fn tx_set_isolation(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    level: Option<String>,
    read_only: Option<bool>,
) -> Result<Value, String> {
    let conn = current_conn(&state, &conn_id)?;
    let dialect = dialect_of(&conn);
    if let Some(l) = &level {
        if !isolation_allowed(dialect, l) {
            return Err("Mức cô lập không hợp lệ cho hệ quản trị này".to_string());
        }
    }
    {
        let mut m = g().meta.lock().map_err(|e| e.to_string())?;
        m.isolation = level.map(|l| l.to_uppercase());
        if let Some(ro) = read_only {
            m.read_only = ro;
        }
    }
    emit_state();
    Ok(status_json())
}

async fn end_tx(
    state: tauri::State<'_, crate::AppState>,
    conn_id: &str,
    sql: &str,
) -> Result<Value, String> {
    if !is_open() {
        return Err("Không có transaction nào đang mở".to_string());
    }
    // `conn_id` is already a `&str` here, unlike the commands that own a `String`.
    let conn = current_conn(&state, conn_id)?;
    let mut guard = lock_pinned(&conn).await?;
    let pinned = guard.as_mut().ok_or("Phiên transaction không sẵn sàng")?;
    let out = raw_on_pinned(pinned, &conn, sql).await;
    drop(guard);

    // The transaction is over either way: a failed COMMIT on Postgres (serialization failure,
    // deferred constraint) has already rolled the whole thing back, and leaving the UI showing an
    // open transaction would invite a second COMMIT against nothing.
    {
        let mut m = g().meta.lock().map_err(|e| e.to_string())?;
        m.close();
    }
    release_if_closed().await;
    emit_state();
    out.map(|_| status_json())
}

#[tauri::command]
pub async fn tx_commit(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<Value, String> {
    end_tx(state, &conn_id, "COMMIT").await
}

#[tauri::command]
pub async fn tx_rollback(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
) -> Result<Value, String> {
    end_tx(state, &conn_id, "ROLLBACK").await
}

#[tauri::command]
pub async fn tx_savepoint(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
) -> Result<Value, String> {
    let clean = sanitize_savepoint(&name)?;
    let conn = current_conn(&state, &conn_id)?;
    run_raw(&conn, format!("SAVEPOINT {}", clean)).await?;
    Ok(status_json())
}

#[tauri::command]
pub async fn tx_rollback_to(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
) -> Result<Value, String> {
    let clean = sanitize_savepoint(&name)?;
    let conn = current_conn(&state, &conn_id)?;
    run_raw(&conn, format!("ROLLBACK TO SAVEPOINT {}", clean)).await?;
    Ok(status_json())
}

/// Savepoint names go into SQL by formatting like every other identifier in this app. Unlike a
/// table name they are invented by the user in a text box with no catalog to check against, so
/// restrict them to a shape that cannot carry an injection instead of quoting them.
fn sanitize_savepoint(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err("Tên savepoint chỉ gồm chữ, số và dấu gạch dưới, bắt đầu bằng chữ".to_string());
    }
    Ok(trimmed.to_string())
}
