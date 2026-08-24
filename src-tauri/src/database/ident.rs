//! Trích dẫn định danh và literal theo từng dialect. Mọi chỗ dựng SQL từ tên bảng/cột đi qua đây.

use serde_json::Value;

use super::conn::{DbConnection, DbKind};

/// Defaults a Postgres schema to `public`, so a connection that never reported one behaves exactly
/// as it did before schema support existed.
///
/// This used to have a twin, `pg_schema(&DatabaseManager)`, called at 9 sites. Those sites now read
/// `ConnCtx::schema()`, which is defaulted on the way out — a call site can no longer forget to
/// default and silently query `public` (§4.4d of docs/multi-connection-plan.md). `ConnCtx` builds
/// its value with this function, so `public` is still spelled in exactly one place.
pub(crate) fn pg_schema_of(opt: &Option<String>) -> String {
    opt.clone().unwrap_or_else(|| "public".to_string())
}

/// Escape a schema/identifier for use inside a single-quoted SQL literal (`nspname = '...'`).
pub(crate) fn sql_str(s: &str) -> String {
    s.replace('\'', "''")
}

// Bọc định danh theo dialect (MySQL backtick, còn lại double quote), nhân đôi ký tự đóng.
pub(crate) fn quote_ident(conn: &DbConnection, name: &str) -> String {
    match &conn.kind {
        DbKind::Mysql(_) => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// A table name as it must appear in generated SQL: `"sales"."film"` on Postgres.
///
/// Only Postgres qualifies — MySQL's schema *is* the open database (the connection already
/// points at it) and SQLite has none. Passing `None`/empty leaves the bare quoted name, so
/// every call site keeps its old output until a schema is actually selected. This is the twin
/// of `compare.rs`'s `qualified()`; see `docs/postgres-schema-support-plan.md` §4.2 for the
/// list of sites that must use it.
pub(crate) fn qualified(conn: &DbConnection, schema: &Option<String>, table: &str) -> String {
    match (&conn.kind, schema) {
        (DbKind::Postgres(_), Some(s)) if !s.is_empty() => {
            format!("{}.{}", quote_ident(conn, s), quote_ident(conn, table))
        }
        _ => quote_ident(conn, table),
    }
}

// Bật/tắt kiểm tra khóa ngoại ở MỨC SESSION. Chỉ đúng khi mọi lệnh dùng chung một `Exec`.
// Dùng try_run: server từ chối (Postgres `session_replication_role` cần superuser) thì lệnh
// chính vẫn phải chạy, và lệnh khôi phục vẫn phải thử dù lệnh chính đã lỗi.
pub(crate) fn fk_checks_sql(conn: &DbConnection, on: bool) -> &'static str {
    match &conn.kind {
        DbKind::Mysql(_) => {
            if on { "SET FOREIGN_KEY_CHECKS = 1" } else { "SET FOREIGN_KEY_CHECKS = 0" }
        }
        DbKind::Postgres(_) => {
            if on { "SET session_replication_role = 'origin'" } else { "SET session_replication_role = 'replica'" }
        }
        DbKind::Sqlite(_) => {
            if on { "PRAGMA foreign_keys = ON" } else { "PRAGMA foreign_keys = OFF" }
        }
    }
}

// Định dạng một giá trị JSON thành literal SQL (theo cùng quy ước với commit_changes/export):
// null -> NULL, chuỗi -> '...' (escape nháy đơn), còn lại (số/bool) -> to_string().
pub(crate) fn sql_literal(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "NULL".to_string(),
        Some(Value::String(s)) => format!("'{}'", s.replace('\'', "''")),
        Some(other) => other.to_string(),
    }
}
