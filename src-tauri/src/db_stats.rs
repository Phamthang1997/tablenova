use tauri::State;
use serde_json::{json, Value};
use crate::database::DbConnection;
use crate::AppState;

fn get_pg_i64_cell(row: &sqlx::postgres::PgRow, col: &str) -> i64 {
    use sqlx::Row;
    if let Ok(v) = row.try_get::<i64, _>(col) { return v; }
    if let Ok(v) = row.try_get::<i32, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<f64, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<bigdecimal::BigDecimal, _>(col) {
        return v.to_string().parse::<f64>().map(|f| f as i64).unwrap_or(0);
    }
    if let Ok(v) = row.try_get::<String, _>(col) {
        return v.parse::<i64>().unwrap_or(0);
    }
    0
}

fn get_mysql_i64_cell(row: &sqlx::mysql::MySqlRow, col: &str) -> i64 {
    use sqlx::Row;
    if let Ok(v) = row.try_get::<i64, _>(col) { return v; }
    if let Ok(v) = row.try_get::<u64, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<i32, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<u32, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<f64, _>(col) { return v as i64; }
    if let Ok(v) = row.try_get::<bigdecimal::BigDecimal, _>(col) {
        return v.to_string().parse::<f64>().map(|f| f as i64).unwrap_or(0);
    }
    if let Ok(v) = row.try_get::<String, _>(col) {
        return v.parse::<i64>().unwrap_or(0);
    }
    0
}

#[tauri::command]
pub async fn get_database_stats(state: State<'_, AppState>) -> Result<Value, String> {
    let (conn_clone, _db_type) = {
        let mgr = state.db_manager.lock().map_err(|e| e.to_string())?;
        let conn = mgr.connection.clone().ok_or_else(|| "Chưa kết nối database".to_string())?;
        (conn, mgr.db_type.clone())
    };

    match &conn_clone {
        DbConnection::Sqlite(sqlite_conn) => {
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
        DbConnection::Postgres(pool) => {
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
        DbConnection::Mysql(pool) => {
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

// ===== Thống kê TẤT CẢ database trên server =====

const MYSQL_SYSTEM_DBS: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];
const PG_SYSTEM_DBS: &[&str] = &["postgres", "template0", "template1"];

fn is_system_db(db_type: &str, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match db_type {
        "mysql" => MYSQL_SYSTEM_DBS.contains(&lower.as_str()),
        "postgres" => PG_SYSTEM_DBS.contains(&lower.as_str()),
        _ => false,
    }
}

// Đếm bảng + số dòng ước tính của MỘT database Postgres đang kết nối.
// pg_class chỉ nhìn thấy database hiện tại, nên muốn số liệu của database khác
// bắt buộc phải mở kết nối riêng tới nó (chế độ "quét sâu").
const PG_DB_COUNT_SQL: &str = r#"
    SELECT
        COUNT(*)::bigint AS total_tables,
        COALESCE(SUM(GREATEST(c.reltuples::bigint, 0)), 0)::bigint AS total_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
"#;

async fn pg_count_tables_rows(pool: &sqlx::PgPool) -> Result<(i64, i64), String> {
    let row = sqlx::query(PG_DB_COUNT_SQL).fetch_one(pool).await.map_err(|e| e.to_string())?;
    Ok((
        get_pg_i64_cell(&row, "total_tables").max(0),
        get_pg_i64_cell(&row, "total_rows").max(0),
    ))
}

// Mở kết nối tạm tới một database Postgres khác để lấy số bảng/số dòng, rồi đóng ngay.
async fn pg_count_tables_rows_remote(url: &str) -> Result<(i64, i64), String> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .map_err(|e| e.to_string())?;
    let out = pg_count_tables_rows(&pool).await;
    pool.close().await;
    out
}

#[tauri::command]
pub async fn get_all_databases_stats(state: State<'_, AppState>, deep: Option<bool>) -> Result<Value, String> {
    let deep = deep.unwrap_or(false);

    let (conn_clone, last_config, tunnel_port) = {
        let mgr = state.db_manager.lock().map_err(|e| e.to_string())?;
        let conn = mgr.connection.clone().ok_or_else(|| "Chưa kết nối database".to_string())?;
        (
            conn,
            mgr.last_config.clone(),
            mgr.ssh_tunnel.as_ref().map(|t| t.local_port),
        )
    };

    match &conn_clone {
        DbConnection::Sqlite(sqlite_conn) => {
            // SQLite: "tất cả database" = database chính + các database đã ATTACH.
            let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;

            let entries: Vec<(String, Option<String>)> = {
                let mut stmt = conn.prepare("PRAGMA database_list;").map_err(|e| e.to_string())?;
                let rows: Vec<(String, Option<String>)> = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                rows
            };

            let mut databases = Vec::new();

            for (schema, file) in entries {
                let q = schema.replace('"', "\"\"");
                let page_size: i64 = conn
                    .query_row(&format!("PRAGMA \"{}\".page_size;", q), [], |r| r.get(0))
                    .unwrap_or(0);
                let page_count: i64 = conn
                    .query_row(&format!("PRAGMA \"{}\".page_count;", q), [], |r| r.get(0))
                    .unwrap_or(0);

                let table_names: Vec<String> = {
                    let sql = format!(
                        "SELECT name FROM \"{}\".sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
                        q
                    );
                    match conn.prepare(&sql) {
                        Ok(mut stmt) => stmt
                            .query_map([], |r| r.get(0))
                            .map(|it| it.filter_map(|r| r.ok()).collect())
                            .unwrap_or_default(),
                        Err(_) => Vec::new(),
                    }
                };

                let mut total_rows: i64 = 0;
                for name in &table_names {
                    let sql = format!(
                        "SELECT COUNT(*) FROM \"{}\".\"{}\"",
                        q,
                        name.replace('"', "\"\"")
                    );
                    total_rows += conn.query_row(&sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0).max(0);
                }

                // Tên hiển thị ưu tiên đường dẫn tệp; database tạm/in-memory thì không có tệp.
                let display_name = file.filter(|f| !f.is_empty()).unwrap_or_else(|| schema.clone());
                let is_current = schema == "main";

                databases.push(json!({
                    "db_name": display_name,
                    "schema_name": schema,
                    "is_system": false,
                    "is_current": is_current,
                    "total_tables": table_names.len(),
                    "total_rows": total_rows,
                    "data_size_bytes": Value::Null,
                    "index_size_bytes": Value::Null,
                    "total_size_bytes": page_size * page_count,
                    "charset": "UTF-8",
                    "collation": Value::Null,
                    "error": Value::Null
                }));
            }

            Ok(json!({
                "db_type": "sqlite",
                "current_db": "main",
                "deep": true,
                "supports_deep_scan": false,
                "rows_are_exact": true,
                "databases": databases
            }))
        }
        DbConnection::Postgres(pool) => {
            let current_db: String = sqlx::query_scalar("SELECT current_database()")
                .fetch_one(pool)
                .await
                .unwrap_or_default();

            // pg_database_size() lỗi nếu user không có quyền CONNECT, nên lọc trước.
            let rows = sqlx::query(
                r#"
                SELECT
                    d.datname AS db_name,
                    pg_database_size(d.datname) AS total_size_bytes,
                    pg_encoding_to_char(d.encoding) AS charset,
                    d.datcollate AS collation
                FROM pg_database d
                WHERE d.datistemplate = false
                  AND d.datallowconn = true
                  AND has_database_privilege(d.datname, 'CONNECT')
                ORDER BY pg_database_size(d.datname) DESC;
                "#,
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut databases = Vec::new();

            for r in &rows {
                let name: String = r.get("db_name");
                let is_current = name == current_db;
                let charset: Option<String> = r.try_get("charset").ok();
                let collation: Option<String> = r.try_get("collation").ok();

                // Số bảng/số dòng: database hiện tại luôn lấy được; các database khác chỉ
                // khi bật quét sâu (mỗi database là một kết nối mới).
                let (tables, total_rows, err) = if is_current {
                    match pg_count_tables_rows(pool).await {
                        Ok((t, rw)) => (Some(t), Some(rw), None),
                        Err(e) => (None, None, Some(e)),
                    }
                } else if deep {
                    match last_config.as_ref() {
                        Some(conf) => {
                            let mut url_conf = conf.clone();
                            if let (Some(obj), Some(port)) = (url_conf.as_object_mut(), tunnel_port) {
                                obj.insert("host".to_string(), json!("127.0.0.1"));
                                obj.insert("port".to_string(), json!(port));
                            }
                            let url = crate::database::build_pg_url(&url_conf, Some(name.as_str()));
                            match pg_count_tables_rows_remote(&url).await {
                                Ok((t, rw)) => (Some(t), Some(rw), None),
                                Err(e) => (None, None, Some(e)),
                            }
                        }
                        None => (None, None, Some("Chưa có cấu hình kết nối để quét sâu".to_string())),
                    }
                } else {
                    (None, None, None)
                };

                databases.push(json!({
                    "db_name": name.clone(),
                    "schema_name": Value::Null,
                    "is_system": is_system_db("postgres", &name),
                    "is_current": is_current,
                    "total_tables": tables,
                    "total_rows": total_rows,
                    "data_size_bytes": Value::Null,
                    "index_size_bytes": Value::Null,
                    "total_size_bytes": get_pg_i64_cell(r, "total_size_bytes").max(0),
                    "charset": charset,
                    "collation": collation,
                    "error": err
                }));
            }

            Ok(json!({
                "db_type": "postgres",
                "current_db": current_db,
                "deep": deep,
                "supports_deep_scan": true,
                "rows_are_exact": false,
                "databases": databases
            }))
        }
        DbConnection::Mysql(pool) => {
            let current_db: String = sqlx::query_scalar("SELECT COALESCE(DATABASE(), '')")
                .fetch_one(pool)
                .await
                .unwrap_or_default();

            // LEFT JOIN từ SCHEMATA để database rỗng (chưa có bảng nào) vẫn xuất hiện.
            let rows = sqlx::query(
                r#"
                SELECT
                    s.SCHEMA_NAME AS db_name,
                    COUNT(t.TABLE_NAME) AS total_tables,
                    COALESCE(SUM(t.TABLE_ROWS), 0) AS total_rows,
                    COALESCE(SUM(t.DATA_LENGTH), 0) AS data_size_bytes,
                    COALESCE(SUM(t.INDEX_LENGTH), 0) AS index_size_bytes,
                    COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS total_size_bytes,
                    s.DEFAULT_CHARACTER_SET_NAME AS charset,
                    s.DEFAULT_COLLATION_NAME AS collation
                FROM information_schema.SCHEMATA s
                LEFT JOIN information_schema.TABLES t
                       ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                      AND t.TABLE_TYPE = 'BASE TABLE'
                GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME
                ORDER BY total_size_bytes DESC;
                "#,
            )
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

            use sqlx::Row;
            let mut databases = Vec::new();

            for r in &rows {
                let name: String = r.get("db_name");
                let charset: Option<String> = r.try_get("charset").ok();
                let collation: Option<String> = r.try_get("collation").ok();

                databases.push(json!({
                    "db_name": name.clone(),
                    "schema_name": Value::Null,
                    "is_system": is_system_db("mysql", &name),
                    "is_current": name == current_db,
                    "total_tables": get_mysql_i64_cell(r, "total_tables").max(0),
                    "total_rows": get_mysql_i64_cell(r, "total_rows").max(0),
                    "data_size_bytes": get_mysql_i64_cell(r, "data_size_bytes").max(0),
                    "index_size_bytes": get_mysql_i64_cell(r, "index_size_bytes").max(0),
                    "total_size_bytes": get_mysql_i64_cell(r, "total_size_bytes").max(0),
                    "charset": charset,
                    "collation": collation,
                    "error": Value::Null
                }));
            }

            Ok(json!({
                "db_type": "mysql",
                "current_db": current_db,
                "deep": true,
                "supports_deep_scan": false,
                "rows_are_exact": false,
                "databases": databases
            }))
        }
    }
}

#[tauri::command]
pub async fn get_exact_table_row_count(state: State<'_, AppState>, table_name: String) -> Result<Value, String> {
    let (conn_clone, _db_type) = {
        let mgr = state.db_manager.lock().map_err(|e| e.to_string())?;
        let conn = mgr.connection.clone().ok_or_else(|| "Chưa kết nối database".to_string())?;
        (conn, mgr.db_type.clone())
    };

    match &conn_clone {
        DbConnection::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.lock().map_err(|e| e.to_string())?;
            let sql = format!("SELECT COUNT(*) FROM \"{}\"", table_name.replace('"', "\"\""));
            let count: i64 = conn.query_row(&sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
            Ok(json!({ "table_name": table_name, "exact_rows": count.max(0) }))
        }
        DbConnection::Postgres(pool) => {
            let sql = format!("SELECT COUNT(*) FROM \"{}\"", table_name.replace('"', "\"\""));
            let row = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let count = get_pg_i64_cell(&row, "count").max(0);
            Ok(json!({ "table_name": table_name, "exact_rows": count }))
        }
        DbConnection::Mysql(pool) => {
            let sql = format!("SELECT COUNT(*) FROM `{}`", table_name.replace('`', "``"));
            let row = sqlx::query(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await.map_err(|e| e.to_string())?;
            let count = get_mysql_i64_cell(&row, "COUNT(*)").max(0);
            Ok(json!({ "table_name": table_name, "exact_rows": count }))
        }
    }
}
