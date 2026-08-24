//! SSH tunnel (local port forwarding).
//!
//! Mở listener TCP ở `127.0.0.1:<cổng ngẫu nhiên>`; mỗi kết nối tới được chuyển tiếp qua kênh
//! `direct-tcpip` của phiên SSH tới `(remote_host, remote_port)` NHÌN TỪ máy chủ SSH. sqlx/redis
//! kết nối tới cổng local đó thay vì host thật.
//!
//! **Thả handle là đóng cổng**, nên ai sở hữu kết nối cũng phải sở hữu tunnel:
//! `ServerHandle.ssh_tunnel` cho SQL lẫn Redis.

use std::sync::Arc;

use russh::client::Handle;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::auth::{connect_and_auth, SshHandler};

pub struct SshTunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
    // Giữ phiên SSH sống suốt vòng đời tunnel (drop Handle sẽ ngắt phiên)
    _session: Arc<Handle<SshHandler>>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Dừng vòng lặp accept; Arc<Handle> giảm ref -> phiên SSH đóng khi không còn tham chiếu
        self.accept_task.abort();
    }
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
