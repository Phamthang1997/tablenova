//! OS- and window-level commands. Nothing to do with databases — they lived in
//! `database.rs` only for historical reasons.

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // The first empty argument is the window TITLE for `start`: without it a path
        // containing spaces (already quoted) is read as the title and nothing opens.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_app_window_size(window: tauri::Window, width: u32, height: u32) -> Result<(), String> {
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: width as f64,
        height: height as f64,
    }));
    let _ = window.center();
    Ok(())
}
