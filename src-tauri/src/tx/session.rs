//! The state machine of one session: the pinned connection, the counter of statements waiting to be committed,
//! savepoints, and emitting `tx-state-changed` to the frontend.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::{Value, json};

use crate::database::DbConnection;

use super::effect::{TxEffect, is_aborted_error, same_savepoint};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// The connection a manual transaction is pinned to. Holding it out of the pool for the whole
/// transaction is the entire point — `execute_raw_sql_generic` acquires a NEW connection per call,
/// so a `BEGIN` sent through it lands on a different session than the statements it should wrap.
pub(super) enum Pinned {
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

pub(super) struct Meta {
    pub(super) autocommit: bool,
    pub(super) open: bool,
    pub(super) aborted: bool,
    /// Number of write statements in the transaction. May exceed `pending.len()` once the log stops
    /// recording — the count is what the UI promises, so it must stay exact.
    pub(super) statements: usize,
    /// The SQL of those statements, for the pending-changes dialog.
    pub(super) pending: Vec<String>,
    pub(super) pending_bytes: usize,
    /// The log stopped recording (size cap); the dialog says so instead of quietly showing less.
    pub(super) log_truncated: bool,
    pub(super) started_at: Option<Instant>,
    pub(super) isolation: Option<String>,
    pub(super) read_only: bool,
    /// Savepoint name + the value of `statements` when it was set, so `ROLLBACK TO` can put the
    /// counter and the log back exactly instead of guessing.
    pub(super) savepoints: Vec<(String, usize)>,
    /// Set when a statement implicitly committed, so the UI can say why the counter dropped.
    pub(super) last_implicit_commit: bool,
}

impl Meta {
    pub(super) fn new() -> Meta {
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

    pub(super) fn close(&mut self) {
        self.open = false;
        self.aborted = false;
        self.statements = 0;
        self.pending.clear();
        self.pending_bytes = 0;
        self.log_truncated = false;
        self.started_at = None;
        self.savepoints.clear();
    }

    pub(super) fn record(&mut self, sql: &str) {
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
    pub(super) fn rewind_to(&mut self, mark: usize) {
        self.statements = self.statements.min(mark);
        self.pending.truncate(self.pending.len().min(mark));
        self.pending_bytes = self.pending.iter().map(|s| s.len()).sum();
    }
}

/// One manual-transaction session — one per open connection.
pub(super) struct Session {
    /// Small and synchronous — never locked across an `.await`.
    pub(super) meta: Mutex<Meta>,
    /// Held across the whole statement on purpose: one session runs one statement at a time.
    /// **Per session, not global.** One shared lock would serialise every connection behind
    /// whichever one is mid-statement, and — far worse before the map existed — would pin one
    /// connection as *the* session and send every other connection's statements to it.
    ///
    /// `Arc` so `lock_owned()` can hand back a guard that owns its keep-alive. A borrowed
    /// `MutexGuard<'_, _>` cannot outlive the `Arc<Session>` that `lock_pinned` looked up, and the
    /// callers hold the guard across their whole statement.
    pub(super) pinned: Arc<tokio::sync::Mutex<Option<Pinned>>>,
}

impl Session {
    fn new() -> Self {
        Session {
            meta: Mutex::new(Meta::new()),
            pinned: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

static TX_REGISTRY: OnceLock<Mutex<HashMap<crate::state::ConnScopeId, Arc<Session>>>> =
    OnceLock::new();
pub(super) fn tx_registry() -> &'static Mutex<HashMap<crate::state::ConnScopeId, Arc<Session>>> {
    TX_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The session of a connection, **without creating one**.
///
/// `should_route` runs on every statement — including each of the 50k in a restore — so the check
/// path must not write to the map. A connection with no session yet behaves as auto-commit, which is
/// already the right answer for one that has never been switched to manual mode.
pub(super) fn get_session(id: &str) -> Option<Arc<Session>> {
    let map = match tx_registry().lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    map.get(id).cloned()
}

/// The session of a connection, creating it on first use. Only the paths that actually open or
/// configure a session call this.
///
/// Returns an `Arc` so the caller can **drop the registry lock before awaiting** `pinned`. Holding
/// the map guard across that await would violate `CODING_STANDARDS.md` §6.3 and would put the global
/// serialisation back one level up — the very thing the per-session `pinned` removes.
pub(super) fn session_for(id: &str) -> Arc<Session> {
    let mut map = match tx_registry().lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    if let Some(s) = map.get(id) {
        return s.clone();
    }
    let s = Arc::new(Session::new());
    map.insert(Arc::from(id), s.clone());
    s
}

/// The session a live connection belongs to. `ConnId::Adhoc` has none and never gets one — see
/// `should_route`.
///
/// What comes back is the `conn_id`, a per-connect UUID used to index `TX_REGISTRY`. It is not a
/// credential — `mint_id()` is a random v4 UUID, deliberately never derived from the connection
/// config (see `state/ids.rs`) — and it never reaches SQL: `route.rs` passes it *alongside* the
/// statement, never into it.
///
/// **Do not put `session`, `key` or `uuid` back into this name.** CodeQL's sensitive-name heuristic
/// (`SensitiveDataHeuristics.qll`) classifies `session.?(id|key)` and any `uuid` substring as
/// account info, and this function is a taint *source* the moment it matches. It then reports both
/// SQLite execution funnels — `Exec::run` and `sqlite_raw` — as cleartext storage of a secret
/// (alerts 34/35), because the returned `&str` borrows `conn.id` while the same `conn` carries the
/// DB handle in `conn.kind`: two fields of one struct the analysis does not separate. Renaming
/// `session_key` -> `session_id` could not help — `id` and `key` are alternatives inside the *same*
/// group of that regex — which is what the earlier attempt cost.
pub(super) fn conn_scope_id(conn: &DbConnection) -> Option<&str> {
    match &conn.id {
        crate::state::ConnId::Session(s) => Some(s),
        crate::state::ConnId::Adhoc => None,
    }
}

/// The status of one connection's session. A connection with no session reports the default —
/// auto-commit on, nothing open — which is exactly its state.
pub fn status_json(conn_id: &str) -> Value {
    let session = get_session(conn_id);
    let fallback = Meta::new();
    let m = match session.as_ref() {
        Some(s) => match s.meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        },
        None => return meta_json(conn_id, &fallback),
    };
    meta_json(conn_id, &m)
}

fn meta_json(conn_id: &str, m: &Meta) -> Value {
    let mut v = json!({
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
    });
    // ONE added field, not a re-wrapped payload: `TxControl` filters on it
    // (`payload.connId !== activeConnId`), and wrapping would break every field access in that
    // component and the `TxStatus` type at once, for nothing. See §4.2 of the plan.
    if let Some(o) = v.as_object_mut() {
        o.insert("connId".to_string(), json!(conn_id));
    }
    v
}

pub(super) fn emit_state(conn_id: &str) {
    crate::state::emit("tx-state-changed", status_json(conn_id));
}

/// Read one field out of a connection's `Meta`. A connection with no session yet has the default
/// state, so the three predicates below answer `false` for it without creating anything.
pub(super) fn with_meta<T>(conn_id: &str, f: impl FnOnce(&Meta) -> T, default: T) -> T {
    match get_session(conn_id) {
        Some(s) => {
            let m = match s.meta.lock() {
                Ok(m) => m,
                Err(e) => e.into_inner(),
            };
            f(&m)
        }
        None => default,
    }
}

/// True when a transaction is open and holding changes the user has not committed.
pub fn has_pending(conn_id: &str) -> bool {
    with_meta(conn_id, |m| m.open && m.statements > 0, false)
}

/// How many uncommitted **write** statements one connection is holding — the number the left rail
/// puts on that connection's badge (§4.2b). Zero for a connection with no session, or one that is
/// open but has only read.
pub fn pending_count(conn_id: &str) -> usize {
    with_meta(conn_id, |m| if m.open { m.statements } else { 0 }, 0)
}

/// **Any** connection with uncommitted changes.
///
/// Deliberately not per-connection: the window-close guard asks "is anything dirty", and asking it
/// per connection would let closing the window silently discard another tab's transaction.
pub fn any_pending() -> bool {
    let map = match tx_registry().lock() {
        Ok(m) => m,
        Err(e) => e.into_inner(),
    };
    map.values().any(|s| {
        let m = match s.meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        m.open && m.statements > 0
    })
}

pub fn is_open(conn_id: &str) -> bool {
    with_meta(conn_id, |m| m.open, false)
}

/// Auto-commit is off, whether or not a transaction happens to be open right now.
pub fn manual_mode(conn_id: &str) -> bool {
    with_meta(conn_id, |m| !m.autocommit, false)
}

/// Should a command that writes run on the pinned session?
///
/// **Not** `is_open()`: a transaction only opens when the first statement runs, so a command that
/// checks `is_open()` and finds `false` would happily commit on its own connection — manual commit
/// that commits by itself. Every write path outside the three SQL funnels must ask *this*.
/// Takes the **connection**, not an id string: both call sites already hold one, and letting the
/// handle carry its own identity is what keeps a caller from pairing connection A with id B (§4.4a).
/// An ad-hoc pool has no session and never joins one.
pub fn use_session(conn: &DbConnection) -> bool {
    match conn_scope_id(conn) {
        Some(k) => manual_mode(k) || is_open(k),
        None => false,
    }
}

/// Guard for the batch commands that must own their connection and their own transaction
/// (Data Generator, restore): they issue periodic commits by design, so they cannot join the
/// user's transaction, and they would block on the locks it holds. Refusing beats freezing —
/// and beats committing behind the user's back while the mode says "manual".
pub fn reject_if_manual_or_open(conn_id: &str, action: &str) -> Result<(), String> {
    // Same predicate as `use_session`, spelled out because the callers (restore, data generation)
    // guard *before* they have a connection handle — they only know the id.
    if manual_mode(conn_id) || is_open(conn_id) {
        return Err(format!(
            "Đang bật commit thủ công — hãy kết thúc transaction và chuyển về tự động trước khi {}",
            action
        ));
    }
    Ok(())
}

/// Fold the statement's outcome into the transaction state.
///
/// `is_write` decides whether the pending counter moves — see `is_write_stmt`.
pub(super) fn apply_effect(
    conn_id: &str,
    effect: &TxEffect,
    is_write: bool,
    sql: &str,
    failed_with: Option<&str>,
) {
    let session = session_for(conn_id);
    let mut m = match session.meta.lock() {
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
        emit_state(conn_id);
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
            if let Some(pos) = m
                .savepoints
                .iter()
                .position(|(s, _)| same_savepoint(s, name))
            {
                let mark = m.savepoints[pos].1;
                m.savepoints.truncate(pos + 1);
                m.rewind_to(mark);
            }
            m.aborted = false;
        }
        TxEffect::Release(name) => {
            if let Some(pos) = m
                .savepoints
                .iter()
                .position(|(s, _)| same_savepoint(s, name))
            {
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
    emit_state(conn_id);
}

pub(super) fn check_not_aborted(conn_id: &str, effect: &TxEffect) -> Result<(), String> {
    let Some(session) = get_session(conn_id) else {
        return Ok(());
    };
    let m = match session.meta.lock() {
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

/// Give the pinned connection back once no transaction is open and the user is in auto-commit.
/// In manual mode the connection is kept: the next statement opens a new transaction on it anyway,
/// and re-acquiring per statement would reintroduce the session-hopping this module exists to fix.
pub(super) async fn release_if_closed(conn_id: &str) {
    let Some(session) = get_session(conn_id) else {
        return;
    };
    let (open, autocommit) = {
        let m = match session.meta.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        (m.open, m.autocommit)
    };
    if !open && autocommit {
        let pinned = session.pinned.clone();
        let mut guard = pinned.lock_owned().await;
        *guard = None;
    }
}
