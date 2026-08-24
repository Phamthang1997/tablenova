//! PRNG xoshiro256** có hạt giống, viết tay (~30 dòng) — không `rand`, không entropy của OS,
//! không đồng hồ. Cùng spec + cùng seed thì dữ liệu sinh ra giống hệt tới từng byte.
//!
//! Mỗi cột rút từ SUBSTREAM RIÊNG (`mix_seed`). Một stream dùng chung sẽ khiến sửa cột thứ 3
//! làm đổi giá trị của mọi cột sau nó, và preview nhảy loạn theo từng phím gõ.


// ===================== Seeded PRNG =====================

/// xoshiro256** — 4x u64 state, period 2^256-1, seeded through SplitMix64.
pub struct Rng {
    s: [u64; 4],
}

pub(super) fn split_mix64(state: &mut u64) -> u64 {
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
pub(super) fn mix_seed(seed: u64, table: &str, column: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed;
    for part in [table.as_bytes(), b":", column.as_bytes()] {
        for b in part {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    }
    h
}
