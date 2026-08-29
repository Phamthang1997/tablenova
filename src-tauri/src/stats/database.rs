//! `get_database_stats` — the overview numbers of the database currently open (Database Info).

use tauri::State;
use serde_json::{json, Value};
use crate::database::DbKind;
use crate::AppState;
use super::cells::{get_mysql_i64_cell, get_pg_i64_cell};

#[tauri::command]
pub async fn get_database_stats(state: State<'_, AppState>, conn_id: String) -> Result<Value, String> {
    let (conn_clone, _db_type) = {
        // `acquire` returns `"Chưa kết nối CSDL"` where it used to be `"Chưa kết nối database"`; both
        // literals already mapped to `backend.notConnected` in `backendErrors.ts`, so the UI is unchanged.
        let ctx = state.connections.acquire(&conn_id)?;
        (ctx.conn().clone(), ctx.server().db_type.clone())
    };

    match &conn_clone.kind {
        DbKind::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;

            let page_size: i64 = conn.query_row("PRAGMA page_size;", [], |r| r.get(0)).unwrap_or(4096);
            let page_count: i64 = conn.query_row("PRAGMA page_count;", [], |r| r.get(0)).unwrap_or(0);
            let total_size_bytes = page_size * page_count;

            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;"
            ).map_err(|e| e.to_string())?;

            let table_names: Vec<String> = stmt.query_map([], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;

            for name in table_names {
                let sql = format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\""));
                let count: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap_or(0).max(0);
                total_rows += count;
                tables.push(json!({
                    "table_name": name,
                    "rows": count,
                    "is_exact": true,
                    "data_size_bytes": Value::Null,
                    "index_size_bytes": Value::Null,
                    "total_size_bytes": Value::Null,
                    "engine": "SQLite",
                    "collation": Value::Null
                }));
            }

            Ok(json!({
                "db_name": "SQLite Database",
                "db_type": "sqlite",
                "total_size_bytes": total_size_bytes,
                "total_tables": tables.len(),
                "total_rows": total_rows,
                "tables": tables
            }))
        }
        DbKind::Postgres(pool) => {
            let db_name: String = sqlx::query_scalar("SELECT current_database()")
                .fetch_one(pool)
                .await
                .unwrap_or_else(|_| "PostgreSQL".into());

            let total_size_bytes: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())")
                .fetch_one(pool)
                .await
                .unwrap_or(0);

            let rows = sqlx::query(
                r#"
                SELECT
                    t.relname AS table_name,
                    GREATEST(COALESCE(c.reltuples::bigint, 0), 0) AS estimated_rows,
                    pg_total_relation_size(c.oid) AS total_size_bytes,
                    pg_relation_size(c.oid) AS data_size_bytes,
                    pg_indexes_size(c.oid) AS index_size_bytes
                FROM pg_stat_user_tables t
                JOIN pg_class c ON c.relname = t.relname
                JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
                WHERE t.schemaname IN ('public', current_schema())
                ORDER BY pg_total_relation_size(c.oid) DESC;
                "#
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;

            for r in &rows {
                let name: String = r.get("table_name");
                let count = get_pg_i64_cell(r, "estimated_rows").max(0);
                let total_sz = get_pg_i64_cell(r, "total_size_bytes").max(0);
                let data_sz = get_pg_i64_cell(r, "data_size_bytes").max(0);
                let idx_sz = get_pg_i64_cell(r, "index_size_bytes").max(0);
                total_rows += count;

                tables.push(json!({
                    "table_name": name,
                    "rows": count,
                    "is_exact": false,
                    "data_size_bytes": data_sz,
                    "index_size_bytes": idx_sz,
                    "total_size_bytes": total_sz,
                    "engine": "PostgreSQL",
                    "collation": Value::Null
                }));
            }

            Ok(json!({
                "db_name": db_name,
                "db_type": "postgres",
                "total_size_bytes": total_size_bytes,
                "total_tables": tables.len(),
                "total_rows": total_rows,
                "tables": tables
            }))
        }
        DbKind::Mysql(pool) => {
            let db_name: String = sqlx::query_scalar("SELECT DATABASE()")
                .fetch_one(pool)
                .await
                .unwrap_or_else(|_| "MySQL".into());

            let rows = sqlx::query(
                r#"
                SELECT
                    TABLE_NAME AS table_name,
                    COALESCE(TABLE_ROWS, 0) AS estimated_rows,
                    COALESCE(DATA_LENGTH, 0) AS data_size_bytes,
                    COALESCE(INDEX_LENGTH, 0) AS index_size_bytes,
                    COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) AS total_size_bytes,
                    COALESCE(ENGINE, 'MySQL') AS engine,
                    TABLE_COLLATION AS collation
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_TYPE = 'BASE TABLE'
                ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC;
                "#
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut tables = Vec::new();
            let mut total_rows: i64 = 0;
            let mut total_size_bytes: i64 = 0;

            for r in &rows {
                let name: String = r.get("table_name");
                let count = get_mysql_i64_cell(r, "estimated_rows").max(0);
                let data_sz = get_mysql_i64_cell(r, "data_size_bytes").max(0);
                let idx_sz = get_mysql_i64_cell(r, "index_size_bytes").max(0);
                let total_sz = get_mysql_i64_cell(r, "total_size_bytes").max(0);
                let engine: String = r.get("engine");
                let collation: Option<String> = r.get("collation");

                total_rows += count;
                total_size_bytes += total_sz;

                tables.push(json!({
                    "table_name": name,
                    "rows": count,
                    "is_exact": false,
                    "data_size_bytes": data_sz,
                    "index_size_bytes": idx_sz,
                    "total_size_bytes": total_sz,
                    "engine": engine,
                    "collation": collation
                }));
            }

            Ok(json!({
                "db_name": db_name,
                "db_type": "mysql",
                "total_size_bytes": total_size_bytes,
                "total_tables": tables.len(),
                "total_rows": total_rows,
                "tables": tables
            }))
        }
    }
}
