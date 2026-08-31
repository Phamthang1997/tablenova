// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// mimalloc replaces the system allocator for the whole process.
///
/// It lives in `main.rs` rather than the library because a `#[global_allocator]` is a property of
/// the final binary, and putting it in the lib would also impose it on `cargo test`, where the
/// allocator under test is not the thing being tested.
///
/// Why it might matter here: reading a result set allocates once per CELL — a `String` for the
/// column name and a `serde_json::Value` for the contents — so a 79,040-row × 8-column read is
/// roughly 632,000 allocations, and Windows' default allocator is the weakest of the three
/// platforms'.
///
/// Why it might NOT: the measured cost of that path was dominated by sqlx building and discarding
/// an `Error::ColumnDecode` per failed type probe, which the fast path in `database/decode.rs`
/// removed — and allocation was never separately measured. The honest test is one number: run the
/// same query before and after and read `transfer …ms` off the SQL editor's status bar. If it does
/// not move, take this back out rather than carrying a C dependency for a number nobody saw.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    tablegrid::run();
}
