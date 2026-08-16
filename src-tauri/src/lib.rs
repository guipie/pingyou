mod core;
mod ollama;
mod utils;

use core::{
    device::start_device_listening,
    gamepad::{start_gamepad_listing, stop_gamepad_listing},
    prevent_default, setup,
};
use tauri::{Manager, WindowEvent, generate_handler};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_custom_window::{
    MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL, show_preference_window,
};
use utils::fs_extra::copy_dir;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();

            let main_window = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or_else(|| format!("主窗口 [{}] 未找到", MAIN_WINDOW_LABEL))?;

            let preference_window = app
                .get_webview_window(PREFERENCE_WINDOW_LABEL)
                .ok_or_else(|| format!("设置窗口 [{}] 未找到", PREFERENCE_WINDOW_LABEL))?;

            setup::default(&app_handle, main_window.clone(), preference_window.clone());
            // 当启动带参数 --dev 时，才打开开发者工具
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--pydev".to_string()) {
                // 遍历所有已创建的webview窗口
                let all_wins = app.webview_windows();
                for (_label, win) in all_wins {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(generate_handler![
            copy_dir,
            start_device_listening,
            start_gamepad_listing,
            stop_gamepad_listing,
            // 硬件检测-检查硬件-ollma管理
            utils::sys_info::check_hardware,
            ollama::ollama_manager::start_ollama_engine,
            ollama::ollama_manager::download_model,
            ollama::ollama_manager::pause_download,
            ollama::ollama_manager::resume_download,
            ollama::ollama_manager::cancel_download,
            ollama::ollama_manager::is_downloading,
            ollama::ollama_manager::stop_ollama_engine,
            ollama::ollama_manager::cleanup_local_models,
            ollama::ollama_manager::list_local_models,
            // apiKey 加密/解密
            utils::crypto::encrypt_string,
            utils::crypto::decrypt_string,
        ])
        // .plugin(tauri_plugin_shell::init()) // Tauri v2 必备插件
        .plugin(tauri_plugin_http::init()) // 注册插件
        .plugin(tauri_plugin_admin_status::init())
        .plugin(tauri_plugin_custom_window::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pinia::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(prevent_default::init())
        .plugin(tauri_plugin_single_instance::init(
            |app_handle, _argv, _cwd| {
                show_preference_window(app_handle);
            },
        ))
        .plugin(tauri_plugin_sql::Builder::default().build()) //启用SQLite
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                // 1. 核心：必须显式指定将日志输出到标准终端控制台 (Stdout)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                // 2. 核心：设置全局最低日志级别为 Debug，确保前端的 console.log (通常是 Debug/Info 级别) 能够通过过滤
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                // .filter(|metadata| !metadata.target().contains("gilrs"))
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_locale::init())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();

                api.prevent_close();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败，请检查配置与依赖");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            show_preference_window(app_handle);
        }
        _ => {
            let _ = app_handle;
        }
    });
}
