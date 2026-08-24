// Bulk test-data generation (the "Data Generator" feature).
//
// WHY THE WHOLE ENGINE LIVES HERE AND NOT IN THE FRONTEND
//  - Volume: a real run is 10k..1M rows; generating in the WebView and shipping every value
//    over IPC pays for JSON serialisation twice.
//  - Foreign keys: a FK generator has to read the parent table, and only Rust holds the
//    connection.
//  - No twin to keep in sync. `split_sql_statements` <-> `src/sql/statements.ts` and the Rust
//    error literals <-> `backendErrors.ts` are already two hand-synced pairs; a third one
//    (a TS copy of the generators, only for preview) would silently drift, and the preview
//    would stop matching what actually gets inserted. `preview_generated_data` therefore runs
//    the SAME code path as `generate_data`, minus the writes.
//
// DETERMINISM: everything comes out of a seeded xoshiro256** — no OS entropy, no clock. The
// same spec + same seed produces byte-identical data, which is what makes a generated dataset
// worth committing to a test suite. Each column draws from its OWN substream
// (`mix(seed, table, column)`), so editing one column's settings does not shift the values of
// every other column and make the preview jump around.
//
// NO NEW CRATES: the PRNG, the regex-subset expander and the pattern/template expander are
// written here on purpose (~250 lines) instead of pulling in `rand`/`fake`/`rand_regex`. The
// only crates used are ones the app already depends on: `chrono` (dates) and `serde_json`.
// The consequence to remember is that `regex` (the crate) plays no part in generation — it can
// only match, not sample — so the subset parser below is the whole regex story.
//
// LANGUAGE: error messages are Vietnamese like the rest of the backend and are translated at
// the `dbHelper` boundary (`src/utils/backendErrors.ts`) — reword one here and you must update
// that table.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeDelta, Timelike};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::database::{execute_raw_sql_generic, DbConnection, Exec};
use crate::datasets as ds;
use crate::AppState;

/// Key under which a run registers its cancel flag in `AppState::cancel_flags`.
///
/// Scoped by `conn_id`, not fixed. One generation runs at a time **per connection** (it is a modal
/// dialog), but with several connections open two runs can overlap — and a single fixed key made the
/// second `insert` replace the first run.s flag, so that run became uncancellable and whichever run
/// finished first orphaned the other.s flag on `remove`.
fn cancel_key(conn_id: &str) -> String {
    format!("__data_generator__:{conn_id}")
}

/// Used when the frontend sends no seed. Any constant works; it must not come from the clock.
const DEFAULT_SEED: u64 = 20_260_806;

/// Rows per INSERT statement. 500 keeps the statement text far below MySQL's default
/// `max_allowed_packet`, and is dropped further for very wide tables (see `pick_batch_size`).
const DEFAULT_BATCH: usize = 500;

/// Parent-key values kept in memory for FK generators that may reference rows created in the
/// same run. A cap is needed because the parent table can itself be a million rows.
const FK_POOL_CAP: usize = 100_000;

/// Existing parent rows read to feed a FK generator.
const FK_FETCH_LIMIT: usize = 100_000;

/// Retries before giving up on a `unique` column.
const UNIQUE_RETRIES: usize = 100;

// ===================== Seeded PRNG =====================

/// xoshiro256** — 4x u64 state, period 2^256-1, seeded through SplitMix64.
pub struct Rng {
    s: [u64; 4],
}

fn split_mix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut z = seed;
        Rng {
            s: [
                split_mix64(&mut z),
                split_mix64(&mut z),
                split_mix64(&mut z),
                split_mix64(&mut z),
            ],
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in `[0, n)` via Lemire's multiply-shift with rejection. `%` would bias the low
    /// values whenever `n` does not divide 2^64.
    pub fn below(&mut self, n: u64) -> u64 {
        if n <= 1 {
            return 0;
        }
        let mut x = self.next_u64();
        let mut m = (x as u128) * (n as u128);
        let mut low = m as u64;
        if low < n {
            let threshold = n.wrapping_neg() % n;
            while low < threshold {
                x = self.next_u64();
                m = (x as u128) * (n as u128);
                low = m as u64;
            }
        }
        (m >> 64) as u64
    }

    /// Uniform in `[min, max]` (inclusive). Swapped bounds are tolerated.
    pub fn range_i64(&mut self, min: i64, max: i64) -> i64 {
        let (lo, hi) = if min <= max { (min, max) } else { (max, min) };
        let span = (hi as i128 - lo as i128) as u128 + 1;
        let span = span.min(u64::MAX as u128) as u64;
        lo.wrapping_add(self.below(span) as i64)
    }

    /// Uniform in `[0, 1)`, 53-bit mantissa.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// true with probability `percent` (0..100).
    pub fn chance(&mut self, percent: f64) -> bool {
        if percent <= 0.0 {
            return false;
        }
        if percent >= 100.0 {
            return true;
        }
        self.unit() * 100.0 < percent
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    /// Standard normal (Box-Muller), used by the `normal` distribution option.
    pub fn normal(&mut self) -> f64 {
        // 1 - unit() so the log is never taken of exactly 0.
        let u1 = 1.0 - self.unit();
        let u2 = self.unit();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}

/// Per-column substream seed: FNV-1a over (seed, table, column).
fn mix_seed(seed: u64, table: &str, column: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed;
    for part in [table.as_bytes(), b":", column.as_bytes()] {
        for b in part {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    }
    h
}

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
    fn literal(&self, dialect: &str) -> String {
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

    fn to_json(&self) -> Value {
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
    fn key(&self) -> String {
        match self {
            Cell::Null => String::new(),
            Cell::Text(s) => format!("t{s}"),
            Cell::Num(n) => format!("n{n}"),
            Cell::Bool(b) => format!("b{b}"),
            Cell::Raw(r) => format!("r{r}"),
        }
    }

    fn from_json(v: &Value) -> Cell {
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

fn rows_of(res: &[Value]) -> Vec<Value> {
    res.first()
        .and_then(|r| r.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// String of a result cell. Drivers disagree on whether an `information_schema` number comes
/// back as a JSON number or string, so both are accepted.
fn s(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn opt_i64(row: &Value, key: &str) -> Option<i64> {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(v)) => v.parse::<i64>().ok(),
        _ => None,
    }
}

fn o_val<'a>(options: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    options.as_ref().and_then(|o| o.get(key)).filter(|v| !v.is_null())
}

fn o_str(options: &Option<Value>, key: &str) -> Option<String> {
    o_val(options, key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    })
}

fn o_f64(options: &Option<Value>, key: &str) -> Option<f64> {
    o_val(options, key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    })
}

fn o_i64(options: &Option<Value>, key: &str) -> Option<i64> {
    o_val(options, key).and_then(|v| match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn o_usize(options: &Option<Value>, key: &str) -> Option<usize> {
    o_i64(options, key).and_then(|v| if v >= 0 { Some(v as usize) } else { None })
}

fn o_arr(options: &Option<Value>, key: &str) -> Vec<Value> {
    o_val(options, key)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn quote_char(dialect: &str) -> char {
    if dialect == "mysql" { '`' } else { '"' }
}

/// A table name as it must appear in generated SQL: `"sales"."film"` on Postgres.
///
/// Twin of `database.rs`'s `qualified()`. MySQL's schema is the open database and SQLite has
/// none, so only Postgres qualifies; `None` leaves the bare quoted name.
fn qualified(dialect: &str, schema: &Option<String>, table: &str) -> String {
    match (dialect, schema.as_deref()) {
        ("postgres", Some(s)) if !s.is_empty() => {
            format!("{}.{}", quote_ident(dialect, s), quote_ident(dialect, table))
        }
        _ => quote_ident(dialect, table),
    }
}

fn quote_ident(dialect: &str, name: &str) -> String {
    let q = quote_char(dialect);
    format!("{q}{name}{q}")
}

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
const RX_STAR_MAX: u32 = 8;
/// Cap for explicit `{n,m}`.
const RX_REPEAT_MAX: u32 = 64;

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

fn parse_alt(chars: &[char], start: usize) -> Result<(Vec<Vec<Rx>>, usize), String> {
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

fn escape_node(c: char) -> Result<Rx, String> {
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

fn parse_class(chars: &[char], start: usize) -> Result<(Rx, usize), String> {
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

fn parse_quant(node: Rx, chars: &[char], i: usize) -> Result<(Rx, usize), String> {
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

const RX_ANY_FALLBACK: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

fn sample_regex(seq: &[Rx], rng: &mut Rng, out: &mut String) {
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

// ===================== Lorem / composite text helpers =====================

fn lorem_words(rng: &mut Rng, n: usize) -> String {
    let mut parts: Vec<&str> = Vec::with_capacity(n);
    for _ in 0..n {
        parts.push(rng.pick(ds::LOREM));
    }
    parts.join(" ")
}

fn capitalize(s: &str) -> String {
    let mut it = s.chars();
    match it.next() {
        Some(c) => c.to_uppercase().collect::<String>() + it.as_str(),
        None => String::new(),
    }
}

fn title_case(s: &str) -> String {
    s.split(' ').map(capitalize).collect::<Vec<_>>().join(" ")
}

fn lorem_sentence(rng: &mut Rng) -> String {
    let n = 5 + rng.below(9) as usize;
    format!("{}.", capitalize(&lorem_words(rng, n)))
}

fn lorem_paragraph(rng: &mut Rng) -> String {
    let n = 2 + rng.below(4) as usize;
    (0..n).map(|_| lorem_sentence(rng)).collect::<Vec<_>>().join(" ")
}

fn slug(s: &str) -> String {
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

fn vi_deaccent(s: &str) -> String {
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

fn first_names(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::FIRST_NAMES_VI } else { ds::FIRST_NAMES_EN }
}

fn last_names(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::LAST_NAMES_VI } else { ds::LAST_NAMES_EN }
}

fn cities(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::CITIES_VI } else { ds::CITIES_EN }
}

fn streets(locale: &str) -> &'static [&'static str] {
    if locale == "vi" { ds::STREETS_VI } else { ds::STREETS_EN }
}

fn full_name(rng: &mut Rng, locale: &str) -> String {
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
fn luhn_complete(digits: &str) -> String {
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

// ===================== Column runtime state =====================

struct ColState {
    /// `table.column` — used in every error message so it never needs an outer wrapper (a
    /// wrapped Vietnamese message could not be matched by `backendErrors.ts`).
    name: String,
    generator: String,
    spec: GenColumnSpec,
    rng: Rng,
    unique: bool,
    seen: HashSet<String>,
    seq: i64,
    seq_step: i64,
    locale: String,
    dist: String,
    /// `foreignKey`, `list`, `enumValues`
    pool: Vec<Cell>,
    /// `weightedList` — cumulative weights so a pick is a binary search.
    weighted: Vec<(Cell, f64)>,
    rx: Option<Vec<Rx>>,
}

impl ColState {
    fn new(seed: u64, table: &str, spec: &GenColumnSpec) -> Result<Self, String> {
        let qualified = format!("{}.{}", table, spec.column);
        let mut rx = None;
        if spec.generator == "regex" {
            let pattern = o_str(&spec.options, "pattern").unwrap_or_default();
            if pattern.is_empty() {
                return Err(format!("Cột '{}' thiếu biểu thức regex", qualified));
            }
            rx = Some(
                parse_regex(&pattern)
                    .map_err(|e| format!("Regex của cột '{}' không hợp lệ: {}", qualified, e))?,
            );
        }

        let mut pool: Vec<Cell> = Vec::new();
        if spec.generator == "list" || spec.generator == "enumValues" {
            pool = o_arr(&spec.options, "values").iter().map(Cell::from_json).collect();
            if pool.is_empty() {
                return Err(format!("Cột '{}' chưa có danh sách giá trị", qualified));
            }
        }

        let mut weighted: Vec<(Cell, f64)> = Vec::new();
        if spec.generator == "weightedList" {
            let mut acc = 0.0;
            for item in o_arr(&spec.options, "values") {
                // Accepts [value, weight] or {value, weight}.
                let (v, w) = match &item {
                    Value::Array(a) => (
                        a.first().cloned().unwrap_or(Value::Null),
                        a.get(1).and_then(|w| w.as_f64()).unwrap_or(1.0),
                    ),
                    Value::Object(o) => (
                        o.get("value").cloned().unwrap_or(Value::Null),
                        o.get("weight").and_then(|w| w.as_f64()).unwrap_or(1.0),
                    ),
                    other => (other.clone(), 1.0),
                };
                if w <= 0.0 {
                    continue;
                }
                acc += w;
                weighted.push((Cell::from_json(&v), acc));
            }
            if weighted.is_empty() {
                return Err(format!("Cột '{}' chưa có danh sách giá trị có trọng số", qualified));
            }
        }

        Ok(ColState {
            name: qualified,
            generator: spec.generator.clone(),
            spec: spec.clone(),
            rng: Rng::new(mix_seed(seed, table, &spec.column)),
            unique: spec.unique.unwrap_or(false),
            seen: HashSet::new(),
            seq: o_i64(&spec.options, "start").unwrap_or(1),
            seq_step: o_i64(&spec.options, "step").unwrap_or(1).max(1),
            locale: o_str(&spec.options, "locale").unwrap_or_else(|| "en".to_string()),
            dist: o_str(&spec.options, "distribution").unwrap_or_else(|| "uniform".to_string()),
            pool,
            weighted,
            rx,
        })
    }

    /// One value, honouring nullPercent / unique / prefix / suffix / case.
    fn next_cell(&mut self, dialect: &str) -> Result<Cell, String> {
        if let Some(p) = self.spec.null_percent {
            if self.rng.chance(p) {
                return Ok(Cell::Null);
            }
        }
        let attempts = if self.unique { UNIQUE_RETRIES } else { 1 };
        for _ in 0..attempts {
            let base = self.base_cell(dialect)?;
            let cell = self.decorate(base);
            if !self.unique {
                return Ok(cell);
            }
            if self.seen.insert(cell.key()) {
                return Ok(cell);
            }
        }
        Err(format!(
            "Không sinh đủ giá trị khác nhau cho cột '{}' sau {} lần thử",
            self.name, UNIQUE_RETRIES
        ))
    }

    fn decorate(&mut self, cell: Cell) -> Cell {
        // Only text is decorated; a number keeps its exact literal.
        let text = match cell {
            Cell::Text(t) => t,
            other => return other,
        };
        if let Some(p) = self.spec.empty_percent {
            if self.rng.chance(p) {
                return Cell::Text(String::new());
            }
        }
        let mut out = match self.spec.case.as_deref() {
            Some("upper") => text.to_uppercase(),
            Some("lower") => text.to_lowercase(),
            Some("title") => title_case(&text),
            _ => text,
        };
        if let Some(p) = &self.spec.prefix {
            out = format!("{p}{out}");
        }
        if let Some(s) = &self.spec.suffix {
            out.push_str(s);
        }
        Cell::Text(out)
    }

    /// Unit sample in `[0, 1)` shaped by the `distribution` option.
    fn shaped_unit(&mut self) -> f64 {
        match self.dist.as_str() {
            "normal" => (self.rng.normal() * 0.18 + 0.5).clamp(0.0, 0.999_999),
            "exponential" => {
                let u = 1.0 - self.rng.unit();
                (-u.ln() / 4.0).clamp(0.0, 0.999_999)
            }
            _ => self.rng.unit(),
        }
    }

    fn base_cell(&mut self, dialect: &str) -> Result<Cell, String> {
        let opts = self.spec.options.clone();
        let g = self.generator.clone();
        let loc = self.locale.clone();

        let cell = match g.as_str() {
            "null" => Cell::Null,

            // ---- numbers ----
            "integer" | "smallint" | "bigint" => {
                let min = o_i64(&opts, "min").unwrap_or(1);
                let max = o_i64(&opts, "max").unwrap_or(if g == "bigint" { 1_000_000_000 } else { 100_000 });
                let unit = self.shaped_unit();
                let span = (max as i128 - min as i128).unsigned_abs() as f64;
                Cell::Num(((min.min(max) as f64) + unit * span).round().to_string())
            }
            "decimal" => {
                let min = o_f64(&opts, "min").unwrap_or(0.0);
                let max = o_f64(&opts, "max").unwrap_or(10_000.0);
                let scale = o_usize(&opts, "scale").unwrap_or(2).min(10);
                let unit = self.shaped_unit();
                let v = min + unit * (max - min);
                Cell::Num(format!("{v:.scale$}"))
            }
            "float" => {
                let min = o_f64(&opts, "min").unwrap_or(0.0);
                let max = o_f64(&opts, "max").unwrap_or(1.0);
                let unit = self.shaped_unit();
                Cell::Num(format!("{:.6}", min + unit * (max - min)))
            }
            "bool" => {
                let p = o_f64(&opts, "truePercent").unwrap_or(50.0);
                Cell::Bool(self.rng.chance(p))
            }
            "sequence" => {
                let v = self.seq;
                self.seq = self.seq.saturating_add(self.seq_step);
                Cell::Num(v.to_string())
            }
            "year" => {
                let min = o_i64(&opts, "min").unwrap_or(1990);
                let max = o_i64(&opts, "max").unwrap_or(2030);
                Cell::Num(self.rng.range_i64(min, max).to_string())
            }
            "latitude" => Cell::Num(format!("{:.6}", -90.0 + self.rng.unit() * 180.0)),
            "longitude" => Cell::Num(format!("{:.6}", -180.0 + self.rng.unit() * 360.0)),

            // ---- date / time ----
            "date" => {
                let (min, max) = date_bounds(&opts);
                let days = (max - min).num_days().max(0);
                let d = min
                    .checked_add_signed(TimeDelta::days(self.rng.range_i64(0, days)))
                    .unwrap_or(min);
                Cell::Text(d.format("%Y-%m-%d").to_string())
            }
            "time" => {
                let secs = self.rng.below(86_400) as u32;
                let t = NaiveTime::from_num_seconds_from_midnight_opt(secs, 0)
                    .unwrap_or_else(|| NaiveTime::from_hms_opt(0, 0, 0).unwrap());
                Cell::Text(t.format("%H:%M:%S").to_string())
            }
            "datetime" | "timestamp" => {
                let (min, max) = datetime_bounds(&opts);
                let secs = (max - min).num_seconds().max(0);
                let dt = min
                    .checked_add_signed(TimeDelta::seconds(self.rng.range_i64(0, secs)))
                    .unwrap_or(min);
                Cell::Text(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            }

            // ---- text ----
            "string" => {
                let charset = charset_of(&opts);
                let min_len = o_usize(&opts, "minLength").unwrap_or(5);
                let max_len = o_usize(&opts, "maxLength").unwrap_or(min_len.max(12)).max(min_len);
                let len = min_len + self.rng.below((max_len - min_len + 1) as u64) as usize;
                let mut out = String::with_capacity(len);
                for _ in 0..len {
                    out.push(*self.rng.pick(&charset));
                }
                Cell::Text(out)
            }
            "password" => {
                const CS: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
                let len = o_usize(&opts, "length").unwrap_or(12).clamp(4, 64);
                let mut out = String::with_capacity(len);
                for _ in 0..len {
                    out.push(*self.rng.pick(CS) as char);
                }
                Cell::Text(out)
            }
            "word" => Cell::Text(lorem_words(&mut self.rng, 1)),
            "title" => {
                // Word count first: `lorem_words(&mut self.rng, self.rng...)` would borrow
                // `self.rng` twice in one expression.
                let n = 2 + self.rng.below(3) as usize;
                Cell::Text(title_case(&lorem_words(&mut self.rng, n)))
            }
            "sentence" => Cell::Text(lorem_sentence(&mut self.rng)),
            "paragraph" | "text" => {
                let max_len = o_usize(&opts, "maxLength").unwrap_or(0);
                let mut out = if g == "text" {
                    lorem_sentence(&mut self.rng)
                } else {
                    lorem_paragraph(&mut self.rng)
                };
                if max_len > 0 && out.chars().count() > max_len {
                    out = out.chars().take(max_len).collect();
                }
                Cell::Text(out)
            }
            "template" => {
                let pattern = o_str(&opts, "pattern").unwrap_or_else(|| "??-####".to_string());
                Cell::Text(expand_template(&pattern, &mut self.rng))
            }
            "regex" => {
                let mut out = String::new();
                // take/put back instead of clone: the AST would otherwise be cloned per row.
                if let Some(rx) = self.rx.take() {
                    sample_regex(&rx, &mut self.rng, &mut out);
                    self.rx = Some(rx);
                }
                Cell::Text(out)
            }
            "uuid" => {
                let mut b = [0u8; 16];
                for chunk in b.chunks_mut(8) {
                    let v = self.rng.next_u64().to_le_bytes();
                    chunk.copy_from_slice(&v[..chunk.len()]);
                }
                // Version 4 + RFC 4122 variant bits.
                b[6] = (b[6] & 0x0f) | 0x40;
                b[8] = (b[8] & 0x3f) | 0x80;
                let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
                Cell::Text(format!(
                    "{}-{}-{}-{}-{}",
                    &hex[0..8],
                    &hex[8..12],
                    &hex[12..16],
                    &hex[16..20],
                    &hex[20..32]
                ))
            }
            "json" => {
                let keys = o_arr(&opts, "keys");
                let mut map = Map::new();
                if keys.is_empty() {
                    map.insert("id".into(), json!(self.rng.range_i64(1, 100_000)));
                    map.insert("name".into(), json!(lorem_words(&mut self.rng, 2)));
                    map.insert("active".into(), json!(self.rng.chance(70.0)));
                } else {
                    for k in keys {
                        let key = k.as_str().unwrap_or("key").to_string();
                        map.insert(key, json!(lorem_words(&mut self.rng, 1)));
                    }
                }
                Cell::Text(Value::Object(map).to_string())
            }
            "blob" => {
                let len = o_usize(&opts, "length").unwrap_or(8).clamp(1, 4096);
                let mut hex = String::with_capacity(len * 2);
                for _ in 0..len {
                    hex.push_str(&format!("{:02x}", self.rng.below(256) as u8));
                }
                Cell::Raw(match dialect {
                    "postgres" => format!("'\\x{hex}'::bytea"),
                    _ => format!("X'{hex}'"),
                })
            }
            "expression" => {
                let sql = o_str(&opts, "sql").unwrap_or_default();
                if sql.trim().is_empty() {
                    return Err(format!("Cột '{}' chưa có biểu thức SQL", self.name));
                }
                Cell::Raw(sql)
            }

            // ---- lists ----
            "list" | "enumValues" => {
                let idx = self.rng.below(self.pool.len() as u64) as usize;
                self.pool[idx].clone()
            }
            "weightedList" => {
                let total = self.weighted.last().map(|(_, w)| *w).unwrap_or(1.0);
                let target = self.rng.unit() * total;
                let idx = self
                    .weighted
                    .partition_point(|(_, cum)| *cum <= target)
                    .min(self.weighted.len() - 1);
                self.weighted[idx].0.clone()
            }
            "foreignKey" => {
                if self.pool.is_empty() {
                    Cell::Null
                } else {
                    let idx = self.rng.below(self.pool.len() as u64) as usize;
                    self.pool[idx].clone()
                }
            }

            // ---- meaningful ----
            "firstName" => Cell::Text(self.rng.pick(first_names(&loc)).to_string()),
            "lastName" => Cell::Text(self.rng.pick(last_names(&loc)).to_string()),
            "fullName" => Cell::Text(full_name(&mut self.rng, &loc)),
            "gender" => Cell::Text(if self.rng.chance(50.0) { "male".into() } else { "female".into() }),
            "email" => {
                let domains = {
                    let custom: Vec<String> = o_arr(&opts, "domains")
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    if custom.is_empty() {
                        ds::EMAIL_DOMAINS.iter().map(|d| d.to_string()).collect()
                    } else {
                        custom
                    }
                };
                let first = self.rng.pick(first_names(&loc)).to_string();
                let last = self.rng.pick(last_names(&loc)).to_string();
                let local = slug(&vi_deaccent(&format!("{first} {last}")));
                let n = self.rng.below(1000);
                let domain = self.rng.pick(&domains).clone();
                Cell::Text(format!("{local}{n}@{domain}"))
            }
            "username" => {
                let first = self.rng.pick(first_names(&loc)).to_string();
                let n = self.rng.below(10_000);
                Cell::Text(format!("{}{}", vi_deaccent(&first), n))
            }
            "phone" => {
                if loc == "vi" {
                    const PREFIX: &[&str] = &["032", "033", "034", "035", "036", "037", "038", "039", "070", "076", "077", "078", "079", "081", "082", "083", "084", "085", "086", "088", "090", "091", "094", "096", "097", "098"];
                    Cell::Text(format!("{}{:07}", self.rng.pick(PREFIX), self.rng.below(10_000_000)))
                } else {
                    Cell::Text(format!(
                        "+1-{:03}-{:03}-{:04}",
                        200 + self.rng.below(700),
                        self.rng.below(1000),
                        self.rng.below(10_000)
                    ))
                }
            }
            "city" => Cell::Text(self.rng.pick(cities(&loc)).to_string()),
            "country" => Cell::Text(self.rng.pick(ds::COUNTRIES).to_string()),
            "countryCode" => Cell::Text(self.rng.pick(ds::COUNTRY_CODES).to_string()),
            "street" => {
                let no = 1 + self.rng.below(300);
                Cell::Text(format!("{no} {}", self.rng.pick(streets(&loc))))
            }
            "address" => {
                let no = 1 + self.rng.below(300);
                let street = self.rng.pick(streets(&loc)).to_string();
                let city = self.rng.pick(cities(&loc)).to_string();
                Cell::Text(format!("{no} {street}, {city}"))
            }
            "zipCode" => Cell::Text(format!("{:05}", self.rng.below(100_000))),
            "timezone" => Cell::Text(self.rng.pick(ds::TIMEZONES).to_string()),
            "company" => Cell::Text(format!(
                "{} {}",
                self.rng.pick(ds::COMPANY_WORDS),
                self.rng.pick(ds::COMPANY_SUFFIX)
            )),
            "department" => Cell::Text(self.rng.pick(ds::DEPARTMENTS).to_string()),
            "jobTitle" => Cell::Text(self.rng.pick(ds::JOB_TITLES).to_string()),
            "productName" => Cell::Text(format!(
                "{} {}",
                self.rng.pick(ds::PRODUCT_ADJECTIVES),
                self.rng.pick(ds::PRODUCT_NOUNS)
            )),
            "sku" => Cell::Text(format!(
                "{}{}-{:05}",
                (b'A' + self.rng.below(26) as u8) as char,
                (b'A' + self.rng.below(26) as u8) as char,
                self.rng.below(100_000)
            )),
            "currencyCode" => Cell::Text(self.rng.pick(ds::CURRENCY_CODES).to_string()),
            "orderStatus" => Cell::Text(self.rng.pick(ds::ORDER_STATUSES).to_string()),
            "creditCard" => {
                let mut digits = String::with_capacity(15);
                digits.push('4');
                for _ in 0..14 {
                    digits.push_str(&self.rng.below(10).to_string());
                }
                Cell::Text(luhn_complete(&digits))
            }
            "ipv4" => Cell::Text(format!(
                "{}.{}.{}.{}",
                1 + self.rng.below(223),
                self.rng.below(256),
                self.rng.below(256),
                1 + self.rng.below(254)
            )),
            "ipv6" => {
                let groups: Vec<String> = (0..8).map(|_| format!("{:04x}", self.rng.below(65_536))).collect();
                Cell::Text(groups.join(":"))
            }
            "macAddress" => {
                let bytes: Vec<String> = (0..6).map(|_| format!("{:02x}", self.rng.below(256))).collect();
                Cell::Text(bytes.join(":"))
            }
            "domain" => Cell::Text(self.rng.pick(ds::URL_HOSTS).to_string()),
            "url" => {
                let host = self.rng.pick(ds::URL_HOSTS).to_string();
                let path = self.rng.pick(ds::URL_PATHS).to_string();
                Cell::Text(if path.is_empty() {
                    format!("https://{host}")
                } else {
                    format!("https://{host}/{path}")
                })
            }
            "hexColor" => Cell::Text(format!("#{:06x}", self.rng.below(0x100_0000))),
            "mimeType" => Cell::Text(self.rng.pick(ds::MIME_TYPES).to_string()),
            "fileName" => Cell::Text(format!(
                "{}-{}.{}",
                lorem_words(&mut self.rng, 1),
                self.rng.below(1000),
                self.rng.pick(ds::FILE_EXTENSIONS)
            )),

            other => return Err(format!("Generator '{other}' không được hỗ trợ")),
        };
        Ok(cell)
    }
}

fn charset_of(opts: &Option<Value>) -> Vec<char> {
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

fn parse_date_opt(text: &str) -> Option<NaiveDate> {
    let t = text.trim();
    NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").ok().map(|d| d.date()))
}

fn date_bounds(opts: &Option<Value>) -> (NaiveDate, NaiveDate) {
    let default_min = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
    let default_max = NaiveDate::from_ymd_opt(2030, 12, 31).unwrap();
    let min = o_str(opts, "min").and_then(|v| parse_date_opt(&v)).unwrap_or(default_min);
    let max = o_str(opts, "max").and_then(|v| parse_date_opt(&v)).unwrap_or(default_max);
    if min <= max { (min, max) } else { (max, min) }
}

fn datetime_bounds(opts: &Option<Value>) -> (NaiveDateTime, NaiveDateTime) {
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

// ===================== Database metadata =====================

#[derive(Debug, Clone)]
pub struct ColMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub auto_inc: bool,
    pub has_default: bool,
    pub max_len: Option<i64>,
    pub scale: Option<i64>,
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FkMeta {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone)]
pub struct TableMeta {
    pub name: String,
    pub columns: Vec<ColMeta>,
    pub fks: Vec<FkMeta>,
}

impl TableMeta {
    fn fk_of(&self, column: &str) -> Option<&FkMeta> {
        self.fks.iter().find(|f| f.column == column)
    }
}

fn parse_enum_type(column_type: &str) -> Vec<String> {
    // MySQL COLUMN_TYPE looks like: enum('a','b') / set('x','y')
    let lower = column_type.to_lowercase();
    if !(lower.starts_with("enum(") || lower.starts_with("set(")) {
        return Vec::new();
    }
    let inner = match (column_type.find('('), column_type.rfind(')')) {
        (Some(a), Some(b)) if b > a => &column_type[a + 1..b],
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if in_str && chars.peek() == Some(&'\'') => {
                cur.push('\'');
                chars.next();
            }
            '\'' => {
                if in_str {
                    out.push(std::mem::take(&mut cur));
                }
                in_str = !in_str;
            }
            _ if in_str => cur.push(c),
            _ => {}
        }
    }
    out
}

async fn query_rows(conn: &DbConnection, sql: &str) -> Result<Vec<Value>, String> {
    Ok(rows_of(&execute_raw_sql_generic(conn, sql.to_string()).await?))
}

/// Reads columns + foreign keys of the base tables. `only` limits the work for SQLite, whose
/// metadata needs one PRAGMA per table.
pub async fn collect_meta(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    only: Option<&[String]>,
) -> Result<Vec<TableMeta>, String> {
    // Postgres only; the MySQL branch below filters by DATABASE() and SQLite has no schema.
    let sch = schema.clone().unwrap_or_else(|| "public".to_string()).replace('\'', "''");
    let mut metas: Vec<TableMeta> = Vec::new();

    match dialect {
        "mysql" => {
            let tables = query_rows(
                conn,
                "SELECT TABLE_NAME AS tname FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }
            let mut cols: HashMap<String, Vec<ColMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, DATA_TYPE AS dtype, \
                        COLUMN_TYPE AS ctype, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, \
                        EXTRA AS extra, COLUMN_DEFAULT AS cdefault, \
                        CHARACTER_MAXIMUM_LENGTH AS maxlen, NUMERIC_SCALE AS nscale \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
            )
            .await?
            {
                let ctype = s(&r, "ctype");
                cols.entry(s(&r, "tname")).or_default().push(ColMeta {
                    name: s(&r, "cname"),
                    data_type: ctype.clone(),
                    nullable: s(&r, "nullable").eq_ignore_ascii_case("YES"),
                    is_pk: s(&r, "ckey") == "PRI",
                    auto_inc: s(&r, "extra").to_lowercase().contains("auto_increment"),
                    has_default: r.get("cdefault").map(|v| !v.is_null()).unwrap_or(false),
                    max_len: opt_i64(&r, "maxlen"),
                    scale: opt_i64(&r, "nscale"),
                    enum_values: parse_enum_type(&ctype),
                });
            }
            let mut fks: HashMap<String, Vec<FkMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT TABLE_NAME AS tname, COLUMN_NAME AS cname, \
                        REFERENCED_TABLE_NAME AS rtable, REFERENCED_COLUMN_NAME AS rcolumn \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL",
            )
            .await?
            {
                fks.entry(s(&r, "tname")).or_default().push(FkMeta {
                    column: s(&r, "cname"),
                    ref_table: s(&r, "rtable"),
                    ref_column: s(&r, "rcolumn"),
                });
            }
            for t in order {
                metas.push(TableMeta {
                    columns: cols.remove(&t).unwrap_or_default(),
                    fks: fks.remove(&t).unwrap_or_default(),
                    name: t,
                });
            }
        }
        "postgres" => {
            let tables = query_rows(
                conn,
                &format!(
                    "SELECT table_name AS tname FROM information_schema.tables \
                     WHERE table_schema = '{sch}' AND table_type = 'BASE TABLE' ORDER BY table_name"
                ),
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }

            // Enum labels per user type, so an enum column offers its real values.
            let mut enum_labels: HashMap<String, Vec<String>> = HashMap::new();
            for r in query_rows(
                conn,
                "SELECT t.typname AS tname, e.enumlabel AS label FROM pg_type t \
                 JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY e.enumsortorder",
            )
            .await
            .unwrap_or_default()
            {
                enum_labels.entry(s(&r, "tname")).or_default().push(s(&r, "label"));
            }

            let mut pks: HashMap<String, HashSet<String>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    "SELECT tc.table_name AS tname, kcu.column_name AS cname \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '{sch}'"
                ),
            )
            .await?
            {
                pks.entry(s(&r, "tname")).or_default().insert(s(&r, "cname"));
            }

            let mut cols: HashMap<String, Vec<ColMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    "SELECT table_name AS tname, column_name AS cname, data_type AS dtype, \
                            udt_name AS udt, is_nullable AS nullable, column_default AS cdefault, \
                            is_identity AS identity, character_maximum_length AS maxlen, \
                            numeric_scale AS nscale \
                     FROM information_schema.columns WHERE table_schema = '{sch}' \
                     ORDER BY table_name, ordinal_position"
                ),
            )
            .await?
            {
                let tname = s(&r, "tname");
                let cname = s(&r, "cname");
                let default = s(&r, "cdefault");
                let dtype = s(&r, "dtype");
                let udt = s(&r, "udt");
                let enum_values = if dtype == "USER-DEFINED" {
                    enum_labels.get(&udt).cloned().unwrap_or_default()
                } else {
                    Vec::new()
                };
                let is_pk = pks.get(&tname).map(|set| set.contains(&cname)).unwrap_or(false);
                cols.entry(tname).or_default().push(ColMeta {
                    name: cname,
                    data_type: if dtype == "USER-DEFINED" { udt } else { dtype },
                    nullable: s(&r, "nullable").eq_ignore_ascii_case("YES"),
                    is_pk,
                    auto_inc: default.contains("nextval") || s(&r, "identity").eq_ignore_ascii_case("YES"),
                    has_default: !default.is_empty(),
                    max_len: opt_i64(&r, "maxlen"),
                    scale: opt_i64(&r, "nscale"),
                    enum_values,
                });
            }

            let mut fks: HashMap<String, Vec<FkMeta>> = HashMap::new();
            for r in query_rows(
                conn,
                &format!(
                    "SELECT tc.table_name AS tname, kcu.column_name AS cname, \
                            ccu.table_name AS rtable, ccu.column_name AS rcolumn \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     JOIN information_schema.constraint_column_usage ccu \
                       ON ccu.constraint_name = tc.constraint_name \
                     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '{sch}'"
                ),
            )
            .await?
            {
                fks.entry(s(&r, "tname")).or_default().push(FkMeta {
                    column: s(&r, "cname"),
                    ref_table: s(&r, "rtable"),
                    ref_column: s(&r, "rcolumn"),
                });
            }
            for t in order {
                metas.push(TableMeta {
                    columns: cols.remove(&t).unwrap_or_default(),
                    fks: fks.remove(&t).unwrap_or_default(),
                    name: t,
                });
            }
        }
        _ => {
            // SQLite: one PRAGMA pair per table, so `only` really matters here.
            let tables = query_rows(
                conn,
                "SELECT name AS tname FROM sqlite_master WHERE type = 'table' \
                 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .await?;
            let mut order: Vec<String> = tables.iter().map(|r| s(r, "tname")).collect();
            if let Some(keep) = only {
                order.retain(|t| keep.iter().any(|k| k == t));
            }
            for t in order {
                let mut columns = Vec::new();
                for r in query_rows(conn, &format!("PRAGMA table_info(\"{}\")", t.replace('"', "\"\""))).await? {
                    let dtype = s(&r, "type");
                    let is_pk = opt_i64(&r, "pk").unwrap_or(0) > 0;
                    let default = r.get("dflt_value").map(|v| !v.is_null()).unwrap_or(false);
                    columns.push(ColMeta {
                        name: s(&r, "name"),
                        // INTEGER PRIMARY KEY is the rowid alias -> effectively auto-increment.
                        auto_inc: is_pk && dtype.to_uppercase().contains("INT"),
                        data_type: dtype,
                        nullable: opt_i64(&r, "notnull").unwrap_or(0) == 0,
                        is_pk,
                        has_default: default,
                        max_len: None,
                        scale: None,
                        enum_values: Vec::new(),
                    });
                }
                let mut fks = Vec::new();
                for r in query_rows(
                    conn,
                    &format!("PRAGMA foreign_key_list(\"{}\")", t.replace('"', "\"\"")),
                )
                .await
                .unwrap_or_default()
                {
                    fks.push(FkMeta {
                        column: s(&r, "from"),
                        ref_table: s(&r, "table"),
                        ref_column: s(&r, "to"),
                    });
                }
                metas.push(TableMeta { name: t, columns, fks });
            }
        }
    }

    Ok(metas)
}

/// Insertion order: parents before children. Kahn's algorithm, keeping the caller's order as
/// the tie-break so the result is stable. Returns the tables that are still part of a cycle.
pub fn topo_order(tables: &[String], fks: &HashMap<String, Vec<FkMeta>>) -> (Vec<String>, Vec<String>) {
    let in_scope: HashSet<&String> = tables.iter().collect();
    // deps[child] = parents that must be inserted first (self-references ignored: a row can
    // point at another row of the same table, which no ordering can fix).
    let mut deps: HashMap<String, HashSet<String>> = HashMap::new();
    for t in tables {
        let mut set = HashSet::new();
        for fk in fks.get(t).map(|v| v.as_slice()).unwrap_or(&[]) {
            if fk.ref_table != *t && in_scope.contains(&fk.ref_table) {
                set.insert(fk.ref_table.clone());
            }
        }
        deps.insert(t.clone(), set);
    }

    let mut out: Vec<String> = Vec::with_capacity(tables.len());
    let mut done: HashSet<String> = HashSet::new();
    loop {
        let mut progressed = false;
        for t in tables {
            if done.contains(t) {
                continue;
            }
            let ready = deps
                .get(t)
                .map(|d| d.iter().all(|p| done.contains(p)))
                .unwrap_or(true);
            if ready {
                out.push(t.clone());
                done.insert(t.clone());
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    let cyclic: Vec<String> = tables.iter().filter(|t| !done.contains(*t)).cloned().collect();
    // Cyclic tables still have to be generated; they go last and need constraints turned off.
    let mut order = out;
    order.extend(cyclic.iter().cloned());
    (order, cyclic)
}

// ===================== Generator suggestion =====================

fn type_family(data_type: &str) -> &'static str {
    let t = data_type.to_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("").to_string();
    match base.as_str() {
        "tinyint" if t.starts_with("tinyint(1)") => "bool",
        "bool" | "boolean" | "bit" => "bool",
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "int2" | "int4" | "serial"
        | "smallserial" => "int",
        "bigint" | "int8" | "bigserial" => "bigint",
        "decimal" | "numeric" | "money" => "decimal",
        "float" | "double" | "real" | "float4" | "float8" => "float",
        "date" => "date",
        "time" | "timetz" => "time",
        "datetime" | "timestamp" | "timestamptz" => "datetime",
        "year" => "year",
        "json" | "jsonb" => "json",
        "uuid" => "uuid",
        "blob" | "bytea" | "binary" | "varbinary" | "longblob" | "mediumblob" | "tinyblob" => "blob",
        "enum" | "set" => "enum",
        "text" | "mediumtext" | "longtext" | "tinytext" | "clob" => "text",
        "char" | "varchar" | "character" | "nchar" | "nvarchar" | "citext" => "string",
        _ => {
            if t.contains("char") || t.contains("text") {
                "string"
            } else if t.contains("int") {
                "int"
            } else {
                "string"
            }
        }
    }
}

/// Best-effort default generator for a column. Order matters: FK beats everything (it is the
/// only choice that keeps the data valid), then identity columns, then the column NAME (this is
/// what makes the dialog usable without configuring anything), then the declared type.
pub fn suggest_generator(col: &ColMeta, fk: Option<&FkMeta>) -> (String, Value) {
    if let Some(fk) = fk {
        return (
            "foreignKey".to_string(),
            json!({ "refTable": fk.ref_table, "refColumn": fk.ref_column }),
        );
    }
    if col.auto_inc {
        return ("skip".to_string(), json!({}));
    }

    let family = type_family(&col.data_type);
    if family == "enum" && !col.enum_values.is_empty() {
        return ("enumValues".to_string(), json!({ "values": col.enum_values }));
    }
    if !col.enum_values.is_empty() {
        return ("enumValues".to_string(), json!({ "values": col.enum_values }));
    }

    let name = col.name.to_lowercase();
    let textual = matches!(family, "string" | "text");
    let has = |needle: &str| name.contains(needle);
    let max_len = col.max_len.unwrap_or(255);

    if textual {
        if has("email") || has("e_mail") {
            return ("email".to_string(), json!({}));
        }
        if name == "password" || has("passwd") || has("password") || has("pwd") {
            return ("password".to_string(), json!({ "length": 12 }));
        }
        if has("first_name") || name == "firstname" || name == "fname" || has("given_name") {
            return ("firstName".to_string(), json!({}));
        }
        if has("last_name") || name == "lastname" || name == "lname" || has("surname") || has("family_name") {
            return ("lastName".to_string(), json!({}));
        }
        if has("full_name") || name == "name" || has("username") || name == "user" || has("display_name") {
            return (
                if has("username") || name == "user" { "username".to_string() } else { "fullName".to_string() },
                json!({}),
            );
        }
        if has("phone") || has("mobile") || has("tel") {
            return ("phone".to_string(), json!({}));
        }
        if has("city") || has("district") || has("province") {
            return ("city".to_string(), json!({}));
        }
        if has("country_code") {
            return ("countryCode".to_string(), json!({}));
        }
        if has("country") {
            return ("country".to_string(), json!({}));
        }
        if has("zip") || has("postal") {
            return ("zipCode".to_string(), json!({}));
        }
        if has("address") || has("street") {
            return ("address".to_string(), json!({}));
        }
        if has("company") || has("organization") || has("employer") {
            return ("company".to_string(), json!({}));
        }
        if has("department") {
            return ("department".to_string(), json!({}));
        }
        if has("job") || has("position") || has("role_name") {
            return ("jobTitle".to_string(), json!({}));
        }
        if has("currency") {
            return ("currencyCode".to_string(), json!({}));
        }
        if has("timezone") || has("time_zone") {
            return ("timezone".to_string(), json!({}));
        }
        if has("url") || has("website") || has("link") || has("avatar") || has("image") {
            return ("url".to_string(), json!({}));
        }
        if name == "ip" || has("ip_address") || name.ends_with("_ip") {
            return ("ipv4".to_string(), json!({}));
        }
        if has("mac") {
            return ("macAddress".to_string(), json!({}));
        }
        if has("color") || has("colour") {
            return ("hexColor".to_string(), json!({}));
        }
        if has("uuid") || has("guid") {
            return ("uuid".to_string(), json!({}));
        }
        if has("mime") {
            return ("mimeType".to_string(), json!({}));
        }
        if has("file_name") || has("filename") {
            return ("fileName".to_string(), json!({}));
        }
        if has("sku") || has("barcode") {
            return ("sku".to_string(), json!({}));
        }
        if has("status") || has("state") {
            return ("orderStatus".to_string(), json!({}));
        }
        if has("description") || has("comment") || has("note") || has("content") || has("body") || has("bio") {
            return ("paragraph".to_string(), json!({ "maxLength": max_len.min(2000) }));
        }
        if has("title") || has("subject") || has("summary") {
            return ("sentence".to_string(), json!({}));
        }
        if has("product") {
            return ("productName".to_string(), json!({}));
        }
        if has("gender") || has("sex") {
            return ("gender".to_string(), json!({}));
        }
    }

    match family {
        "bool" => return ("bool".to_string(), json!({ "truePercent": 50 })),
        "date" => return ("date".to_string(), json!({})),
        "time" => return ("time".to_string(), json!({})),
        "datetime" => return ("datetime".to_string(), json!({})),
        "year" => return ("year".to_string(), json!({})),
        "json" => return ("json".to_string(), json!({})),
        "uuid" => return ("uuid".to_string(), json!({})),
        "blob" => return ("blob".to_string(), json!({ "length": 16 })),
        "text" => {
            return ("paragraph".to_string(), json!({ "maxLength": 500 }));
        }
        "decimal" | "float" => {
            let scale = col.scale.unwrap_or(2).clamp(0, 6);
            let money = has("price") || has("amount") || has("total") || has("cost") || has("salary")
                || has("balance") || has("fee") || has("rate");
            let generator = if family == "float" && !money { "float" } else { "decimal" };
            let max = if money { 5_000.0 } else { 1_000.0 };
            return (generator.to_string(), json!({ "min": 0, "max": max, "scale": scale }));
        }
        "int" | "bigint" => {
            if name.starts_with("is_") || name.starts_with("has_") || name.starts_with("can_") {
                return ("bool".to_string(), json!({ "truePercent": 50 }));
            }
            if has("year") {
                return ("year".to_string(), json!({}));
            }
            if has("age") {
                return ("integer".to_string(), json!({ "min": 18, "max": 80 }));
            }
            if has("quantity") || has("qty") || has("count") || has("stock") {
                return ("integer".to_string(), json!({ "min": 0, "max": 500 }));
            }
            if col.is_pk {
                return ("sequence".to_string(), json!({ "start": 1, "step": 1 }));
            }
            let max = if family == "bigint" { 1_000_000_000 } else { 100_000 };
            return ("integer".to_string(), json!({ "min": 1, "max": max }));
        }
        _ => {}
    }

    // Fall-through: a plain string sized to the column.
    let max = max_len.clamp(1, 40);
    (
        "string".to_string(),
        json!({ "minLength": (max / 2).max(1), "maxLength": max, "charset": "alnum" }),
    )
}

// ===================== Commands =====================

/// Connection + dialect + the selected Postgres schema, all read under one lock.
///
/// The schema rides along here rather than being a parameter of every command because the five
/// functions that need it (`collect_meta`, `fetch_fk_pool`, `estimate_fk_pool`, `insert_sql`,
/// `run_generation`) are internal, not commands — see the plan §5.0.
fn active_conn(
    state: &State<'_, AppState>,
    conn_id: &str,
) -> Result<(DbConnection, String, Option<String>), String> {
    // Same tuple as before so none of the five internal callers changes.
    //
    // The dialect always comes from the live connection. That deleted the old
    // `if db_type.is_empty()` fallback rather than porting it: `ConnCtx::dialect()` derives it, so
    // there is no second spelling of the dialect that could disagree with the connection.
    let ctx = state.connections.acquire(conn_id)?;
    Ok((
        ctx.conn().clone(),
        ctx.dialect().to_string(),
        ctx.raw_schema().map(str::to_string),
    ))
}

/// Tables/columns available for generation, with a suggested generator per column and the
/// FK-safe insertion order.
#[tauri::command]
pub async fn get_generation_targets(state: State<'_, AppState>, conn_id: String) -> Result<Value, String> {
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    let metas = collect_meta(&conn, &dialect, &schema, None).await?;

    let names: Vec<String> = metas.iter().map(|m| m.name.clone()).collect();
    let fk_map: HashMap<String, Vec<FkMeta>> =
        metas.iter().map(|m| (m.name.clone(), m.fks.clone())).collect();
    let (order, cyclic) = topo_order(&names, &fk_map);

    let mut tables_json = Vec::with_capacity(metas.len());
    for name in &order {
        let Some(meta) = metas.iter().find(|m| &m.name == name) else { continue };
        let mut cols_json = Vec::with_capacity(meta.columns.len());
        for col in &meta.columns {
            let fk = meta.fk_of(&col.name);
            let (generator, options) = suggest_generator(col, fk);
            cols_json.push(json!({
                "name": col.name,
                "type": col.data_type,
                "nullable": col.nullable,
                "isPrimaryKey": col.is_pk,
                "autoIncrement": col.auto_inc,
                "hasDefault": col.has_default,
                "maxLength": col.max_len,
                "scale": col.scale,
                "enumValues": col.enum_values,
                "fk": fk.map(|f| json!({ "refTable": f.ref_table, "refColumn": f.ref_column })),
                "suggestedGenerator": generator,
                "suggestedOptions": options,
            }));
        }
        tables_json.push(json!({ "table": meta.name, "columns": cols_json }));
    }

    let mut warnings: Vec<String> = Vec::new();
    if !cyclic.is_empty() {
        warnings.push(format!(
            "Các bảng tham chiếu vòng: {}. Hãy bật 'Tắt ràng buộc' khi sinh.",
            cyclic.join(", ")
        ));
    }

    Ok(json!({
        "success": true,
        "dbType": dialect,
        "tables": tables_json,
        "order": order,
        "warnings": warnings,
    }))
}

/// Distinct values of a parent key, used by the `foreignKey` generator.
async fn fetch_fk_pool(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    table: &str,
    column: &str,
) -> Result<Vec<Cell>, String> {
    let sql = format!(
        "SELECT DISTINCT {} AS fkval FROM {} WHERE {} IS NOT NULL LIMIT {}",
        quote_ident(dialect, column),
        qualified(dialect, schema, table),
        quote_ident(dialect, column),
        FK_FETCH_LIMIT
    );
    let rows = query_rows(conn, &sql).await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.get("fkval"))
        .filter(|v| !v.is_null())
        .map(Cell::from_json)
        .collect())
}

/// Keys a parent table is *about to* receive, for the preview only.
///
/// Without this, previewing a child table before its parent has any row shows a column of NULLs —
/// which reads as "the foreign key generator is broken" even though the real run fills it. Two
/// cases, and the second is the common one:
///  - the parent's key is generated by us (sequence/uuid/...): replay that column's generator;
///  - the parent's key is auto-increment (`skip`): only the database knows it, so continue from
///    `MAX(key)` the way the database will.
/// Returns empty when the parent is not part of this run — then there really is nothing to sample.
#[allow(clippy::too_many_arguments)]
async fn estimate_fk_pool(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    seed: u64,
    all_tables: &[GenTableSpec],
    ref_table: &str,
    ref_column: &str,
) -> Vec<Cell> {
    // Enough for the preview to look varied without generating a whole parent table.
    const SAMPLE: usize = 200;

    let Some(parent) = all_tables.iter().find(|t| t.table == ref_table) else {
        return Vec::new();
    };
    let want = parent.rows.clamp(1, SAMPLE);

    let parent_col = parent.columns.iter().find(|c| c.column == ref_column);
    if let Some(cspec) = parent_col {
        if cspec.generator != "skip" {
            if let Ok(mut st) = ColState::new(seed, ref_table, cspec) {
                let mut out = Vec::with_capacity(want);
                for _ in 0..want {
                    match st.next_cell(dialect) {
                        Ok(Cell::Null) => {}
                        Ok(cell) => out.push(cell),
                        Err(_) => break,
                    }
                }
                return out;
            }
        }
    }

    // Auto-increment (or a column left to the database): continue the sequence from MAX(key).
    let sql = format!(
        "SELECT MAX({}) AS mx FROM {}",
        quote_ident(dialect, ref_column),
        qualified(dialect, schema, ref_table)
    );
    let start = query_rows(conn, &sql)
        .await
        .ok()
        .and_then(|rows| rows.first().and_then(|r| opt_i64(r, "mx")))
        .unwrap_or(0);
    (1..=want as i64)
        .map(|i| Cell::Num((start + i).to_string()))
        .collect()
}

struct PreparedTable {
    columns: Vec<String>,
    states: Vec<ColState>,
}

/// Builds the per-column runtime state of one table.
///
/// A FK column draws from the union of two sources, and it needs both:
///  - what the parent table holds (read here) — the only place an auto-increment parent key can
///    come from, since that column is generated by the database, not by us;
///  - `generated`: the key values this run produced for the parent, for the case where the parent
///    is generated *after* the child (a reference cycle) so the table read cannot show them yet.
#[allow(clippy::too_many_arguments)]
async fn prepare_table(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    seed: u64,
    tspec: &GenTableSpec,
    // Every table of the run — a preview needs the *parent's* spec to estimate FK values.
    // (A `///` doc comment on a parameter is a compile error, so this stays a plain comment.)
    all_tables: &[GenTableSpec],
    generated: &HashMap<(String, String), Vec<Cell>>,
    warnings: &mut Vec<String>,
    strict_fk: bool,
) -> Result<PreparedTable, String> {
    let mut columns = Vec::new();
    let mut states = Vec::new();
    for cspec in &tspec.columns {
        if cspec.generator == "skip" {
            continue;
        }
        let mut st = ColState::new(seed, &tspec.table, cspec)?;
        if cspec.generator == "foreignKey" {
            let ref_table = o_str(&cspec.options, "refTable").unwrap_or_default();
            let ref_column = o_str(&cspec.options, "refColumn").unwrap_or_default();
            if ref_table.is_empty() || ref_column.is_empty() {
                return Err(format!(
                    "Cột '{}.{}' chưa chọn bảng/cột tham chiếu",
                    tspec.table, cspec.column
                ));
            }
            let mut pool = fetch_fk_pool(conn, dialect, schema, &ref_table, &ref_column).await?;
            if let Some(extra) = generated.get(&(ref_table.clone(), ref_column.clone())) {
                pool.extend(extra.iter().cloned());
            }
            if pool.is_empty() {
                if strict_fk {
                    return Err(format!(
                        "Bảng cha '{}.{}' không có dòng nào để lấy khóa ngoại cho cột '{}.{}'",
                        ref_table, ref_column, tspec.table, cspec.column
                    ));
                }
                // Preview: the parent is still empty, but during the real run it will not be —
                // it is generated first. Showing NULL here would make the feature look broken,
                // so estimate the keys the parent is about to get and say so in a warning.
                pool = estimate_fk_pool(conn, dialect, schema, seed, all_tables, &ref_table, &ref_column).await;
                warnings.push(if pool.is_empty() {
                    format!(
                        "Bảng cha '{}.{}' không có dòng nào để lấy khóa ngoại cho cột '{}.{}'",
                        ref_table, ref_column, tspec.table, cspec.column
                    )
                } else {
                    format!(
                        "Xem trước: khóa ngoại của cột '{}.{}' là ƯỚC LƯỢNG vì bảng cha '{}.{}' còn rỗng; khi sinh thật sẽ lấy khóa thật của bảng cha.",
                        tspec.table, cspec.column, ref_table, ref_column
                    )
                });
            }
            st.pool = pool;
        }
        columns.push(cspec.column.clone());
        states.push(st);
    }
    if states.is_empty() {
        return Err(format!("Bảng '{}' không có cột nào để sinh dữ liệu", tspec.table));
    }
    Ok(PreparedTable { columns, states })
}

fn insert_sql(dialect: &str, schema: &Option<String>, table: &str, columns: &[String], rows: &[Vec<Cell>]) -> String {
    let cols = columns
        .iter()
        .map(|c| quote_ident(dialect, c))
        .collect::<Vec<_>>()
        .join(", ");
    let values = rows
        .iter()
        .map(|row| {
            let cells = row
                .iter()
                .map(|c| c.literal(dialect))
                .collect::<Vec<_>>()
                .join(", ");
            format!("({cells})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO {} ({}) VALUES {};",
        qualified(dialect, schema, table),
        cols,
        values
    )
}

/// Wide tables make the statement text grow fast; keep a batch well under a few MB so a MySQL
/// server with a small `max_allowed_packet` still accepts it.
fn pick_batch_size(requested: usize, column_count: usize) -> usize {
    let base = requested.clamp(1, 5_000);
    if column_count > 40 {
        base.min(100)
    } else if column_count > 20 {
        base.min(250)
    } else {
        base
    }
}

/// Preview rows for ONE table — same code path as the real run, no writes.
#[tauri::command]
pub async fn preview_generated_data(
    state: State<'_, AppState>, conn_id: String,
    spec: GenSpec,
    table: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    let tspec = spec
        .tables
        .iter()
        .find(|t| t.table == table)
        .ok_or_else(|| format!("Không có cấu hình sinh dữ liệu cho bảng '{table}'"))?;

    let seed = spec.seed.unwrap_or(DEFAULT_SEED);
    let mut warnings: Vec<String> = Vec::new();
    let generated: HashMap<(String, String), Vec<Cell>> = HashMap::new();
    let mut prepared =
        prepare_table(&conn, &dialect, &schema, seed, tspec, &spec.tables, &generated, &mut warnings, false).await?;

    let count = limit.unwrap_or(100).clamp(1, 1000).min(tspec.rows.max(1));
    let mut data = Vec::with_capacity(count);
    for _ in 0..count {
        let mut map = Map::new();
        for (idx, st) in prepared.states.iter_mut().enumerate() {
            let cell = st.next_cell(&dialect)?;
            map.insert(prepared.columns[idx].clone(), cell.to_json());
        }
        data.push(Value::Object(map));
    }

    Ok(json!({
        "success": true,
        "columns": prepared.columns,
        "data": data,
        "warnings": warnings,
    }))
}

/// Marks the running generation as cancelled. Safe to call when nothing is running.
#[tauri::command]
pub async fn cancel_data_generation(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Value, String> {
    let flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&cancel_key(&conn_id)) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "success": true }))
}

/// Generates and inserts the data. Reports progress through `on_progress`:
/// `{type:'start'|'table'|'progress'|'done'|'error', ...}`.
#[tauri::command]
pub async fn generate_data(
    state: State<'_, AppState>, conn_id: String,
    spec: GenSpec,
    // Bắt buộc (không dùng Option): Channel không impl Deserialize nên `Option<Channel<_>>`
    // không thoả CommandArg — frontend luôn tạo kênh.
    on_progress: Channel<Value>,
) -> Result<Value, String> {
    // Same reason as restore_backup: this runs on its own connection and would block on the locks
    // an open manual transaction holds. See tx::reject_if_manual_or_open.
    crate::tx::reject_if_manual_or_open(&conn_id, "sinh dữ liệu")?;
    let (conn, dialect, schema) = active_conn(&state, &conn_id)?;
    // Its INSERTs go through `Exec`, i.e. past the funnels that carry the read-only gate.
    // `preview_generated_data` is deliberately not gated — it writes nothing.
    crate::database::reject_conn_read_only(&conn)?;
    if spec.tables.is_empty() {
        return Err("Chưa chọn bảng nào để sinh dữ liệu".to_string());
    }
    let started = std::time::Instant::now();

    let seed = spec.seed.unwrap_or(DEFAULT_SEED);
    let opts = spec.options.clone().unwrap_or_default();
    let disable_constraints = opts.disable_constraints.unwrap_or(false);
    let commit_every = opts.commit_every_batches.unwrap_or(20).max(1);

    // FK-safe order + the parent keys that later tables will need in memory.
    let names: Vec<String> = spec.tables.iter().map(|t| t.table.clone()).collect();
    let metas = collect_meta(&conn, &dialect, &schema, Some(&names)).await?;
    let fk_map: HashMap<String, Vec<FkMeta>> =
        metas.iter().map(|m| (m.name.clone(), m.fks.clone())).collect();
    let (order, cyclic) = topo_order(&names, &fk_map);

    let mut warnings: Vec<String> = Vec::new();
    if !cyclic.is_empty() && !disable_constraints {
        warnings.push(format!(
            "Các bảng tham chiếu vòng: {}. Hãy bật 'Tắt ràng buộc' khi sinh.",
            cyclic.join(", ")
        ));
    }

    // Parent keys to keep in memory while generating: every column a FK in this run points at.
    // Cheap (one Vec per referenced column, capped) and it is the only thing that can serve a
    // cyclic reference, where the parent is generated after the child.
    let mut remember: HashSet<(String, String)> = HashSet::new();
    for t in &spec.tables {
        for c in &t.columns {
            if c.generator != "foreignKey" {
                continue;
            }
            let rt = o_str(&c.options, "refTable").unwrap_or_default();
            let rc = o_str(&c.options, "refColumn").unwrap_or_default();
            if !rt.is_empty() && !rc.is_empty() {
                remember.insert((rt, rc));
            }
        }
    }

    let total_rows: usize = spec.tables.iter().map(|t| t.rows).sum();
    let _ = on_progress.send(json!({
        "type": "start",
        "totalRows": total_rows,
        "tables": order,
    }));

    // Cancel flag, same registry as execute_query_stream/cancel_query.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().map_err(|e| e.to_string())?;
        flags.insert(cancel_key(&conn_id), cancel.clone());
    }

    let outcome = run_generation(
        &conn,
        &dialect,
        &schema,
        &spec,
        &order,
        seed,
        disable_constraints,
        commit_every,
        &remember,
        total_rows,
        &on_progress,
        &cancel,
        &mut warnings,
    )
    .await;

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&cancel_key(&conn_id));
    }

    match outcome {
        Ok((inserted, cancelled)) => {
            let elapsed = started.elapsed().as_millis() as u64;
            let inserted_json: Map<String, Value> =
                inserted.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
            let _ = on_progress.send(json!({
                "type": "done",
                "cancelled": cancelled,
                "elapsedMs": elapsed,
                "inserted": inserted_json.clone(),
            }));
            Ok(json!({
                "success": true,
                "cancelled": cancelled,
                "elapsedMs": elapsed,
                "inserted": inserted_json,
                "warnings": warnings,
            }))
        }
        Err(msg) => {
            let _ = on_progress.send(json!({ "type": "error", "message": msg.clone() }));
            Err(msg)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_generation(
    conn: &DbConnection,
    dialect: &str,
    schema: &Option<String>,
    spec: &GenSpec,
    order: &[String],
    seed: u64,
    disable_constraints: bool,
    commit_every: usize,
    remember: &HashSet<(String, String)>,
    total_rows: usize,
    on_progress: &Channel<Value>,
    cancel: &Arc<AtomicBool>,
    warnings: &mut Vec<String>,
) -> Result<(HashMap<String, usize>, bool), String> {
    let mut exec = Exec::acquire(conn).await?;

    // Constraints off, then transaction open. The ORDER is dialect-specific and neither half is
    // interchangeable:
    //  - SQLite: `PRAGMA foreign_keys` is a no-op *inside* a transaction, so it must come first.
    //  - MySQL: `SET FOREIGN_KEY_CHECKS` is session level; before or after works, keep it first.
    //  - Postgres: `SET CONSTRAINTS` is only valid *inside* a transaction, so it comes after
    //    BEGIN — and again after every periodic commit, since it dies with the transaction.
    if disable_constraints {
        match dialect {
            "mysql" => exec.try_run("SET FOREIGN_KEY_CHECKS = 0;").await,
            "postgres" => {}
            _ => exec.try_run("PRAGMA foreign_keys = OFF;").await,
        }
    }
    let begin = if dialect == "mysql" { "START TRANSACTION;" } else { "BEGIN;" };
    exec.try_run(begin).await;
    if disable_constraints && dialect == "postgres" {
        exec.try_run("SET CONSTRAINTS ALL DEFERRED;").await;
    }

    let mut inserted: HashMap<String, usize> = HashMap::new();
    let mut generated: HashMap<(String, String), Vec<Cell>> = HashMap::new();
    let mut done_rows = 0usize;
    let mut batches_since_commit = 0usize;
    let mut cancelled = false;

    // A failure must not leave the session with constraints off or a transaction open.
    macro_rules! bail {
        ($msg:expr) => {{
            let msg: String = $msg;
            exec.try_run("ROLLBACK;").await;
            restore_session(&mut exec, dialect, disable_constraints).await;
            return Err(msg);
        }};
    }

    'tables: for table in order {
        let Some(tspec) = spec.tables.iter().find(|t| &t.table == table) else { continue };
        if tspec.rows == 0 {
            continue;
        }

        let mut prepared =
            match prepare_table(conn, dialect, schema, seed, tspec, &spec.tables, &generated, warnings, true).await {
                Ok(p) => p,
                Err(e) => bail!(e),
            };

        if tspec.mode.as_deref() == Some("truncate") {
            // DELETE, not TRUNCATE: MySQL implicitly COMMITs on TRUNCATE (DDL), which would
            // make the surrounding transaction unable to roll back what was already written.
            let sql = format!("DELETE FROM {};", qualified(dialect, schema, table));
            if let Err(e) = exec.run(sql).await {
                bail!(format!("Không xoá được dữ liệu cũ của bảng '{table}': {e}"));
            }
        }

        let _ = on_progress.send(json!({
            "type": "table",
            "table": table,
            "rows": tspec.rows,
            "totalDone": done_rows,
            "totalRows": total_rows,
        }));

        let remember_idx: Vec<usize> = prepared
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| remember.contains(&(table.clone(), (*c).clone())))
            .map(|(i, _)| i)
            .collect();

        let batch_size = pick_batch_size(
            spec.options.as_ref().and_then(|o| o.batch_size).unwrap_or(DEFAULT_BATCH),
            prepared.columns.len(),
        );

        let mut produced = 0usize;
        while produced < tspec.rows {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break 'tables;
            }
            let take = batch_size.min(tspec.rows - produced);
            let mut rows: Vec<Vec<Cell>> = Vec::with_capacity(take);
            for _ in 0..take {
                let mut row = Vec::with_capacity(prepared.states.len());
                for st in prepared.states.iter_mut() {
                    // The error already names `table.column`, so it needs no wrapper here.
                    match st.next_cell(dialect) {
                        Ok(cell) => row.push(cell),
                        Err(e) => bail!(e),
                    }
                }
                for idx in &remember_idx {
                    let pool = generated
                        .entry((table.clone(), prepared.columns[*idx].clone()))
                        .or_default();
                    if pool.len() < FK_POOL_CAP {
                        pool.push(row[*idx].clone());
                    }
                }
                rows.push(row);
            }

            let sql = insert_sql(dialect, schema, table, &prepared.columns, &rows);
            if let Err(e) = exec.run(sql).await {
                bail!(format!("Lỗi khi chèn dữ liệu vào bảng '{table}': {e}"));
            }

            produced += take;
            done_rows += take;
            *inserted.entry(table.clone()).or_insert(0) += take;
            batches_since_commit += 1;

            let _ = on_progress.send(json!({
                "type": "progress",
                "table": table,
                "done": produced,
                "total": tspec.rows,
                "totalDone": done_rows,
                "totalRows": total_rows,
            }));

            // Periodic commit so a long run does not sit on one giant transaction (undo log /
            // WAL growth), at the cost of a cancel leaving the committed part behind — which is
            // reported back as `inserted`.
            if batches_since_commit >= commit_every {
                exec.try_run("COMMIT;").await;
                exec.try_run(begin).await;
                if disable_constraints && dialect == "postgres" {
                    exec.try_run("SET CONSTRAINTS ALL DEFERRED;").await;
                }
                batches_since_commit = 0;
            }
        }

        // Commit at the end of EVERY table, not just at the end of the run. `prepare_table` reads
        // the parent key of a FK column through `execute_raw_sql_generic`, which takes its own
        // connection from the pool and therefore cannot see rows still uncommitted in ours — the
        // child table would find an empty parent and the whole run would fail. It also is the only
        // way to learn an auto-increment parent key, which the database assigns and we never see.
        // No atomicity is lost that the periodic commit above had not already given up.
        exec.try_run("COMMIT;").await;
        exec.try_run(begin).await;
        if disable_constraints && dialect == "postgres" {
            exec.try_run("SET CONSTRAINTS ALL DEFERRED;").await;
        }
        batches_since_commit = 0;
    }

    exec.try_run("COMMIT;").await;
    restore_session(&mut exec, dialect, disable_constraints).await;
    Ok((inserted, cancelled))
}

/// Puts the session back the way it was before returning the connection to the pool.
async fn restore_session(exec: &mut Exec, dialect: &str, disabled: bool) {
    if !disabled {
        return;
    }
    match dialect {
        "mysql" => exec.try_run("SET FOREIGN_KEY_CHECKS = 1;").await,
        "postgres" => {}
        _ => exec.try_run("PRAGMA foreign_keys = ON;").await,
    }
}
