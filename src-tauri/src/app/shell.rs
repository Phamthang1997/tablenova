//! Lệnh cấp hệ điều hành / cửa sổ. Không liên quan tới database — chúng nằm trong
//! `database.rs` chỉ vì lịch sử.

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Tham số rỗng đầu tiên là TIÊU ĐỀ cửa sổ của `start`: thiếu nó thì đường dẫn
        // có dấu cách (đã được bọc nháy) bị hiểu thành tiêu đề và không mở gì cả.
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
