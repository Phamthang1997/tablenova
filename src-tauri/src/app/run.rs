//! Tauri bootstrap: builds the `Builder`, attaches plugins, `manage`s state and wires the handler.
//!
//! `setup.rs` and `handlers.rs` are two pieces of this very Builder, so it has to sit next to them
//! rather than in `lib.rs` — `lib.rs` only does what nothing else can: declare the modules.

use crate::state::AppState;

/// TEMPORARY tracer — remove once it has named the crash.
///
/// Writes to a FILE because the release binary is built with `windows_subsystem = "windows"` and
/// has no console. Each line is opened, written and closed, so the last line on disk survives the
/// crash and names what was running.
///
/// The thread name is the field that matters now: every command was moved off the main thread, so a
/// remaining stack overflow would be on a `tokio-rt-worker` (2MB by default) instead of `main`
/// (1MB) — a different problem with a different fix, and the log says which.
pub(crate) fn boot_trace(stage: &str) {
    use std::io::Write;
    let probe = 0u8;
    // Address of a local in THIS frame. Compared between lines on the same thread it shows how much
    // stack has been consumed since the previous one — the difference is what matters, and a drop of
    // hundreds of KB between two lines is the answer on its own.
    let sp = &probe as *const u8 as usize;
    let current = std::thread::current();
    let thread = current.name().unwrap_or("<unnamed>").to_string();
    let path = std::env::temp_dir().join("tablenova-boot.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{stage}\tthread={thread}\tsp=0x{sp:x}");
    }
}

/// TEMPORARY, with `boot_trace` — remove together.
///
/// Separates the two failure classes without a console. A PANIC (unwrap on None, index out of
/// bounds, an `expect` in a dependency) runs this hook and lands in the log with its message and
/// location. A stack overflow or access violation is a hardware fault, not a panic, so it runs
/// nothing — an empty tail after the last `invoke:` line means the fault, not a panic.
fn install_panic_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        boot_trace(&format!("PANIC at {location}: {info}"));
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_log();
    // BEFORE the Builder, and it never comes back: `--mcp-stdio` turns this launch into a plain
    // stdio<->HTTP proxy for an AI client, and must not touch the window layer at all. That is the
    // bootstrap-level change `docs/mcp-server-plan.md` §0.4 was wary of - contained here to one
    // early `if`, because a proxy needs no window, no plugins and no state.
    if let Some(port) = crate::mcp::stdio::requested_port(&std::env::args().collect::<Vec<_>>()) {
        crate::mcp::stdio::serve(port);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            super::setup::init(app);
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(super::handlers::handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
