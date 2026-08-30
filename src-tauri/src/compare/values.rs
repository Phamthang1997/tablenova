//! Comparing the VALUE of one cell. Pure, no I/O.
//!
//! The only place it is lenient is number-vs-numeric-string (a `DECIMAL` comes back from sqlx as a string);
//! two strings are compared exactly, so a real difference is never hidden.

use serde_json::Value;

/// The canonical form of a cell, for comparison / key pairing.
pub(super) fn norm_scalar(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}null".to_string(),
        Value::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(n) => norm_number(&n.to_string()),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Drops meaningless trailing zeros in the fractional part: `1.50` and `1.5` are one value.
pub(super) fn norm_number(s: &str) -> String {
    let t = s.trim();
    if !t.contains('.') {
        return t.to_string();
    }
    let t = t.trim_end_matches('0');
    let t = t.trim_end_matches('.');
    // "-0.0" and "0" are the same value, do not report them as different.
    if t.is_empty() || t == "-" || t == "-0" {
        "0".to_string()
    } else {
        t.to_string()
    }
}

pub(super) fn looks_numeric(s: &str) -> bool {
    !s.trim().is_empty() && s.trim().parse::<f64>().is_ok()
}

/// Whether two cells count as equal.
///
/// It is lenient in EXACTLY the case that needs it: one side a number, the other a numeric string —
/// DECIMAL/NUMERIC comes back from sqlx as a string, so MySQL and Postgres produce two different JSON
/// types for the same value. Two strings are compared exactly, so a real difference is never
/// missed.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The ONE case this loosens: sqlx returns DECIMAL/NUMERIC as a string, so MySQL and Postgres
    /// hand back two different JSON types for the same value.
    #[test]
    fn a_number_equals_its_own_numeric_string() {
        assert!(values_equal(&json!(1.5), &json!("1.50")));
        assert!(values_equal(&json!("1.50"), &json!(1.5)));
        assert!(values_equal(&json!(10), &json!("10")));
        assert!(!values_equal(&json!(1.5), &json!("1.6")));
    }

    /// Two strings are compared EXACTLY, so a real difference is never hidden — this is the line
    /// that keeps the whole comparison honest.
    #[test]
    fn two_strings_are_compared_exactly() {
        assert!(!values_equal(&json!("1.50"), &json!("1.5")));
        assert!(!values_equal(&json!("a"), &json!("A")));
        assert!(!values_equal(&json!(" a"), &json!("a")));
        assert!(values_equal(&json!("a"), &json!("a")));
    }

    /// NULL equals only NULL: an empty string or a zero is a value the other side does not have.
    #[test]
    fn null_matches_only_null() {
        assert!(values_equal(&json!(null), &json!(null)));
        assert!(!values_equal(&json!(null), &json!("")));
        assert!(!values_equal(&json!(null), &json!(0)));
    }

    /// MySQL has no boolean type — TINYINT(1) arrives as a number where Postgres sends a bool.
    #[test]
    fn a_bool_equals_the_number_a_tinyint_would_carry() {
        assert!(values_equal(&json!(true), &json!(1)));
        assert!(values_equal(&json!(false), &json!(0)));
        assert!(!values_equal(&json!(true), &json!(0)));
    }

    #[test]
    fn trailing_zeros_in_a_decimal_are_not_a_difference() {
        assert_eq!(norm_number("1.50"), "1.5");
        assert_eq!(norm_number("1.000"), "1");
        assert_eq!(norm_number("10"), "10");
        assert_eq!(norm_number("  2.20  "), "2.2");
        // -0.0 and 0 are the same value; reporting them as different would be noise.
        assert_eq!(norm_number("-0.0"), "0");
        assert_eq!(norm_number("0.0"), "0");
    }

    /// A NULL must not collide with the literal string "null" when the two are used as a row key.
    #[test]
    fn the_null_marker_cannot_be_typed_by_a_user() {
        assert_ne!(norm_scalar(&json!(null)), norm_scalar(&json!("null")));
        assert_eq!(norm_scalar(&json!(true)), "1");
        assert_eq!(norm_scalar(&json!(1.50)), "1.5");
        assert_eq!(norm_scalar(&json!("x")), "x");
    }

    #[test]
    fn looks_numeric_rejects_blank_and_text() {
        assert!(looks_numeric("1.5"));
        assert!(looks_numeric(" -2 "));
        assert!(!looks_numeric(""));
        assert!(!looks_numeric("   "));
        assert!(!looks_numeric("1.5x"));
    }
}
