//! Giới hạn thời gian cho MỘT câu lệnh do người dùng bấm chạy — hàng rào phía client.

use serde_json::{json, Value};

/// Giới hạn thời gian cho MỘT câu lệnh mà người dùng chạy, đọc từ config của kết nối
/// (`statementTimeoutSecs`, 0/absent = tắt).
///
/// Đây là hàng rào phía **client**: hết giờ thì future bị bỏ, sqlx đóng connection đó và UI được
/// trả lại ngay. Nó không phải `statement_timeout` của server, nên server có thể còn chạy nốt câu
/// lệnh cho tới khi phát hiện socket đã đóng. Đổi lại — và đây là lý do chọn cách này — nó không
/// để lại một chút state nào trong session: đặt `statement_timeout` ở mức pool thì mọi connection
/// lấy ra sau đó đều mang theo giới hạn ấy, kể cả những việc **dài theo thiết kế** như phục hồi
/// dump, sinh dữ liệu hay `CREATE INDEX`, và mỗi ngoại lệ lại là một `SET` phải nhớ hoàn nguyên
/// đúng lúc. Ở đây thì không cần ngoại lệ nào: giới hạn chỉ tồn tại trong bốn command mà người
/// dùng tự bấm chạy, còn các việc dài đi đường khác.
pub(crate) fn stmt_timeout(config: &Value) -> Option<std::time::Duration> {
    let secs = config.get("statementTimeoutSecs").and_then(|v| v.as_u64()).unwrap_or(0);
    (secs > 0).then(|| std::time::Duration::from_secs(secs))
}

/// Đổi giới hạn thời gian câu lệnh của một kết nối **ngay lúc đang chạy**.
///
/// Ghi vào chính config của server trong registry, và `stmt_timeout` đọc config đó ở mỗi lần một
/// command chạy — nên giá trị mới có hiệu lực từ câu lệnh kế tiếp, không cần kết nối lại. Đây là
/// phần thưởng của việc không đặt `statement_timeout` ở mức session: không có state nào ở server
/// phải đồng bộ lại.
///
/// Phạm vi là **server**, không phải từng kết nối: các database mở trên cùng một server dùng chung
/// `ServerHandle`, đúng bằng phạm vi mà frontend lưu (`connKey`).
#[tauri::command]
pub async fn set_statement_timeout(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    secs: u64,
) -> Result<Value, String> {
    let ctx = state.connections.acquire(&conn_id)?;
    ctx.server().set_config_field("statementTimeoutSecs", json!(secs));
    Ok(json!({ "success": true, "secs": secs }))
}

/// Thông báo hết giờ. Là literal tiếng Việt nên có bản sinh đôi ở `backendErrors.ts`.
pub(crate) fn timeout_msg(limit: std::time::Duration) -> String {
    format!("Câu lệnh đã chạy quá {} giây và bị dừng", limit.as_secs())
}

/// Chạy một tương lai dưới giới hạn của kết nối. `None` = chạy như trước, không thêm lớp nào.
pub(crate) async fn with_timeout<T, F>(limit: Option<std::time::Duration>, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    match limit {
        None => fut.await,
        Some(d) => match tokio::time::timeout(d, fut).await {
            Ok(r) => r,
            Err(_) => Err(timeout_msg(d)),
        },
    }
}
