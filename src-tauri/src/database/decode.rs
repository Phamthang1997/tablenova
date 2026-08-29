//! Conversion at the driver boundary: reading one cell into a `serde_json::Value`, and binding parameters the other way.
//!
//! The two macros here deliberately take an untyped `$col` so both a `&str` and a `usize` work —
//! the `&str` form is ONLY for hand-written introspection queries whose aliases are certainly unique.

use serde_json::Value;

// Decode one Postgres cell into a serde_json::Value.
// Several types are tried in turn so nothing is lost: integers/floats, bool, NUMERIC, date/time, UUID, JSON, string, blob.
// The date/decimal/json/uuid types are supported by enabling features on sqlx-postgres (without pulling in sqlx-sqlite).
macro_rules! decode_pg_cell {
    // `$col` may be a column name OR a 0-based index (both implement sqlx::ColumnIndex).
    // Callers reading a result set must pass the INDEX: `try_get` by name resolves to the
    // first column with that name, so `SELECT *` over joins would return that same first
    // value for every repeated name.
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col = $col;
        if let Ok(v) = row.try_get::<Option<i16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bool>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bigdecimal::BigDecimal>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col) { v.map(|x| json!(x.to_rfc3339())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<String>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        // Last resort: hand back the raw bytes the server sent.
        //
        // Every branch above asks sqlx to decode into a Rust type, and sqlx first checks that
        // the column's type id is compatible — so a type it has no mapping for (MySQL GEOMETRY
        // is the one that bit us: sakila's `address.location`) failed every branch and fell
        // into `Value::Null`. The cell then exported as NULL, and re-importing that dump died
        // on `location` being NOT NULL — silent data loss that only surfaced on the way back.
        // `try_get` is what enforces that check; calling Decode directly on the raw value skips
        // it, so anything the server sent survives as bytes. (`MySqlValueRef::as_bytes` is
        // pub(crate) in sqlx 0.9, hence going through Decode rather than reading it off.)
        else {
            match row.try_get_raw(col) {
                Ok(raw) if !raw.is_null() => {
                    match <Vec<u8> as sqlx::Decode<'_, sqlx::Postgres>>::decode(raw) {
                        // Postgres sends most of what lands here as text: an ENUM arrives as its
                        // label, and so do inet/interval/tsvector. Handing those back as an array
                        // of byte numbers would trade one wrong answer for another, so valid
                        // UTF-8 becomes a string and only genuinely binary payloads stay bytes.
                        Ok(b) => match std::str::from_utf8(&b) {
                            Ok(s) => json!(s),
                            Err(_) => json!(b),
                        },
                        Err(_) => Value::Null,
                    }
                }
                _ => Value::Null,
            }
        }
    }};
}

pub(crate) use decode_pg_cell;

// Decode one MySQL cell (including unsigned integer types, DECIMAL, date/time and JSON).
macro_rules! decode_mysql_cell {
    // Same contract as decode_pg_cell!: pass the 0-based INDEX when reading a result set.
    ($row:expr, $col:expr) => {{
        let row = $row;
        let col = $col;
        if let Ok(v) = row.try_get::<Option<i8>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<i64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u8>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u16>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<u64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f32>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<f64>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bool>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<bigdecimal::BigDecimal>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col) { v.map(|x| json!(x.to_rfc3339())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<chrono::NaiveTime>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(col) { v.map(|x| json!(x.to_string())).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<String>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(col) { v.map(|x| json!(x)).unwrap_or(Value::Null) }
        // Last resort: hand back the raw bytes the server sent.
        //
        // Every branch above asks sqlx to decode into a Rust type, and sqlx first checks that
        // the column's type id is compatible — so a type it has no mapping for (MySQL GEOMETRY
        // is the one that bit us: sakila's `address.location`) failed every branch and fell
        // into `Value::Null`. The cell then exported as NULL, and re-importing that dump died
        // on `location` being NOT NULL — silent data loss that only surfaced on the way back.
        // `try_get` is what enforces that check; calling Decode directly on the raw value skips
        // it, so anything the server sent survives as bytes. (`MySqlValueRef::as_bytes` is
        // pub(crate) in sqlx 0.9, hence going through Decode rather than reading it off.)
        else {
            match row.try_get_raw(col) {
                Ok(raw) if !raw.is_null() => {
                    match <Vec<u8> as sqlx::Decode<'_, sqlx::MySql>>::decode(raw) {
                        Ok(b) => json!(b),
                        Err(_) => Value::Null,
                    }
                }
                _ => Value::Null,
            }
        }
    }};
}

pub(crate) use decode_mysql_cell;

// Convert one JSON value (sent by the frontend as a query parameter) into a rusqlite Value to bind.
// Used for parameterized queries on SQLite — avoiding string interpolation (SQL injection safe).
pub(crate) fn json_to_sqlite_value(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SV;
    match v {
        Value::Null => SV::Null,
        Value::Bool(b) => SV::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) if n.is_i64() => SV::Integer(n.as_i64().unwrap()),
        Value::Number(n) if n.is_u64() => SV::Integer(n.as_u64().unwrap() as i64),
        Value::Number(n) => SV::Real(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => SV::Text(s.clone()),
        other => SV::Text(other.to_string()),
    }
}

// Bind the list of JSON parameters onto a sqlx::query for Postgres, in order (keeping the types so the DB does not complain about casts).
pub(crate) fn bind_pg_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &[Value],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
            Value::Number(n) if n.is_u64() => q.bind(n.as_u64().unwrap() as i64),
            Value::Number(n) => q.bind(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => q.bind(s.clone()),
            other => q.bind(other.to_string()),
        };
    }
    q
}

// Bind the list of JSON parameters onto a sqlx::query for MySQL, in order.
pub(crate) fn bind_mysql_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &[Value],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
            Value::Number(n) if n.is_u64() => q.bind(n.as_u64().unwrap() as i64),
            Value::Number(n) => q.bind(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => q.bind(s.clone()),
            other => q.bind(other.to_string()),
        };
    }
    q
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use rusqlite::types::Value as SV;
    use rusqlite::Connection as SqliteConnection;

    #[test]
    fn test_json_to_sqlite_value_null() {
        let val = json!(null);
        assert_eq!(json_to_sqlite_value(&val), SV::Null);
    }

    #[test]
    fn test_json_to_sqlite_value_bool() {
        assert_eq!(json_to_sqlite_value(&json!(true)), SV::Integer(1));
        assert_eq!(json_to_sqlite_value(&json!(false)), SV::Integer(0));
    }

    #[test]
    fn test_json_to_sqlite_value_number() {
        assert_eq!(json_to_sqlite_value(&json!(100)), SV::Integer(100));
        assert_eq!(json_to_sqlite_value(&json!(3.14159)), SV::Real(3.14159));
    }

    #[test]
    fn test_json_to_sqlite_value_string() {
        assert_eq!(json_to_sqlite_value(&json!("TableNova")), SV::Text("TableNova".into()));
    }

    #[test]
    fn test_sqlite_in_memory_query() -> Result<(), Box<dyn std::error::Error>> {
        let conn = SqliteConnection::open_in_memory()?;
        conn.execute("CREATE TABLE test_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);", [])?;
        conn.execute("INSERT INTO test_users (name) VALUES (?1), (?2);", ["Alice", "Bob"])?;

        let mut stmt = conn.prepare("SELECT id, name FROM test_users ORDER BY id ASC;")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let results: Vec<(i64, String)> = rows.collect::<Result<_, _>>()?;
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], (1, "Alice".into()));
        assert_eq!(results[1], (2, "Bob".into()));

        Ok(())
    }
}
