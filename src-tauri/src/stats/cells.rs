//! Reads one integer cell out of a driver row, accepting every type the server may return.
//!
//! `COUNT(*)` is a BIGINT on Postgres but `SUM(...)` is NUMERIC, and MySQL returns unsigned for
//! some `information_schema` columns — so the types have to be tried in turn instead of forcing one.

pub(super) fn get_pg_i64_cell(row: &sqlx::postgres::PgRow, col: &str) -> i64 {
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

pub(super) fn get_mysql_i64_cell(row: &sqlx::mysql::MySqlRow, col: &str) -> i64 {
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
