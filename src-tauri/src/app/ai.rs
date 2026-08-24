//! `ai_chat` — điểm cuối của bảng AI Copilot (`AiAssistant.tsx`).
//!
//! Vẫn là STUB: nó echo lại prompt. Nằm ở `app/` chứ không ở `database/commands/` vì nó không
//! chạm tới database nào — nó chỉ tình cờ được khai báo cạnh các lệnh SQL từ thuở một tệp.

use serde_json::{json, Value};

#[tauri::command]
pub async fn ai_chat(message: String) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "reply": format!("AI: Bạn vừa gửi: '{}'. Tính năng Copilot đang hoạt động offline thông qua Tauri Rust backend.", message)
    }))
}
