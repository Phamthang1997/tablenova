//! So sánh GIÁ TRỊ của một ô. Thuần, không I/O.
//!
//! Chỉ nới lỏng ở chỗ số-với-chuỗi-số (`DECIMAL` về từ sqlx là chuỗi); hai chuỗi thì so
//! chính xác, nên một khác biệt thật không bao giờ bị giấu.

use serde_json::Value;

/// Dạng chuẩn của một ô để so sánh/ghép khóa.
pub(super) fn norm_scalar(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}null".to_string(),
        Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        Value::Number(n) => norm_number(&n.to_string()),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Bỏ số 0 vô nghĩa ở cuối phần thập phân: `1.50` và `1.5` là một giá trị.
pub(super) fn norm_number(s: &str) -> String {
    let t = s.trim();
    if !t.contains('.') {
        return t.to_string();
    }
    let t = t.trim_end_matches('0');
    let t = t.trim_end_matches('.');
    // "-0.0" và "0" là cùng một giá trị, đừng báo khác nhau.
    if t.is_empty() || t == "-" || t == "-0" {
        "0".to_string()
    } else {
        t.to_string()
    }
}

pub(super) fn looks_numeric(s: &str) -> bool {
    !s.trim().is_empty() && s.trim().parse::<f64>().is_ok()
}

/// Hai ô có coi là bằng nhau.
///
/// Chỉ nới lỏng ĐÚNG trường hợp cần thiết: một bên là số, bên kia là chuỗi số —
/// DECIMAL/NUMERIC được sqlx trả về dạng chuỗi nên MySQL và Postgres cho ra hai kiểu
/// JSON khác nhau cho cùng một giá trị. Hai chuỗi thì so chính xác, để không bỏ sót
/// khác biệt thật.
pub(super) fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (Value::Number(_), Value::String(s)) | (Value::String(s), Value::Number(_)) => {
            let num = if matches!(a, Value::Number(_)) { a } else { b };
            looks_numeric(s) && norm_number(s) == norm_scalar(num)
        }
        (Value::Bool(x), Value::Number(n)) | (Value::Number(n), Value::Bool(x)) => {
            n.as_f64().map(|f| (f != 0.0) == *x).unwrap_or(false)
        }
        _ => a == b,
    }
}
