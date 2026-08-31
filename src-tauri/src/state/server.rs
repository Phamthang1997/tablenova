//! `ServerHandle` — what every connection to the same server shares.

use std::sync::Mutex;

use serde_json::Value;

use super::ids::ServerId;
use crate::ssh::SshTunnel;

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
    /// restore rewrites its `database` field, and `ServerHandle` is shared through an `Arc`.
    ///
    /// `switch_database` was the other writer and is gone, but the `Mutex` **stays**: the restore
    /// path still rewrites this, and that one cannot be removed the same way — a `USE` arrives from
    /// inside the dump the user is replaying, not from a command with a `conn_id` to mint a new one
    /// for. Read it with `config()`, not by locking directly.
    last_config: Mutex<Value>,
    pub ssh_tunnel: Option<SshTunnel>,
}

impl ServerHandle {
    pub fn new(
        id: ServerId,
        db_type: String,
        last_config: Value,
        ssh_tunnel: Option<SshTunnel>,
    ) -> Self {
        ServerHandle {
            id,
            db_type,
            last_config: Mutex::new(last_config),
            ssh_tunnel,
        }
    }

    /// A clone of the server config. Tolerates a poisoned lock the same way `tx/` does —
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

    /// Change ONE field of the config, leaving the rest untouched.
    ///
    /// It exists instead of `config()` → edit → `set_config()`: those two steps are a read-modify-write
    /// outside the lock, so two commands running side by side can overwrite each other. Here all three
    /// steps happen under the same lock acquisition. A config that is not an object (never happens in
    /// practice) is skipped rather than replaced by a fresh object, which would lose connection details.
    pub fn set_config_field(&self, key: &str, v: Value) {
        let mut guard = match self.last_config.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if let Some(obj) = guard.as_object_mut() {
            obj.insert(key.to_string(), v);
        }
    }
}
