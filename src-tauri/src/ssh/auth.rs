//! SSH connect and AUTHENTICATE — a single path, shared by the port-forwarding tunnel
//! (`ssh/tunnel.rs`) and the terminal panel (`terminal/ssh.rs`).

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, load_secret_key, PrivateKey, PrivateKeyWithHashAlg};
use serde_json::Value;

// Handler for the SSH client. Internal DB tool: every host key is accepted (no known_hosts check).
pub struct SshHandler;

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

/// Connect over SSH and authenticate (password or private key), returning a Handle ready to open channels.
/// Shared by the tunnel (forwarding the DB port) and the terminal (PTY/shell for reading logs).
/// `config` carries the ssh* fields from the frontend.
pub async fn connect_and_auth(config: &Value) -> Result<Handle<SshHandler>, String> {
    let ssh_host = config.get("sshHost").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("Thiếu địa chỉ máy chủ SSH")?;
    let ssh_port = config.get("sshPort").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
    let ssh_user = config.get("sshUser").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("root");
    let auth_type = config.get("sshAuthType").and_then(|v| v.as_str()).unwrap_or("password");

    // 1. SSH connection
    let ssh_config = Arc::new(client::Config::default());
    let mut handle = client::connect(ssh_config, (ssh_host, ssh_port), SshHandler)
        .await
        .map_err(|e| format!("Lỗi kết nối SSH tới {}:{}: {}", ssh_host, ssh_port, e))?;

    // 2. Authentication (password or private key)
    let auth_result = match auth_type {
        "key" => {
            let passphrase = config.get("sshPassphrase").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let key: PrivateKey = if let Some(content) = config.get("sshKeyContent").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                decode_secret_key(content, passphrase)
                    .map_err(|e| format!("Lỗi đọc nội dung private key: {}", e))?
            } else if let Some(path) = config.get("sshKeyPath").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                load_secret_key(path, passphrase)
                    .map_err(|e| format!("Lỗi đọc file private key '{}': {}", path, e))?
            } else {
                return Err("Thiếu private key cho xác thực SSH bằng khóa".to_string());
            };
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle.authenticate_publickey(ssh_user, key_with_alg)
                .await
                .map_err(|e| format!("Lỗi xác thực SSH bằng khóa: {}", e))?
        }
        _ => {
            let password = config.get("sshPassword").and_then(|v| v.as_str()).unwrap_or("");
            handle.authenticate_password(ssh_user, password)
                .await
                .map_err(|e| format!("Lỗi xác thực SSH bằng mật khẩu: {}", e))?
        }
    };

    if !auth_result.success() {
        return Err("Xác thực SSH thất bại: sai tài khoản, mật khẩu hoặc khóa.".to_string());
    }
    Ok(handle)
}
