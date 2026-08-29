//! A table's CHECK constraints.

use serde_json::{json, Value};

use crate::database::{execute_raw_sql_generic, result_rows, row_str, sql_str, DbKind};

#[tauri::command]
pub async fn get_check_constraints(state: tauri::State<'_, crate::AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT tc.CONSTRAINT_NAME as name, cc.CHECK_CLAUSE as expression, 'YES' as enforced FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA WHERE tc.TABLE_NAME = '{}' AND tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
            "SELECT conname AS name, pg_get_constraintdef(c.oid) AS expression, 'YES' AS enforced FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE t.relname = '{}' AND n.nspname = '{}' AND c.contype = 'c'",
            table_name.replace('\'', "''"), sch
        ),
        _ => return Ok(json!({ "success": true, "constraints": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut constraints: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        constraints.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "expression": row_str(row, "expression").unwrap_or(""),
            "enforced": row_str(row, "enforced").map(|s| s == "YES").unwrap_or(true)
        }));
    }

    Ok(json!({ "success": true, "constraints": constraints }))
}
