//! A table's partitions.

use serde_json::{Value, json};

use crate::database::{DbKind, execute_raw_sql_generic, result_rows, row_i64, row_str};

#[tauri::command]
pub async fn get_table_partitions(conn_id: String, table_name: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let conn_type = {
        let ctx = state.connections.acquire(&conn_id)?;
        ctx.conn().clone()
    };

    let sql = match &conn_type.kind {
        DbKind::Mysql(_) => format!(
            "SELECT PARTITION_NAME as name, PARTITION_METHOD as method, PARTITION_EXPRESSION as expression, PARTITION_DESCRIPTION as description, TABLE_ROWS as table_rows, DATA_LENGTH as data_length FROM INFORMATION_SCHEMA.PARTITIONS WHERE TABLE_NAME = '{}' AND TABLE_SCHEMA = DATABASE() AND PARTITION_NAME IS NOT NULL",
            table_name.replace('\'', "''")
        ),
        DbKind::Postgres(_) => format!(
            "SELECT c.relname AS name, 'PARTITION' AS method, pg_get_expr(c.relpartbound, c.oid) AS expression, '' AS description, c.reltuples::bigint AS table_rows, 0 AS data_length FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class parent ON parent.oid = i.inhparent WHERE parent.relname = '{}'",
            table_name.replace('\'', "''")
        ),
        _ => return Ok(json!({ "success": true, "partitions": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut partitions: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        partitions.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "method": row_str(row, "method").unwrap_or(""),
            "expression": row_str(row, "expression").unwrap_or(""),
            "description": row_str(row, "description").unwrap_or(""),
            "tableRows": row_i64(row, "table_rows"),
            "dataLength": row_i64(row, "data_length")
        }));
    }

    Ok(json!({ "success": true, "partitions": partitions }))
}).await
}
