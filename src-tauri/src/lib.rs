pub mod data_generator;
pub mod database;
pub mod datasets;
pub mod db_compare;
pub mod db_stats;
pub mod redis_cmds;
pub mod redis_db;
pub mod ssh_tunnel;
pub mod ssh_terminal;
pub mod local_terminal;
pub mod aws_iam;
pub mod export;
pub mod secret_store;
pub mod tx_session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64};

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
    // Kết nối Redis (tách biệt khỏi DbConnection SQL).
    pub redis: redis_db::RedisState,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            use tauri::Manager;
            // Vật liệu kính của cửa sổ được áp DUY NHẤT ở đây, không dùng
            // windowEffects trong tauri.conf.json — nếu khai cả hai thì effect bị
            // áp hai lần. Chọn cách gọi thủ công vì Tauri xử lý windowEffects bằng
            // cách lấy variant khớp đầu tiên rồi bỏ qua lỗi trả về, tức KHÔNG có
            // fallback thật; còn ở đây mica lỗi thì còn tụt xuống blur được.
            if let Some(window) = app.get_webview_window("main") {
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

            // The transaction state changes deep inside the SQL funnels, which have no AppHandle.
            // Park one here so it can emit "tx-state-changed" instead of every command's response
            // shape having to carry the state.
            tx_session::set_app_handle(app.handle().clone());

            Ok(())
        })
        .manage(AppState {
            db_manager: Mutex::new(database::DatabaseManager {
                connection: None,
                db_type: String::new(),
                ssh_tunnel: None,
                last_config: None,
                current_schema: None,
            }),
            cancel_flags: Mutex::new(HashMap::new()),
            ssh_terminals: Mutex::new(HashMap::new()),
            local_terminals: Mutex::new(HashMap::new()),
            conn_generation: AtomicU64::new(0),
            redis: redis_db::RedisState::new(),
        })
        .invoke_handler(tauri::generate_handler![
            database::connect_db,
            database::disconnect_db,
            database::get_connection_status,
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
            tx_session::tx_status,
            tx_session::tx_set_autocommit,
            tx_session::tx_set_isolation,
            tx_session::tx_commit,
            tx_session::tx_rollback,
            tx_session::tx_savepoint,
            tx_session::tx_rollback_to,
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
            database::import_dbeaver,
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
            database::list_schemas,
            database::set_current_schema,
            database::create_database,
            database::drop_database,
            database::rename_database,
            database::get_db_charsets,
            database::get_database_objects,
            database::get_object_definition,
            database::get_table_triggers,
            database::get_all_triggers,
            database::get_table_ddl_extras,
            database::save_trigger,
            database::drop_trigger,
            database::save_routine_definition,
            database::get_sequences,
            database::alter_sequence,
            database::drop_sequence,
            database::get_table_partitions,
            database::get_check_constraints,
            database::save_view_definition,
            database::open_url,
            database::set_app_window_size,
            secret_store::secret_set,
            secret_store::secret_get,
            secret_store::secret_delete,
            secret_store::secret_get_many,
            secret_store::secret_set_many,
            secret_store::secret_delete_many,
            data_generator::get_generation_targets,
            data_generator::preview_generated_data,
            data_generator::generate_data,
            data_generator::cancel_data_generation,
            db_compare::compare_schemas,
            db_compare::compare_data_overview,
            db_compare::compare_table_data,
            db_stats::get_database_stats,
            db_stats::get_all_databases_stats,
            db_stats::get_exact_table_row_count,
            redis_db::redis_connect,
            redis_db::redis_disconnect,
            redis_db::redis_select_db,
            redis_db::redis_scan_keys,
            redis_db::redis_scan_stream,
            redis_db::redis_get_key,
            redis_db::redis_set_key,
            redis_db::redis_hash_set,
            redis_db::redis_hash_del,
            redis_db::redis_list_set,
            redis_db::redis_list_push,
            redis_db::redis_list_del,
            redis_db::redis_set_member,
            redis_db::redis_set_del_member,
            redis_db::redis_zset_add,
            redis_db::redis_zset_del,
            redis_db::redis_stream_add,
            redis_db::redis_stream_del,
            redis_db::redis_delete_keys,
            redis_db::redis_set_ttl,
            redis_db::redis_rename_key,
            redis_db::redis_flush_db,
            redis_db::redis_info,
            redis_db::redis_execute_cmd,
            redis_db::redis_set_read_only,
            redis_db::redis_get_elements,
            redis_db::redis_delete_by_pattern,
            redis_db::redis_slowlog_get,
            redis_db::redis_slowlog_reset,
            redis_db::redis_slowlog_config,
            redis_db::redis_pubsub_start,
            redis_db::redis_publish,
            redis_db::redis_monitor_start,
            redis_db::redis_json_get,
            redis_db::redis_json_set,
            redis_db::redis_json_del,
            redis_db::redis_set_key_bytes,
            redis_db::redis_stream_groups,
            redis_db::redis_stream_consumers,
            redis_db::redis_stream_pending,
            redis_db::redis_stream_ack,
            redis_db::redis_stream_claim,
            redis_db::redis_analyze_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
