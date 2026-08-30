//! Sequences (Postgres): listing, editing, dropping.

use serde_json::{Value, json};

use crate::database::{DbKind, execute_raw_sql_generic, result_rows, row_str, sql_str};

#[tauri::command]
pub async fn get_sequences(conn_id: String) -> Result<Value, String> {
    Box::pin(async move {
    let state = crate::state::require_state()?;
    let (conn_type, schema) = {
        let ctx = state.connections.acquire(&conn_id)?;
        let ct = ctx.conn().clone();
        (ct, ctx.schema().to_string())
    };
    let sch = sql_str(&schema);

    let sql = match &conn_type.kind {
        DbKind::Postgres(_) => format!("SELECT sequence_name as name, data_type, start_value, minimum_value as min_val, maximum_value as max_val, increment, cycle_option as cycle FROM information_schema.sequences WHERE sequence_schema = '{sch}'"),
        DbKind::Mysql(_) => "SELECT table_name as name, 'bigint' as data_type, '1' as start_value, '1' as min_val, '9223372036854775807' as max_val, '1' as increment, 'NO' as cycle FROM information_schema.tables WHERE table_type = 'SEQUENCE' AND table_schema = DATABASE()".to_string(),
        _ => return Ok(json!({ "success": true, "sequences": [] })),
    };

    let results = execute_raw_sql_generic(&conn_type, sql).await?;
    let mut sequences: Vec<Value> = Vec::new();
    for row in result_rows(&results) {
        sequences.push(json!({
            "name": row_str(row, "name").unwrap_or(""),
            "dataType": row_str(row, "data_type").unwrap_or("bigint"),
            "startValue": row_str(row, "start_value").unwrap_or("1"),
            "minVal": row_str(row, "min_val").unwrap_or("1"),
            "maxVal": row_str(row, "max_val").unwrap_or(""),
            "incrementBy": row_str(row, "increment").unwrap_or("1"),
            "cycle": row_str(row, "cycle").map(|c| c == "YES").unwrap_or(false)
        }));
    }

    Ok(json!({ "success": true, "sequences": sequences }))
}).await
}

#[tauri::command]
pub async fn alter_sequence(conn_id: String, sequence_sql: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        execute_raw_sql_generic(&conn_type, sequence_sql).await?;
        Ok(json!({ "success": true, "message": "Đã cập nhật Sequence thành công" }))
    })
    .await
}

#[tauri::command]
pub async fn drop_sequence(conn_id: String, sequence_name: String) -> Result<Value, String> {
    Box::pin(async move {
        let state = crate::state::require_state()?;
        let conn_type = {
            let ctx = state.connections.acquire(&conn_id)?;
            ctx.conn().clone()
        };

        let sql = match &conn_type.kind {
            DbKind::Mysql(_) => format!("DROP SEQUENCE IF EXISTS `{}`", sequence_name),
            _ => format!("DROP SEQUENCE IF EXISTS \"{}\"", sequence_name),
        };

        execute_raw_sql_generic(&conn_type, sql).await?;
        Ok(json!({ "success": true, "message": "Đã xóa Sequence thành công" }))
    })
    .await
}
