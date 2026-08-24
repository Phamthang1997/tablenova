//! `get_table_data` — đọc một trang dữ liệu của bảng cho lưới.

use serde_json::{json, Value};

use crate::database::{
    execute_raw_sql_generic, qualified, sql_str, stmt_timeout, uniquify_columns, with_timeout,
    DbKind,
};

use super::catalog::{estimate_row_count, exact_row_count};

/// A cursor value, exactly as the database spelled it.
///
/// Only a number or a string can be a cursor. Anything else (NULL, a BLOB arriving as a byte array,
/// a composite) has no usable `>` boundary here, and returning `None` is what makes the frontend
/// fall back to `OFFSET` for that view instead of paging on a value it cannot compare.
fn scalar_to_cursor(v: &Value) -> Option<String> {
    match v {
        // `Number::to_string` keeps every digit of an i64 — the whole reason the cursor is minted
        // here and not read off the row on the frontend (see `next_cursor`).
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// One page of a table, plus how many rows there are in total.
///
/// Paging is by cursor when the frontend names a `seek_column` (a single-column primary key) and
/// hands back the `nextCursor` of the previous page, and by `OFFSET` otherwise — a filter or a sort
/// on another column is not a reason to fall back, but a table without a single-column key is.
///
/// `count_mode` is `"skip"` | `"auto"` | `"exact"`, and **anything else — including absent — means
/// `"exact"`**. That default is load-bearing, not a formality: the export paths (`dumpBuilder`,
/// `ExportTableDialog`) page until `rows.length >= totalCount`, so an *under*estimate there would
/// end the loop early and write a truncated dump with no error. Only the grid's status line, which
/// can afford a `~`, opts into the other two modes.
#[tauri::command]
pub async fn get_table_data(
    state: tauri::State<'_, crate::AppState>, conn_id: String,
    name: String,
    page: u32,
    limit: u32,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    filter: Option<String>,
    count_mode: Option<String>,
    seek_column: Option<String>,
    cursor: Option<String>,
) -> Result<Value, String> {
    let (conn_type, schema, limit_dur) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.raw_schema().map(str::to_string), stmt_timeout(&ctx.server().config()))
    };

    let is_mysql = matches!(&conn_type.kind, DbKind::Mysql(_));
    // Ký tự trích dẫn định danh theo dialect: MySQL dùng backtick, còn lại dùng dấu nháy kép
    let q = if is_mysql { '`' } else { '"' };
    // The grid reads through this command, so it has to name the same schema the sidebar listed
    // from — otherwise a table outside `public` lists fine and then fails to open.
    let table_ref = qualified(&conn_type, &schema, &name);

    // WHERE: frontend đã dựng mệnh đề lọc đúng dialect, chỉ ghép thô vào sau WHERE
    let filter_body = filter.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let where_clause = match filter_body {
        Some(f) => format!(" WHERE {}", f),
        None => String::new(),
    };

    // loại bỏ ký tự trích dẫn có sẵn để tránh phá cú pháp, rồi tự bọc lại
    let safe_ident = |s: &str| s.replace('`', "").replace('"', "");
    let seek_col = seek_column
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| safe_ident(s));

    // ORDER BY: cột người dùng chọn, và nếu không có thì cột seek (khoá chính một cột) mà frontend
    // đưa xuống. Keyset pagination chỉ đúng khi thứ tự là xác định, nên chế độ "chưa sort" cũng
    // phải nhận `ORDER BY <pk>` — việc đó vá luôn một lỗi âm thầm có từ trước: `LIMIT/OFFSET` mà
    // không `ORDER BY` thì server được phép trả cùng một dòng ở hai trang khác nhau.
    let sort_col = sort_by
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| safe_ident(s))
        .or_else(|| seek_col.clone());
    let desc = matches!(sort_dir.as_deref(), Some(d) if d.eq_ignore_ascii_case("desc"));
    let dir = if desc { "DESC" } else { "ASC" };
    let order_clause = match &sort_col {
        Some(col) => format!(" ORDER BY {q}{col}{q} {dir}"),
        None => String::new(),
    };

    // Keyset ("seek") pagination. Con trỏ chỉ có nghĩa với đúng cột nó được lấy ra, nên nó chỉ được
    // dùng khi thứ tự đang áp dụng CHÍNH LÀ cột seek: sort theo cột khác thì frontend đã thôi gửi
    // `seek_column`, và điều kiện này là lớp chặn thứ hai.
    let seek_active = seek_col.as_ref().filter(|c| sort_col.as_deref() == Some(c.as_str()));
    let seek_clause = match (seek_active, cursor.as_ref().map(|s| s.as_str()).filter(|s| !s.is_empty())) {
        (Some(col), Some(v)) => {
            let op = if desc { "<" } else { ">" };
            let lit = sql_str(v);
            // Luôn là literal chuỗi, kể cả với khoá số: kiểu của CỘT quyết định phép so sánh, nên
            // `id > '500'` vẫn so theo số. Tự suy kiểu từ giá trị thì một khoá `varchar` chứa số
            // sẽ được so như số trong khi `ORDER BY` so như chuỗi — hai thứ tự khác nhau, và trang
            // sau lặng lẽ bỏ sót dòng.
            Some(format!("{q}{col}{q} {op} '{lit}'"))
        }
        _ => None,
    };

    // WHERE của trang = filter + con trỏ. Filter PHẢI được bọc ngoặc: `a = 1 OR b = 2` nối thẳng
    // bằng AND sẽ thành `a = 1 OR (b = 2 AND pk > …)`, tức là lọc khác hẳn ý người dùng.
    let row_where = match (filter_body, &seek_clause) {
        (Some(f), Some(seek)) => format!(" WHERE ({f}) AND {seek}"),
        (Some(f), None) => format!(" WHERE {f}"),
        (None, Some(seek)) => format!(" WHERE {seek}"),
        (None, None) => String::new(),
    };

    // Con trỏ THAY THẾ offset, không cộng dồn: đó là toàn bộ điểm của pha này — trang sâu không
    // còn phải đọc rồi bỏ đi n dòng đầu.
    let offset = if seek_clause.is_some() { 0 } else { (page.saturating_sub(1)) * limit };
    // Read ONE row more than the page needs: whether a next page exists is then a fact about the
    // rows, not a division of a row count that may be an estimate — and it costs nothing.
    let fetch_limit = limit.saturating_add(1);
    let sql = format!(
        "SELECT * FROM {table_ref}{row_where}{order_clause} LIMIT {fetch_limit} OFFSET {offset}",
        table_ref = table_ref, row_where = row_where, order_clause = order_clause, fetch_limit = fetch_limit, offset = offset
    );
    // Số đếm là của cả tập đã lọc, nên nó dùng `where_clause` (không có con trỏ) — nếu không thì
    // mỗi trang lại báo một tổng nhỏ dần.
    let count_sql = format!(
        "SELECT COUNT(*) FROM {table_ref}{where_clause}",
        table_ref = table_ref, where_clause = where_clause
    );

    let mut rows_json = Vec::new();
    let mut columns = Vec::new();

    match &conn_type.kind {
        DbKind::Sqlite(conn_arc) => {
            let conn = conn_arc.lock().map_err(|e| e.to_string())?;

            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let col_count = stmt.column_count();
            for i in 0..col_count {
                columns.push(stmt.column_name(i).map_err(|e| e.to_string())?.to_string());
            }
            uniquify_columns(&mut columns);

            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut map = serde_json::Map::new();
                for i in 0..col_count {
                    let col_name = columns[i].clone();
                    let val: Value = match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                        Ok(rusqlite::types::ValueRef::Real(r)) => json!(r),
                        Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                        Ok(rusqlite::types::ValueRef::Blob(b)) => json!(b),
                        _ => Value::Null,
                    };
                    map.insert(col_name, val);
                }
                rows_json.push(Value::Object(map));
            }
        }
        _ => {
            let result = with_timeout(limit_dur, execute_raw_sql_generic(&conn_type, sql.clone())).await?;
            if let Some(first_res) = result.get(0) {
                if let Some(data) = first_res.get("data").and_then(|v| v.as_array()) {
                    rows_json = data.clone();
                }
                if let Some(cols) = first_res.get("columns").and_then(|v| v.as_array()) {
                    columns = cols.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect();
                }
            }
        }
    }

    // The extra row read above never reaches the frontend — it only answers "is there a next page".
    let has_more = rows_json.len() > limit as usize;
    rows_json.truncate(limit as usize);

    // Con trỏ cho trang sau: giá trị cột seek ở dòng CUỐI của trang này (sau khi đã cắt dòng đọc
    // thừa), dạng chuỗi chính xác. Phải lấy ở Rust chứ không để frontend đọc từ dòng JSON: một khoá
    // i64 lớn hơn 2^53 (kiểu snowflake) đi qua `JSON.parse` của JS là mất chữ số cuối, và con trỏ
    // lệch một đơn vị thì trang sau bỏ sót dòng — không lỗi, không dấu vết.
    let next_cursor = if has_more {
        seek_active
            .and_then(|col| rows_json.last()?.get(col.as_str()))
            .and_then(scalar_to_cursor)
    } else {
        None
    };

    // Counting is the expensive half of this command: it re-scans the whole table (or the whole
    // filter) while the page itself touches `limit` rows. Paging, sorting and resizing a page
    // cannot change the answer, so the grid asks for it only when the table, the filter or the
    // data itself changed — see `gridPaging.ts`.
    let mode = count_mode.as_deref().unwrap_or("exact");
    let (total_count, count_exact) = if mode == "skip" {
        (None, None)
    } else {
        // An estimate cannot answer a WHERE clause, so a filtered view is always counted for real.
        let approx = if mode == "auto" && where_clause.is_empty() {
            estimate_row_count(&conn_type, &schema, &name).await
        } else {
            None
        };
        match approx {
            Some(n) => (Some(n), Some(false)),
            // Đếm quá giờ thì trả `None`, không phải lỗi: dòng dữ liệu đã có rồi, và giao diện đã
            // biết hiển thị "không rõ tổng số" (pha 2). Chết cả trang chỉ vì con số ở thanh dưới
            // là đổi một bất tiện thành một sự cố.
            None => match limit_dur {
                None => (exact_row_count(&conn_type, &count_sql).await, Some(true)),
                Some(d) => (
                    tokio::time::timeout(d, exact_row_count(&conn_type, &count_sql))
                        .await
                        .unwrap_or(None),
                    Some(true),
                ),
            },
        }
    };

    Ok(json!({
        "success": true,
        "data": rows_json,
        "columns": columns,
        // `null`, not 0: "not counted" and "no rows" must not look the same on the frontend.
        "totalCount": total_count,
        "countExact": count_exact,
        "hasMore": has_more,
        // Đưa nguyên vào lần gọi sau để lấy trang kế tiếp. `null` = không seek được (không có trang
        // sau, hoặc khoá không phải số/chuỗi) và frontend lại dùng số trang.
        "nextCursor": next_cursor
    }))
}
