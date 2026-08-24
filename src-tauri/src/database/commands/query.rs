//! Chạy SQL do người dùng gõ: một câu, nhiều câu, hoặc stream kết quả về theo lô.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::database::{
    execute_raw_sql_generic, run_bound_query, split_sql_statements, stmt_timeout,
    stream_sql_statements, timeout_msg, with_timeout,
};

#[tauri::command]
pub async fn execute_query(state: tauri::State<'_, crate::AppState>, conn_id: String, sql: String, params: Option<Vec<Value>>) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    // Có tham số -> bind ở tầng driver (parameterized, một câu lệnh). Không có -> giữ nguyên hành vi cũ.
    let params = params.unwrap_or_default();
    let results = if params.is_empty() {
        with_timeout(limit, execute_raw_sql_generic(&conn_type, sql.clone())).await?
    } else {
        with_timeout(limit, run_bound_query(&conn_type, sql.clone(), &params)).await?
    };
    Ok(json!({ "success": true, "results": results }))
}

// Chạy nhiều câu lệnh SQL, mỗi câu trả về một bộ kết quả riêng (phục vụ nhiều result tab ở SqlEditor)
#[tauri::command]
pub async fn execute_multi_query(state: tauri::State<'_, crate::AppState>, conn_id: String, sql: String) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    let statements = split_sql_statements(&sql);
    let mut results: Vec<Value> = Vec::new();

    for stmt in statements {
        // Giới hạn tính cho TỪNG câu lệnh, không cho cả lô: "Run all" trên 50 câu lệnh ngắn không
        // phải là một câu lệnh chạy lâu, và cộng dồn thời gian của chúng lại sẽ giết đúng những lô
        // hoàn toàn bình thường.
        match with_timeout(limit, execute_raw_sql_generic(&conn_type, stmt.clone())).await {
            Ok(mut res) => {
                if let Some(first) = res.drain(..).next() {
                    let mut obj = first.as_object().cloned().unwrap_or_default();
                    obj.insert("query".to_string(), json!(stmt));
                    results.push(Value::Object(obj));
                }
            }
            Err(e) => {
                // Trả về các kết quả đã chạy được + thông báo lỗi ở câu lệnh gặp sự cố
                return Ok(json!({
                    "success": false,
                    "results": results,
                    "message": format!("Lỗi tại câu lệnh:\n{}\n\nChi tiết: {}", stmt, e)
                }));
            }
        }
    }

    Ok(json!({ "success": true, "results": results }))
}

// ---- Streaming SQL cho SQL Editor ----
// Chạy (nhiều) câu lệnh và ĐẨY kết quả theo từng batch qua Channel về frontend thay vì gom hết rồi trả một lần.
// Nhờ đó dòng đầu hiện gần như tức thì, UI không đơ, và có thể DỪNG giữa chừng qua cancel_query.
// Giao thức message gửi qua channel (đều có trường "type"):
//   { type:"columns", stmtIndex, query, columns:[...] }   -> bắt đầu 1 câu lệnh
//   { type:"rows",    stmtIndex, rows:[{...}, ...] }        -> 1 batch dữ liệu
//   { type:"done",    stmtCount, cancelled }                -> tất cả câu lệnh xong
//   { type:"error",   stmtIndex, message }                  -> lỗi, dừng stream
#[tauri::command]
pub async fn execute_query_stream(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    sql: String,
    query_id: String,
    channel: Channel<Value>,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    let (conn_type, limit) = {
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), stmt_timeout(&ctx.server().config()))
    };

    // Đăng ký cờ hủy để cancel_query có thể dừng vòng lặp stream đang chạy
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(query_id.clone(), cancel_flag.clone());
    }

    // Hết giờ thì bật đúng cái cờ mà `cancel_query` bật, nên vòng stream dừng bằng cùng một đường
    // — không thêm nhánh dừng thứ hai vào chỗ đang đẩy dữ liệu. `timed_out` để phân biệt "hết giờ"
    // với "người dùng bấm Stop": hai thứ đó phải hiện hai thông báo khác nhau.
    //
    // Giới hạn tính cho cả câu lệnh, kể cả phần đang đẩy dòng về — giống hệt `statement_timeout`
    // của server, vốn cũng không dừng đếm khi bắt đầu có dòng đầu tiên.
    let timed_out = Arc::new(AtomicBool::new(false));
    let timer = limit.map(|d| {
        let flag = cancel_flag.clone();
        let fired = timed_out.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            fired.store(true, Ordering::Relaxed);
            flag.store(true, Ordering::Relaxed);
        })
    });

    let params = params.unwrap_or_default();
    let outcome = stream_sql_statements(&conn_type, &sql, &params, &channel, &cancel_flag).await;
    // Xong sớm thì hẹn giờ không còn việc gì; để nó chạy tiếp là bật cờ hủy của một lượt chạy sau.
    if let Some(t) = timer {
        t.abort();
    }

    // Luôn gỡ cờ khi kết thúc (dù thành công hay lỗi)
    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&query_id);
    }

    match outcome {
        Ok((stmt_count, cancelled)) => {
            // Hết giờ đi ra bằng khung `error`, không phải `done{cancelled}`: người dùng không bấm
            // Stop, và nói với họ là họ đã bấm thì lần sau họ sẽ đi tìm một cái nút không tồn tại.
            if let (true, Some(d)) = (timed_out.load(Ordering::Relaxed), limit) {
                let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_count, "message": timeout_msg(d) }));
                return Ok(json!({ "success": false }));
            }
            let _ = channel.send(json!({ "type": "done", "stmtCount": stmt_count, "cancelled": cancelled }));
            Ok(json!({ "success": true }))
        }
        Err((stmt_index, msg)) => {
            let _ = channel.send(json!({ "type": "error", "stmtIndex": stmt_index, "message": msg }));
            Ok(json!({ "success": false }))
        }
    }
}

// Đánh dấu một truy vấn đang stream cần dừng. Không lỗi nếu query_id không còn tồn tại.
#[tauri::command]
pub async fn cancel_query(state: tauri::State<'_, crate::AppState>, query_id: String) -> Result<Value, String> {
    let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&query_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "success": true }))
}
