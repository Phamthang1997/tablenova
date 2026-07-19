// Local Terminal: spawn shell trên chính máy đang chạy app (không qua SSH) để xem log/chạy lệnh cục bộ.
// Dùng portable-pty (ConPTY trên Windows, PTY thật trên *nix). Cùng giao thức message với ssh_terminal
// nên frontend dùng chung một component.
//
// Message đẩy về frontend (đều có "type"):
//   { type:"data", bytes:[...] }  -> output shell (mảng byte, xterm tự giải mã UTF-8)
//   { type:"closed" }             -> shell/pty đã đóng

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use serde_json::{Value, json};
use tauri::ipc::Channel;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};

pub struct LocalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl LocalSession {
    fn shutdown(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }
}

// Shell mặc định theo hệ điều hành.
fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command]
pub async fn open_local_terminal(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<Value>,
) -> Result<Value, String> {
    // Đóng phiên cũ trùng id nếu có
    {
        let mut map = state.local_terminals.lock().map_err(|e| e.to_string())?;
        if let Some(old) = map.remove(&session_id) {
            old.shutdown();
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Lỗi mở PTY cục bộ: {}", e))?;

    let cmd = CommandBuilder::new(default_shell());
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Lỗi mở shell cục bộ: {}", e))?;
    // Bỏ slave để read nhận EOF khi shell thoát
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Vòng lặp đọc chạy trên thread riêng (portable-pty đọc kiểu blocking).
    let out = channel.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = out.send(json!({ "type": "closed" }));
                    break;
                }
                Ok(n) => {
                    let _ = out.send(json!({ "type": "data", "bytes": buf[..n].to_vec() }));
                }
                Err(_) => {
                    let _ = out.send(json!({ "type": "closed" }));
                    break;
                }
            }
        }
    });

    {
        let mut map = state.local_terminals.lock().map_err(|e| e.to_string())?;
        map.insert(
            session_id,
            LocalSession {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                child: Mutex::new(child),
            },
        );
    }

    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn send_local_input(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    let map = state.local_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.get(&session_id) {
        if let Ok(mut w) = sess.writer.lock() {
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            let _ = w.flush();
        }
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn resize_local_terminal(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    let map = state.local_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.get(&session_id) {
        if let Ok(master) = sess.master.lock() {
            let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn close_local_terminal(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<Value, String> {
    let mut map = state.local_terminals.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.remove(&session_id) {
        sess.shutdown();
    }
    Ok(json!({ "success": true }))
}

// Kiểu state giữ trong AppState.
pub type LocalTerminalMap = Mutex<HashMap<String, LocalSession>>;
