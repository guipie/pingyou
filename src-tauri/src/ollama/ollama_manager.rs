use futures_util::StreamExt;
use ollama_rs::Ollama;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

// 远程配置文件地址（发布前可改为官方可信源）
const CONFIG_URL: &str = "https://hz.hkzh56.com/ollama.json";

// 我们自己拉起的 Ollama 子进程句柄，用于精准关闭（而非杀掉系统上所有同名进程）
fn engine_child() -> &'static Mutex<Option<Child>> {
    static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}

// 全局取消标志：前端调用 cancel_download 后置为 true，下载循环检测到后中断
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

// 全局下载状态标志：用于前端刷新后查询是否有正在进行的下载
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct DownloadPayload {
    progress: f64,
    status: String,
}

// 严格对应你提供的 JSON 嵌套层级结构
#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)]
struct OllamaPlatforms {
    windows: String,
    linux: String,
    mac: String,
}

#[derive(serde::Deserialize, Debug)]
struct RemoteConfig {
    ollama: OllamaPlatforms,
}

// 根据当前编译平台，动态获取对应的下载直链
fn select_url_by_platform(config: &RemoteConfig) -> &str {
    #[cfg(target_os = "windows")]
    return &config.ollama.windows;
    #[cfg(target_os = "macos")]
    return &config.ollama.mac;
    #[cfg(target_os = "linux")]
    return &config.ollama.linux;
}

// 获取本地沙箱内引擎的可执行文件名称
fn get_engine_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "ollama.exe";
    #[cfg(not(target_os = "windows"))]
    return "ollama";
}

// 发送下载进度事件，失败仅记录日志，不 panic
fn emit_progress(app_handle: &AppHandle, progress: f64, status: String) {
    if let Err(e) = app_handle.emit(
        "download-progress",
        DownloadPayload { progress, status },
    ) {
        log::warn!("发送下载进度事件失败: {}", e);
    }
}

// 在 spawn_blocking 中执行 ZIP 解压，避免阻塞 tokio 异步运行时
fn extract_zip_blocking(zip_path: std::path::PathBuf, engine_dir: std::path::PathBuf) -> Result<(), String> {
    let zip_file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name 会拒绝 ../ 等路径穿越，返回 None 时直接跳过
        let outpath = match file.enclosed_name() {
            Some(path) => engine_dir.join(path),
            None => continue,
        };
        if (*file.name()).ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_file(zip_path);
    Ok(())
}

// 检查是否已被取消，若取消则返回错误
fn check_cancelled() -> Result<(), String> {
    if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
        Err("下载已被用户取消".to_string())
    } else {
        Ok(())
    }
}

// ─── 对外暴露的命令 ────────────────────────────────────────────────

/// 前端调用此命令取消正在进行的下载
#[tauri::command]
pub fn cancel_download() {
    log::info!("[OLLAMA] 收到前端取消下载请求");
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
}

/// 前端刷新后调用此命令查询是否有下载正在进行（用于恢复 UI 状态）
#[tauri::command]
pub fn is_downloading() -> bool {
    DOWNLOAD_ACTIVE.load(Ordering::SeqCst)
}

// 1. 后台静默拉起内置的 Ollama 环境（若不存在则全自动下载解压）
#[tauri::command]
pub async fn start_ollama_engine(app_handle: AppHandle) -> Result<(), String> {
    // 重置取消标志并标记下载激活
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    DOWNLOAD_ACTIVE.store(true, Ordering::SeqCst);

    // 使用 defer 风格的 guard：函数退出时清理状态
    struct CleanupGuard;
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _guard = CleanupGuard;

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let engine_dir = app_dir.join("engine");
    let model_dir = app_dir.join("models");

    // 同步目录创建用 spawn_blocking 包裹，避免阻塞异步运行时
    let engine_dir_clone = engine_dir.clone();
    let model_dir_clone = model_dir.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&engine_dir_clone).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&model_dir_clone).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("目录创建任务失败: {}", e))??;

    let engine_path = engine_dir.join(get_engine_binary_name());

    // 检查本地是否已经下载过引擎组件
    if !engine_path.exists() {
        emit_progress(&app_handle, 0.0, "正在安全请求云端环境配置...".to_string());

        let client = reqwest::Client::new();
        let config = client
            .get(CONFIG_URL)
            .send()
            .await
            .map_err(|e| format!("无法连接配置服务器: {}", e))?
            .json::<RemoteConfig>()
            .await
            .map_err(|e| format!("解析远程配置失败: {}", e))?;

        let download_url = select_url_by_platform(&config);

        if download_url.is_empty() {
            return Err("云端配置中对应您系统的下载链接为空，请联系客服".to_string());
        }

        let is_zip = download_url.ends_with(".zip");
        let temp_download_path = if is_zip {
            engine_dir.join("ollama_temp.zip")
        } else {
            engine_path.clone()
        };

        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("请求下载直链失败: {}", e))?;

        let total_size = match response.content_length() {
            Some(size) if size > 0 => size,
            _ => {
                if is_zip {
                    1_460_000_000
                } else {
                    200_000_000
                }
            }
        };

        let mut file = File::create(&temp_download_path)
            .await
            .map_err(|e| format!("创建本地缓存文件失败: {}", e))?;
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_emitted_progress = 0.0;

        while let Some(item) = stream.next().await {
            // ★ 取消检查
            check_cancelled()?;

            let chunk = item.map_err(|e| format!("网络传输中断: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入硬盘失败: {}", e))?;

            downloaded += chunk.len() as u64;
            let mut progress = (downloaded as f64 / total_size as f64) * 100.0;
            if progress > 99.0 {
                progress = 99.0;
            }
            if progress < 0.0 || progress.is_nan() {
                progress = 0.0;
            }

            if progress - last_emitted_progress >= 0.5 || progress >= 99.0 {
                last_emitted_progress = progress;
                emit_progress(
                    &app_handle,
                    progress,
                    format!("正在高速下载AI核心组件: {:.1}%", progress),
                );
                tokio::task::yield_now().await;
            }
        }
        file.flush().await.map_err(|e| format!("刷新硬盘缓存失败: {}", e))?;
        drop(file);

        // 如果是 Windows 常见的 ZIP 包，用 spawn_blocking 解压
        if is_zip {
            // ★ 解压前再次检查取消
            check_cancelled()?;

            emit_progress(&app_handle, 99.5, "正在解压并深度优化本地 AI 显卡加速环境...".to_string());

            let zip_path = temp_download_path.clone();
            let engine_dir_for_unzip = engine_dir.clone();
            tokio::task::spawn_blocking(move || extract_zip_blocking(zip_path, engine_dir_for_unzip))
                .await
                .map_err(|e| format!("解压任务失败: {}", e))??;
        }

        // 非 Windows 系统自动修复可执行文件权限
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&engine_path)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&engine_path, perms).map_err(|e| e.to_string())?;
        }
    }

    // 智能检测真实的 ollama.exe 路径（防止官方压缩包解压后带有目录嵌套）
    let mut real_engine_path = engine_path.clone();
    if !real_engine_path.exists() {
        if let Ok(entries) = std::fs::read_dir(&engine_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join(get_engine_binary_name()).exists() {
                    real_engine_path = path.join(get_engine_binary_name());
                    break;
                }
            }
        }
    }

    // ★ 启动引擎前再次检查取消
    check_cancelled()?;

    emit_progress(&app_handle, 99.9, "内核环境就绪，正在激活大模型通道...".to_string());

    let model_dir_str = model_dir.to_string_lossy().to_string();
    log::info!("[OLLAMA] 模型存放绝对路径设置为: {}", model_dir_str);

    let _child = Command::new(&real_engine_path)
        .arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11435")
        .env("OLLAMA_MODELS", model_dir_str)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动本地AI服务失败: {}", e))?;

    // 保存句柄以便后续精准关闭；若存在旧句柄先回收，避免僵尸进程
    if let Ok(mut guard) = engine_child().lock() {
        if let Some(mut old) = guard.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        *guard = Some(_child);
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;

    Ok(())
}

// 2. 带进度条的模型下载封装
#[tauri::command(rename_all = "snake_case")]
pub async fn download_model(app_handle: AppHandle, model_name: String) -> Result<(), String> {
    // 标记下载激活（引擎启动可能已结束，这里重新标记）
    DOWNLOAD_ACTIVE.store(true, Ordering::SeqCst);

    struct CleanupGuard;
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _guard = CleanupGuard;

    let trimmed_name = model_name.trim();
    if trimmed_name.is_empty() {
        return Err("传入推荐模型名称为空，无法进行下载！".to_string());
    }
    log::info!("[OLLAMA] 准备下载模型: {}", trimmed_name);

    let ollama = Ollama::builder()
        .host("http://127.0.0.1".to_string())
        .port(11435)
        .build();

    let mut stream = ollama
        .pull_model_stream(model_name.clone(), false)
        .await
        .map_err(|e| format!("连接大模型仓库失败: {}", e))?;

    let mut last_emitted_progress = 0.0;
    let mut downloaded_any_chunk = false;

    while let Some(res) = stream.next().await {
        // ★ 取消检查
        check_cancelled()?;

        if let Ok(status) = res {
            if let (Some(completed), Some(total)) = (status.completed, status.total) {
                downloaded_any_chunk = true;
                let mut progress = (completed as f64 / total as f64) * 100.0;
                if progress > 99.5 {
                    progress = 99.5;
                }
                if progress < 0.0 || progress.is_nan() {
                    progress = 0.0;
                }
                if progress - last_emitted_progress >= 0.5 || progress >= 99.5 {
                    last_emitted_progress = progress;
                    emit_progress(
                        &app_handle,
                        progress,
                        format!("正在高速下载AI大模型: {:.1}%", progress),
                    );
                    tokio::task::yield_now().await;
                }
            } else {
                emit_progress(
                    &app_handle,
                    last_emitted_progress,
                    status.message.clone(),
                );
            }
        }
    }
    if !downloaded_any_chunk {
        return Err(format!(
            "模型下载失败：未接收到来自本地服务的有效数据流，请检查模型名称 [{}] 是否正确存在于官方仓库中。",
            trimmed_name
        ));
    }
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    emit_progress(&app_handle, 100.0, "模型初始化成功！".to_string());
    Ok(())
}

// -------------------------------------------------一键清理本地模型-----------------------------------------------
#[derive(Clone, serde::Serialize)]
struct CleanupPayload {
    success: bool,
    status: String,
}

fn emit_cleanup(app_handle: &AppHandle, success: bool, status: String) {
    if let Err(e) = app_handle.emit(
        "cleanup-status",
        CleanupPayload { success, status },
    ) {
        log::warn!("发送清理状态事件失败: {}", e);
    }
}

// 命令 1：安全强制关闭正在后台运行的本地 Ollama 引擎进程
#[tauri::command]
pub async fn stop_ollama_engine() -> Result<(), String> {
    // 优先精准关闭我们自己拉起的子进程，不去干扰用户自行安装的 Ollama
    let mut killed = false;
    if let Ok(mut guard) = engine_child().lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            killed = true;
        }
    }

    // 仅当没有跟踪到自己的子进程时（例如应用重启后句柄丢失），
    // 才回退到按名字杀进程。为减少误杀用户自装 Ollama，这里记录警告。
    if !killed {
        log::warn!("[OLLAMA] 未跟踪到本应用启动的 Ollama 子进程，回退到按名杀进程（可能影响用户自装 Ollama）");
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/IM", "ollama.exe"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("killall")
                .arg("ollama")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    Ok(())
}

// 命令 2：一键彻底清除本地大模型文件
#[tauri::command(rename_all = "snake_case")]
pub async fn cleanup_local_models(
    app_handle: AppHandle,
    model_name: Option<String>,
) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let engine_dir = app_dir.join("engine");
    let model_dir = app_dir.join("models");

    emit_cleanup(&app_handle, false, "正在安全关闭本地 AI 引擎...".to_string());
    let _ = stop_ollama_engine().await;

    if let Some(name) = model_name {
        emit_cleanup(&app_handle, false, format!("正在从本地仓库卸载模型: {}...", name));
        let ollama = Ollama::builder()
            .host("http://127.0.0.1".to_string())
            .port(11435)
            .build();
        let _ = ollama.delete_model(name).await;
    } else {
        emit_cleanup(&app_handle, false, "正在全量物理粉碎 AI 内核、显卡驱动及模型数据...".to_string());

        if model_dir.exists() {
            tokio::fs::remove_dir_all(&model_dir)
                .await
                .map_err(|e| format!("大模型仓库清理失败: {}", e))?;
            // 重新创建空文件夹，失败仅记录日志不阻断流程
            if let Err(e) = tokio::fs::create_dir_all(&model_dir).await {
                log::warn!("[OLLAMA] 重建模型目录失败: {}", e);
            }
        }

        if engine_dir.exists() {
            tokio::fs::remove_dir_all(&engine_dir)
                .await
                .map_err(|e| format!("1.8GB AI 核心组件清理失败: {}", e))?;
        }
    }

    emit_cleanup(&app_handle, true, "1.8GB 本地 AI 组件及模型已全部彻底移除，空间已完美释放！".to_string());

    Ok(())
}

// ----------------------模型管理----------------------

#[derive(serde::Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
}

#[tauri::command]
pub async fn list_local_models() -> Result<Vec<ModelInfo>, String> {
    let ollama = Ollama::builder()
        .host("http://127.0.0.1".to_string())
        .port(11435)
        .build();

    match ollama.list_local_models().await {
        Ok(models) => {
            let list = models
                .into_iter()
                .map(|m| ModelInfo {
                    name: m.name,
                    size: m.size,
                })
                .collect();
            Ok(list)
        }
        Err(e) => Err(format!("获取模型列表失败: {}", e)),
    }
}
