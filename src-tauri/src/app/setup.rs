//! The work that runs ONCE at app startup: the window's glass material and the `AppHandle`s
//! parked for the layers that never receive an `AppState`.

use tauri::Manager;

/// Runs inside `Builder::setup`. A failure here would be a startup failure, but both pieces of work
/// inside are best-effort, so the function has no failing branch.
pub fn init(app: &tauri::App) {
    apply_window_material(app);

    // The transaction state changes deep inside the SQL funnels, which have no AppHandle.
    // Park one here so it can emit "tx-state-changed" instead of every command's response
    // shape having to carry the state.
    crate::tx::set_app_handle(app.handle().clone());
    // Same trick, different purpose: the SQL funnels read the read-only flag out of the
    // connection registry, and they have a `&DbConnection` but no `AppState`.
    crate::state::set_app_handle(app.handle().clone());
}

/// The window's glass material is applied ONLY here, never through windowEffects in
/// tauri.conf.json — declaring both applies the effect twice. Doing it by hand is deliberate:
/// Tauri handles windowEffects by taking the first matching variant and then ignoring the error it
/// returns, i.e. there is NO real fallback; here, when mica fails we can still fall back to blur.
fn apply_window_material(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = &window;

    #[cfg(target_os = "macos")]
    let _ = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
        // Active: keep the glass fully lit even when the window loses focus
        // (macOS greys it out by default). 12.0: corner radius matching the CSS
        // [data-os='macos'] #root, since decorations = false.
        Some(window_vibrancy::NSVisualEffectState::Active),
        Some(12.0),
    );

    #[cfg(target_os = "windows")]
    {
        // dark = None -> Mica follows the system's light/dark preference.
        // Passing Some(true) used to force dark, so the app's light theme still
        // sat on dark glass. A machine without Mica support (Win 10) falls back
        // to Blur.
        if window_vibrancy::apply_mica(&window, None).is_err() {
            let _ = window_vibrancy::apply_blur(&window, Some((18, 20, 26, 125)));
        }
    }
}

// Do NOT set_menu here. There used to be a hand-built "Edit" menu made of
// MenuItem::with_id, but it was useless and actively harmful:
//  - No on_menu_event existed -> clicking the items did nothing at all,
//    while they still claimed the Ctrl+Z/X/C/V/A accelerators.
//  - On Windows with decorations = false the native menu bar is drawn
//    inside the client area -> a faint "Edit" label on top of our own TitleBar.
//  - On macOS, Tauri already attaches a full Menu::default() (App/File/Edit/
//    View/Window/Help) whose copy/paste items really work when the builder
//    does not call .menu() — see tauri/src/app.rs. set_menu() in setup()
//    runs later, so it was OVERWRITING that good menu with a broken one.
// Dropped entirely: macOS gets its default menu back, and on Windows/Linux
// WebView2/WebKitGTK handle clipboard inside inputs on their own anyway.
