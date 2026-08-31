//! Identifier quoting per dialect. Only Postgres gets schema-qualified, so the output for
//! MySQL/SQLite is unchanged.

pub(super) fn quote_char(dialect: &str) -> char {
    if dialect == "mysql" { '`' } else { '"' }
}

/// A table name as it must appear in generated SQL: `"sales"."film"` on Postgres.
///
/// Twin of `database.rs`'s `qualified()`. MySQL's schema is the open database and SQLite has
/// none, so only Postgres qualifies; `None` leaves the bare quoted name.
pub(super) fn qualified(dialect: &str, schema: &Option<String>, table: &str) -> String {
    match (dialect, schema.as_deref()) {
        ("postgres", Some(s)) if !s.is_empty() => {
            format!(
                "{}.{}",
                quote_ident(dialect, s),
                quote_ident(dialect, table)
            )
        }
        _ => quote_ident(dialect, table),
    }
}

pub(super) fn quote_ident(dialect: &str, name: &str) -> String {
    let q = quote_char(dialect);
    format!("{q}{name}{q}")
}
