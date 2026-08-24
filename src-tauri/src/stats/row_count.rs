//! `get_exact_table_row_count` — COUNT(*) thật của một bảng, khi con số ước tính chưa đủ.

use tauri::State;
use serde_json::{json, Value};
use crate::database::DbKind;
use crate::AppState;
use super::cells::{get_mysql_i64_cell, get_pg_i64_cell};

#[tauri::command]
pub async fn get_exact_table_row_count(state: State<'_, AppState>, conn_id: String, table_name: String) -> Result<Value, String> {
    let (conn_clone, _db_type) = {
        // `acquire` trả `"Chưa kết nối CSDL"` thay cho `"Chưa kết nối database"` trước đây; cả hai
        // literal đã cùng trỏ về `backend.notConnected` trong `backendErrors.ts` nên UI không đổi.
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
