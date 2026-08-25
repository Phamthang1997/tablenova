//! Text generation: lorem, slugs, stripping Vietnamese diacritics, person names / addresses, and Luhn-valid card numbers.

use crate::datagen::datasets as ds;

use super::rng::Rng;

// ===================== Lorem / composite text helpers =====================

pub(super) fn lorem_words(rng: &mut Rng, n: usize) -> String {
    let mut parts: Vec<&str> = Vec::with_capacity(n);
    for _ in 0..n {
        parts.push(rng.pick(ds::LOREM));
    }
    parts.join(" ")
}

pub(super) fn capitalize(s: &str) -> String {
    let mut it = s.chars();
    match it.next() {
        Some(c) => c.to_uppercase().collect::<String>() + it.as_str(),
        None => String::new(),
    }
}

pub(super) fn title_case(s: &str) -> String {
    s.split(' ').map(capitalize).collect::<Vec<_>>().join(" ")
}

pub(super) fn lorem_sentence(rng: &mut Rng) -> String {
    let n = 5 + rng.below(9) as usize;
    format!("{}.", capitalize(&lorem_words(rng, n)))
}

pub(super) fn lorem_paragraph(rng: &mut Rng) -> String {
    let n = 2 + rng.below(4) as usize;
    (0..n).map(|_| lorem_sentence(rng)).collect::<Vec<_>>().join(" ")
}

pub(super) fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('.') && !out.is_empty() {
            out.push('.');
        }
    }
    // Non-ASCII names (Vietnamese) can slug down to nothing useful.
    out.trim_matches('.').to_string()
}

pub(super) fn vi_deaccent(s: &str) -> String {
    // Small transliteration table: enough to turn a Vietnamese name into an email local part.
    const MAP: &[(char, char)] = &[
        ('à', 'a'), ('á', 'a'), ('ạ', 'a'), ('ả', 'a'), ('ã', 'a'), ('â', 'a'), ('ầ', 'a'),
        ('ấ', 'a'), ('ậ', 'a'), ('ẩ', 'a'), ('ẫ', 'a'), ('ă', 'a'), ('ằ', 'a'), ('ắ', 'a'),
        ('ặ', 'a'), ('ẳ', 'a'), ('ẵ', 'a'), ('è', 'e'), ('é', 'e'), ('ẹ', 'e'), ('ẻ', 'e'),
        ('ẽ', 'e'), ('ê', 'e'), ('ề', 'e'), ('ế', 'e'), ('ệ', 'e'), ('ể', 'e'), ('ễ', 'e'),
        ('ì', 'i'), ('í', 'i'), ('ị', 'i'), ('ỉ', 'i'), ('ĩ', 'i'), ('ò', 'o'), ('ó', 'o'),
        ('ọ', 'o'), ('ỏ', 'o'), ('õ', 'o'), ('ô', 'o'), ('ồ', 'o'), ('ố', 'o'), ('ộ', 'o'),
        ('ổ', 'o'), ('ỗ', 'o'), ('ơ', 'o'), ('ờ', 'o'), ('ớ', 'o'), ('ợ', 'o'), ('ở', 'o'),
        ('ỡ', 'o'), ('ù', 'u'), ('ú', 'u'), ('ụ', 'u'), ('ủ', 'u'), ('ũ', 'u'), ('ư', 'u'),
        ('ừ', 'u'), ('ứ', 'u'), ('ự', 'u'), ('ử', 'u'), ('ữ', 'u'), ('ỳ', 'y'), ('ý', 'y'),
        ('ỵ', 'y'), ('ỷ', 'y'), ('ỹ', 'y'), ('đ', 'd'),
    ];
    s.chars()
        .map(|c| {
            let lower = c.to_lowercase().next().unwrap_or(c);
            MAP.iter()
                .find(|(from, _)| *from == lower)
                .map(|(_, to)| *to)
                .unwrap_or(lower)
        })
        .collect()
}

pub(super) fn first_names(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::FIRST_NAMES_VI } else { ds::FIRST_NAMES_EN }
}

pub(super) fn last_names(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::LAST_NAMES_VI } else { ds::LAST_NAMES_EN }
}

pub(super) fn cities(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::CITIES_VI } else { ds::CITIES_EN }
}

pub(super) fn streets(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::STREETS_VI } else { ds::STREETS_EN }
}

pub(super) fn full_name(rng: &mut Rng, locale: &str) -> String {
    if locale == "vi" {
        // Surname + middle name + given name.
        format!(
            "{} {} {}",
            rng.pick(ds::LAST_NAMES_VI),
            rng.pick(ds::MIDDLE_NAMES_VI),
            rng.pick(ds::FIRST_NAMES_VI)
        )
    } else {
        format!("{} {}", rng.pick(ds::FIRST_NAMES_EN), rng.pick(ds::LAST_NAMES_EN))
    }
}

/// Appends a Luhn check digit so the number passes the usual validators.
pub(super) fn luhn_complete(digits: &str) -> String {
    let mut sum = 0u32;
    // The check digit will sit at the end, so the rightmost existing digit is "odd" position.
    for (i, c) in digits.chars().rev().enumerate() {
        let d = c.to_digit(10).unwrap_or(0);
        let d = if i % 2 == 0 { d * 2 } else { d };
        sum += if d > 9 { d - 9 } else { d };
    }
    let check = (10 - (sum % 10)) % 10;
    format!("{digits}{check}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Standard Luhn check over the finished number, independent of how the digit was computed.
    fn luhn_valid(s: &str) -> bool {
        let mut sum = 0u32;
        for (i, c) in s.chars().rev().enumerate() {
            let d = c.to_digit(10).unwrap();
            let d = if i % 2 == 1 { d * 2 } else { d };
            sum += if d > 9 { d - 9 } else { d };
        }
        sum % 10 == 0
    }

    #[test]
    fn luhn_complete_appends_a_digit_that_validates() {
        for body in ["453201511283003", "4111111111111", "37828224631000", "0", ""] {
            let full = luhn_complete(body);
            assert_eq!(full.len(), body.len() + 1, "{body}");
            assert!(full.starts_with(body), "{body}");
            assert!(luhn_valid(&full), "{full}");
        }
    }

    /// The visa test number: 4532015112830366 is the well-known valid value for this body.
    #[test]
    fn luhn_complete_matches_a_known_number() {
        assert_eq!(luhn_complete("453201511283036"), "4532015112830366");
    }

    #[test]
    fn slug_lowercases_and_joins_with_dots() {
        assert_eq!(slug("John Smith"), "john.smith");
        assert_eq!(slug("A  B"), "a.b");
        assert_eq!(slug("O'Brien"), "o.brien");
        assert_eq!(slug("  padded  "), "padded");
        assert_eq!(slug(""), "");
    }

    /// A non-ASCII name slugs down to something useless, which is exactly why `vi_deaccent` runs
    /// first when building an email local part.
    #[test]
    fn deaccenting_before_slugging_is_what_makes_it_usable() {
        assert_eq!(vi_deaccent("Nguyễn Văn A"), "nguyen van a");
        assert_eq!(slug(&vi_deaccent("Nguyễn Văn A")), "nguyen.van.a");
        assert_eq!(vi_deaccent("Đỗ Thị Hà"), "do thi ha");
    }

    /// Deaccenting also lowercases, so an ASCII name passes through unchanged except for case.
    #[test]
    fn deaccenting_leaves_ascii_alone() {
        assert_eq!(vi_deaccent("John"), "john");
        assert_eq!(vi_deaccent(""), "");
    }

    #[test]
    fn capitalize_and_title_case_handle_empty_and_multiword() {
        assert_eq!(capitalize("abc"), "Abc");
        assert_eq!(capitalize(""), "");
        assert_eq!(title_case("lorem ipsum dolor"), "Lorem Ipsum Dolor");
        assert_eq!(title_case(""), "");
    }

    #[test]
    fn generated_text_is_deterministic_per_seed() {
        let a = lorem_sentence(&mut Rng::new(4));
        let b = lorem_sentence(&mut Rng::new(4));
        assert_eq!(a, b);
        assert!(a.ends_with('.'), "{a}");
        assert_ne!(a, lorem_sentence(&mut Rng::new(5)));
    }

    #[test]
    fn full_name_uses_the_locale_lists() {
        let mut r = Rng::new(6);
        for _ in 0..30 {
            let en = full_name(&mut r, "en");
            assert!(en.split(' ').count() >= 2, "{en}");
            assert!(en.is_ascii(), "{en}");
        }
        // The Vietnamese list is a different set of names, not the English one transliterated.
        let vi = full_name(&mut Rng::new(6), "vi");
        assert_ne!(vi, full_name(&mut Rng::new(6), "en"));
    }
}
