//! `ai_chat` — the endpoint behind the AI Copilot panel (`AiAssistant.tsx`).
//!
//! Still a STUB: it echoes the prompt back. It lives in `app/` rather than `database/commands/`
//! because it touches no database — it only happened to be declared next to the SQL commands back when everything was one file.

use serde_json::{json, Value};

#[tauri::command]
pub async fn ai_chat(message: String) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "reply": format!("AI: Bạn vừa gửi: '{}'. Tính năng Copilot đang hoạt động offline thông qua Tauri Rust backend.", message)
    }))
}
