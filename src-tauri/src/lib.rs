mod commands;
pub mod files;
pub mod state;
pub mod store;

use std::io::Write;
use std::path::Path;

use tauri::{Manager, RunEvent, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;

pub use state::AppState;

/// Daily log files kept in `<data dir>/logs` (about a week of history).
const LOG_FILES_KEPT: usize = 7;

/// Starts the file logger: `<data dir>/logs/prometeo.<date>.log`, INFO unless `PROMETEO_LOG` says otherwise
/// (`PROMETEO_LOG=debug`, or a full `tracing` filter such as `info,prometeo_datagrip=debug`).
fn init_logging(log_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(log_dir)
        .map_err(|e| format!("Cannot create the log folder {}: {e}", log_dir.display()))?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("prometeo")
        .filename_suffix("log")
        .max_log_files(LOG_FILES_KEPT)
        .build(log_dir)
        .map_err(|e| format!("Cannot open a log file in {}: {e}", log_dir.display()))?;
    let filter = EnvFilter::try_from_env("PROMETEO_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(appender)
        .with_ansi(false)
        .try_init()
        .map_err(|e| format!("Cannot start logging: {e}"))
}

/// Writes the panic and its backtrace to `<logs>/panic.log` (flushed and synced before the process aborts),
/// then runs the previous hook.
fn install_panic_hook(log_dir: &Path) {
    let path = log_dir.join("panic.log");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        let text = format!(
            "[{ts}] PANIC at {location}: {message}\n{}\n",
            std::backtrace::Backtrace::force_capture()
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(text.as_bytes());
            let _ = f.flush();
            let _ = f.sync_all();
        }
        previous(info);
    }));
}

pub fn run() {
    let app = tauri::Builder::default()
        // must be the first plugin: a second launch has to reach the first instance before it creates windows
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
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
            // Logging must not keep the app from starting: a failure is reported on stderr (visible in dev builds).
            let log_dir = data_dir.join("logs");
            if let Err(e) = init_logging(&log_dir) {
                eprintln!("cannot start logging: {e}");
            }
            install_panic_hook(&log_dir);
            // The WebView keeps its own storage (localStorage: explorer state, tabs, layout). Under an overridden
            // data / config dir it must live there too, or the state of one profile leaks into another.
            let webview_dir = std::env::var_os("PROMETEO_DATA_DIR")
                .map(|d| std::path::PathBuf::from(d).join("webview"))
                .or_else(|| {
                    std::env::var_os("PROMETEO_CONFIG_DIR")
                        .map(|d| std::path::PathBuf::from(d).join("webview"))
                });
            let state = AppState::open(config_dir, data_dir)?;
            app.manage(state);
            // the main window is declared in tauri.conf.json with `create: false`: built here to set the WebView data directory
            for cfg in app.config().app.windows.iter().filter(|w| !w.create) {
                let mut builder = WebviewWindowBuilder::from_config(app.handle(), cfg)?;
                if let Some(dir) = &webview_dir {
                    std::fs::create_dir_all(dir)?;
                    builder = builder.data_directory(dir.clone());
                }
                builder.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_data_sources,
            commands::save_data_source,
            commands::delete_data_source,
            commands::duplicate_data_source,
            commands::copy_data_source_password,
            commands::export_data_sources,
            commands::import_data_sources,
            commands::import_data_sources_text,
            commands::export_settings,
            commands::import_settings,
            commands::choose_open_json,
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
            commands::explain_plan,
            commands::cancel_session,
            commands::table_data,
            commands::apply_changes,
            commands::table_data_in_session,
            commands::apply_changes_in_session,
            commands::choose_export_path,
            commands::default_export_path,
            commands::approve_export_path,
            commands::export_query,
            commands::export_query_to_string,
            commands::export_result,
            commands::export_to_string,
            commands::cancel_export,
            commands::choose_import_file,
            commands::import_preview,
            commands::import_file,
            commands::cancel_import,
            commands::run_sql_file,
            commands::cancel_script,
            commands::dump_schema,
            commands::cancel_dump,
            commands::open_dump_folder,
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
            commands::choose_open_files,
            commands::choose_attach_folder,
            commands::detach_file_root,
            commands::file_roots,
            commands::read_file,
            commands::write_file,
            commands::list_dir,
            commands::list_scratches,
            commands::create_scratch,
            commands::delete_scratch,
            commands::rename_scratch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Prometeo DataGrip");

    app.run(|handle, event| {
        // make sure the debounced ui-state write is not lost on exit
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                if let Err(e) = state.ui.flush() {
                    tracing::error!("cannot save ui state: {e}");
                }
            }
        }
    });
}
