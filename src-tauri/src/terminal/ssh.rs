// SSH Terminal: opens a PTY + shell on the SSH server for reading logs / running commands (tail -f, journalctl...).
// Reuses connect_and_auth from ssh/auth.rs (one authentication path for both the tunnel and the terminal).
//
// Output travels server -> frontend over a tauri::ipc::Channel (the same pattern as SQL streaming).
// Input, resize and close come from the frontend as separate commands and are passed into the session
// task over an mpsc channel — that way the task exclusively owns the russh Channel (no shared &mut).
//
// Messages pushed to the frontend (all carry a "type"):
//   { type:"data",   bytes:[...] }   -> output data (a byte array; xterm decodes the UTF-8 itself)
//   { type:"exit",   code }          -> the shell exited
//   { type:"closed" }                -> the session has closed

use crate::ssh::connect_and_auth;
use russh::ChannelMsg;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

// Commands sent from a frontend command into the task that manages one terminal session.
enum TermCmd {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct TerminalSession {
    tx: mpsc::UnboundedSender<TermCmd>,
    task: JoinHandle<()>,
}

impl TerminalSession {
    fn shutdown(self) {
        let _ = self.tx.send(TermCmd::Close);
        self.task.abort();
    }
}

#[tauri::command]
pub async fn open_ssh_terminal(
    profile_config: Value,
    session_id: String,
    cols: u32,
    rows: u32,
    channel: Channel<Value>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    // If session_id already exists (reopened), close the old session first
    {
        let mut map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
        if let Some(old) = map.remove(&session_id) {
            old.shutdown();
        }
    }

    let handle = connect_and_auth(&profile_config).await?;

    let mut ch = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Lỗi mở kênh SSH: {}", e))?;
    ch.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("Lỗi yêu cầu PTY: {}", e))?;
    ch.request_shell(true)
        .await
        .map_err(|e| format!("Lỗi mở shell: {}", e))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<TermCmd>();
    let out = channel.clone();

    // The session task: owns the handle (keeping the SSH session alive) + the russh channel.
    let task = tokio::spawn(async move {
        let _handle = handle; // keep the SSH session alive for the task's whole lifetime
        loop {
            tokio::select! {
                msg = ch.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let _ = out.send(json!({ "type": "data", "bytes": data.to_vec() }));
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = out.send(json!({ "type": "data", "bytes": data.to_vec() }));
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            let _ = out.send(json!({ "type": "exit", "code": exit_status }));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            let _ = out.send(json!({ "type": "closed" }));
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(TermCmd::Input(d)) => { let _ = ch.data(&d[..]).await; }
                        Some(TermCmd::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                        Some(TermCmd::Close) | None => {
                            let _ = ch.eof().await;
                            let _ = out.send(json!({ "type": "closed" }));
                            break;
                        }
                    }
                }
            }
        }
    });

    {
        let mut map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
        map.insert(session_id, TerminalSession { tx, task });
    }

    Ok(json!({ "success": true }))
}).await
}

#[tauri::command]
pub async fn send_ssh_input(session_id: String, data: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
        if let Some(sess) = map.get(&session_id) {
            sess.tx
                .send(TermCmd::Input(data.into_bytes()))
                .map_err(|_| "Phiên terminal đã đóng".to_string())?;
        }
        Ok(json!({ "success": true }))
    })
    .await
}

#[tauri::command]
pub async fn resize_ssh_terminal(
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
        if let Some(sess) = map.get(&session_id) {
            let _ = sess.tx.send(TermCmd::Resize(cols, rows));
        }
        Ok(json!({ "success": true }))
    })
    .await
}

#[tauri::command]
pub async fn close_ssh_terminal(session_id: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let mut map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
        if let Some(sess) = map.remove(&session_id) {
            sess.shutdown();
        }
        Ok(json!({ "success": true }))
    })
    .await
}

// The state type held in AppState.
pub type SshTerminalMap = Mutex<HashMap<String, TerminalSession>>;
