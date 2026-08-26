mod core;
mod ollama;
mod utils;

use core::{
    device::start_device_listening,
    gamepad::{start_gamepad_listing, stop_gamepad_listing},
    prevent_default, setup,
};
use tauri::{Emitter, Manager, WindowEvent, generate_handler};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_custom_window::{
    MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL, show_preference_window,
};
use utils::fs_extra::copy_dir;
use utils::local_http::spawn_local_http_server;
use utils::model_download::{copy_model_file, download_and_extract_model, download_model_file, ensure_custom_models_dir, extract_local_zip};

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
            // 捕获首次启动时的 deep link URL（Windows/Linux 下通过 CLI 参数传入）
            // 直接 emit 事件，前端 onMounted 里通过 listen("deep-link-url") 接收
            if let Some(url) = args.iter().find(|arg| arg.starts_with("pingyou://")) {
                let _ = app_handle.emit("deep-link-url", url.clone());
            }

            // 启动本地 HTTP 回调服务（http://127.0.0.1:14201）：
            //   - 浏览器可以通过 GET /ping 探测应用是否在运行
            //   - GET /import-model?id=xxx 直接触发模型下载（不依赖 pingyou:// 协议）
            spawn_local_http_server(&app_handle);

            // 启动时一次性修复 custom-models 目录权限（解决 Windows ERROR_ACCESS_DENIED / os error 5）
            // 目录从 APPDATA 迁移到了 <EXEDIR>/assets/custom-models（dev 下=target/debug/assets/custom-models）
            if let Ok(root_dir) = ensure_custom_models_dir() {
                let _ = utils::model_download::fixup_acl_recursive(&root_dir);
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
            // 模型下载与解压（deep link 导入模型）
            download_and_extract_model,
            download_model_file,
            utils::model_download::resolve_custom_models_dir,
            extract_local_zip,
            copy_model_file
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
            |app_handle, argv, _cwd| {
                // Windows/Linux 下 deep link 会启动新实例，single-instance 拦截后将 URL 转发给主实例
                for arg in &argv {
                    if arg.starts_with("pingyou://") {
                        let _ = app_handle.emit("deep-link-url", arg.clone());
                    }
                }
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
        .plugin(tauri_plugin_deep_link::init())
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
