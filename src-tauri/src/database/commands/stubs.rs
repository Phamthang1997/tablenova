//! Các lệnh còn là stub. `ai_chat` có UI gọi thật; ba lệnh còn lại không còn caller nào ở
//! frontend (dump được dựng ở `src/utils/dumpBuilder.ts`) và là ứng viên xoá — xem đợt 9.

use serde_json::{json, Value};

#[tauri::command]
pub async fn ai_chat(message: String) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "reply": format!("AI: Bạn vừa gửi: '{}'. Tính năng Copilot đang hoạt động offline thông qua Tauri Rust backend.", message)
    }))
}

#[tauri::command]
pub async fn export_table(_state: tauri::State<'_, crate::AppState>, _name: String, _format: String) -> Result<Value, String> {
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub async fn import_dbeaver() -> Result<Value, String> {
    Ok(json!({ "success": true, "connections": [] }))
}

#[tauri::command]
pub async fn restore_backup_old(_state: tauri::State<'_, crate::AppState>, _file_path: String, _tables: Vec<String>) -> Result<Value, String> {
    Ok(json!({ "success": true }))
}
