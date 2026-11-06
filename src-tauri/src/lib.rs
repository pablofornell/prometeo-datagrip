mod commands;
pub mod state;
pub mod store;

use tauri::{Manager, RunEvent};

pub use state::AppState;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let paths = app.path();
            // PROMETEO_CONFIG_DIR / PROMETEO_DATA_DIR override the OS locations (demos, tests).
            let config_dir = std::env::var_os("PROMETEO_CONFIG_DIR")
                .map(Into::into)
                .unwrap_or(paths.app_config_dir()?);
            let data_dir = std::env::var_os("PROMETEO_DATA_DIR")
                .map(Into::into)
                .unwrap_or(paths.app_data_dir()?);
            let state = AppState::open(config_dir, data_dir)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_data_sources,
            commands::save_data_source,
            commands::delete_data_source,
            commands::duplicate_data_source,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::connected_data_sources,
            commands::open_session,
            commands::close_session,
            commands::session_in_transaction,
            commands::session_tx_status,
            commands::session_state,
            commands::introspect,
            commands::get_ddl,
            commands::schema_snapshot,
            commands::execute,
            commands::fetch_more,
            commands::cancel,
            commands::close_execution,
            commands::table_data,
            commands::apply_changes,
            commands::table_data_in_session,
            commands::apply_changes_in_session,
            commands::choose_export_path,
            commands::export_query,
            commands::export_query_to_string,
            commands::export_result,
            commands::export_to_string,
            commands::split_statements,
            commands::statement_at,
            commands::history_list,
            commands::history_search,
            commands::history_clear,
            commands::get_ui_state,
            commands::set_ui_state,
            commands::flush_ui_state,
            commands::list_consoles,
            commands::read_console,
            commands::write_console,
            commands::create_console,
            commands::delete_console,
            commands::rename_console,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Prometeo DataGrip");

    app.run(|handle, event| {
        // make sure the debounced ui-state write is not lost on exit
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                if let Err(e) = state.ui.flush() {
                    eprintln!("cannot save ui state: {e}");
                }
            }
        }
    });
}
