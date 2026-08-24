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

mod app_handle;
mod ctx;
mod entry;
mod ids;
mod registry;
mod server;

pub use app_handle::*;
pub use ctx::*;
pub use entry::*;
pub use ids::*;
pub use registry::*;
pub use server::*;
