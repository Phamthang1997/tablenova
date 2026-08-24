//! Đọc kết quả đã chuẩn hoá (`{ columns, data }`) — và làm tên cột duy nhất trước khi dựng row.

use serde_json::Value;

pub(crate) fn rows_of(res: &[Value]) -> Vec<Value> {
    res.get(0)
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn cell<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// Makes the column names of a result set unique, in place.
///
/// Every row we hand to the frontend is a JSON object keyed by column name, so two
/// columns with the same name would collapse into one: `serde_json::Map::insert`
/// overwrites, and all but the last value is lost without any error. `SELECT *` over
/// a few joins hits this immediately — sakila's `film JOIN inventory JOIN store JOIN
/// address JOIN city` yields five `last_update` columns and three `film_id`s.
///
/// Repeats get a ` (2)`, ` (3)`, … suffix. The caller must build the row map from the
/// SAME (already uniquified) vector, so the frontend's `row[col]` lookups still
/// resolve — the suffix is the only thing that changes, and it shows up in the grid
/// header exactly where a duplicate really exists.
pub(crate) fn uniquify_columns(columns: &mut [String]) {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for i in 0..columns.len() {
        let base = columns[i].clone();
        // Scoped so the mutable borrow of `seen` ends before the lookup below.
        let count = {
            let c = seen.entry(base.clone()).or_insert(0);
            *c += 1;
            *c
        };
        if count == 1 {
            continue;
        }
        // A real column could already be named "x (2)", so keep bumping until free.
        let mut n = count;
        let mut candidate = format!("{base} ({n})");
        while seen.contains_key(&candidate) {
            n += 1;
            candidate = format!("{base} ({n})");
        }
        seen.insert(candidate.clone(), 1);
        columns[i] = candidate;
    }
}

/// First cell of the first row of an `execute_raw_sql_generic` result, as an integer.
///
/// `DECIMAL`/`bigint` arrive from sqlx as a string often enough that both spellings have to be
/// accepted here — this is the same widening the inline count-extraction did before, minus four
/// levels of nesting, and it is now shared by the exact count and the estimate.
pub(crate) fn first_i64(results: Vec<Value>) -> Option<i64> {
    let row = results.first()?.get("data")?.as_array()?.first()?.as_object()?;
    let v = row.values().next()?;
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// Lấy giá trị chuỗi ở ô đầu tiên của mỗi hàng trong kết quả execute_raw_sql_generic
pub(crate) fn all_string_values(results: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(data) = results.get(0).and_then(|r| r.get("data")).and_then(|v| v.as_array()) {
        for row in data {
            if let Some(v) = row.as_object().and_then(|o| o.values().next()) {
                if let Some(s) = v.as_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

// -------------------------------------------------------------
// ADVANCED SCHEMA & OBJECT MANAGEMENT (Triggers, Sequences, Partitions, Check Constraints, Routines, Views)
// -------------------------------------------------------------

// Rows of `execute_raw_sql_generic` are JSON OBJECTS keyed by column name
// (`{ columns: [...], data: [{col: val}] }`), never positional arrays. The four commands
// below used to read them with `row.as_array()`, which is always `None`: the loop body never
// ran, so every one of them returned an empty list on all three dialects and the matching UI
// (Structure > Triggers / Partitions / Check constraints, Sequence Manager) looked as if the
// database had no such objects. Read through these helpers, and address columns by the alias
// each query already declares.
pub(crate) fn result_rows(results: &[Value]) -> &[Value] {
    results
        .first()
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[])
}

pub(crate) fn row_str<'a>(row: &'a Value, col: &str) -> Option<&'a str> {
    row.get(col).and_then(|v| v.as_str())
}

// Counters arrive as a number on some drivers and as a string on others (MySQL BIGINT via
// information_schema, Postgres ::bigint) — accept both, like the code this replaces did.
pub(crate) fn row_i64(row: &Value, col: &str) -> i64 {
    row.get(col)
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}
