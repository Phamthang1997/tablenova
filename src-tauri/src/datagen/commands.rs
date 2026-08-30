//! The four `#[tauri::command]`s of the Data Generator.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::ipc::Channel;

use crate::database::DbConnection;

use super::meta::{collect_meta, topo_order, FkMeta};
use super::spec::{o_str, Cell, GenSpec};
use super::suggest::suggest_generator;
use super::writer::{prepare_table, run_generation};

/// Key under which a run registers its cancel flag in `AppState::cancel_flags`.
///
/// Scoped by `conn_id`, not fixed. One generation runs at a time **per connection** (it is a modal
/// dialog), but with several connections open two runs can overlap — and a single fixed key made the
/// second `insert` replace the first run.s flag, so that run became uncancellable and whichever run
/// finished first orphaned the other.s flag on `remove`.
pub(super) fn cancel_key(conn_id: &str) -> String {
    format!("__data_generator__:{conn_id}")
}

/// Used when the frontend sends no seed. Any constant works; it must not come from the clock.
pub(super) const DEFAULT_SEED: u64 = 20_260_806;

// ===================== Commands =====================

/// Connection + dialect + the selected Postgres schema, all read under one lock.
///
/// The schema rides along here rather than being a parameter of every command because the five
/// functions that need it (`collect_meta`, `fetch_fk_pool`, `estimate_fk_pool`, `insert_sql`,
/// `run_generation`) are internal, not commands — see the plan §5.0.
pub(super) fn active_conn(
    state: &crate::AppState,
    conn_id: &str,
) -> Result<(DbConnection, String, Option<String>), String> {
    // Same tuple as before so none of the five internal callers changes.
    //
    // The dialect always comes from the live connection. That deleted the old
    // `if db_type.is_empty()` fallback rather than porting it: `ConnCtx::dialect()` derives it, so
    // there is no second spelling of the dialect that could disagree with the connection.
    let ctx = state.connections.acquire(conn_id)?;
    Ok((
        ctx.conn().clone(),
        ctx.dialect().to_string(),
        ctx.raw_schema().map(str::to_string),
    ))
}

/// Tables/columns available for generation, with a suggested generator per column and the
/// FK-safe insertion order.
#[tauri::command]
pub async fn get_generation_targets(conn_id: String) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    let metas = collect_meta(&conn, &dialect, &schema, None).await?;

    let names: Vec<String> = metas.iter().map(|m| m.name.clone()).collect();
    let fk_map: HashMap<String, Vec<FkMeta>> =
        metas.iter().map(|m| (m.name.clone(), m.fks.clone())).collect();
    let (order, cyclic) = topo_order(&names, &fk_map);

    let mut tables_json = Vec::with_capacity(metas.len());
    for name in &order {
        let Some(meta) = metas.iter().find(|m| &m.name == name) else { continue };
        let mut cols_json = Vec::with_capacity(meta.columns.len());
        for col in &meta.columns {
            let fk = meta.fk_of(&col.name);
            let (generator, options) = suggest_generator(col, fk);
            cols_json.push(json!({
                "name": col.name,
                "type": col.data_type,
                "nullable": col.nullable,
                "isPrimaryKey": col.is_pk,
                "autoIncrement": col.auto_inc,
                "hasDefault": col.has_default,
                "maxLength": col.max_len,
                "scale": col.scale,
                "enumValues": col.enum_values,
                "fk": fk.map(|f| json!({ "refTable": f.ref_table, "refColumn": f.ref_column })),
                "suggestedGenerator": generator,
                "suggestedOptions": options,
            }));
        }
        tables_json.push(json!({ "table": meta.name, "columns": cols_json }));
    }

    let mut warnings: Vec<String> = Vec::new();
    if !cyclic.is_empty() {
        warnings.push(format!(
            "Các bảng tham chiếu vòng: {}. Hãy bật 'Tắt ràng buộc' khi sinh.",
            cyclic.join(", ")
        ));
    }

    Ok(json!({
        "success": true,
        "dbType": dialect,
        "tables": tables_json,
        "order": order,
        "warnings": warnings,
    }))
}

/// Preview rows for ONE table — same code path as the real run, no writes.
#[tauri::command]
pub async fn preview_generated_data(
    conn_id: String,
    spec: GenSpec,
    table: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    let tspec = spec
        .tables
        .iter()
        .find(|t| t.table == table)
        .ok_or_else(|| format!("Không có cấu hình sinh dữ liệu cho bảng '{table}'"))?;

    let seed = spec.seed.unwrap_or(DEFAULT_SEED);
    let mut warnings: Vec<String> = Vec::new();
    let generated: HashMap<(String, String), Vec<Cell>> = HashMap::new();
    let mut prepared =
        prepare_table(&conn, &dialect, &schema, seed, tspec, &spec.tables, &generated, &mut warnings, false).await?;

    let count = limit.unwrap_or(100).clamp(1, 1000).min(tspec.rows.max(1));
    let mut data = Vec::with_capacity(count);
    for _ in 0..count {
        let mut map = Map::new();
        for (idx, st) in prepared.states.iter_mut().enumerate() {
            let cell = st.next_cell(&dialect)?;
            map.insert(prepared.columns[idx].clone(), cell.to_json());
        }
        data.push(Value::Object(map));
    }

    Ok(json!({
        "success": true,
        "columns": prepared.columns,
        "data": data,
        "warnings": warnings,
    }))
}

/// Marks the running generation as cancelled. Safe to call when nothing is running.
#[tauri::command]
pub async fn cancel_data_generation(
    conn_id: String,
) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&cancel_key(&conn_id)) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "success": true }))
}

/// Generates and inserts the data. Reports progress through `on_progress`:
/// `{type:'start'|'table'|'progress'|'done'|'error', ...}`.
#[tauri::command]
pub async fn generate_data(
    conn_id: String,
    spec: GenSpec,
    // Mandatory (not an Option): Channel does not implement Deserialize, so `Option<Channel<_>>`
    // does not satisfy CommandArg — and the frontend always creates the channel.
    on_progress: Channel<Value>,
) -> Result<Value, String> {
    let state = crate::state::require_state()?;
    // Same reason as restore_backup: this runs on its own connection and would block on the locks
    // an open manual transaction holds. See tx::reject_if_manual_or_open.
    crate::tx::reject_if_manual_or_open(&conn_id, "sinh dữ liệu")?;
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    // Its INSERTs go through `Exec`, i.e. past the funnels that carry the read-only gate.
    // `preview_generated_data` is deliberately not gated — it writes nothing.
    crate::database::reject_conn_read_only(&conn)?;
    if spec.tables.is_empty() {
        return Err("Chưa chọn bảng nào để sinh dữ liệu".to_string());
    }
    let started = std::time::Instant::now();

    let seed = spec.seed.unwrap_or(DEFAULT_SEED);
    let opts = spec.options.clone().unwrap_or_default();
    let disable_constraints = opts.disable_constraints.unwrap_or(false);
    let commit_every = opts.commit_every_batches.unwrap_or(20).max(1);

    // FK-safe order + the parent keys that later tables will need in memory.
    let names: Vec<String> = spec.tables.iter().map(|t| t.table.clone()).collect();
    let metas = collect_meta(&conn, &dialect, &schema, Some(&names)).await?;
    let fk_map: HashMap<String, Vec<FkMeta>> =
        metas.iter().map(|m| (m.name.clone(), m.fks.clone())).collect();
    let (order, cyclic) = topo_order(&names, &fk_map);

    let mut warnings: Vec<String> = Vec::new();
    if !cyclic.is_empty() && !disable_constraints {
        warnings.push(format!(
            "Các bảng tham chiếu vòng: {}. Hãy bật 'Tắt ràng buộc' khi sinh.",
            cyclic.join(", ")
        ));
    }

    // Parent keys to keep in memory while generating: every column a FK in this run points at.
    // Cheap (one Vec per referenced column, capped) and it is the only thing that can serve a
    // cyclic reference, where the parent is generated after the child.
    let mut remember: HashSet<(String, String)> = HashSet::new();
    for t in &spec.tables {
        for c in &t.columns {
            if c.generator != "foreignKey" {
                continue;
            }
            let rt = o_str(&c.options, "refTable").unwrap_or_default();
            let rc = o_str(&c.options, "refColumn").unwrap_or_default();
            if !rt.is_empty() && !rc.is_empty() {
                remember.insert((rt, rc));
            }
        }
    }

    let total_rows: usize = spec.tables.iter().map(|t| t.rows).sum();
    let _ = on_progress.send(json!({
        "type": "start",
        "totalRows": total_rows,
        "tables": order,
    }));

    // Cancel flag, same registry as execute_query_stream/cancel_query.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(cancel_key(&conn_id), cancel.clone());
    }

    let outcome = run_generation(
        &conn,
        &dialect,
        &schema,
        &spec,
        &order,
        seed,
        disable_constraints,
        commit_every,
        &remember,
        total_rows,
        &on_progress,
        &cancel,
        &mut warnings,
    )
    .await;

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&cancel_key(&conn_id));
    }

    match outcome {
        Ok((inserted, cancelled)) => {
            let elapsed = started.elapsed().as_millis() as u64;
            let inserted_json: Map<String, Value> =
                inserted.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
            let _ = on_progress.send(json!({
                "type": "done",
                "cancelled": cancelled,
                "elapsedMs": elapsed,
                "inserted": inserted_json.clone(),
            }));
            Ok(json!({
                "success": true,
                "cancelled": cancelled,
                "elapsedMs": elapsed,
                "inserted": inserted_json,
                "warnings": warnings,
            }))
        }
        Err(msg) => {
            let _ = on_progress.send(json!({ "type": "error", "message": msg.clone() }));
            Err(msg)
        }
    }
}
