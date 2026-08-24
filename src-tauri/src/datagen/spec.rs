//! Spec mà frontend gửi xuống (`GenSpec`), ô giá trị sinh ra (`Cell`), và các hàm đọc tuỳ chọn.

use chrono::{NaiveDate, NaiveDateTime, Timelike};
use serde::Deserialize;
use serde_json::{json, Value};

// ===================== Generated cell =====================

/// One generated value, kept in the shape it will take in SQL. `Num` stays a string so a
/// DECIMAL never round-trips through f64 (`19.99` must not become `19.989999...`), and `Raw`
/// carries an expression the user typed (`NOW()`) or a dialect-specific blob literal.
#[derive(Clone, Debug)]
pub enum Cell {
    Null,
    Text(String),
    Num(String),
    Bool(bool),
    Raw(String),
}

impl Cell {
    pub(super) fn literal(&self, dialect: &str) -> String {
        match self {
            Cell::Null => "NULL".to_string(),
            Cell::Num(n) => n.clone(),
            Cell::Raw(r) => r.clone(),
            Cell::Bool(b) => {
                if dialect == "sqlite" {
                    if *b { "1".into() } else { "0".into() }
                } else if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            }
            Cell::Text(s) => {
                // MySQL treats backslash as an escape character inside string literals by
                // default, so a generated `a\b` would silently become `a<backspace>`.
                // Postgres (standard_conforming_strings=on) and SQLite take it literally.
                let escaped = if dialect == "mysql" {
                    s.replace('\\', "\\\\").replace('\'', "''")
                } else {
                    s.replace('\'', "''")
                };
                format!("'{}'", escaped)
            }
        }
    }

    pub(super) fn to_json(&self) -> Value {
        match self {
            Cell::Null => Value::Null,
            Cell::Text(s) => json!(s),
            Cell::Raw(r) => json!(r),
            Cell::Bool(b) => json!(b),
            Cell::Num(n) => n
                .parse::<i64>()
                .map(|v| json!(v))
                .or_else(|_| n.parse::<f64>().map(|v| json!(v)))
                .unwrap_or_else(|_| json!(n)),
        }
    }

    /// Key for the `unique` set. NULLs are not tracked (SQL treats them as distinct).
    pub(super) fn key(&self) -> String {
        match self {
            Cell::Null => String::new(),
            Cell::Text(s) => format!("t{s}"),
            Cell::Num(n) => format!("n{n}"),
            Cell::Bool(b) => format!("b{b}"),
            Cell::Raw(r) => format!("r{r}"),
        }
    }

    pub(super) fn from_json(v: &Value) -> Cell {
        match v {
            Value::Null => Cell::Null,
            Value::Bool(b) => Cell::Bool(*b),
            Value::Number(n) => Cell::Num(n.to_string()),
            Value::String(s) => Cell::Text(s.clone()),
            other => Cell::Text(other.to_string()),
        }
    }
}

// ===================== Spec coming from the frontend =====================

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenColumnSpec {
    pub column: String,
    /// Generator id, e.g. `integer`, `email`, `foreignKey`, or `skip` to leave the column out
    /// of the INSERT entirely (auto-increment / DEFAULT columns).
    pub generator: String,
    #[serde(default)]
    pub null_percent: Option<f64>,
    #[serde(default)]
    pub empty_percent: Option<f64>,
    #[serde(default)]
    pub unique: Option<bool>,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    /// `upper` | `lower` | `title`
    #[serde(default)]
    pub case: Option<String>,
    /// Generator-specific settings (min/max/scale/values/pattern/...).
    #[serde(default)]
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenTableSpec {
    pub table: String,
    pub rows: usize,
    /// `append` (default) | `truncate` (delete existing rows first, inside the transaction).
    #[serde(default)]
    pub mode: Option<String>,
    pub columns: Vec<GenColumnSpec>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenOptions {
    #[serde(default)]
    pub disable_constraints: Option<bool>,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub commit_every_batches: Option<usize>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenSpec {
    #[serde(default)]
    pub seed: Option<u64>,
    pub tables: Vec<GenTableSpec>,
    #[serde(default)]
    pub options: Option<GenOptions>,
}

// ===================== Small JSON helpers =====================

pub(super) fn rows_of(res: &[Value]) -> Vec<Value> {
    res.first()
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// String of a result cell. Drivers disagree on whether an `information_schema` number comes
/// back as a JSON number or string, so both are accepted.
pub(super) fn s(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub(super) fn opt_i64(row: &Value, key: &str) -> Option<i64> {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(v)) => v.parse::<i64>().ok(),
        _ => None,
    }
}

pub(super) fn o_val<'a>(options: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    options.as_ref().and_then(|o| o.get(key)).filter(|v| !v.is_null())
}

pub(super) fn o_str(options: &Option<Value>, key: &str) -> Option<String> {
    o_val(options, key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    })
}

pub(super) fn o_f64(options: &Option<Value>, key: &str) -> Option<f64> {
    o_val(options, key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    })
}

pub(super) fn o_i64(options: &Option<Value>, key: &str) -> Option<i64> {
    o_val(options, key).and_then(|v| match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

pub(super) fn o_usize(options: &Option<Value>, key: &str) -> Option<usize> {
    o_i64(options, key).and_then(|v| if v >= 0 { Some(v as usize) } else { None })
}

pub(super) fn o_arr(options: &Option<Value>, key: &str) -> Vec<Value> {
    o_val(options, key)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

pub(super) fn charset_of(opts: &Option<Value>) -> Vec<char> {
    match o_str(opts, "charset").unwrap_or_else(|| "alnum".to_string()).as_str() {
        "alpha" => "abcdefghijklmnopqrstuvwxyz".chars().collect(),
        "ALPHA" => "ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars().collect(),
        "digits" => "0123456789".chars().collect(),
        "hex" => "0123456789abcdef".chars().collect(),
        "alnum" => "abcdefghijklmnopqrstuvwxyz0123456789".chars().collect(),
        custom if !custom.is_empty() => custom.chars().collect(),
        _ => "abcdefghijklmnopqrstuvwxyz0123456789".chars().collect(),
    }
}

pub(super) fn parse_date_opt(text: &str) -> Option<NaiveDate> {
    let t = text.trim();
    NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").ok().map(|d| d.date()))
}

pub(super) fn date_bounds(opts: &Option<Value>) -> (NaiveDate, NaiveDate) {
    let default_min = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
    let default_max = NaiveDate::from_ymd_opt(2030, 12, 31).unwrap();
    let min = o_str(opts, "min").and_then(|v| parse_date_opt(&v)).unwrap_or(default_min);
    let max = o_str(opts, "max").and_then(|v| parse_date_opt(&v)).unwrap_or(default_max);
    if min <= max { (min, max) } else { (max, min) }
}

pub(super) fn datetime_bounds(opts: &Option<Value>) -> (NaiveDateTime, NaiveDateTime) {
    let to_dt = |d: NaiveDate| d.and_hms_opt(0, 0, 0).unwrap_or_default();
    let parse = |text: &str| -> Option<NaiveDateTime> {
        let t = text.trim();
        NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S")
            .ok()
            .or_else(|| NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S").ok())
            .or_else(|| parse_date_opt(t).map(to_dt))
    };
    let (dmin, dmax) = date_bounds(&None);
    let min = o_str(opts, "min").and_then(|v| parse(&v)).unwrap_or_else(|| to_dt(dmin));
    let max = o_str(opts, "max")
        .and_then(|v| parse(&v))
        .unwrap_or_else(|| to_dt(dmax).with_hour(23).and_then(|d| d.with_minute(59)).and_then(|d| d.with_second(59)).unwrap_or_else(|| to_dt(dmax)));
    if min <= max { (min, max) } else { (max, min) }
}
