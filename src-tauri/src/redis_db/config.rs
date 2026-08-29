//! Building the connection URL and the TLS configuration.
//!
//! TLS here is a MODE, not a switch: `redis_ssl_mode()` folds the form's `sslEnabled` +
//! `sslMode` into DISABLED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY. Its twin is
//! `REDIS_SSL_MODES` in `ConnectionManager.tsx`.

use serde_json::Value;

// `RedisState` has been deleted. Its five fields now live in the registry, one copy per connection:
// `conn`/`db_index`/`caps` in `state::RedisConn`, `config`/`ssh_tunnel` on
// `state::ServerHandle` (shared between the db indexes of the same server), and `read_only` is a flag on
// `ConnEntry` — the same flag SQL and the rail read, so there is no second source of truth.

pub(crate) fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Resolves the UI's SSL fields into one of DISABLED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY.
///
/// Profiles saved before the Redis SSL tab existed carry only the on/off switch (`sslEnabled`),
/// and that switch meant `rediss://` with rustls' default full verification — so an absent mode
/// maps to VERIFY_IDENTITY, not to the weakest mode. PREFERRED is not offered for Redis (there
/// is no STARTTLS-style negotiation: a port either speaks TLS or it does not) but is mapped
/// defensively in case a profile switched type and kept the field.
pub(crate) fn redis_ssl_mode(config: &Value) -> String {
    let enabled = config.get("sslEnabled").and_then(|v| v.as_bool()).unwrap_or(false)
        || config.get("useSsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let mode = config.get("sslMode").and_then(|v| v.as_str()).unwrap_or("").trim();
    match mode {
        "" | "DISABLED" => if enabled { "VERIFY_IDENTITY" } else { "DISABLED" },
        "PREFERRED" => "VERIFY_IDENTITY",
        other => other,
    }
    .to_string()
}

pub(crate) fn build_redis_url(config: &Value, db_index: i64) -> String {
    let host = config.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(6379);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config.get("password").and_then(|v| v.as_str()).unwrap_or("");
    let mode = redis_ssl_mode(config);
    let scheme = if mode == "DISABLED" { "redis" } else { "rediss" };

    let auth = if !password.is_empty() {
        format!("{}:{}@", url_encode(user), url_encode(password))
    } else {
        String::new()
    };
    let mut url = format!("{}://{}{}:{}/{}", scheme, auth, host, port, db_index);
    // REQUIRED = encrypted but without certificate verification. redis-rs only accepts this configuration
    // through the URL's `#insecure` fragment; url_encode already escapes '#' in the user/password, so this
    // fragment cannot be injected from user data.
    if mode == "REQUIRED" {
        url.push_str("#insecure");
    }
    url
}

// Three separate PEM-reading functions instead of one taking a "file kind" argument: the backendErrors.ts
// table translates the whole sentence, and a Vietnamese argument nested inside it would survive untranslated.
pub(crate) fn read_ca_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được chứng chỉ CA '{}': {}", path, e))
}

pub(crate) fn read_client_cert_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được chứng chỉ client '{}': {}", path, e))
}

pub(crate) fn read_client_key_pem(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("Không đọc được khoá client '{}': {}", path, e))
}

/// Reads the CA / client certificate files named by the SSL tab. Returns `None` when none are
/// set, which is the signal to use the system trust store through the plain URL path.
pub(crate) fn redis_tls_certs(config: &Value) -> Result<Option<redis::TlsCertificates>, String> {
    let field = |key: &str| {
        config
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let ca = field("sslCaPath");
    let cert = field("sslCertPath");
    let key = field("sslKeyPath");
    if ca.is_none() && cert.is_none() && key.is_none() {
        return Ok(None);
    }

    let client_tls = match (cert, key) {
        (Some(c), Some(k)) => Some(redis::ClientTlsConfig {
            client_cert: read_client_cert_pem(&c)?,
            client_key: read_client_key_pem(&k)?,
        }),
        (None, None) => None,
        // mTLS needs the full cert + key pair. Silently ignoring half of it makes the server refuse the connection
        // with a cryptic TLS error, while the real cause is in the form.
        _ => return Err("mTLS cần cả chứng chỉ client và khoá client".to_string()),
    };
    let root_cert = match ca {
        Some(p) => Some(read_ca_pem(&p)?),
        None => None,
    };
    Ok(Some(redis::TlsCertificates { client_tls, root_cert }))
}

/// Builds the client for `config`. Shared by connect, the db-index switch and the dedicated
/// Pub/Sub-Profiler connection so all three speak TLS the same way.
pub(crate) fn make_client(config: &Value, db_index: i64) -> Result<redis::Client, String> {
    let mode = redis_ssl_mode(config);
    let url = build_redis_url(config, db_index);
    let certs = if mode == "DISABLED" { None } else { redis_tls_certs(config)? };

    let client = match certs {
        Some(c) => redis::Client::build_with_tls(url, c)
            .map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e))?,
        None => redis::Client::open(url).map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e))?,
    };

    // VERIFY_CA = verify the certificate chain but skip the hostname. It must be set AFTER build_with_tls:
    // that call rebuilds tls_params from the certificate files and would drop the flag if set before.
    // It is also the only usable mode when Redis goes through an SSH tunnel, because the certificate is then
    // checked against 127.0.0.1.
    if mode == "VERIFY_CA" {
        let mut addr = client.get_connection_info().addr().clone();
        addr.set_danger_accept_invalid_hostnames(true);
        let info = client.get_connection_info().clone().set_addr(addr);
        return redis::Client::open(info).map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e));
    }
    Ok(client)
}
