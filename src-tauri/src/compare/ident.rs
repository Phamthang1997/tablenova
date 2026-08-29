//! Quoting identifiers and literals for the TARGET dialect (the generated script always runs on the target).


// ---- Identifier / literal quoting ----

pub(super) fn q_ident(dialect: &str, name: &str) -> String {
    if dialect == "mysql" {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

pub(super) fn q_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The fully qualified table name. SQLite has no schemas, so it just returns the table name.
pub(super) fn qualified(dialect: &str, schema: &str, table: &str) -> String {
    if dialect == "sqlite" || schema.is_empty() {
        q_ident(dialect, table)
    } else {
        format!("{}.{}", q_ident(dialect, schema), q_ident(dialect, table))
    }
}
