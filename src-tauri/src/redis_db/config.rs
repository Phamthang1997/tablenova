//! Dựng URL kết nối và cấu hình TLS.
//!
//! TLS ở đây là một CHẾ ĐỘ, không phải một công tắc: `redis_ssl_mode()` gộp `sslEnabled` +
//! `sslMode` của form thành DISABLED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY. Bản sinh đôi
//! của nó là `REDIS_SSL_MODES` trong `ConnectionManager.tsx`.

use serde_json::Value;

// `RedisState` đã bị xoá. Năm trường của nó giờ nằm trong registry, mỗi kết nối một bản:
// `conn`/`db_index`/`caps` trong `state::RedisConn`, `config`/`ssh_tunnel` trên
// `state::ServerHandle` (dùng chung giữa các db index của cùng server), `read_only` là cờ của
// `ConnEntry` — cùng một cờ mà SQL và thanh rail đọc, nên không còn hai nguồn sự thật.

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
    // REQUIRED = mã hoá nhưng không kiểm tra chứng chỉ. redis-rs chỉ nhận cấu hình này qua
    // fragment `#insecure` của URL; url_encode đã escape '#' trong user/password nên fragment
    // này không thể bị chèn từ dữ liệu người dùng.
    if mode == "REQUIRED" {
        url.push_str("#insecure");
    }
    url
}

// Ba hàm đọc file PEM riêng thay vì một hàm có tham số "loại file": bảng backendErrors.ts dịch
// cả khung câu, một tham số tiếng Việt lồng bên trong sẽ nằm nguyên trong câu đã dịch.
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
        // mTLS cần đủ cặp cert + key. Thiếu một nửa mà im lặng bỏ qua thì server từ chối kết nối
        // với một lỗi TLS khó hiểu, trong khi nguyên nhân thật nằm ở form.
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

    // VERIFY_CA = kiểm tra chuỗi chứng chỉ nhưng bỏ qua tên miền. Phải đặt SAU build_with_tls:
    // hàm đó dựng lại tls_params từ các file chứng chỉ và sẽ xoá mất cờ nếu đặt trước.
    // Đây cũng là mode duy nhất dùng được khi Redis đi qua SSH tunnel, vì lúc đó chứng chỉ
    // được đối chiếu với 127.0.0.1.
    if mode == "VERIFY_CA" {
        let mut addr = client.get_connection_info().addr().clone();
        addr.set_danger_accept_invalid_hostnames(true);
        let info = client.get_connection_info().clone().set_addr(addr);
        return redis::Client::open(info).map_err(|e| format!("Cấu hình TLS không hợp lệ: {}", e));
    }
    Ok(client)
}
