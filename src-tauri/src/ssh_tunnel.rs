// SSH tunnel (local port forwarding) dùng russh.
// Tạo một listener TCP ở 127.0.0.1:<local_port>, mỗi kết nối tới sẽ được chuyển tiếp
// qua kênh direct-tcpip của phiên SSH tới (remote_host:remote_port) nhìn từ máy SSH.
// sqlx/rusqlite sẽ kết nối tới 127.0.0.1:<local_port> thay vì host thật.

use std::sync::Arc;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, load_secret_key, PrivateKey, PrivateKeyWithHashAlg};

// Handler cho client SSH. Công cụ DB nội bộ: chấp nhận mọi host key (không kiểm tra known_hosts).
pub struct TunnelHandler;

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

pub struct SshTunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
    // Giữ phiên SSH sống suốt vòng đời tunnel (drop Handle sẽ ngắt phiên)
    _session: Arc<Handle<TunnelHandler>>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Dừng vòng lặp accept; Arc<Handle> giảm ref -> phiên SSH đóng khi không còn tham chiếu
        self.accept_task.abort();
    }
}

/// Kết nối SSH và xác thực (password hoặc private key), trả về Handle đã sẵn sàng mở kênh.
/// Dùng chung cho tunnel (chuyển tiếp cổng DB) và terminal (PTY/shell xem log).
/// `config` chứa các trường ssh* từ frontend.
pub async fn connect_and_auth(config: &Value) -> Result<Handle<TunnelHandler>, String> {
    let ssh_host = config.get("sshHost").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("Thiếu địa chỉ máy chủ SSH")?;
    let ssh_port = config.get("sshPort").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
    let ssh_user = config.get("sshUser").and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("root");
    let auth_type = config.get("sshAuthType").and_then(|v| v.as_str()).unwrap_or("password");

    // 1. Kết nối SSH
    let ssh_config = Arc::new(client::Config::default());
    let mut handle = client::connect(ssh_config, (ssh_host, ssh_port), TunnelHandler)
        .await
        .map_err(|e| format!("Lỗi kết nối SSH tới {}:{}: {}", ssh_host, ssh_port, e))?;

    // 2. Xác thực (password hoặc private key)
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

impl SshTunnel {
    /// Mở tunnel. `config` chứa các trường ssh* (từ frontend); `remote_host`/`remote_port`
    /// là địa chỉ DB nhìn từ phía máy chủ SSH.
    pub async fn open(config: &Value, remote_host: &str, remote_port: u16) -> Result<SshTunnel, String> {
        // 1+2. Kết nối + xác thực (dùng chung với terminal)
        let handle = connect_and_auth(config).await?;

        let session = Arc::new(handle);

        // 3. Listener local trên cổng ngẫu nhiên
        let listener = TcpListener::bind(("127.0.0.1", 0u16))
            .await
            .map_err(|e| format!("Lỗi mở cổng chuyển tiếp local: {}", e))?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

        // 4. Vòng lặp accept: mỗi kết nối -> mở kênh direct-tcpip và bơm dữ liệu hai chiều
        let remote_host = remote_host.to_string();
        let session_for_task = session.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (mut inbound, _addr) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let sess = session_for_task.clone();
                let rhost = remote_host.clone();
                tokio::spawn(async move {
                    let channel = match sess
                        .channel_open_direct_tcpip(rhost, remote_port as u32, "127.0.0.1", local_port as u32)
                        .await
                    {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut stream).await;
                });
            }
        });

        Ok(SshTunnel {
            local_port,
            accept_task,
            _session: session,
        })
    }
}
