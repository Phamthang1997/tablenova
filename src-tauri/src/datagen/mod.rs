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

mod column;
mod commands;
mod ident;
mod meta;
mod regex;
mod rng;
mod spec;
mod suggest;
mod template;
mod text;
mod writer;

pub use commands::*;

// `template_space` không có caller trong Rust: nó là bản gốc mà `templateSpace` bên
// `src/utils/dataGenHelper.ts` được kiểm theo (xem dataGenHelper.test.ts). Giữ nguyên mức hiển thị
// cũ để cặp sinh đôi đó còn nghĩa — xoá nó là một quyết định riêng, không phải việc của đợt tách.
pub use template::template_space;
