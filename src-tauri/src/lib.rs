pub mod database;
pub mod ssh_tunnel;
pub mod ssh_terminal;
pub mod local_terminal;
pub mod aws_iam;
pub mod export;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64};
use tauri::menu::{Menu, MenuItem, Submenu};

pub struct AppState {
    pub db_manager: Mutex<database::DatabaseManager>,
    // Cờ hủy cho các truy vấn đang stream (query_id -> cờ). execute_query_stream đăng ký,
    // cancel_query bật cờ để dừng vòng lặp đẩy dữ liệu.
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    // Các phiên SSH Terminal đang mở (session_id -> phiên).
    pub ssh_terminals: ssh_terminal::SshTerminalMap,
    // Các phiên Local Terminal (shell cục bộ) đang mở.
    pub local_terminals: local_terminal::LocalTerminalMap,
    // Tăng mỗi lần connect/disconnect. Task làm mới token IAM dùng để biết kết nối còn "đời" của nó không.
    pub conn_generation: AtomicU64,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle();
            let edit_menu = Submenu::new(
                handle,
                "Edit",
                true,
            )?;
            let undo = MenuItem::with_id(handle, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
            let redo = MenuItem::with_id(handle, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
            let cut = MenuItem::with_id(handle, "cut", "Cut", true, Some("CmdOrCtrl+X"))?;
            let copy = MenuItem::with_id(handle, "copy", "Copy", true, Some("CmdOrCtrl+C"))?;
            let paste = MenuItem::with_id(handle, "paste", "Paste", true, Some("CmdOrCtrl+V"))?;
            let select_all = MenuItem::with_id(handle, "selectall", "Select All", true, Some("CmdOrCtrl+A"))?;
            edit_menu.append_items(&[&undo, &redo, &cut, &copy, &paste, &select_all])?;
            
            let menu = Menu::new(handle)?;
            menu.append(&edit_menu)?;
            app.set_menu(menu)?;

            Ok(())
        })
        .manage(AppState {
            db_manager: Mutex::new(database::DatabaseManager {
                connection: None,
                db_type: String::new(),
                ssh_tunnel: None,
                last_config: None,
            }),
            cancel_flags: Mutex::new(HashMap::new()),
            ssh_terminals: Mutex::new(HashMap::new()),
            local_terminals: Mutex::new(HashMap::new()),
            conn_generation: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            database::connect_db,
            database::disconnect_db,
            database::get_tables,
            database::get_full_catalog,
            database::get_table_data,
            database::get_table_schema,
            database::alter_table_schema,
            database::preview_alter_schema,
            database::execute_query,
            database::execute_multi_query,
            database::execute_query_stream,
            database::cancel_query,
            ssh_terminal::open_ssh_terminal,
            ssh_terminal::send_ssh_input,
            ssh_terminal::resize_ssh_terminal,
            ssh_terminal::close_ssh_terminal,
            local_terminal::open_local_terminal,
            local_terminal::send_local_input,
            local_terminal::resize_local_terminal,
            local_terminal::close_local_terminal,
            database::commit_changes,
            database::ai_chat,
            database::export_table,
            database::export_multi_tables,
            database::import_dbeaver,
            database::parse_backup_tables,
            database::restore_backup,
            database::import_new_table,
            database::create_table,
            database::drop_table,
            database::truncate_table,
            database::get_table_definition,
            database::rename_table,
            database::import_table_data,
            database::get_databases_list,
            database::list_databases,
            database::switch_database,
            database::create_database,
            database::drop_database,
            database::rename_database,
            database::get_db_charsets,
            database::get_database_objects,
            database::get_object_definition,
            database::open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
