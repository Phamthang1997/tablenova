//! Các lệnh chỉ trả về `{ success: true }` mà không làm gì.
//!
//! - `ai_chat` — UI (`AiAssistant.tsx`) gọi thật; nó echo lại prompt cho tới khi được nối vào model.
//! - `export_table` — còn một wrapper `dbHelper.exportTable`, nhưng KHÔNG có ai gọi wrapper đó.
//! - `import_dbeaver` — không còn dấu vết nào trong `src/`.
//! - `restore_backup_old` — chết hẳn: không có trong `src/`, và cũng KHÔNG có trong
//!   `app/handlers.rs`, tức frontend không gọi tới được kể cả khi muốn.
//!
//! Ba lệnh sau là ứng viên xoá (kèm wrapper và mục trong `safeMode.ts`), nhưng xoá là một quyết
//! định riêng chứ không phải việc của đợt tách tệp.

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
