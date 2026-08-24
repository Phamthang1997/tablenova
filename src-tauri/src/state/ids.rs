//! Danh tính của một kết nối: `SessionId`, `ServerId`, `ConnId` và cách sinh id mới.

use std::sync::Arc;

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
    /// A registry entry. `tx/` may pin this one as a manual-transaction session.
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
