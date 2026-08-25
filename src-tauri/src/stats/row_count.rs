//! `get_exact_table_row_count` — a real COUNT(*) of one table, for when the estimate is not enough.

use tauri::State;
use serde_json::{json, Value};
use crate::database::DbKind;
use crate::AppState;
use super::cells::{get_mysql_i64_cell, get_pg_i64_cell};

#[tauri::command]
pub async fn get_exact_table_row_count(state: State<'_, AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let (conn_clone, _db_type) = {
        // `acquire` returns `"Chưa kết nối CSDL"` where it used to be `"Chưa kết nối database"`; both
        // literals already mapped to `backend.notConnected` in `backendErrors.ts`, so the UI is unchanged.
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.server().db_type.clone())
    };

    match &conn_clone.kind {
        DbKind::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;
            let sql = format!("SELECT COUNT(*) FROM \"{}\"", table_name.replace('"', "\"\""));
            let count: i64 = conn.query_row(&sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
            Ok(json!({ "table_name": table_name, "exact_rows": count.max(0) }))
        }
        DbKind::Postgres(pool) => {
            let sql = format!("SELECT COUNT(*) FROM \"{}\"", table_name.replace('"', "\"\""));
            let row = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let count = get_pg_i64_cell(&row, "count").max(0);
            Ok(json!({ "table_name": table_name, "exact_rows": count }))
        }
        DbKind::Mysql(pool) => {
            let sql = format!("SELECT COUNT(*) FROM `{}`", table_name.replace('`', "``"));
            let row = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let count = get_mysql_i64_cell(&row, "COUNT(*)").max(0);
            Ok(json!({ "table_name": table_name, "exact_rows": count }))
        }
    }
}
