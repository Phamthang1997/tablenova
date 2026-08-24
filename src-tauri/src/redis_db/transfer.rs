//! Xuất / nhập keyspace theo prefix, bằng DUMP/RESTORE.
//!
//! Dùng payload gốc của Redis chứ không phải một bộ serializer đọc được: hai đường đọc sẵn có
//! đều làm mất dữ liệu (`lossy_text`, cắt chuỗi ở `STRING_PREVIEW_MAX`), và mất dữ liệu âm thầm
//! là kiểu hỏng tệ nhất cho một tính năng sao lưu. Đổi lại: payload mang footer phiên bản RDB,
//! nên chỉ phục hồi được vào Redis cùng phiên bản HOẶC mới hơn.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::redis_db::conn::{ensure_writable, take_conn};
use crate::redis_db::value::{as_i64, as_text};

// ---- Xuất / nhập keyspace theo prefix (DUMP / RESTORE) ----
//
// Vì sao là DUMP/RESTORE chứ không phải một bộ tuần tự JSON đọc được: hai đường đọc sẵn có đều
// KHÔNG trung thực. `fetch_elements` đưa mọi phần tử qua `lossy_text` (byte không phải UTF-8 thành
// U+FFFD, xem cờ `binary` mà UI dùng để chặn sửa), còn `redis_get_key` cắt string ở
// `STRING_PREVIEW_MAX`. Một bản xuất dựng trên hai thứ đó sẽ làm hỏng dữ liệu mà không báo gì —
// đúng loại lỗi tệ nhất cho một tính năng backup. DUMP là byte thô do Redis tự sinh: đúng từng
// byte, và bao được cả những kiểu app chưa có trình xem (ReJSON, TimeSeries, vector set).
//
// Đánh đổi phải nói với người dùng: payload DUMP mang footer phiên bản RDB, nên nhập vào một Redis
// **cũ hơn** sẽ lỗi "DUMP payload version or checksum are wrong". Cùng phiên bản hoặc mới hơn thì
// chạy. Dialog phía frontend ghi rõ điều này.

/// Trần số key mỗi lượt. Một lượt DUMP trả về toàn bộ giá trị qua một message IPC, nên không có
/// trần thì một batch do frontend tính sai thành vài trăm MB trong một lần gọi.
pub(crate) const TRANSFER_BATCH_MAX: usize = 5_000;

/// DUMP + PTTL + TYPE cho một lô key. Payload đi ra dạng base64 (không phải mảng số như `bytes` của
/// `redis_get_key`): cùng nội dung, IPC nhỏ hơn ~3 lần, và ghi thẳng vào tệp NDJSON được.
#[tauri::command]
pub async fn redis_dump_keys(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    if keys.is_empty() {
        return Ok(json!({ "success": true, "entries": [], "missing": [] }));
    }
    if keys.len() > TRANSFER_BATCH_MAX {
        return Err(format!("Mỗi lượt chỉ nhận tối đa {} key", TRANSFER_BATCH_MAX));
    }
    let mut c = take_conn(&state, &conn_id)?;

    // Đọc thì pipeline được: DUMP một key không còn tồn tại trả Nil chứ không phải lỗi, nên cả lô
    // không bao giờ bị một key làm gãy. Đường ghi (`redis_restore_keys`) không có tính chất đó.
    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("DUMP").arg(k);
        pipe.cmd("PTTL").arg(k);
        pipe.cmd("TYPE").arg(k);
    }
    let raw: Vec<redis::Value> = pipe.query_async(&mut c).await.map_err(|e| e.to_string())?;

    let mut entries = Vec::with_capacity(keys.len());
    let mut missing: Vec<String> = Vec::new();
    for (i, k) in keys.iter().enumerate() {
        // Key hết hạn hoặc bị xoá trong khoảng giữa SCAN và DUMP -> Nil. Đó không phải lỗi, nhưng
        // cũng không được im lặng: nó vào `missing` để bản xuất nói đúng số key nó thật sự chứa.
        let payload = match raw.get(i * 3) {
            Some(redis::Value::BulkString(b)) => Some(b.clone()),
            _ => None,
        };
        let Some(bytes) = payload else {
            missing.push(k.clone());
            continue;
        };
        entries.push(json!({
            "key": k,
            "type": raw.get(i * 3 + 2).map(as_text).unwrap_or_default(),
            // PTTL: -1 = không có TTL, -2 = không có key. Giữ nguyên milli giây, đừng làm tròn về
            // giây như `TTL`: một key còn 500ms mà lưu thành 0 giây là mất TTL.
            "ttlMs": raw.get(i * 3 + 1).map(as_i64).unwrap_or(-1),
            "payload": B64.encode(&bytes),
        }));
    }

    Ok(json!({ "success": true, "entries": entries, "missing": missing }))
}

/// RESTORE một lô bản ghi đã xuất. `replace` = ghi đè key đã có (RESTORE … REPLACE).
///
/// **Từng key một, cố ý không pipeline.** Một pipeline chỉ báo về lỗi ĐẦU TIÊN, mà lô này không
/// idempotent khi `replace = false`: các key phía sau vẫn được server thực thi, nên chạy lại lô để
/// quy lỗi cho đúng key sẽ nhận BUSYKEY cho chính những key mình vừa tạo và báo cáo chúng là "đã
/// tồn tại, bỏ qua". Một bản nhập nói sai nó đã ghi gì còn tệ hơn một bản nhập chậm; frontend chia
/// lô nhỏ nên thanh tiến độ vẫn chạy đều.
#[tauri::command]
pub async fn redis_restore_keys(
    state: tauri::State<'_, crate::AppState>,
    conn_id: String,
    entries: Vec<Value>,
    replace: bool,
) -> Result<Value, String> {
    ensure_writable(&state, &conn_id)?;
    if entries.len() > TRANSFER_BATCH_MAX {
        return Err(format!("Mỗi lượt chỉ nhận tối đa {} key", TRANSFER_BATCH_MAX));
    }
    let mut c = take_conn(&state, &conn_id)?;
    let mut restored = 0usize;
    let mut skipped = 0usize;
    let mut failed: Vec<Value> = Vec::new();

    for e in &entries {
        let key = e.get("key").and_then(|v| v.as_str()).unwrap_or_default();
        let b64 = e.get("payload").and_then(|v| v.as_str()).unwrap_or_default();
        // Bản ghi khuyết đã bị `redisTransfer.ts` loại từ lúc đọc tệp (nó có `t()` để nói bằng
        // ngôn ngữ đang dùng, còn ở đây thì không) — nhánh này chỉ là chốt cuối.
        if key.is_empty() || b64.is_empty() {
            failed.push(json!({ "key": key, "error": "missing key or payload" }));
            continue;
        }
        let bytes = match B64.decode(b64) {
            Ok(b) => b,
            Err(_) => {
                failed.push(json!({ "key": key, "error": "invalid base64 payload" }));
                continue;
            }
        };
        // RESTORE nhận TTL bằng milli giây, 0 = không hết hạn. PTTL trả -1 cho key không có TTL và
        // -2 cho key không tồn tại; cả hai đều phải thành 0, không phải một số âm (server từ chối).
        let ttl_ms = e.get("ttlMs").and_then(|v| v.as_i64()).unwrap_or(-1);
        let mut cmd = redis::cmd("RESTORE");
        cmd.arg(key).arg(if ttl_ms > 0 { ttl_ms } else { 0 }).arg(bytes);
        if replace {
            cmd.arg("REPLACE");
        }
        match cmd.query_async::<redis::Value>(&mut c).await {
            Ok(_) => restored += 1,
            Err(err) => {
                // BUSYKEY: key đã có và người dùng không chọn ghi đè. Đó là "bỏ qua" theo đúng ý
                // họ, không phải lỗi — gộp vào `failed` thì một bản nhập hoàn toàn bình thường
                // hiện lên như hàng nghìn lỗi.
                let msg = err.to_string();
                if err.code() == Some("BUSYKEY") || msg.contains("BUSYKEY") {
                    skipped += 1;
                } else {
                    failed.push(json!({ "key": key, "error": msg }));
                }
            }
        }
    }

    Ok(json!({
        "success": true,
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    }))
}
