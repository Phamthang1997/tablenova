// SSH Terminal: mở PTY + shell trên máy chủ SSH để xem log / chạy lệnh (tail -f, journalctl...).
// Tái dùng connect_and_auth + TunnelHandler từ ssh_tunnel.rs (một đường xác thực duy nhất).
//
// Output server -> frontend đi qua tauri::ipc::Channel (đồng bộ pattern với streaming SQL).
// Input, resize, close từ frontend đi qua các command riêng, chuyển vào task quản lý phiên
// bằng một mpsc channel — nhờ đó task độc quyền sở hữu russh Channel (tránh chia sẻ &mut).
//
// Message đẩy về frontend (đều có "type"):
//   { type:"data",   bytes:[...] }   -> dữ liệu output (mảng byte, xterm tự giải mã UTF-8)
//   { type:"exit",   code }          -> shell thoát
//   { type:"closed" }                -> phiên đã đóng

use std::collections::HashMap;
use std::sync::Mutex;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tauri::ipc::Channel;
use russh::ChannelMsg;
use crate::ssh_tunnel::connect_and_auth;

// Lệnh gửi từ command frontend vào task quản lý một phiên terminal.
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
    state: tauri::State<'_, crate::AppState>,
    profile_config: Value,
    session_id: String,
    cols: u32,
    rows: u32,
    channel: Channel<Value>,
) -> Result<Value, String> {
    // Nếu session_id đã tồn tại (mở lại), đóng phiên cũ trước
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

    // Task quản lý phiên: sở hữu handle (giữ session SSH sống) + russh channel.
    let task = tokio::spawn(async move {
        let _handle = handle; // giữ phiên SSH sống suốt vòng đời task
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
}

#[tauri::command]
pub async fn send_ssh_input(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    let map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.get(&session_id) {
        sess.tx
            .send(TermCmd::Input(data.into_bytes()))
            .map_err(|_| "Phiên terminal đã đóng".to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn resize_ssh_terminal(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<Value, String> {
    let map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.get(&session_id) {
        let _ = sess.tx.send(TermCmd::Resize(cols, rows));
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn close_ssh_terminal(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<Value, String> {
    let mut map = state.ssh_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.remove(&session_id) {
        sess.shutdown();
    }
    Ok(json!({ "success": true }))
}

// Kiểu state giữ trong AppState.
pub type SshTerminalMap = Mutex<HashMap<String, TerminalSession>>;
