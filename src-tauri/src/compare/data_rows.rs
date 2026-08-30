//! `compare_table_data` — compares ONE table row by row using a key, and generates the sync script.

use std::collections::{BTreeSet, HashMap};

use serde_json::{json, Value};

use crate::compare::ident::{q_ident, qualified};
use crate::compare::read::read_schema;
use crate::compare::script::{delete_sql, insert_sql, update_sql};
use crate::compare::side::{query_rows, resolve_side, side_json, CompareSide, Resolved};
use crate::compare::sync_sql::SqlOut;
use crate::compare::values::{norm_scalar, values_equal};

// The maximum number of rows read from EACH side when comparing data. Above that -> the result is marked
// `truncated` and only the first rows in key order are compared.
pub(super) const DEFAULT_DATA_LIMIT: usize = 20_000;

// The maximum number of DIFFERING rows returned to the UI (the counts in `summary` are still the real ones).
pub(super) const DEFAULT_MAX_DIFF_ROWS: usize = 500;

// ===================== Command: compare one table's data =====================

/// The key string of a row. It is used to pair rows across the two sides, so it must normalise the same
/// way `values_equal` does (the number 1 and the string "1" from two different drivers are the SAME key).
pub(super) fn key_of(row: &Value, keys: &[String]) -> String {
    keys.iter()
        .map(|k| norm_scalar(row.get(k).unwrap_or(&Value::Null)))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn compare_table_data(
    conn_id: String,
    source: CompareSide,
    target: CompareSide,
    table: String,
    key_columns: Option<Vec<String>>,
    limit: Option<usize>,
    max_diff_rows: Option<usize>,
    include_drops: Option<bool>,
) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    if table.trim().is_empty() {
        return Err("Thiếu tên bảng".to_string());
    }
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = compare_table_data_inner(
        &src,
        &tgt,
        &table,
        key_columns,
        limit.unwrap_or(DEFAULT_DATA_LIMIT).max(1),
        max_diff_rows.unwrap_or(DEFAULT_MAX_DIFF_ROWS).max(1),
        include_drops.unwrap_or(false),
    )
    .await;
    src.close().await;
    tgt.close().await;
    out
}).await
}

pub(super) async fn fetch_rows(
    r: &Resolved,
    table: &str,
    columns: &[String],
    keys: &[String],
    limit: usize,
) -> Result<Vec<Value>, String> {
    let cols: Vec<String> = columns.iter().map(|c| q_ident(&r.dialect, c)).collect();
    let order: Vec<String> = keys.iter().map(|c| q_ident(&r.dialect, c)).collect();
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {} LIMIT {}",
        cols.join(", "),
        qualified(&r.dialect, &r.schema, table),
        order.join(", "),
        limit + 1
    );
    query_rows(&r.conn, sql).await
}

pub(super) async fn compare_table_data_inner(
    src: &Resolved,
    tgt: &Resolved,
    table: &str,
    key_columns: Option<Vec<String>>,
    limit: usize,
    max_diff_rows: usize,
    include_drops: bool,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let s_tbl = src_meta
        .get(table)
        .ok_or_else(|| format!("Bảng '{}' không có ở nguồn", table))?;
    let t_tbl = tgt_meta
        .get(table)
        .ok_or_else(|| format!("Bảng '{}' không có ở đích", table))?;

    // Only compare columns present on BOTH sides; the structural mismatch is reported separately so the UI can tell the user.
    let common: Vec<String> = s_tbl
        .columns
        .iter()
        .filter(|c| t_tbl.column(&c.name).is_some())
        .map(|c| c.name.clone())
        .collect();
    if common.is_empty() {
        return Err(format!("Bảng '{}' không có cột nào chung giữa hai bên", table));
    }
    let only_src_cols: Vec<String> = s_tbl
        .columns
        .iter()
        .filter(|c| t_tbl.column(&c.name).is_none())
        .map(|c| c.name.clone())
        .collect();
    let only_tgt_cols: Vec<String> = t_tbl
        .columns
        .iter()
        .filter(|c| s_tbl.column(&c.name).is_none())
        .map(|c| c.name.clone())
        .collect();

    // The key: chosen by the user, or the source's PK. With no key, rows cannot be paired.
    let keys: Vec<String> = match key_columns.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => s_tbl.pk.clone(),
    };
    if keys.is_empty() {
        return Err(format!(
            "Bảng '{}' không có khóa chính — hãy chọn cột khóa để so dữ liệu",
            table
        ));
    }
    for k in &keys {
        if !common.contains(k) {
            return Err(format!("Cột khóa '{}' không có ở cả hai bên", k));
        }
    }

    let s_rows = fetch_rows(src, table, &common, &keys, limit).await?;
    let t_rows = fetch_rows(tgt, table, &common, &keys, limit).await?;
    let truncated = s_rows.len() > limit || t_rows.len() > limit;
    let s_rows = &s_rows[..s_rows.len().min(limit)];
    let t_rows = &t_rows[..t_rows.len().min(limit)];

    let mut t_index: HashMap<String, &Value> = HashMap::with_capacity(t_rows.len());
    let mut dup_target = 0usize;
    for row in t_rows.iter() {
        if t_index.insert(key_of(row, &keys), row).is_some() {
            dup_target += 1;
        }
    }

    let mut rows_json: Vec<Value> = Vec::new();
    let (mut n_only_src, mut n_only_tgt, mut n_diff, mut n_same) = (0usize, 0usize, 0usize, 0usize);
    let mut matched: BTreeSet<String> = BTreeSet::new();

    let mut sql = SqlOut::new(include_drops);
    sql.note(format!(
        "Data sync for table {}: {} -> {}",
        table, src.label, tgt.label
    ));
    sql.note(format!("Key columns: {}", keys.join(", ")));
    if !include_drops {
        sql.note("DELETE statements are commented out (enable \"generate drop statements\" to run them).");
    }
    sql.blank();

    for s_row in s_rows.iter() {
        let k = key_of(s_row, &keys);
        matched.insert(k.clone());
        match t_index.get(&k) {
            None => {
                n_only_src += 1;
                if rows_json.len() < max_diff_rows {
                    rows_json.push(json!({
                        "status": "onlySource",
                        "key": key_values(s_row, &keys),
                        "source": s_row,
                        "target": Value::Null,
                        "changedColumns": [],
                    }));
                }
                sql.push(insert_sql(tgt, table, s_row, &common));
            }
            Some(t_row) => {
                let changed: Vec<String> = common
                    .iter()
                    .filter(|c| {
                        !values_equal(
                            s_row.get(c.as_str()).unwrap_or(&Value::Null),
                            t_row.get(c.as_str()).unwrap_or(&Value::Null),
                        )
                    })
                    .cloned()
                    .collect();
                if changed.is_empty() {
                    n_same += 1;
                } else {
                    n_diff += 1;
                    if rows_json.len() < max_diff_rows {
                        rows_json.push(json!({
                            "status": "different",
                            "key": key_values(s_row, &keys),
                            "source": s_row,
                            "target": *t_row,
                            "changedColumns": changed,
                        }));
                    }
                    sql.push(update_sql(tgt, table, s_row, &changed, &keys));
                }
            }
        }
    }

    for t_row in t_rows.iter() {
        let k = key_of(t_row, &keys);
        if matched.contains(&k) {
            continue;
        }
        n_only_tgt += 1;
        if rows_json.len() < max_diff_rows {
            rows_json.push(json!({
                "status": "onlyTarget",
                "key": key_values(t_row, &keys),
                "source": Value::Null,
                "target": t_row,
                "changedColumns": [],
            }));
        }
        sql.destructive(delete_sql(tgt, table, t_row, &keys));
    }

    let identical = n_only_src == 0 && n_only_tgt == 0 && n_diff == 0;
    if identical {
        sql.note("Both sides hold the same data (within the compared range).");
    }

    let mut warnings: Vec<String> = Vec::new();
    if truncated {
        warnings.push(format!(
            "Chỉ so {} dòng đầu (theo thứ tự khóa) của mỗi bên.",
            limit
        ));
    }
    if dup_target > 0 {
        warnings.push(format!(
            "Đích có {} dòng trùng khóa — chỉ dòng cuối được đem so.",
            dup_target
        ));
    }
    if !only_src_cols.is_empty() || !only_tgt_cols.is_empty() {
        warnings.push("Hai bên lệch cột: chỉ so những cột có ở cả hai bên.".to_string());
    }

    Ok(json!({
        "success": true,
        "table": table,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "keyColumns": keys,
        "columns": common,
        "columnsOnlySource": only_src_cols,
        "columnsOnlyTarget": only_tgt_cols,
        "identical": identical,
        "summary": {
            "onlySource": n_only_src,
            "onlyTarget": n_only_tgt,
            "different": n_diff,
            "identical": n_same,
            "sourceRows": s_rows.len(),
            "targetRows": t_rows.len(),
        },
        "rows": rows_json,
        "rowsTruncated": n_only_src + n_only_tgt + n_diff > rows_json.len(),
        "truncated": truncated,
        "syncSql": sql.lines,
        "includeDrops": include_drops,
        "warnings": warnings,
    }))
}

pub(super) fn key_values(row: &Value, keys: &[String]) -> Value {
    Value::Array(
        keys.iter()
            .map(|k| row.get(k).cloned().unwrap_or(Value::Null))
            .collect(),
    )
}
