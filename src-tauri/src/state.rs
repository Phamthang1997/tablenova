// The connection registry — the multi-connection replacement for `DatabaseManager`.
//
// See `docs/multi-connection-plan.md`. Three decisions from that document shape this file, and
// none of them is arbitrary:
//
// 1. **§4.1 — there is no "active connection" here.** A `conn_id` is an argument every
//    connection-bound command carries. A backend-side "active" pointer would have to be set by the
//    frontend before each operation, and across ~210 async call sites two tabs refreshing at once
//    interleave and one of them reads or writes the *wrong* connection with no error raised.
//
// 2. **§4.3 — one `conn_id` means one `(server, database)` pair.** The pool, the current schema,
//    the transaction session and the autocomplete catalog all share exactly that lifetime, so one
//    opaque key serves all four and no signature needs a tuple. Opening a second database on the
//    same server mints a new `conn_id` that shares the server's `Arc<ServerHandle>`; SQLite needs
//    no special case because one file is one database.
//
// 3. **§4.4c — `inner` is private, and `acquire()` is the only way out.** The old code inlined
//    `{ lock manager; match connection.as_ref(); clone per variant; drop guard }` at 56 sites. If
//    that shape stays reachable, "did I convert every site" is a grep question. With `inner`
//    private to this module it becomes a compile question.
//
// `ConnId` lives here too (§4.4a): it is identity, and putting it next to `SessionId` keeps the one
// question "which connection is this" answered in a single place.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

use crate::database::DbConnection;
use crate::ssh_tunnel::SshTunnel;

/// Identifies one `(server, database)` pair. `Arc<str>` rather than `String` because it is cloned
/// on every acquire and looked up on every statement: `Arc<str>: Borrow<str>` lets `HashMap::get`
/// take a `&str`, so a lookup allocates nothing.
pub type SessionId = Arc<str>;

/// Identifies one server. Several `SessionId`s share one of these.
pub type ServerId = Arc<str>;

/// Which connection a `DbConnection` handle belongs to.
///
/// Lives *inside* the handle rather than being passed alongside it (§4.4a). A `(&DbConnection, &str)`
/// pair — or a struct holding both — would let a caller pair connection A's handle with connection
/// B's id, which is the exact failure class this refactor exists to remove. A field cannot drift.
#[derive(Clone)]
pub enum ConnId {
    /// A registry entry. `tx_session` may pin this one as a manual-transaction session.
    Session(SessionId),
    /// A short-lived pool this process opened for itself — `db_compare::resolve_side`, a deep scan,
    /// a `list_databases` probe. **Never routable to a transaction session**, and that is a fix
    /// rather than an optimisation: `should_route` answers from global session state before it looks
    /// at the connection, so with manual commit on, an ad-hoc pool used to get pinned as the user's
    /// session and `BEGIN` ran on it — every later statement of the user then went to the compare
    /// database, and the pool was closed under the session. See §0 of the plan.
    Adhoc,
}

/// `AppHandle` parked so the three SQL funnels can reach the registry.
///
/// They receive a `&DbConnection` and no `AppState` — the same shape that made `tx_session` keep its
/// state in a module-level static. The difference here is deliberate: this parks a *handle* and
/// reads the registry through it, so the read-only flag has exactly one home (`ConnEntry`). A second
/// copy kept in sync would be the duplicate-cache mistake this codebase has paid for twice already.
static APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();

fn app_slot() -> &'static Mutex<Option<tauri::AppHandle>> {
    APP.get_or_init(|| Mutex::new(None))
}

/// Called once from `lib.rs` setup.
pub fn set_app_handle(app: tauri::AppHandle) {
    if let Ok(mut slot) = app_slot().lock() {
        *slot = Some(app);
    }
}

/// Is this connection refusing writes?
///
/// `false` for an ad-hoc pool (it is this process's own, never the user's) and whenever the handle
/// is not parked yet — failing open here matches every other lookup in this module, and the flag is
/// only ever true because a user turned it on.
pub fn conn_is_read_only(id: &ConnId) -> bool {
    let ConnId::Session(sid) = id else {
        return false;
    };
    let guard = match app_slot().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let Some(app) = guard.as_ref() else {
        return false;
    };
    use tauri::Manager;
    app.state::<crate::AppState>().connections.is_read_only(sid)
}

/// A fresh opaque id. UUID rather than a counter so an id is never reused across restarts, and
/// never derived from the connection config: config carries credentials, and any normalisation slip
/// in a derived key would turn two profiles with different credentials on the same host into one id
/// — silent cross-talk instead of two connections (§4.3).
pub fn mint_id() -> Arc<str> {
    Arc::from(uuid::Uuid::new_v4().to_string().as_str())
}

/// What every `ConnEntry` on the same server shares.
///
/// The SSH tunnel lives here rather than per connection on purpose: dropping the handle closes the
/// forwarded port, so the last `ConnEntry` on a server going away is what must close it. An
/// `Arc<ServerHandle>` gets that for free — no hand-rolled refcount, and no "who owns the tunnel"
/// question to answer at every call site.
pub struct ServerHandle {
    pub id: ServerId,
    /// `"sqlite"` / `"postgres"` / `"mysql"`. Kept only for rebuilding a connection URL. The
    /// dialect a command branches on comes from `ConnCtx::dialect()`, which derives it from the
    /// live connection — the two cannot disagree that way, and this one is `""` while disconnected.
    pub db_type: String,
    /// The config a new pool on this server is built from (a different database, or an IAM token
    /// refresh). Carries credentials, so it never leaves the backend.
    ///
    /// Behind a `Mutex` because it genuinely changes on a live server: a MySQL `USE` inside a
    /// restore and `switch_database` both rewrite its `database` field, and `ServerHandle` is shared
    /// through an `Arc`. Phase 3 should be able to drop the `Mutex` again — once the database comes
    /// from `ConnEntry::db` and the pool builder overrides it, this becomes purely server-level
    /// (host/port/credentials) and stops changing. Read it with `config()`, not by locking directly.
    last_config: Mutex<Value>,
    pub ssh_tunnel: Option<SshTunnel>,
}

impl ServerHandle {
    pub fn new(id: ServerId, db_type: String, last_config: Value, ssh_tunnel: Option<SshTunnel>) -> Self {
        ServerHandle {
            id,
            db_type,
            last_config: Mutex::new(last_config),
            ssh_tunnel,
        }
    }

    /// A clone of the server config. Tolerates a poisoned lock the same way `tx_session` does —
    /// a panic elsewhere must not turn every later connection attempt into an error.
    pub fn config(&self) -> Value {
        match self.last_config.lock() {
            Ok(g) => g.clone(),
            Err(e) => e.into_inner().clone(),
        }
    }

    pub fn set_config(&self, v: Value) {
        match self.last_config.lock() {
            Ok(mut g) => *g = v,
            Err(e) => *e.into_inner() = v,
        }
    }
}

/// One open `(server, database)`.
pub struct ConnEntry {
    /// Refuse every write on this connection.
    ///
    /// Lives here, in the backend, **not only in the UI** — the same call `redis_db::RedisState`
    /// already made and for the same reason: the SQL editor sends arbitrary statement text, so a
    /// gate in the WebView is a gate on the wrong side of the IPC boundary. Per connection, because
    /// the point is holding production open next to dev.
    pub read_only: bool,
    pub server: Arc<ServerHandle>,
    /// Database name; the file path for SQLite.
    pub db: String,
    pub conn: DbConnection,
    /// Postgres only: the schema introspection filters on and generated statements qualify with.
    /// `None` on MySQL/SQLite, where schema and database are the same thing. It stays *state*
    /// rather than becoming a command argument — see `postgres-schema-support-plan.md` §5.0; only
    /// its home moved, from one global into one entry per `(server, database)`.
    pub current_schema: Option<String>,
}

/// A connection plus everything a command used to clone out of `DatabaseManager` by hand.
///
/// Fields are private and there is no `Clone`: this is threaded, not duplicated. Handing out a
/// bare `DbConnection` next to a separately-passed id would let a caller pair A's handle with B's
/// id, which is the failure class this whole refactor exists to remove.
pub struct ConnCtx {
    id: SessionId,
    server: Arc<ServerHandle>,
    conn: DbConnection,
    dialect: &'static str,
    schema: String,
    raw_schema: Option<String>,
    db: String,
}

impl ConnCtx {
    pub fn id(&self) -> &SessionId {
        &self.id
    }

    pub fn conn(&self) -> &DbConnection {
        &self.conn
    }

    /// The server this connection belongs to — `last_config` and the live SSH tunnel, for the paths
    /// that rebuild a pool (open another database, refresh an IAM token) rather than run a
    /// statement. Several `ConnCtx` on the same server hand back the same `Arc`.
    pub fn server(&self) -> &ServerHandle {
        &self.server
    }

    /// The shared handle itself, for `open_database`: a second database on this server must hold the
    /// **same** `Arc`, or it would open its own tunnel and re-authenticate, and the tunnel would
    /// close as soon as the first connection went away.
    pub fn server_arc(&self) -> Arc<ServerHandle> {
        self.server.clone()
    }

    /// Derived from the live connection, never from `ServerHandle::db_type`.
    pub fn dialect(&self) -> &'static str {
        self.dialect
    }

    /// **Already defaulted to `public`.** Returning `Option<String>` here would let a call site
    /// forget `pg_schema_of` and silently query `public` while the compiler stayed happy — the
    /// quiet-wrong-schema bug `postgres-schema-support-plan.md` §4.2 lists as the easiest to miss.
    /// Use `raw_schema()` only where the *absence* of a schema is the answer.
    pub fn schema(&self) -> &str {
        &self.schema
    }

    /// The unresolved value, for `list_schemas`' `"current"` field.
    pub fn raw_schema(&self) -> Option<&str> {
        self.raw_schema.as_deref()
    }

    /// Kept so `ConnEntry::db` has a reader: `set_db` writes it today (a MySQL `USE`, a
    /// `switch_database`) and Phase 3's left rail is what will display it (§4.2c).
    #[allow(dead_code)]
    pub fn db(&self) -> &str {
        &self.db
    }
}

/// Shared by `acquire` and `sole` so the two cannot drift in what they read out of an entry.
/// Takes the map key, not `entry.server.id`: the id a `ConnCtx` carries is the **conn_id**.
fn ctx_of(key: &SessionId, entry: &ConnEntry) -> ConnCtx {
    ConnCtx {
        id: key.clone(),
        server: entry.server.clone(),
        conn: entry.conn.clone(),
        // Always derived from the live connection, never from `ServerHandle::db_type` — the two
        // cannot disagree that way, and `db_type` is `""` while disconnected.
        dialect: crate::tx_session::dialect_of(&entry.conn),
        schema: crate::database::pg_schema_of(&entry.current_schema),
        raw_schema: entry.current_schema.clone(),
        db: entry.db.clone(),
    }
}

/// Every open connection, keyed by `conn_id`.
///
/// `std::sync::Mutex`, not `tokio`'s: the critical section is "clone a handle out and drop the
/// guard", which must stay sub-microsecond and must never span an `.await` (`CODING_STANDARDS.md`
/// §6.3). An async mutex is slower uncontended and invites exactly the hold-across-await this
/// codebase forbids.
pub struct ConnRegistry {
    inner: Mutex<HashMap<SessionId, ConnEntry>>,
}

impl Default for ConnRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnRegistry {
    pub fn new() -> Self {
        ConnRegistry { inner: Mutex::new(HashMap::new()) }
    }

    /// The only way to get a connection out of the registry.
    ///
    /// An unknown id reuses the existing `"Chưa kết nối CSDL"` verbatim rather than adding a
    /// message: to the user an id that no longer resolves and a connection that was closed are the
    /// same event, and reusing the literal keeps `src/utils/backendErrors.ts` and its
    /// byte-identical Vietnamese round-trip test untouched (§6).
    pub fn acquire(&self, id: &str) -> Result<ConnCtx, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        // `get_key_value`, not `get`: the ConnCtx carries the *conn_id* (this map's key), which is
        // what tx_session will key a session on. `entry.server.id` is a different thing — several
        // conn_ids share one server.
        let (key, entry) = map.get_key_value(id).ok_or_else(|| "Chưa kết nối CSDL".to_string())?;
        Ok(ctx_of(key, entry))
    }

    /// Every open connection, as the left rail needs to draw it (§4.2c): the rail lists **open
    /// connections**, not every database on the server, so this replaces the `list_databases` query
    /// it used to run against the active connection.
    ///
    /// Sorted by id so the rail does not reshuffle itself on every poll — a `HashMap` has no order.
    pub fn list(&self) -> Result<Vec<Value>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out: Vec<(SessionId, Value)> = map
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    serde_json::json!({
                        "connId": &**id,
                        "db": e.db,
                        "dialect": crate::tx_session::dialect_of(&e.conn),
                        "serverId": &*e.server.id,
                        "schema": e.current_schema,
                        // Badge của rail (§4.2b): số câu GHI đang chờ commit trên kết nối này.
                        "pending": crate::tx_session::pending_count(id),
                        "readOnly": e.read_only,
                    }),
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().map(|(_, v)| v).collect())
    }

    pub fn insert(&self, id: SessionId, entry: ConnEntry) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        map.insert(id, entry);
        Ok(())
    }

    /// Replaces the live handle of one entry, for an IAM token refresh that rebuilt the pool.
    pub fn replace_conn(&self, id: &str, conn: DbConnection) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.conn = conn;
        }
        Ok(())
    }

    /// The connection already open on this `(server, database)`, if any. Makes `open_database`
    /// idempotent: clicking a database twice must not mint a second pool for the same place.
    pub fn find(&self, server: &str, db: &str) -> Result<Option<SessionId>, String> {
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map
            .iter()
            .find(|(_, e)| &*e.server.id == server && e.db == db)
            .map(|(id, _)| id.clone()))
    }

    /// An already-open SQLite connection on the same file, if any.
    ///
    /// SQLite is the one dialect where a second connection to the same database is not just
    /// redundant but harmful: two `rusqlite::Connection`s on one file mean `SQLITE_BUSY` the moment
    /// both write. Postgres and MySQL are left alone — opening the same database twice there is a
    /// legitimate thing to want (two independent sessions), and the credentials may even differ.
    ///
    /// Paths are compared after `canonicalize`, which folds `..`, relative paths and — on Windows —
    /// case. A path that cannot be canonicalized (the file is gone) falls back to a raw compare, so
    /// a missing file never *matches* something it should not.
    pub fn find_sqlite(&self, path: &str) -> Result<Option<SessionId>, String> {
        let want = std::fs::canonicalize(path).ok();
        let map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map
            .iter()
            .find(|(_, e)| {
                if !matches!(e.conn.kind, crate::database::DbKind::Sqlite(_)) {
                    return false;
                }
                match (&want, std::fs::canonicalize(&e.db).ok()) {
                    // `want` is matched by reference (it is reused on every iteration), so `a` is a
                    // `&PathBuf` while `b` is owned.
                    (Some(a), Some(b)) => *a == b,
                    _ => e.db == path,
                }
            })
            .map(|(id, _)| id.clone()))
    }

    /// Drops one entry and hands it back, so the caller can roll back its transaction session and
    /// close its pool *after* the registry lock is released — neither may run while a guard is held.
    pub fn remove(&self, id: &str) -> Result<Option<ConnEntry>, String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map.remove(id))
    }

    pub fn set_read_only(&self, id: &str, on: bool) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.read_only = on;
        }
        Ok(())
    }

    pub fn is_read_only(&self, id: &str) -> bool {
        let map = match self.inner.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        map.get(id).map(|e| e.read_only).unwrap_or(false)
    }

    pub fn set_schema(&self, id: &str, schema: Option<String>) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.current_schema = schema;
        }
        Ok(())
    }

    /// The database an entry points at, after a MySQL `USE` inside a restore or a `switch_database`.
    /// Phase 3 replaces both of those with minting a new `conn_id` instead of moving an existing
    /// one, at which point this goes away (§4.3).
    pub fn set_db(&self, id: &str, db: String) -> Result<(), String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(id) {
            entry.db = db;
        }
        Ok(())
    }
}
