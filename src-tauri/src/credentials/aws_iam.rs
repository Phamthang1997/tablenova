// AWS IAM authentication cho RDS/Aurora (MySQL/MariaDB/PostgreSQL).
// Replaces the static password with a short-lived (15 minute) SigV4-signed TOKEN for the "rds-db" service, used as the password.
// The SigV4 presign is implemented here (hmac + sha2) so the whole AWS SDK does NOT have to be pulled in.
// Credentials: an Access Key (typed in) or a Profile (read from ~/.aws/credentials). SSO is not supported yet.

use hmac::{Hmac, Mac, KeyInit};
use sha2::{Digest, Sha256};
use serde_json::Value;

type HmacSha256 = Hmac<Sha256>;

struct AwsCreds {
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC nhận key mọi độ dài");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// RFC3986 encoding for the SigV4 query string (keeps A-Za-z0-9 -_.~ ; everything else becomes upper-case %XX).
fn uri_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        let keep = b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~';
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// Detect the region from the RDS hostname: <name>.<hash>.<region>.rds.amazonaws.com
pub fn detect_region(host: &str) -> Option<String> {
    let parts: Vec<&str> = host.split('.').collect();
    if let Some(pos) = parts.iter().position(|p| *p == "rds") {
        if pos > 0 && !parts[pos - 1].is_empty() {
            return Some(parts[pos - 1].to_string());
        }
    }
    None
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok())
}

// Read the access key/secret/token of one profile in ~/.aws/credentials (a simple INI).
fn read_profile_creds(profile: &str) -> Result<AwsCreds, String> {
    let path = std::env::var("AWS_SHARED_CREDENTIALS_FILE").ok().unwrap_or_else(|| {
        let home = home_dir().unwrap_or_default();
        format!("{}/.aws/credentials", home)
    });
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Không đọc được file credentials '{}': {}", path, e))?;

    let mut in_section = false;
    let mut ak = String::new();
    let mut sk = String::new();
    let mut token: Option<String> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let name = line[1..line.len() - 1].trim();
            in_section = name == profile;
            continue;
        }
        if in_section {
            if let Some((k, v)) = line.split_once('=') {
                let (k, v) = (k.trim(), v.trim());
                match k {
                    "aws_access_key_id" => ak = v.to_string(),
                    "aws_secret_access_key" => sk = v.to_string(),
                    "aws_session_token" => token = Some(v.to_string()),
                    _ => {}
                }
            }
        }
    }
    if ak.is_empty() || sk.is_empty() {
        return Err(format!("Profile '{}' thiếu aws_access_key_id/aws_secret_access_key", profile));
    }
    Ok(AwsCreds { access_key: ak, secret_key: sk, session_token: token })
}

fn resolve_creds(config: &Value) -> Result<AwsCreds, String> {
    let auth = config.get("awsAuthType").and_then(|v| v.as_str()).unwrap_or("access_key");
    if auth == "profile" {
        let profile = config.get("awsProfile").and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or("Thiếu tên AWS profile")?;
        return read_profile_creds(profile);
    }
    let ak = config.get("awsAccessKeyId").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).ok_or("Thiếu AWS Access Key ID")?;
    let sk = config.get("awsSecretAccessKey").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).ok_or("Thiếu AWS Secret Access Key")?;
    let token = config.get("awsSessionToken").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).map(|s| s.to_string());
    Ok(AwsCreds { access_key: ak.to_string(), secret_key: sk.to_string(), session_token: token })
}

// Build the RDS IAM auth token = the SigV4-presigned URL (with the https:// scheme stripped). Used as the password.
pub fn generate_rds_token(config: &Value, default_port: u16) -> Result<String, String> {
    let host = config.get("host").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).ok_or("Thiếu host RDS")?;
    let port = config.get("port").and_then(|v| v.as_u64()).unwrap_or(default_port as u64) as u16;
    let user = config.get("user").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).ok_or("Thiếu DB user cho IAM")?;
    let region = config.get("awsRegion").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty()).map(|s| s.to_string())
        .or_else(|| detect_region(host))
        .ok_or("Không xác định được AWS region (điền thủ công)")?;
    let creds = resolve_creds(config)?;

    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let datestamp = now.format("%Y%m%d").to_string();

    let service = "rds-db";
    let algorithm = "AWS4-HMAC-SHA256";
    let credential_scope = format!("{}/{}/{}/aws4_request", datestamp, region, service);
    let host_header = format!("{}:{}", host.to_lowercase(), port);

    // Query params (signature not included yet). Both key and value must be URI-encoded, then sorted by the encoded key.
    let mut params: Vec<(String, String)> = vec![
        ("Action".into(), "connect".into()),
        ("DBUser".into(), user.to_string()),
        ("X-Amz-Algorithm".into(), algorithm.into()),
        ("X-Amz-Credential".into(), format!("{}/{}", creds.access_key, credential_scope)),
        ("X-Amz-Date".into(), amz_date.clone()),
        ("X-Amz-Expires".into(), "900".into()),
        ("X-Amz-SignedHeaders".into(), "host".into()),
    ];
    if let Some(ref t) = creds.session_token {
        params.push(("X-Amz-Security-Token".into(), t.clone()));
    }

    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (uri_encode(k), uri_encode(v)))
        .collect();
    encoded.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_query = encoded
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_headers = format!("host:{}\n", host_header);
    let signed_headers = "host";
    let payload_hash = sha256_hex(b""); // GET has no body

    let canonical_request = format!(
        "GET\n/\n{}\n{}\n{}\n{}",
        canonical_query, canonical_headers, signed_headers, payload_hash
    );

    let string_to_sign = format!(
        "{}\n{}\n{}\n{}",
        algorithm,
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    // SigV4 signing key
    let k_date = hmac_sha256(format!("AWS4{}", creds.secret_key).as_bytes(), datestamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    // Token = host:port/?<canonical_query>&X-Amz-Signature=<sig>
    Ok(format!("{}/?{}&X-Amz-Signature={}", host_header, canonical_query, signature))
}
