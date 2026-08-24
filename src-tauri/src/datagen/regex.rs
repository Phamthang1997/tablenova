//! Tập con regex được HỖ TRỢ: phân tích và LẤY MẪU từ nó.
//!
//! Crate `regex` chỉ khớp được chứ không sinh được, nên tập con này được parse và sample tay.
//! Thứ nằm ngoài tập con (`(?…)`, backreference, neo, `{n,m}` quá 64) bị từ chối NGAY LÚC
//! cấu hình cột, chứ không phải ở dòng thứ 1.000.000.

use super::rng::Rng;

// ===================== Regex subset =====================

/// Supported subset: literals, `.`, `[a-z0-9_]` (with `^` negation), `\d \w \s \D \W \S`,
/// groups with `|`, and the quantifiers `? * + {n} {n,m}`. Anything else is rejected while the
/// column is being configured, not after a million rows have been generated.
#[derive(Debug, Clone)]
pub enum Rx {
    Lit(char),
    Class(Vec<(char, char)>, bool),
    Any,
    Group(Vec<Vec<Rx>>),
    Repeat(Box<Rx>, u32, u32),
}

/// Cap for unbounded quantifiers (`*`, `+`) — without it one stray `.*` generates unbounded text.
pub(super) const RX_STAR_MAX: u32 = 8;

/// Cap for explicit `{n,m}`.
pub(super) const RX_REPEAT_MAX: u32 = 64;

pub fn parse_regex(pattern: &str) -> Result<Vec<Rx>, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let (alts, next) = parse_alt(&chars, 0)?;
    if next != chars.len() {
        return Err(format!("Regex không hợp lệ tại vị trí {}", next + 1));
    }
    if alts.len() == 1 {
        Ok(alts.into_iter().next().unwrap_or_default())
    } else {
        Ok(vec![Rx::Group(alts)])
    }
}

pub(super) fn parse_alt(chars: &[char], start: usize) -> Result<(Vec<Vec<Rx>>, usize), String> {
    let mut alts: Vec<Vec<Rx>> = Vec::new();
    let mut cur: Vec<Rx> = Vec::new();
    let mut i = start;
    while i < chars.len() {
        match chars[i] {
            ')' => break,
            '|' => {
                alts.push(std::mem::take(&mut cur));
                i += 1;
            }
            '(' => {
                // `(?...)` — lookaround/non-capturing/named groups are out of the subset.
                if chars.get(i + 1) == Some(&'?') {
                    return Err("Regex không hỗ trợ nhóm dạng (?...)".to_string());
                }
                let (inner, next) = parse_alt(chars, i + 1)?;
                if chars.get(next) != Some(&')') {
                    return Err("Regex thiếu dấu ')'".to_string());
                }
                let (node, next) = parse_quant(Rx::Group(inner), chars, next + 1)?;
                cur.push(node);
                i = next;
            }
            '[' => {
                let (node, next) = parse_class(chars, i + 1)?;
                let (node, next) = parse_quant(node, chars, next)?;
                cur.push(node);
                i = next;
            }
            '\\' => {
                let c = *chars
                    .get(i + 1)
                    .ok_or_else(|| "Regex kết thúc bằng dấu '\\'".to_string())?;
                let node = escape_node(c)?;
                let (node, next) = parse_quant(node, chars, i + 2)?;
                cur.push(node);
                i = next;
            }
            '.' => {
                let (node, next) = parse_quant(Rx::Any, chars, i + 1)?;
                cur.push(node);
                i = next;
            }
            '*' | '+' | '?' => {
                return Err(format!("Lượng từ '{}' không có ký tự đứng trước", chars[i]));
            }
            '^' | '$' => {
                return Err("Regex không hỗ trợ neo '^' và '$'".to_string());
            }
            c => {
                let (node, next) = parse_quant(Rx::Lit(c), chars, i + 1)?;
                cur.push(node);
                i = next;
            }
        }
    }
    alts.push(cur);
    Ok((alts, i))
}

pub(super) fn escape_node(c: char) -> Result<Rx, String> {
    Ok(match c {
        'd' => Rx::Class(vec![('0', '9')], false),
        'D' => Rx::Class(vec![('0', '9')], true),
        'w' => Rx::Class(vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')], false),
        'W' => Rx::Class(vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')], true),
        's' => Rx::Class(vec![(' ', ' ')], false),
        'S' => Rx::Class(vec![(' ', ' ')], true),
        'n' => Rx::Lit('\n'),
        't' => Rx::Lit('\t'),
        '1'..='9' => return Err("Regex không hỗ trợ backreference".to_string()),
        'b' | 'B' | 'A' | 'z' | 'Z' => return Err("Regex không hỗ trợ neo dạng \\b".to_string()),
        other => Rx::Lit(other),
    })
}

pub(super) fn parse_class(chars: &[char], start: usize) -> Result<(Rx, usize), String> {
    let mut i = start;
    let negated = chars.get(i) == Some(&'^');
    if negated {
        i += 1;
    }
    let mut ranges: Vec<(char, char)> = Vec::new();
    while i < chars.len() && chars[i] != ']' {
        let lo = if chars[i] == '\\' {
            let c = *chars
                .get(i + 1)
                .ok_or_else(|| "Regex kết thúc bằng dấu '\\'".to_string())?;
            i += 2;
            match escape_node(c)? {
                Rx::Lit(l) => l,
                Rx::Class(mut r, false) => {
                    ranges.append(&mut r);
                    continue;
                }
                _ => return Err("Regex không hỗ trợ ký tự này trong [...]".to_string()),
            }
        } else {
            let c = chars[i];
            i += 1;
            c
        };
        if chars.get(i) == Some(&'-') && chars.get(i + 1).is_some_and(|c| *c != ']') {
            let hi = chars[i + 1];
            i += 2;
            ranges.push(if lo <= hi { (lo, hi) } else { (hi, lo) });
        } else {
            ranges.push((lo, lo));
        }
    }
    if chars.get(i) != Some(&']') {
        return Err("Regex thiếu dấu ']'".to_string());
    }
    if ranges.is_empty() {
        return Err("Lớp ký tự [...] rỗng".to_string());
    }
    Ok((Rx::Class(ranges, negated), i + 1))
}

pub(super) fn parse_quant(node: Rx, chars: &[char], i: usize) -> Result<(Rx, usize), String> {
    match chars.get(i) {
        Some('?') => Ok((Rx::Repeat(Box::new(node), 0, 1), i + 1)),
        Some('*') => Ok((Rx::Repeat(Box::new(node), 0, RX_STAR_MAX), i + 1)),
        Some('+') => Ok((Rx::Repeat(Box::new(node), 1, RX_STAR_MAX), i + 1)),
        Some('{') => {
            let close = chars[i..]
                .iter()
                .position(|c| *c == '}')
                .map(|p| i + p)
                .ok_or_else(|| "Regex thiếu dấu '}'".to_string())?;
            let body: String = chars[i + 1..close].iter().collect();
            let (min, max) = match body.split_once(',') {
                None => {
                    let n: u32 = body
                        .trim()
                        .parse()
                        .map_err(|_| format!("Lượng từ {{{body}}} không hợp lệ"))?;
                    (n, n)
                }
                Some((a, b)) => {
                    let min: u32 = a
                        .trim()
                        .parse()
                        .map_err(|_| format!("Lượng từ {{{body}}} không hợp lệ"))?;
                    let max: u32 = if b.trim().is_empty() {
                        min.saturating_add(RX_STAR_MAX)
                    } else {
                        b.trim()
                            .parse()
                            .map_err(|_| format!("Lượng từ {{{body}}} không hợp lệ"))?
                    };
                    (min, max)
                }
            };
            if max > RX_REPEAT_MAX {
                return Err(format!("Lượng từ tối đa là {RX_REPEAT_MAX}"));
            }
            if min > max {
                return Err(format!("Lượng từ {{{body}}} có min > max"));
            }
            Ok((Rx::Repeat(Box::new(node), min, max), close + 1))
        }
        _ => Ok((node, i)),
    }
}

pub(super) const RX_ANY_FALLBACK: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

pub(super) fn sample_regex(seq: &[Rx], rng: &mut Rng, out: &mut String) {
    for node in seq {
        match node {
            Rx::Lit(c) => out.push(*c),
            Rx::Any => out.push(*rng.pick(RX_ANY_FALLBACK) as char),
            Rx::Class(ranges, negated) => {
                if *negated {
                    // Sample from the fallback alphabet and reject what the class excludes.
                    for _ in 0..32 {
                        let c = *rng.pick(RX_ANY_FALLBACK) as char;
                        if !ranges.iter().any(|(lo, hi)| c >= *lo && c <= *hi) {
                            out.push(c);
                            break;
                        }
                    }
                } else {
                    // Weight each range by its size so [a-z0-9] is not half digits.
                    let total: u32 = ranges
                        .iter()
                        .map(|(lo, hi)| (*hi as u32 - *lo as u32) + 1)
                        .sum();
                    let mut pick = rng.below(total as u64) as u32;
                    for (lo, hi) in ranges {
                        let size = (*hi as u32 - *lo as u32) + 1;
                        if pick < size {
                            if let Some(c) = char::from_u32(*lo as u32 + pick) {
                                out.push(c);
                            }
                            break;
                        }
                        pick -= size;
                    }
                }
            }
            Rx::Group(alts) => {
                if alts.is_empty() {
                    continue;
                }
                let idx = rng.below(alts.len() as u64) as usize;
                sample_regex(&alts[idx], rng, out);
            }
            Rx::Repeat(inner, min, max) => {
                let n = if max > min {
                    *min + rng.below((*max - *min + 1) as u64) as u32
                } else {
                    *min
                };
                for _ in 0..n {
                    sample_regex(std::slice::from_ref(inner.as_ref()), rng, out);
                }
            }
        }
    }
}
