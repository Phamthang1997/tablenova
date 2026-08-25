//! `compare_schemas` — the command that compares the STRUCTURE of two databases.

use std::collections::BTreeSet;

use serde_json::{json, Value};
use tauri::State;

use crate::AppState;
use crate::compare::diff::{
    column_changes, fk_changes, index_changes, view_def_differs,
};
use crate::compare::ident::{q_ident, qualified};
use crate::compare::meta::{col_json, fk_json, idx_json};
use crate::compare::read::read_schema;
use crate::compare::side::{resolve_side, side_json, CompareSide, Resolved};
use crate::compare::sync_sql::{
    add_fk_sql, alter_column_stmts, column_clause, create_index_sql, create_table_sql,
    drop_fk_sql, drop_index_sql, fk_stmt_or_note, SqlOut,
};

// ===================== Command: compare structure =====================

#[tauri::command]
pub async fn compare_schemas(
    state: State<'_, AppState>, conn_id: String,
    source: CompareSide,
    target: CompareSide,
    include_drops: Option<bool>,
) -> Result<Value, String> {
    let src = resolve_side(&state, &source, &conn_id).await?;
    let tgt = match resolve_side(&state, &target, &conn_id).await {
        Ok(t) => t,
        Err(e) => {
            src.close().await;
            return Err(e);
        }
    };

    let out = compare_schemas_inner(&src, &tgt, include_drops.unwrap_or(false)).await;
    src.close().await;
    tgt.close().await;
    out
}

pub(super) async fn compare_schemas_inner(
    src: &Resolved,
    tgt: &Resolved,
    include_drops: bool,
) -> Result<Value, String> {
    let src_meta = read_schema(src).await?;
    let tgt_meta = read_schema(tgt).await?;

    let mut warnings: Vec<String> = Vec::new();
    if src.dialect != tgt.dialect {
        warnings.push(format!(
            "Hai phía khác hệ quản trị ({} / {}): kiểu dữ liệu và giá trị mặc định trong SQL đồng bộ có thể phải sửa tay.",
            src.dialect, tgt.dialect
        ));
    }
    if src.label == tgt.label && src.server == tgt.server && src.schema == tgt.schema {
        warnings.push("Hai phía đang trỏ cùng một database.".to_string());
    }

    let mut sql = SqlOut::new(include_drops);
    sql.note(format!(
        "Schema sync: {} ({}) -> {} ({})",
        src.label, src.dialect, tgt.label, tgt.dialect
    ));
    if !include_drops {
        sql.note("Destructive statements are commented out (enable \"generate drop statements\" to run them).");
    }
    if src.dialect != tgt.dialect {
        sql.note("The two sides use different engines: check data types and default values before running.");
    }

    let all_names: BTreeSet<&String> = src_meta.keys().chain(tgt_meta.keys()).collect();
    let mut tables_json: Vec<Value> = Vec::new();
    let (mut only_src, mut only_tgt, mut different, mut identical) = (0, 0, 0, 0);
    let (mut c_only_src, mut c_only_tgt, mut c_diff) = (0, 0, 0);
    let (mut idx_diffs, mut fk_diffs) = (0, 0);

    for name in all_names {
        let s = src_meta.get(name);
        let t = tgt_meta.get(name);

        match (s, t) {
            (Some(s), None) => {
                only_src += 1;
                c_only_src += s.columns.len();
                sql.blank();
                sql.note(format!("Table only in source: {}", name));
                for stmt in create_table_sql(s, &src.dialect, &tgt.dialect, &tgt.schema) {
                    sql.push(stmt);
                }
                tables_json.push(json!({
                    "name": name,
                    "kind": if s.is_view { "view" } else { "table" },
                    "status": "onlySource",
                    "changes": ["exists"],
                    "diffCount": s.columns.len().max(1),
                    "columns": s.columns.iter().map(|c| json!({
                        "name": c.name, "status": "onlySource", "changes": [], "source": col_json(c), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "indexes": s.indexes.iter().map(|i| json!({
                        "name": i.name, "status": "onlySource", "changes": [], "source": idx_json(i), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "foreignKeys": s.fks.iter().map(|f| json!({
                        "name": f.name, "status": "onlySource", "changes": [], "source": fk_json(f), "target": Value::Null
                    })).collect::<Vec<_>>(),
                    "primaryKey": { "source": s.pk, "target": Value::Null, "differs": !s.pk.is_empty() },
                    "viewDefinitionDiffers": false,
                }));
            }
            (None, Some(t)) => {
                only_tgt += 1;
                c_only_tgt += t.columns.len();
                sql.blank();
                sql.note(format!("Table only in target: {}", name));
                let full = qualified(&tgt.dialect, &tgt.schema, name);
                sql.destructive(if t.is_view {
                    format!("DROP VIEW {};", full)
                } else {
                    format!("DROP TABLE {};", full)
                });
                tables_json.push(json!({
                    "name": name,
                    "kind": if t.is_view { "view" } else { "table" },
                    "status": "onlyTarget",
                    "changes": ["exists"],
                    "diffCount": t.columns.len().max(1),
                    "columns": t.columns.iter().map(|c| json!({
                        "name": c.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": col_json(c)
                    })).collect::<Vec<_>>(),
                    "indexes": t.indexes.iter().map(|i| json!({
                        "name": i.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": idx_json(i)
                    })).collect::<Vec<_>>(),
                    "foreignKeys": t.fks.iter().map(|f| json!({
                        "name": f.name, "status": "onlyTarget", "changes": [], "source": Value::Null, "target": fk_json(f)
                    })).collect::<Vec<_>>(),
                    "primaryKey": { "source": Value::Null, "target": t.pk, "differs": !t.pk.is_empty() },
                    "viewDefinitionDiffers": false,
                }));
            }
            (Some(s), Some(t)) => {
                if s.is_view || t.is_view {
                    let is_kind_mismatch = s.is_view != t.is_view;
                    let view_differs = !is_kind_mismatch && view_def_differs(s.view_def.as_ref(), t.view_def.as_ref(), &src.schema, &tgt.schema, name);
                    let status = if is_kind_mismatch || view_differs { "different" } else { "identical" };

                    let mut changes: Vec<String> = Vec::new();
                    if is_kind_mismatch {
                        changes.push("kind".to_string());
                    }
                    if view_differs {
                        changes.push("viewDefinition".to_string());
                    }

                    if status == "identical" {
                        identical += 1;
                    } else {
                        different += 1;
                        sql.blank();
                        sql.note(format!("View differs: {}", name));
                        if is_kind_mismatch {
                            sql.note(format!(
                                "{} is a {} in source but a {} in target - handle manually.",
                                name,
                                if s.is_view { "view" } else { "table" },
                                if t.is_view { "view" } else { "table" }
                            ));
                        } else if view_differs {
                            let def = s.view_def.clone().unwrap_or_default();
                            let body = def.trim().trim_end_matches(';').to_string();
                            if body.is_empty() {
                                sql.note(format!("Could not read the definition of view {}", name));
                            } else if tgt.dialect == "sqlite" {
                                sql.paired(
                                    format!("DROP VIEW {};", qualified(&tgt.dialect, &tgt.schema, name)),
                                    if body.to_ascii_uppercase().starts_with("CREATE ") {
                                        format!("{};", body)
                                    } else {
                                        format!(
                                            "CREATE VIEW {} AS {};",
                                            qualified(&tgt.dialect, &tgt.schema, name),
                                            body
                                        )
                                    },
                                );
                            } else {
                                sql.push(format!(
                                    "CREATE OR REPLACE VIEW {} AS {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    body
                                ));
                            }
                        }
                    }

                    tables_json.push(json!({
                        "name": name,
                        "kind": if s.is_view { "view" } else { "table" },
                        "status": status,
                        "changes": changes,
                        "diffCount": if status == "identical" { 0 } else { 1 },
                        "columns": Vec::<Value>::new(),
                        "indexes": Vec::<Value>::new(),
                        "foreignKeys": Vec::<Value>::new(),
                        "primaryKey": { "source": s.pk, "target": t.pk, "differs": false },
                        "viewDefinitionDiffers": view_differs,
                    }));
                } else {
                    let mut table_sql: Vec<String> = Vec::new();
                    let mut destructive_sql: Vec<String> = Vec::new();
                    let mut paired_sql: Vec<(String, String)> = Vec::new();
                    let mut changes: Vec<&str> = Vec::new();
                    let mut diff_count = 0usize;

                    // ---- Columns ----
                    let mut cols_json: Vec<Value> = Vec::new();
                    let col_names: Vec<String> = s
                        .columns
                        .iter()
                        .map(|c| c.name.clone())
                        .chain(t.columns.iter().filter(|c| s.column(&c.name).is_none()).map(|c| c.name.clone()))
                        .collect();
                    for cn in &col_names {
                        match (s.column(cn), t.column(cn)) {
                            (Some(sc), None) => {
                                c_only_src += 1;
                                diff_count += 1;
                                cols_json.push(json!({
                                    "name": cn, "status": "onlySource", "changes": [],
                                    "source": col_json(sc), "target": Value::Null
                                }));
                                table_sql.push(format!(
                                    "ALTER TABLE {} ADD COLUMN {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    column_clause(sc, &src.dialect, &tgt.dialect, false)
                                ));
                            }
                            (None, Some(tc)) => {
                                c_only_tgt += 1;
                                diff_count += 1;
                                cols_json.push(json!({
                                    "name": cn, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": col_json(tc)
                                }));
                                destructive_sql.push(format!(
                                    "ALTER TABLE {} DROP COLUMN {};",
                                    qualified(&tgt.dialect, &tgt.schema, name),
                                    q_ident(&tgt.dialect, cn)
                                ));
                            }
                            (Some(sc), Some(tc)) => {
                                let ch = column_changes(sc, tc);
                                if ch.is_empty() {
                                    cols_json.push(json!({
                                        "name": cn, "status": "identical", "changes": [],
                                        "source": col_json(sc), "target": col_json(tc)
                                    }));
                                } else {
                                    c_diff += 1;
                                    diff_count += 1;
                                    cols_json.push(json!({
                                        "name": cn, "status": "different", "changes": ch.clone(),
                                        "source": col_json(sc), "target": col_json(tc)
                                    }));
                                    if ch.iter().any(|c| *c != "position") {
                                        table_sql.extend(alter_column_stmts(
                                            name, sc, tc, &ch, &src.dialect, &tgt.dialect, &tgt.schema,
                                        ));
                                    }
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if cols_json.iter().any(|c| c.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("columns");
                    }

                    // ---- Index ----
                    let mut idx_json_list: Vec<Value> = Vec::new();
                    let idx_names: Vec<String> = s
                        .indexes
                        .iter()
                        .map(|i| i.name.clone())
                        .chain(
                            t.indexes
                                .iter()
                                .filter(|i| !s.indexes.iter().any(|x| x.name == i.name))
                                .map(|i| i.name.clone()),
                        )
                        .collect();
                    for iname in &idx_names {
                        let si = s.indexes.iter().find(|i| &i.name == iname);
                        let ti = t.indexes.iter().find(|i| &i.name == iname);
                        match (si, ti) {
                            (Some(si), None) => {
                                idx_diffs += 1;
                                diff_count += 1;
                                idx_json_list.push(json!({
                                    "name": iname, "status": "onlySource", "changes": [],
                                    "source": idx_json(si), "target": Value::Null
                                }));
                                table_sql.push(create_index_sql(si, name, &tgt.dialect, &tgt.schema));
                            }
                            (None, Some(ti)) => {
                                idx_diffs += 1;
                                diff_count += 1;
                                idx_json_list.push(json!({
                                    "name": iname, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": idx_json(ti)
                                }));
                                destructive_sql.push(drop_index_sql(ti, name, &tgt.dialect, &tgt.schema));
                            }
                            (Some(si), Some(ti)) => {
                                let ch = index_changes(si, ti);
                                if ch.is_empty() {
                                    idx_json_list.push(json!({
                                        "name": iname, "status": "identical", "changes": [],
                                        "source": idx_json(si), "target": idx_json(ti)
                                    }));
                                } else {
                                    idx_diffs += 1;
                                    diff_count += 1;
                                    idx_json_list.push(json!({
                                        "name": iname, "status": "different", "changes": ch,
                                        "source": idx_json(si), "target": idx_json(ti)
                                    }));
                                    paired_sql.push((
                                        drop_index_sql(ti, name, &tgt.dialect, &tgt.schema),
                                        create_index_sql(si, name, &tgt.dialect, &tgt.schema),
                                    ));
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if idx_json_list.iter().any(|i| i.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("indexes");
                    }

                    // ---- Foreign keys ----
                    let mut fk_json_list: Vec<Value> = Vec::new();
                    let fk_names: Vec<String> = s
                        .fks
                        .iter()
                        .map(|f| f.name.clone())
                        .chain(
                            t.fks
                                .iter()
                                .filter(|f| !s.fks.iter().any(|x| x.name == f.name))
                                .map(|f| f.name.clone()),
                        )
                        .collect();
                    for fname in &fk_names {
                        let sf = s.fks.iter().find(|f| &f.name == fname);
                        let tf = t.fks.iter().find(|f| &f.name == fname);
                        match (sf, tf) {
                            (Some(sf), None) => {
                                fk_diffs += 1;
                                diff_count += 1;
                                fk_json_list.push(json!({
                                    "name": fname, "status": "onlySource", "changes": [],
                                    "source": fk_json(sf), "target": Value::Null
                                }));
                                table_sql.push(fk_stmt_or_note(
                                    &tgt.dialect,
                                    name,
                                    fname,
                                    add_fk_sql(sf, name, &tgt.dialect, &tgt.schema),
                                ));
                            }
                            (None, Some(tf)) => {
                                fk_diffs += 1;
                                diff_count += 1;
                                fk_json_list.push(json!({
                                    "name": fname, "status": "onlyTarget", "changes": [],
                                    "source": Value::Null, "target": fk_json(tf)
                                }));
                                if tgt.dialect == "sqlite" {
                                    table_sql.push(fk_stmt_or_note(&tgt.dialect, name, fname, String::new()));
                                } else {
                                    destructive_sql.push(drop_fk_sql(tf, name, &tgt.dialect, &tgt.schema));
                                }
                            }
                            (Some(sf), Some(tf)) => {
                                let ch = fk_changes(sf, tf);
                                if ch.is_empty() {
                                    fk_json_list.push(json!({
                                        "name": fname, "status": "identical", "changes": [],
                                        "source": fk_json(sf), "target": fk_json(tf)
                                    }));
                                } else {
                                    fk_diffs += 1;
                                    diff_count += 1;
                                    fk_json_list.push(json!({
                                        "name": fname, "status": "different", "changes": ch,
                                        "source": fk_json(sf), "target": fk_json(tf)
                                    }));
                                    if tgt.dialect == "sqlite" {
                                        table_sql.push(fk_stmt_or_note(&tgt.dialect, name, fname, String::new()));
                                    } else {
                                        paired_sql.push((
                                            drop_fk_sql(tf, name, &tgt.dialect, &tgt.schema),
                                            add_fk_sql(sf, name, &tgt.dialect, &tgt.schema),
                                        ));
                                    }
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    if fk_json_list.iter().any(|f| f.get("status").and_then(|v| v.as_str()) != Some("identical")) {
                        changes.push("foreignKeys");
                    }

                    // ---- Primary key ----
                    let pk_differs = s.pk != t.pk;
                    if pk_differs {
                        diff_count += 1;
                        changes.push("primaryKey");
                    }

                    let status = if diff_count == 0 { "identical" } else { "different" };

                    if status == "identical" {
                        identical += 1;
                    } else {
                        different += 1;

                        sql.blank();
                        sql.note(format!("Table differs: {}", name));
                        if pk_differs {
                            sql.note(format!(
                                "Primary key differs ({}: [{}] / [{}]) - no statement generated, changing a PK needs a data review.",
                                name,
                                s.pk.join(", "),
                                t.pk.join(", ")
                            ));
                        }
                        for stmt in table_sql {
                            sql.push(stmt);
                        }
                        for stmt in destructive_sql {
                            sql.destructive(stmt);
                        }
                        for (d, c) in paired_sql {
                            sql.paired(d, c);
                        }
                    }

                    tables_json.push(json!({
                        "name": name,
                        "kind": "table",
                        "status": status,
                        "changes": if status == "identical" { Vec::<String>::new() } else { changes.iter().map(|s| s.to_string()).collect() },
                        "diffCount": if status == "identical" { 0 } else { diff_count },
                        "columns": if status == "identical" { Vec::new() } else { cols_json },
                        "indexes": if status == "identical" { Vec::new() } else { idx_json_list },
                        "foreignKeys": if status == "identical" { Vec::new() } else { fk_json_list },
                        "primaryKey": { "source": s.pk, "target": t.pk, "differs": pk_differs },
                        "viewDefinitionDiffers": false,
                    }));
                }
            }
            (None, None) => {}
        }
    }

    let identical_all = only_src == 0 && only_tgt == 0 && different == 0;
    if identical_all {
        sql.blank();
        sql.note("Both sides have the same structure.");
    }

    Ok(json!({
        "success": true,
        "source": side_json(src, src_meta.len()),
        "target": side_json(tgt, tgt_meta.len()),
        "identical": identical_all,
        "summary": {
            "tablesOnlySource": only_src,
            "tablesOnlyTarget": only_tgt,
            "tablesDifferent": different,
            "tablesIdentical": identical,
            "columnsOnlySource": c_only_src,
            "columnsOnlyTarget": c_only_tgt,
            "columnsDifferent": c_diff,
            "indexDiffs": idx_diffs,
            "foreignKeyDiffs": fk_diffs,
        },
        "tables": tables_json,
        "syncSql": sql.lines,
        "includeDrops": include_drops,
        "warnings": warnings,
    }))
}
