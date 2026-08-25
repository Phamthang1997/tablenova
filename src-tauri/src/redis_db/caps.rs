//! What this server can do: its version, and the modules it has loaded (ReJSON, TimeSeries, …).

use redis::aio::MultiplexedConnection;
use serde_json::{json, Value};

use crate::redis_db::cmds::parse_version;
use crate::redis_db::value::as_text;

/// What the connected server can actually do. Probed once at connect instead of being
/// discovered by trying a command and catching the error: the app must work against Redis
/// 6/7/8, Valkey, KeyDB and Dragonfly, and "try it and see" turns every paged read into a
/// possible round trip wasted on a syntax error.
#[derive(Clone, Default)]
pub struct RedisCaps {
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// Lowercased module names from `MODULE LIST` (empty when the command is not allowed).
    pub modules: Vec<String>,
}

impl RedisCaps {
    pub fn has_module(&self, name: &str) -> bool {
        self.modules.iter().any(|m| m == name)
    }
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "major": self.major,
            "minor": self.minor,
            "modules": self.modules,
        })
    }
}

pub(crate) fn caps_of(state: &crate::AppState, conn_id: &str) -> RedisCaps {
    state
        .connections
        .acquire_redis(conn_id)
        .map(|c| c.caps())
        .unwrap_or_default()
}

// One entry of `MODULE LIST`. RESP2 gives a flat array (["name", <n>, "ver", <v>]),
// RESP3 a map — accept both rather than depending on the negotiated protocol.
pub(crate) fn module_name(v: &redis::Value) -> Option<String> {
    let pairs: Vec<(&redis::Value, &redis::Value)> = match v {
        redis::Value::Array(a) => a.chunks(2).filter(|c| c.len() == 2).map(|c| (&c[0], &c[1])).collect(),
        redis::Value::Map(m) => m.iter().map(|(k, val)| (k, val)).collect(),
        _ => return None,
    };
    pairs.into_iter().find_map(|(k, val)| {
        if as_text(k).eq_ignore_ascii_case("name") {
            Some(as_text(val).to_ascii_lowercase())
        } else {
            None
        }
    })
}

// Version + module list, read once per connection. Both lookups are best-effort: managed
// Redis often blocks MODULE LIST by ACL, and a fork may not report redis_version the same
// way — an empty result degrades to "assume the oldest behaviour", never to an error.
pub(crate) async fn probe_caps(conn: &mut MultiplexedConnection) -> RedisCaps {
    let text: String = redis::cmd("INFO")
        .arg("server")
        .query_async(conn)
        .await
        .unwrap_or_default();
    let version = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("redis_version:"))
        .unwrap_or("")
        .trim()
        .to_string();
    let (major, minor) = parse_version(&version);
    let modules = match redis::cmd("MODULE")
        .arg("LIST")
        .query_async::<redis::Value>(conn)
        .await
    {
        Ok(redis::Value::Array(items)) => items.iter().filter_map(module_name).collect(),
        _ => Vec::new(),
    };
    RedisCaps { version, major, minor, modules }
}

// ---- RedisJSON ----

pub(crate) fn ensure_json_module(state: &crate::AppState, conn_id: &str) -> Result<(), String> {
    let caps = caps_of(state, conn_id);
    // An empty module list means MODULE LIST was refused (common on managed Redis), not that
    // there are no modules — in that case let the command itself decide.
    if caps.modules.is_empty() {
        return Ok(());
    }
    if caps.has_module("rejson") || caps.has_module("json") {
        return Ok(());
    }
    Err("Server không có module RedisJSON".to_string())
}
