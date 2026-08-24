//! Đọc một ô số nguyên ra khỏi row của driver, chấp nhận mọi kiểu server có thể trả về.
//!
//! `COUNT(*)` là BIGINT trên Postgres nhưng `SUM(...)` là NUMERIC, và MySQL trả unsigned cho
//! một số cột của `information_schema` — nên phải thử lần lượt thay vì ép một kiểu.

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
