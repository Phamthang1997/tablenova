//! Building the connection string from a config, and transforming the config before connecting (SSH tunnel).

use serde_json::{Value, json};

use crate::ssh::SshTunnel;

// Encode the user/password component so a special character (@, :, /, ...) cannot break the URL
fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Build the Postgres connection string including the SSL configuration (sslmode + sslrootcert when present)
pub(crate) fn build_pg_url(config: &Value, db_override: Option<&str>) -> String {
    let host = config
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(5432);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut database = db_override.unwrap_or_else(|| {
        config
            .get("database")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    });
    if database.trim().is_empty() {
        database = "postgres";
    }

    let mut url = format!(
        "postgres://{}:{}@{}:{}/{}",
        url_encode_component(user),
        url_encode_component(password),
        host,
        port,
        database
    );

    // SSL: map the UI values (DISABLED/PREFERRED/REQUIRED/VERIFY_CA/VERIFY_IDENTITY) -> Postgres' sslmode
    let ssl_mode_ui = config
        .get("sslMode")
        .and_then(|v| v.as_str())
        .unwrap_or("DISABLED");
    let ssl_enabled = config
        .get("sslEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || ssl_mode_ui != "DISABLED";
    if ssl_enabled {
        let pg_mode = match ssl_mode_ui {
            "PREFERRED" => "prefer",
            "REQUIRED" => "require",
            "VERIFY_CA" => "verify-ca",
            "VERIFY_IDENTITY" => "verify-full",
            "DISABLED" => "require", // sslEnabled=true but no mode set -> default to require
            other => other,
        };
        url.push_str(&format!("?sslmode={}", pg_mode));
        if let Some(ca) = config
            .get("sslCaPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&sslrootcert={}", ca));
        }
        if let Some(cert) = config
            .get("sslCertPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&sslcert={}", cert));
        }
        if let Some(key) = config
            .get("sslKeyPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&sslkey={}", key));
        }
    } else {
        // "disable" has to be spelled out: without an sslmode sqlx uses its default
        // PgSslMode::Prefer (which still enables TLS when the server supports it) and even reads the
        // PGSSLMODE environment variable -> the UI says DISABLED while the connection is in fact encrypted.
        url.push_str("?sslmode=disable");
    }
    url
}

// Build the MySQL connection string including the SSL configuration (ssl-mode + ssl-ca when present)
pub(crate) fn build_mysql_url(config: &Value, db_override: Option<&str>) -> String {
    let host = config
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost");
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(3306);
    let user = config.get("user").and_then(|v| v.as_str()).unwrap_or("");
    let password = config
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut database = db_override.unwrap_or_else(|| {
        config
            .get("database")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    });
    if database.trim().is_empty() {
        database = "mysql";
    }

    let mut url = format!(
        "mysql://{}:{}@{}:{}/{}",
        url_encode_component(user),
        url_encode_component(password),
        host,
        port,
        database
    );

    // SSL: the UI values match sqlx MySQL's ssl-mode exactly
    let ssl_mode_ui = config
        .get("sslMode")
        .and_then(|v| v.as_str())
        .unwrap_or("DISABLED");
    let ssl_enabled = config
        .get("sslEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || ssl_mode_ui != "DISABLED";
    if ssl_enabled {
        let my_mode = if ssl_mode_ui == "DISABLED" {
            "REQUIRED"
        } else {
            ssl_mode_ui
        };
        url.push_str(&format!("?ssl-mode={}", my_mode));
        if let Some(ca) = config
            .get("sslCaPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&ssl-ca={}", ca));
        }
        if let Some(cert) = config
            .get("sslCertPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&ssl-cert={}", cert));
        }
        if let Some(key) = config
            .get("sslKeyPath")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            url.push_str(&format!("&ssl-key={}", key));
        }
    } else {
        // Same as Postgres: sqlx's default is MySqlSslMode::Preferred.
        url.push_str("?ssl-mode=DISABLED");
    }
    url
}

// When SSH is enabled, open a tunnel to the config's current (host, port) and return the adjusted config
// pointing the connection at 127.0.0.1:<local_port>. Returns (config_to_connect_with, tunnel).
pub(crate) async fn apply_ssh_tunnel(
    config: &Value,
    default_port: u16,
) -> Result<(Value, Option<SshTunnel>), String> {
    let use_ssh = config
        .get("useSsh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !use_ssh {
        return Ok((config.clone(), None));
    }
    let db_host = config
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1");
    let db_port = config
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(default_port as u64) as u16;

    let tunnel = SshTunnel::open(config, db_host, db_port).await?;
    let local_port = tunnel.local_port;

    let mut tunneled = config.clone();
    if let Some(obj) = tunneled.as_object_mut() {
        obj.insert("host".to_string(), json!("127.0.0.1"));
        obj.insert("port".to_string(), json!(local_port));
    }
    Ok((tunneled, Some(tunnel)))
}
