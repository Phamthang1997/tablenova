//! Trích dẫn định danh và literal theo dialect ĐÍCH (script sinh ra luôn chạy trên target).


// ---- Trích dẫn định danh / literal ----

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

/// Tên bảng đầy đủ. SQLite không có schema nên chỉ trả về tên bảng.
pub(super) fn qualified(dialect: &str, schema: &str, table: &str) -> String {
    if dialect == "sqlite" || schema.is_empty() {
        q_ident(dialect, table)
    } else {
        format!("{}.{}", q_ident(dialect, schema), q_ident(dialect, table))
    }
}
