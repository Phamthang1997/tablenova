//! Reading one side's schema into a `SchemaMeta` — one file per dialect.

mod mysql;
mod pg;
mod sqlite;

use crate::compare::meta::SchemaMeta;
use crate::compare::side::Resolved;
use mysql::read_mysql;
use pg::read_pg;
use sqlite::read_sqlite;

pub(super) async fn read_schema(r: &Resolved) -> Result<SchemaMeta, String> {
    match r.dialect.as_str() {
        "mysql" => read_mysql(&r.conn, &r.schema).await,
        "postgres" => read_pg(&r.conn, &r.schema).await,
        "sqlite" => read_sqlite(&r.conn).await,
        _ => Err("Hệ quản trị CSDL không được hỗ trợ".to_string()),
    }
}
