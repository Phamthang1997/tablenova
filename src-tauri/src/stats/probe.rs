//! Đếm bảng / số dòng của MỘT database, kể cả database chưa có kết nối mở.

use super::cells::get_pg_i64_cell;

// Đếm bảng + số dòng ước tính của MỘT database Postgres đang kết nối.
// pg_class chỉ nhìn thấy database hiện tại, nên muốn số liệu của database khác
// bắt buộc phải mở kết nối riêng tới nó (chế độ "quét sâu").
pub(super) const PG_DB_COUNT_SQL: &str = r#"
    SELECT
        COUNT(*)::bigint AS total_tables,
        COALESCE(SUM(GREATEST(c.reltuples::bigint, 0)), 0)::bigint AS total_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
"#;

pub(super) async fn pg_count_tables_rows(pool: &sqlx::PgPool) -> Result<(i64, i64), String> {
    let row = sqlx::query(PG_DB_COUNT_SQL).fetch_one(pool).await.map_err(|e| e.to_string())?;
    Ok((
        get_pg_i64_cell(&row, "total_tables").max(0),
        get_pg_i64_cell(&row, "total_rows").max(0),
    ))
}

// Mở kết nối tạm tới một database Postgres khác để lấy số bảng/số dòng, rồi đóng ngay.
pub(super) async fn pg_count_tables_rows_remote(url: &str) -> Result<(i64, i64), String> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .map_err(|e| e.to_string())?;
    let out = pg_count_tables_rows(&pool).await;
    pool.close().await;
    out
}

// Real table names of one SQLite schema (`main`, or an ATTACHed name).
pub(super) fn sqlite_table_names(conn: &rusqlite::Connection, quoted_schema: &str) -> Vec<String> {
    let sql = format!(
        "SELECT name FROM \"{}\".sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        quoted_schema
    );
    match conn.prepare(&sql) {
        Ok(mut stmt) => stmt
            .query_map([], |r| r.get(0))
            .map(|it| it.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}
