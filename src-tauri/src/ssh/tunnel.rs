//! SSH tunnel (local port forwarding).
//!
//! Opens a TCP listener on `127.0.0.1:<random port>`; every incoming connection is forwarded over a
//! `direct-tcpip` channel of the SSH session to `(remote_host, remote_port)` AS SEEN FROM the SSH
//! server. sqlx/redis then connect to that local port instead of the real host.
//!
//! **Dropping the handle closes the port**, so whoever owns the connection must own the tunnel:
//! `ServerHandle.ssh_tunnel`, for SQL as well as Redis.

use std::sync::Arc;

use russh::client::Handle;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::auth::{connect_and_auth, SshHandler};

pub struct SshTunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
    // Keep the SSH session alive for the tunnel's whole lifetime (dropping the Handle tears the session down)
    _session: Arc<Handle<SshHandler>>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Stop the accept loop; the Arc<Handle> refcount drops -> the SSH session closes once nothing references it
        self.accept_task.abort();
    }
}

impl SshTunnel {
    /// Open the tunnel. `config` carries the ssh* fields (from the frontend); `remote_host`/`remote_port`
    /// is the DB address as seen from the SSH server.
    pub async fn open(config: &Value, remote_host: &str, remote_port: u16) -> Result<SshTunnel, String> {
        // 1+2. Connect + authenticate (shared with the terminal)
        let handle = connect_and_auth(config).await?;

        let session = Arc::new(handle);

        // 3. Local listener on a random port
        let listener = TcpListener::bind(("127.0.0.1", 0u16))
            .await
            .map_err(|e| format!("Lỗi mở cổng chuyển tiếp local: {}", e))?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

        // 4. Accept loop: each connection -> open a direct-tcpip channel and pump data both ways
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
