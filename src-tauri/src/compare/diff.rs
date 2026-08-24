//! So hai mô tả schema: cột/index/FK nào khác nhau, và khác ở chỗ nào.
//!
//! `norm_type` cố tình chuẩn hoá `int(11)`/`INT` và `character varying`/`varchar` để
//! MySQL 5.7-vs-8 hay MySQL-vs-Postgres không báo nhiễu — độ dài thì vẫn tính.

use crate::compare::meta::{ColMeta, FkMeta, IdxMeta};

// ===================== So sánh cấu trúc =====================

/// Chuẩn hóa kiểu dữ liệu trước khi so, để hai bên chỉ khác cách viết thì không bị
/// báo là khác nhau: bỏ display-width của kiểu số nguyên (MySQL 8 không còn `int(11)`),
/// gộp các tên đồng nghĩa giữa các dialect.
pub(super) fn norm_type(raw: &str) -> String {
    let mut t = raw.trim().to_ascii_lowercase();
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");

    for base in ["tinyint", "smallint", "mediumint", "bigint", "int", "integer"] {
        if let Some(rest) = t.strip_prefix(base) {
            if rest.starts_with('(') {
                if let Some(close) = rest.find(')') {
                    t = format!("{}{}", base, &rest[close + 1..]);
                }
            }
            break;
        }
    }

    let (head, tail) = match t.find('(') {
        Some(i) => (t[..i].trim().to_string(), t[i..].to_string()),
        None => (t.clone(), String::new()),
    };
    let head = match head.as_str() {
        "integer" | "int4" | "serial" | "serial4" => "int",
        "int8" | "bigserial" | "serial8" => "bigint",
        "int2" | "smallserial" => "smallint",
        "character varying" | "varchar2" => "varchar",
        "character" | "bpchar" => "char",
        "bool" => "boolean",
        "double precision" | "float8" => "double",
        "float4" | "real" => "float",
        "timestamp without time zone" => "timestamp",
        "timestamp with time zone" | "timestamptz" => "timestamptz",
        "time without time zone" => "time",
        "decimal" | "numeric" => "decimal",
        "text" | "longtext" | "mediumtext" | "tinytext" | "clob" => "text",
        "blob" | "bytea" | "longblob" | "mediumblob" | "tinyblob" => "blob",
        other => other,
    };
    format!("{}{}", head, tail)
}

/// Giá trị mặc định hai bên có coi là giống nhau. Bỏ dấu nháy/cast của Postgres
/// (`'x'::character varying` <-> `x` của MySQL) và không phân biệt hoa/thường của
/// các hằng như CURRENT_TIMESTAMP.
pub(super) fn norm_default(raw: Option<&str>) -> String {
    let mut d = match raw {
        None => return String::new(),
        Some(s) => s.trim().to_string(),
    };
    if let Some(i) = d.find("::") {
        d = d[..i].trim().to_string();
    }
    let d = d.trim_matches('\'').trim().to_ascii_lowercase();
    match d.as_str() {
        "now()" | "current_timestamp()" => "current_timestamp".to_string(),
        _ => d,
    }
}

pub(super) fn column_changes(a: &ColMeta, b: &ColMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if norm_type(&a.data_type) != norm_type(&b.data_type) {
        ch.push("type");
    }
    if a.nullable != b.nullable {
        ch.push("nullable");
    }
    if norm_default(a.default.as_deref()) != norm_default(b.default.as_deref()) {
        ch.push("default");
    }
    if a.auto_increment != b.auto_increment {
        ch.push("autoIncrement");
    }
    if a.comment.clone().unwrap_or_default() != b.comment.clone().unwrap_or_default() {
        ch.push("comment");
    }
    if a.position != b.position {
        ch.push("position");
    }
    ch
}

pub(super) fn index_changes(a: &IdxMeta, b: &IdxMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.unique != b.unique {
        ch.push("unique");
    }
    ch
}

pub(super) fn fk_changes(a: &FkMeta, b: &FkMeta) -> Vec<&'static str> {
    let mut ch = Vec::new();
    if a.columns != b.columns {
        ch.push("columns");
    }
    if a.ref_table != b.ref_table {
        ch.push("refTable");
    }
    if a.ref_columns != b.ref_columns {
        ch.push("refColumns");
    }
    if a.on_delete.clone().unwrap_or_default().to_ascii_uppercase()
        != b.on_delete.clone().unwrap_or_default().to_ascii_uppercase()
    {
        ch.push("onDelete");
    }
    if a.on_update.clone().unwrap_or_default().to_ascii_uppercase()
        != b.on_update.clone().unwrap_or_default().to_ascii_uppercase()
    {
        ch.push("onUpdate");
    }
    ch
}

/// So sánh định nghĩa view sau khi bỏ khoảng trắng, ngoặc đơn, quotes, typecast, schema qualification —
/// hai server format khác nhau là chuyện thường, chỉ nội dung SQL thực sự khác mới đáng báo.
pub(super) fn view_def_differs(
    a: Option<&String>,
    b: Option<&String>,
    src_db: &str,
    tgt_db: &str,
    name: &str,
) -> bool {
    fn squash(s: Option<&String>, db_name: &str) -> String {
        let mut str_val = match s {
            Some(v) => v.as_str().trim(),
            None => return String::new(),
        };
        if str_val.is_empty() {
            return String::new();
        }

        let lower = str_val.to_ascii_lowercase();
        // Cắt bỏ phần tiền tố "CREATE [OR REPLACE] [ALGORITHM=...] [DEFINER=...] VIEW view_name AS "
        if let Some(v_idx) = lower.find("view ") {
            let after_view = &lower[v_idx + 5..];
            if let Some(as_idx) = after_view.find(" as ") {
                let cut_offset = v_idx + 5 + as_idx + 4;
                if cut_offset < str_val.len() {
                    str_val = &str_val[cut_offset..];
                }
            }
        } else if let Some(as_idx) = lower.find(" as ") {
            if lower.starts_with("create") || lower.starts_with("replace") {
                str_val = &str_val[as_idx + 4..];
            }
        }

        let mut cleaned = str_val
            .replace('"', "")
            .replace('`', "")
            .replace("public.", "")
            .replace("PUBLIC.", "")
            .replace("dbo.", "")
            .replace("DBO.", "")
            .replace("::text", "")
            .replace("::character varying", "")
            .replace("::varchar", "")
            .replace("::integer", "")
            .replace("::int4", "")
            .replace("::int", "")
            .replace("::bigint", "")
            .replace("::int8", "")
            .replace("::boolean", "")
            .replace("::bool", "");

        if !db_name.is_empty() {
            let pfx1 = format!("{}.", db_name.trim());
            let pfx2 = pfx1.to_ascii_lowercase();
            cleaned = cleaned.replace(&pfx1, "").replace(&pfx2, "");
        }

        cleaned = cleaned.replace('(', " ").replace(')', " ");

        cleaned
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(';')
            .to_ascii_lowercase()
    }
    let sa = squash(a, src_db);
    let sb = squash(b, tgt_db);
    if sa.is_empty() || sb.is_empty() {
        return false;
    }
    let differs = sa != sb;
    if differs {
        eprintln!("[VIEW DIFF] {}\n  SA: {}\n  SB: {}", name, sa, sb);
    }
    differs
}
