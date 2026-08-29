// Redis support as a 4th kind of DB — kept SEPARATE from the DbConnection enum (SQL) so that a pile of
// existing matches are not broken, but sharing the `conn_id` registry with SQL
// (`docs/redis-ui-unification-plan.md` §2.3): one list of open connections for `DbRail`, one lifecycle,
// one read-only flag. `RedisState` — one connection and one db_index for the whole app — has been deleted.
//
// One `conn_id` = one `(server, db index)` (§2.1). Changing the db index OPENS ANOTHER CONNECTION, it does not
// change shared state; that is what keeps two key tabs open on two dbs from reading each other's data.
// Uses redis::aio::MultiplexedConnection (cheap to Clone) with the pattern: lock -> clone -> drop lock -> await.

pub mod cmds;
pub mod keys;
pub mod types;

mod admin;
mod analyze;
mod caps;
mod config;
mod conn;
mod live;
mod session;
mod slowlog;
mod transfer;
mod value;

pub use admin::*;
pub use analyze::*;
pub use caps::RedisCaps;
pub use keys::*;
pub use live::*;
pub use session::*;
pub use slowlog::*;
pub use transfer::*;
pub use types::*;
