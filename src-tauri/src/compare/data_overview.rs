//! `compare_data_overview` — counts the rows of each table on both sides. The cheap triage step before
//! comparing row by row.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::compare::ident::qualified;
use crate::compare::read::read_schema;
use crate::compare::side::{query_rows, resolve_side, side_json, CompareSide, Resolved};

// ===================== Command: data overview (row counts) =====================

#[tauri::command]
pub async fn compare_data_overview(
    conn_id: String,
    source: CompareSide,
    target: CompareSide,
    tables: Option<Vec<String>>,
) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = data_overview_inner(&src, &tgt, tables).await;
    src.close().await;
    tgt.close().await;
    out
}

pub(super) async fn count_rows(r: &Resolved, table: &str) -> Result<i64, String> {
    let sql = format!(
        "SELECT COUNT(*) AS n FROM {}",
        qualified(&r.dialect, &r.schema, table)
    );
    let rows = query_rows(&r.conn, sql).await?;
    let v = rows.first().and_then(|row| row.get("n")).cloned().unwrap_or(Value::Null);
    Ok(match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    })
}

pub(super) async fn data_overview_inner(
    src: &Resolved,
    tgt: &Resolved,
    only: Option<Vec<String>>,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let filter: Option<BTreeSet<String>> = only.map(|v| v.into_iter().collect());
    let names: BTreeSet<&String> = src_meta.keys().chain(tgt_meta.keys()).collect();

    let mut out: Vec<Value> = Vec::new();
    let mut diff_tables = 0usize;

    for name in names {
        if let Some(f) = &filter {
            if !f.contains(name) {
                continue;
            }
        }
        let s = src_meta.get(name);
        let t = tgt_meta.get(name);
        // Views are not data-compared (no key, and reading them back depends on the base tables).
        if s.map(|m| m.is_view).unwrap_or(false) || t.map(|m| m.is_view).unwrap_or(false) {
            continue;
        }

        let (mut s_rows, mut t_rows): (Option<i64>, Option<i64>) = (None, None);
        let mut error: Option<String> = None;
        if s.is_some() {
            match count_rows(src, name).await {
                Ok(n) => s_rows = Some(n),
                Err(e) => error = Some(e),
            }
        }
        if t.is_some() {
            match count_rows(tgt, name).await {
                Ok(n) => t_rows = Some(n),
                Err(e) => error = error.or(Some(e)),
            }
        }

        let status = match (s, t) {
            (Some(_), None) => "onlySource",
            (None, Some(_)) => "onlyTarget",
            _ => {
                if s_rows == t_rows {
                    "sameCount"
                } else {
                    "differentCount"
                }
            }
        };
        if status != "sameCount" {
            diff_tables += 1;
        }

        // The suggested key for the data comparison: a PK is only usable when BOTH sides have one.
        let pk: Vec<String> = match (s, t) {
            (Some(s), Some(t)) if !s.pk.is_empty() && s.pk == t.pk => s.pk.clone(),
            (Some(s), None) => s.pk.clone(),
            (None, Some(t)) => t.pk.clone(),
            _ => Vec::new(),
        };
        let comparable = s.is_some() && t.is_some() && !pk.is_empty();

        out.push(json!({
            "name": name,
            "status": status,
            "sourceRows": s_rows,
            "targetRows": t_rows,
            "primaryKey": pk,
            "comparable": comparable,
            "error": error,
        }));
    }

    Ok(json!({
        "success": true,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "tables": out,
        "tablesWithDifference": diff_tables,
    }))
}
