//! Nhận diện database hệ thống của từng dialect (thứ mà dashboard ẩn đi theo mặc định).

pub(super) const MYSQL_SYSTEM_DBS: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];
pub(super) const PG_SYSTEM_DBS: &[&str] = &["postgres", "template0", "template1"];

pub(super) fn is_system_db(db_type: &str, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    match db_type {
        "mysql" => MYSQL_SYSTEM_DBS.contains(&lower.as_str()),
        "postgres" => PG_SYSTEM_DBS.contains(&lower.as_str()),
        _ => false,
    }
}


// System schema names as SQL literals, for a single `NOT IN (...)` clause.
pub(super) fn system_db_sql_list(db_type: &str) -> String {
    let names: &[&str] = match db_type {
        "mysql" => MYSQL_SYSTEM_DBS,
        "postgres" => PG_SYSTEM_DBS,
        _ => &[],
    };
    names
        .iter()
        .map(|n| format!("'{}'", n))
        .collect::<Vec<_>>()
        .join(", ")
}
