//! Mô tả schema đã chuẩn hoá — dạng trung gian mà cả ba dialect đọc về, và phần so khác
//! biệt làm việc trên đó.

use std::collections::BTreeMap;

use serde_json::{json, Value};

// ===================== Metadata =====================

#[derive(Clone, Default)]
pub(super) struct ColMeta {
    pub(super) name: String,
    pub(super) data_type: String,
    pub(super) nullable: bool,
    pub(super) default: Option<String>,
    pub(super) auto_increment: bool,
    pub(super) comment: Option<String>,
    pub(super) position: usize,
}

#[derive(Clone, Default)]
pub(super) struct IdxMeta {
    pub(super) name: String,
    pub(super) columns: Vec<String>,
    pub(super) unique: bool,
}

#[derive(Clone, Default)]
pub(super) struct FkMeta {
    pub(super) name: String,
    pub(super) columns: Vec<String>,
    pub(super) ref_table: String,
    pub(super) ref_columns: Vec<String>,
    pub(super) on_delete: Option<String>,
    pub(super) on_update: Option<String>,
}

#[derive(Clone, Default)]
pub(super) struct TableMeta {
    pub(super) name: String,
    pub(super) is_view: bool,
    pub(super) columns: Vec<ColMeta>,
    pub(super) indexes: Vec<IdxMeta>,
    pub(super) fks: Vec<FkMeta>,
    pub(super) pk: Vec<String>,
    pub(super) view_def: Option<String>,
    /// Câu CREATE gốc — chỉ SQLite có (sqlite_master.sql). Dùng lại nguyên văn khi cả hai
    /// phía đều là SQLite, vì SQLite không ALTER được và câu gốc là bản mô tả chính xác nhất.
    pub(super) create_sql: Option<String>,
}

impl TableMeta {
    pub(super) fn column(&self, name: &str) -> Option<&ColMeta> {
        self.columns.iter().find(|c| c.name == name)
    }
}

pub(super) type SchemaMeta = BTreeMap<String, TableMeta>;

pub(super) fn col_json(c: &ColMeta) -> Value {
    json!({
        "name": c.name,
        "type": c.data_type,
        "nullable": c.nullable,
        "default": c.default,
        "autoIncrement": c.auto_increment,
        "comment": c.comment,
        "position": c.position,
    })
}

pub(super) fn idx_json(i: &IdxMeta) -> Value {
    json!({ "name": i.name, "columns": i.columns, "unique": i.unique })
}

pub(super) fn fk_json(f: &FkMeta) -> Value {
    json!({
        "name": f.name,
        "columns": f.columns,
        "refTable": f.ref_table,
        "refColumns": f.ref_columns,
        "onDelete": f.on_delete,
        "onUpdate": f.on_update,
    })
}
