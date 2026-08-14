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
// Not yet in this file, and deliberately: `ConnId` inside `DbConnection` (§4.4a). That is the next
// slice — it touches ~149 mentions of the connection type and must land after the 56 acquire blocks
// are deleted, not before, or 170 of those mentions get edited only to be thrown away.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

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
    /// Bumped when this server's connections are replaced. **Per server, not global** (§4.6): a
    /// single global counter meant opening a second connection invalidated the *first* one's IAM
    /// refresh task, and that connection then died ~15 minutes later with an auth error and nothing
    /// pointing at the cause.
    pub generation: AtomicU64,
}

impl ServerHandle {
    pub fn new(id: ServerId, db_type: String, last_config: Value, ssh_tunnel: Option<SshTunnel>, generation: u64) -> Self {
        ServerHandle {
            id,
            db_type,
            last_config: Mutex::new(last_config),
            ssh_tunnel,
            generation: AtomicU64::new(generation),
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

    /// Drops one entry and hands it back, so the caller can roll back its transaction session and
    /// close its pool *after* the registry lock is released — neither may run while a guard is held.
    pub fn remove(&self, id: &str) -> Result<Option<ConnEntry>, String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map.remove(id))
    }

    /// Drops every entry, returning them for the same reason `remove` does. `connect_db` uses this:
    /// Phase 1 replaces the one connection rather than adding to it.
    pub fn clear(&self) -> Result<Vec<ConnEntry>, String> {
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(map.drain().map(|(_, e)| e).collect())
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
