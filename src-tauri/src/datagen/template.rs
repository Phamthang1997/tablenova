//! Mẫu chuỗi kiểu `AA-####`: mở rộng, và đếm không gian giá trị (cho cảnh báo trùng).

use super::rng::Rng;

// ===================== Template expander =====================

/// dbForge-style pattern: `#` = digit, `@` = upper letter, `?` = lower letter, `*` = alnum,
/// `\` escapes the next character. Anything else is literal.
pub fn expand_template(pattern: &str, rng: &mut Rng) -> String {
    const DIGITS: &[u8] = b"0123456789";
    const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        if c == '\\' {
            if i < chars.len() {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        let set: Option<&[u8]> = match c {
            '#' => Some(DIGITS),
            '@' => Some(UPPER),
            '?' => Some(LOWER),
            '*' => Some(ALNUM),
            _ => None,
        };
        match set {
            Some(set) => out.push(*rng.pick(set) as char),
            None => out.push(c),
        }
    }
    out
}

/// Number of distinct strings a template can produce, saturating at `u64::MAX`. Used to warn
/// before a `unique` column runs out of values.
pub fn template_space(pattern: &str) -> u64 {
    let chars: Vec<char> = pattern.chars().collect();
    let mut total: u64 = 1;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        if c == '\\' {
            i += 1;
            continue;
        }
        let n: u64 = match c {
            '#' => 10,
            '@' | '?' => 26,
            '*' => 36,
            _ => 1,
        };
        total = total.saturating_mul(n);
    }
    total
}
