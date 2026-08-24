//! Sinh INSERT / UPDATE / DELETE cho phần so sánh DỮ LIỆU.

use serde_json::Value;

use crate::compare::ident::{q_ident, q_lit, qualified};
use crate::compare::side::Resolved;

/// Literal SQL của một ô. Không tham số hóa được vì đây là script để người dùng đọc
/// và chạy ở nơi khác — escaping theo đúng cách `database.rs` vẫn làm.
pub(super) fn sql_value(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => q_lit(s),
        // BLOB được trả về dạng mảng byte -> hex literal (X'..' dùng được ở cả 3 dialect).
        Value::Array(a) => {
            let bytes: Option<Vec<u8>> = a
                .iter()
                .map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect();
            match bytes {
                Some(b) => format!(
                    "X'{}'",
                    b.iter().map(|x| format!("{:02X}", x)).collect::<String>()
                ),
                None => q_lit(&v.to_string()),
            }
        }
        other => q_lit(&other.to_string()),
    }
}

pub(super) fn insert_sql(tgt: &Resolved, table: &str, row: &Value, columns: &[String]) -> String {
    let cols: Vec<String> = columns.iter().map(|c| q_ident(&tgt.dialect, c)).collect();
    let vals: Vec<String> = columns
        .iter()
        .map(|c| sql_value(row.get(c.as_str()).unwrap_or(&Value::Null)))
        .collect();
    format!(
        "INSERT INTO {} ({}) VALUES ({});",
        qualified(&tgt.dialect, &tgt.schema, table),
        cols.join(", "),
        vals.join(", ")
    )
}

pub(super) fn where_key(tgt: &Resolved, row: &Value, keys: &[String]) -> String {
    keys.iter()
        .map(|k| {
            let v = row.get(k.as_str()).unwrap_or(&Value::Null);
            if v.is_null() {
                format!("{} IS NULL", q_ident(&tgt.dialect, k))
            } else {
                format!("{} = {}", q_ident(&tgt.dialect, k), sql_value(v))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub(super) fn update_sql(tgt: &Resolved, table: &str, row: &Value, changed: &[String], keys: &[String]) -> String {
    let sets: Vec<String> = changed
        .iter()
        .map(|c| {
            format!(
                "{} = {}",
                q_ident(&tgt.dialect, c),
                sql_value(row.get(c.as_str()).unwrap_or(&Value::Null))
            )
        })
        .collect();
    format!(
        "UPDATE {} SET {} WHERE {};",
        qualified(&tgt.dialect, &tgt.schema, table),
        sets.join(", "),
        where_key(tgt, row, keys)
    )
}

pub(super) fn delete_sql(tgt: &Resolved, table: &str, row: &Value, keys: &[String]) -> String {
    format!(
        "DELETE FROM {} WHERE {};",
        qualified(&tgt.dialect, &tgt.schema, table),
        where_key(tgt, row, keys)
    )
}
