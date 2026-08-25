//! One entry in the registry: a SQL or Redis connection, together with whatever is specific to it.

use std::sync::Arc;

use crate::database::DbConnection;
use crate::redis_db::RedisCaps;
use super::server::ServerHandle;

/// A Redis connection, as one registry entry holds it.
///
/// `db_index` lives here rather than in a global because a `conn_id` **is** a `(server, db index)`
/// pair for Redis, exactly as it is a `(server, database)` pair for SQL — see
/// `docs/redis-ui-unification-plan.md` §2.1. Switching db therefore mints a new entry instead of
/// mutating a shared one, which is what stops two open key tabs from reading different databases
/// than the one they were opened on.
#[derive(Clone)]
pub struct RedisConn {
    pub conn: redis::aio::MultiplexedConnection,
    pub db_index: i64,
    /// What the server supports (version, modules). Probed once at connect.
    pub caps: RedisCaps,
}

/// The live handle of one entry.
///
/// SQL and Redis share the registry — one list of open connections for the rail, one lifecycle, one
/// read-only flag — and share nothing else: a Redis entry has no dialect, no schema and no
/// transaction session. Keeping them in one map is what lets `DbRail`/`QuickSwitcherPopover` draw
/// both from a single source; a parallel Redis registry would be a second source of truth for that
/// list and for the read-only flag, which is the duplicate-cache mistake this file already warns
/// about above.
pub enum LiveConn {
    Sql(DbConnection),
    Redis(RedisConn),
}

impl LiveConn {
    /// The SQL handle, or `None` for a Redis entry. Callers that need SQL go through
    /// `ConnRegistry::acquire`, which turns that `None` into an error once, at the boundary.
    pub fn sql(&self) -> Option<&DbConnection> {
        match self {
            LiveConn::Sql(c) => Some(c),
            LiveConn::Redis(_) => None,
        }
    }

    /// What the rail labels this connection with. Derived from the live handle for SQL, for the
    /// reason `ctx_of` gives: `ServerHandle::db_type` can be stale, a handle cannot.
    pub fn dialect(&self) -> &'static str {
        match self {
            LiveConn::Sql(c) => crate::tx::dialect_of(c),
            LiveConn::Redis(_) => "redis",
        }
    }
}

/// One open `(server, database)`.
pub struct ConnEntry {
    /// Refuse every write on this connection.
    ///
    /// Lives here, in the backend, **not only in the UI** — the same call `redis_db` used to make
    /// in its own `RedisState` and for the same reason: the SQL editor and the Redis CLI both send
    /// arbitrary command text, so a gate in the WebView is a gate on the wrong side of the IPC
    /// boundary. Per connection, because the point is holding production open next to dev. Redis
    /// reads this same field — it no longer keeps a second flag of its own.
    pub read_only: bool,
    /// May the built-in MCP server show this connection to an AI client?
    ///
    /// **Default `false`, and that is the feature.** A production connection left open must not
    /// become visible to an AI client because the user never opened the MCP settings. Unlike
    /// `read_only`, which is inherited when a sibling database is opened on the same server, this is
    /// NOT inherited: opening a second database is a new place, and "I shared dev" must not quietly
    /// become "I shared prod on the same server". See `docs/mcp-server-plan.md` §3.3.
    pub mcp_exposed: bool,
    pub server: Arc<ServerHandle>,
    /// Database name; the file path for SQLite; `db0`…`db15` for Redis.
    pub db: String,
    pub conn: LiveConn,
    /// Postgres only: the schema introspection filters on and generated statements qualify with.
    /// `None` on MySQL/SQLite, where schema and database are the same thing. It stays *state*
    /// rather than becoming a command argument — see `postgres-schema-support-plan.md` §5.0; only
    /// its home moved, from one global into one entry per `(server, database)`.
    pub current_schema: Option<String>,
}
