//! Việc chạy MỘT LẦN lúc app khởi động: vật liệu kính của cửa sổ và các `AppHandle`
//! được park lại cho những tầng không nhận được `AppState`.

use tauri::Manager;

/// Chạy trong `Builder::setup`. Lỗi ở đây là lỗi khởi động, nhưng cả hai việc bên trong
/// đều "cố gắng hết sức" nên hàm không có nhánh thất bại nào.
pub fn init(app: &tauri::App) {
    apply_window_material(app);

    // The transaction state changes deep inside the SQL funnels, which have no AppHandle.
    // Park one here so it can emit "tx-state-changed" instead of every command's response
    // shape having to carry the state.
    crate::tx_session::set_app_handle(app.handle().clone());
    // Same trick, different purpose: the SQL funnels read the read-only flag out of the
    // connection registry, and they have a `&DbConnection` but no `AppState`.
    crate::state::set_app_handle(app.handle().clone());
}

/// Vật liệu kính của cửa sổ được áp DUY NHẤT ở đây, không dùng windowEffects trong
/// tauri.conf.json — nếu khai cả hai thì effect bị áp hai lần. Chọn cách gọi thủ công vì
/// Tauri xử lý windowEffects bằng cách lấy variant khớp đầu tiên rồi bỏ qua lỗi trả về,
/// tức KHÔNG có fallback thật; còn ở đây mica lỗi thì còn tụt xuống blur được.
fn apply_window_material(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = &window;

    #[cfg(target_os = "macos")]
    let _ = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
        // Active: giữ kính sáng đầy đủ cả khi cửa sổ mất focus (mặc định
        // macOS sẽ làm xám đi). 12.0: bo góc khớp với CSS
        // [data-os='macos'] #root vì decorations = false.
        Some(window_vibrancy::NSVisualEffectState::Active),
        Some(12.0),
    );

    #[cfg(target_os = "windows")]
    {
        // dark = None -> Mica đi theo tuỳ chọn sáng/tối của hệ thống.
        // Trước đây truyền Some(true) là ép tối, nên theme sáng của app
        // vẫn nằm trên nền kính tối. Máy không hỗ trợ Mica (Win 10) thì
        // tụt xuống Blur.
        if window_vibrancy::apply_mica(&window, None).is_err() {
            let _ = window_vibrancy::apply_blur(&window, Some((18, 20, 26, 125)));
        }
    }
}

// KHÔNG set_menu ở đây. Trước đây có một menu "Edit" tự dựng bằng
// MenuItem::with_id, nhưng nó vô dụng và còn gây hại:
//  - Không có on_menu_event nào -> bấm vào các mục không làm gì cả,
//    trong khi vẫn chiếm accelerator Ctrl+Z/X/C/V/A.
//  - Trên Windows với decorations = false, thanh menu native được vẽ
//    trong client area -> hiện chữ "Edit" mờ đè lên TitleBar tự làm.
//  - Trên macOS, Tauri đã tự gắn Menu::default() đầy đủ (App/File/Edit/
//    View/Window/Help) với các mục copy/paste hoạt động thật khi builder
//    không gọi .menu() — xem tauri/src/app.rs. set_menu() trong setup()
//    chạy sau nên đang GHI ĐÈ menu tốt đó bằng menu hỏng.
// Bỏ hẳn: macOS lấy lại menu mặc định, Windows/Linux thì WebView2/
// WebKitGTK vốn tự xử lý clipboard trong input.
