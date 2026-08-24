//! Sinh văn bản: lorem, slug, bỏ dấu tiếng Việt, tên người / địa chỉ, và số thẻ hợp Luhn.

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
        // Họ + đệm + tên.
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
