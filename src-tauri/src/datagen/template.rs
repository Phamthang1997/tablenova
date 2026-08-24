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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_placeholder_draws_from_its_own_character_set() {
        let mut r = Rng::new(1);
        for _ in 0..200 {
            let s = expand_template("@?#*", &mut r);
            let c: Vec<char> = s.chars().collect();
            assert_eq!(c.len(), 4, "{s}");
            assert!(c[0].is_ascii_uppercase(), "{s}");
            assert!(c[1].is_ascii_lowercase(), "{s}");
            assert!(c[2].is_ascii_digit(), "{s}");
            assert!(c[3].is_ascii_lowercase() || c[3].is_ascii_digit(), "{s}");
        }
    }

    #[test]
    fn anything_else_is_literal_and_the_shape_is_kept() {
        let mut r = Rng::new(2);
        let s = expand_template("AA-####", &mut r);
        assert_eq!(s.len(), 7);
        assert!(s.starts_with("AA-"));
        assert!(s[3..].chars().all(|c| c.is_ascii_digit()), "{s}");
    }

    /// A backslash escapes the next character, so a template can contain a literal `#`.
    #[test]
    fn a_backslash_escapes_the_next_character() {
        let mut r = Rng::new(3);
        assert_eq!(expand_template(r"\#\@", &mut r), "#@");
        // A trailing backslash with nothing after it is dropped, not a panic.
        assert_eq!(expand_template(r"a\", &mut r), "a");
    }

    /// The twin of `templateSpace` in `src/utils/dataGenHelper.ts` — same cases on both sides.
    #[test]
    fn template_space_counts_the_placeholders() {
        assert_eq!(template_space("@?-####"), 26 * 26 * 10_000);
        assert_eq!(template_space("*"), 36);
        assert_eq!(template_space("abc"), 1);
        assert_eq!(template_space(""), 1);
    }

    #[test]
    fn template_space_treats_an_escaped_placeholder_as_a_literal() {
        assert_eq!(template_space(r"\#\#"), 1);
        assert_eq!(template_space(r"\#?"), 26);
    }

    /// Saturating rather than overflowing: the number only feeds a "you may run out of unique
    /// values" warning, and a wrapped count would say the opposite of the truth.
    #[test]
    fn template_space_saturates_instead_of_overflowing() {
        assert_eq!(template_space(&"*".repeat(64)), u64::MAX);
    }
}
