use futures_util::StreamExt;
use ollama_rs::Ollama;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, Duration};

// Ollama 引擎下载配置：优先从后端 /api/ollama/config 拉取，失败时回退到 GitHub 默认值。
// 三个平台分别对应官方发布产物：windows=.zip、linux=.tgz、mac=Ollama-darwin.zip。
#[derive(serde::Deserialize, Debug, Clone)]
#[allow(dead_code)]
struct OllamaDownloadConfig {
    windows: String,
    linux: String,
    mac: String,
    #[serde(default, rename = "panelUrl")]
    panel_url: String,
}

fn default_ollama_config() -> OllamaDownloadConfig {
    OllamaDownloadConfig {
        windows:
            "https://github.com/ollama/ollama/releases/download/v0.32.3/ollama-windows-amd64.zip"
                .to_string(),
        linux:
            "https://github.com/ollama/ollama/releases/download/v0.32.3/ollama-linux-amd64.tar.zst"
                .to_string(),
        mac: "https://github.com/ollama/ollama/releases/download/v0.32.3/ollama-darwin.tgz"
            .to_string(),
        panel_url: String::new(),
    }
}

/// 从后端拉取 Ollama 下载配置；未传地址或拉取/解析失败时回退到 GitHub 默认值。
async fn fetch_ollama_config(web_base: Option<&str>) -> OllamaDownloadConfig {
    let Some(base) = web_base.filter(|s| !s.trim().is_empty()) else {
        return default_ollama_config();
    };
    let url = format!("{}/api/ollama/config", base.trim_end_matches('/'));

    match reqwest::Client::new().get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<OllamaDownloadConfig>().await {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!("[OLLAMA] 解析后端下载配置失败，回退默认: {}", e);
                default_ollama_config()
            }
        },
        Ok(resp) => {
            log::warn!("[OLLAMA] 后端下载配置返回 {}，回退默认", resp.status());
            default_ollama_config()
        }
        Err(e) => {
            log::warn!("[OLLAMA] 拉取后端下载配置失败，回退默认: {}", e);
            default_ollama_config()
        }
    }
}

// 我们自己拉起的 Ollama 子进程句柄，用于精准关闭（而非杀掉系统上所有同名进程）
fn engine_child() -> &'static Mutex<Option<Child>> {
    static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}

// 全局取消标志：前端调用 cancel_download 后置为 true，下载循环检测到后中断
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

// 全局暂停标志：前端调用 pause_download 后置为 true，下载循环阻塞等待
static PAUSE_DOWNLOAD: AtomicBool = AtomicBool::new(false);

// 全局下载状态标志：用于前端刷新后查询是否有正在进行的下载
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct DownloadPayload {
    progress: f64,
    status: String,
    /// 下载阶段: "engine" | "model"，用于前端合并进度避免刷新跳动
    phase: String,
}

// 根据当前编译平台，动态获取对应的下载直链
fn select_url_by_platform(config: &OllamaDownloadConfig) -> &str {
    #[cfg(target_os = "windows")]
    return &config.windows;
    #[cfg(target_os = "macos")]
    return &config.mac;
    #[cfg(target_os = "linux")]
    return &config.linux;
}

// 获取本地沙箱内引擎的可执行文件名称
fn get_engine_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "ollama.exe";
    #[cfg(not(target_os = "windows"))]
    return "ollama";
}

// 发送下载进度事件，失败仅记录日志，不 panic
fn emit_progress(app_handle: &AppHandle, progress: f64, status: String, phase: &str) {
    if let Err(e) = app_handle.emit(
        "download-progress",
        DownloadPayload {
            progress,
            status,
            phase: phase.to_string(),
        },
    ) {
        log::warn!("发送下载进度事件失败: {}", e);
    }
}

// 在 spawn_blocking 中执行 ZIP 解压，避免阻塞 tokio 异步运行时
fn extract_zip_blocking(
    zip_path: std::path::PathBuf,
    engine_dir: std::path::PathBuf,
) -> Result<(), String> {
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

// 在 spawn_blocking 中执行 TGZ（.tar.gz）解压，避免阻塞 tokio 异步运行时。
// tar crate 的 unpack 自带路径穿越防护。
fn extract_tgz_blocking(
    tgz_path: std::path::PathBuf,
    engine_dir: std::path::PathBuf,
) -> Result<(), String> {
    let file = std::fs::File::open(&tgz_path).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&engine_dir)
        .map_err(|e| format!("解压 tgz 失败: {}", e))?;
    let _ = std::fs::remove_file(tgz_path);
    Ok(())
}

// 递归在 engine 目录中定位真正的 ollama 可执行文件。
// 兼容：裸二进制、zip 解压后的扁平结构、tgz 解压后的 bin/ 目录、mac 的 Ollama.app/Contents/Resources/。
fn find_ollama_binary(dir: &Path, binary_name: &str) -> Option<PathBuf> {
    let direct = dir.join(binary_name);
    if direct.is_file() {
        return Some(direct);
    }
    fn walk(dir: &Path, binary_name: &str, depth: usize) -> Option<PathBuf> {
        if depth > 8 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.file_name().map(|n| n == binary_name).unwrap_or(false) {
                return Some(path);
            }
            if path.is_dir() {
                if let Some(found) = walk(&path, binary_name, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(dir, binary_name, 0)
}

// ─── 下载循环中的状态检查 ─────────────────────────────────────────

/// 检查取消标志，若已取消返回错误
fn check_cancelled() -> Result<(), String> {
    if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
        Err("下载已被用户取消".to_string())
    } else {
        Ok(())
    }
}

/// 检查暂停标志，若暂停则循环 sleep 直到恢复或取消
async fn wait_if_paused() -> Result<(), String> {
    while PAUSE_DOWNLOAD.load(Ordering::SeqCst) {
        // 暂停期间也要检查取消
        check_cancelled()?;
        sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

// ─── 对外暴露的命令 ────────────────────────────────────────────────

/// 前端调用此命令暂停正在进行的下载
#[tauri::command]
pub fn pause_download() {
    log::info!("[OLLAMA] 收到前端暂停下载请求");
    PAUSE_DOWNLOAD.store(true, Ordering::SeqCst);
}

/// 前端调用此命令恢复暂停的下载
#[tauri::command]
pub fn resume_download() {
    log::info!("[OLLAMA] 收到前端恢复下载请求");
    PAUSE_DOWNLOAD.store(false, Ordering::SeqCst);
}

/// 前端调用此命令取消下载，并清理所有临时文件
#[tauri::command]
pub async fn cancel_download(app_handle: AppHandle) -> Result<(), String> {
    log::info!("[OLLAMA] 收到前端取消下载请求，将清理临时文件");

    // 先设置取消标志，并清除暂停（避免死锁）
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
    PAUSE_DOWNLOAD.store(false, Ordering::SeqCst);

    // 清理临时下载文件
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let engine_dir = app_dir.join("engine");

    // 删除引擎临时 zip（如果存在）
    let temp_zip = engine_dir.join("ollama_temp.zip");
    if temp_zip.exists() {
        if let Err(e) = tokio::fs::remove_file(&temp_zip).await {
            log::warn!("[OLLAMA] 删除临时zip失败: {}", e);
        } else {
            log::info!("[OLLAMA] 已清理临时zip: {:?}", temp_zip);
        }
    }

    // 如果引擎二进制不存在（说明引擎还没下载完），清理整个 engine 目录
    let engine_bin = engine_dir.join(get_engine_binary_name());
    if !engine_bin.exists() && engine_dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&engine_dir).await {
            log::warn!("[OLLAMA] 清理未完成引擎目录失败: {}", e);
        } else {
            log::info!("[OLLAMA] 已清理未完成的引擎目录");
        }
    }

    Ok(())
}

/// 前端刷新后调用此命令查询是否有下载正在进行（用于恢复 UI 状态）
#[tauri::command]
pub fn is_downloading() -> bool {
    DOWNLOAD_ACTIVE.load(Ordering::SeqCst)
}

// 1. 后台静默拉起内置的 Ollama 环境（若不存在则全自动下载解压）
#[tauri::command(rename_all = "snake_case")]
pub async fn start_ollama_engine(
    app_handle: AppHandle,
    web_base: Option<String>,
) -> Result<(), String> {
    // 重置取消/暂停标志并标记下载激活
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    PAUSE_DOWNLOAD.store(false, Ordering::SeqCst);
    DOWNLOAD_ACTIVE.store(true, Ordering::SeqCst);

    // 使用 defer 风格的 guard：函数退出时清理状态
    struct CleanupGuard;
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
            PAUSE_DOWNLOAD.store(false, Ordering::SeqCst);
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
        emit_progress(
            &app_handle,
            0.0,
            "正在安全请求云端环境配置...".to_string(),
            "engine",
        );

        let config = fetch_ollama_config(web_base.as_deref()).await;
        let download_url = select_url_by_platform(&config);

        if download_url.is_empty() {
            return Err("云端配置中对应您系统的下载链接为空，请联系客服".to_string());
        }

        let is_zip = download_url.ends_with(".zip");
        let is_tgz = download_url.ends_with(".tgz") || download_url.ends_with(".tar.gz");
        let is_archive = is_zip || is_tgz;
        let temp_download_path = if is_archive {
            engine_dir.join(if is_tgz {
                "ollama_temp.tgz"
            } else {
                "ollama_temp.zip"
            })
        } else {
            engine_path.clone()
        };

        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("请求下载直链失败: {}", e))?;

        let total_size = match response.content_length() {
            Some(size) if size > 0 => size,
            _ => {
                if is_archive {
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
            // ★ 暂停检查：阻塞等待直到恢复或取消
            wait_if_paused().await?;
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
                    "engine",
                );
                tokio::task::yield_now().await;
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("刷新硬盘缓存失败: {}", e))?;
        drop(file);

        // 解压压缩包（Windows/mac 用 zip，Linux 用 tgz）
        if is_archive {
            // ★ 解压前检查
            wait_if_paused().await?;
            check_cancelled()?;

            emit_progress(
                &app_handle,
                99.5,
                "正在解压并深度优化本地 AI 显卡加速环境...".to_string(),
                "engine",
            );

            let archive_path = temp_download_path.clone();
            let engine_dir_for_unzip = engine_dir.clone();
            if is_tgz {
                tokio::task::spawn_blocking(move || {
                    extract_tgz_blocking(archive_path, engine_dir_for_unzip)
                })
                .await
                .map_err(|e| format!("解压任务失败: {}", e))??;
            } else {
                tokio::task::spawn_blocking(move || {
                    extract_zip_blocking(archive_path, engine_dir_for_unzip)
                })
                .await
                .map_err(|e| format!("解压任务失败: {}", e))??;
            }
        }
    }

    // 智能检测真实的 ollama 路径（兼容 zip/tgz/裸二进制/mac .app 的目录嵌套）
    let real_engine_path = find_ollama_binary(&engine_dir, get_engine_binary_name())
        .ok_or_else(|| "未找到 ollama 引擎可执行文件，请检查安装包或重新下载".to_string())?;

    // 非 Windows 系统自动修复可执行文件权限
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&real_engine_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&real_engine_path, perms).map_err(|e| e.to_string())?;
    }

    // ★ 启动引擎前检查
    wait_if_paused().await?;
    check_cancelled()?;

    emit_progress(
        &app_handle,
        100.0,
        "内核环境就绪，正在激活大模型通道...".to_string(),
        "engine",
    );

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

/// 拖拽导入本地 Ollama 引擎文件（zip/tgz/裸二进制），解压/复制到沙箱 engine 目录。
/// 用户从网盘下载官方安装包后拖拽进应用，走此命令落盘，随后可直接启动引擎。
/// 说明：用户拖入的源文件保持不变，仅复制后解压到 engine 目录。
#[tauri::command(rename_all = "snake_case")]
pub async fn import_engine_file(app_handle: AppHandle, file_path: String) -> Result<(), String> {
    let src = PathBuf::from(&file_path);
    if !src.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let engine_dir = app_dir.join("engine");

    tokio::task::spawn_blocking({
        let engine_dir = engine_dir.clone();
        move || std::fs::create_dir_all(&engine_dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("目录创建任务失败: {}", e))??;

    let lower = file_path.to_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".tgz") || lower.ends_with(".tar.gz") {
        // 复制为临时文件后解压（解压函数会清理临时副本，用户源文件保留）
        let is_tgz = lower.ends_with(".tgz") || lower.ends_with(".tar.gz");
        let tmp = engine_dir.join(if is_tgz {
            "ollama_temp.tgz"
        } else {
            "ollama_temp.zip"
        });
        tokio::fs::copy(&src, &tmp)
            .await
            .map_err(|e| format!("复制文件失败: {}", e))?;

        let engine_dir_for_unzip = engine_dir.clone();
        if is_tgz {
            tokio::task::spawn_blocking(move || extract_tgz_blocking(tmp, engine_dir_for_unzip))
                .await
                .map_err(|e| format!("解压任务失败: {}", e))??;
        } else {
            tokio::task::spawn_blocking(move || extract_zip_blocking(tmp, engine_dir_for_unzip))
                .await
                .map_err(|e| format!("解压任务失败: {}", e))??;
        }
    } else {
        // 裸二进制：复制为 engine 目录下的标准名称
        let dest = engine_dir.join(get_engine_binary_name());
        tokio::fs::copy(&src, &dest)
            .await
            .map_err(|e| format!("复制文件失败: {}", e))?;

        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = tokio::fs::metadata(&dest)
                .await
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(0o755);
            tokio::fs::set_permissions(&dest, perms)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // 校验导入后能否定位到可执行文件
    if find_ollama_binary(&engine_dir, get_engine_binary_name()).is_none() {
        return Err("导入的安装包中未找到 ollama 引擎可执行文件，请确认文件正确".to_string());
    }

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
            PAUSE_DOWNLOAD.store(false, Ordering::SeqCst);
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
        // ★ 暂停检查
        wait_if_paused().await?;
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
                        "model",
                    );
                    tokio::task::yield_now().await;
                }
            } else {
                emit_progress(
                    &app_handle,
                    last_emitted_progress,
                    status.message.clone(),
                    "model",
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

    emit_progress(&app_handle, 100.0, "模型初始化成功！".to_string(), "model");
    Ok(())
}

// -------------------------------------------------一键清理本地模型-----------------------------------------------
#[derive(Clone, serde::Serialize)]
struct CleanupPayload {
    success: bool,
    status: String,
}

fn emit_cleanup(app_handle: &AppHandle, success: bool, status: String) {
    if let Err(e) = app_handle.emit("cleanup-status", CleanupPayload { success, status }) {
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

    emit_cleanup(
        &app_handle,
        false,
        "正在安全关闭本地 AI 引擎...".to_string(),
    );
    let _ = stop_ollama_engine().await;

    if let Some(name) = model_name {
        emit_cleanup(
            &app_handle,
            false,
            format!("正在从本地仓库卸载模型: {}...", name),
        );
        let ollama = Ollama::builder()
            .host("http://127.0.0.1".to_string())
            .port(11435)
            .build();
        let _ = ollama.delete_model(name).await;
    } else {
        emit_cleanup(
            &app_handle,
            false,
            "正在全量物理粉碎 AI 内核、显卡驱动及模型数据...".to_string(),
        );

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

    emit_cleanup(
        &app_handle,
        true,
        "1.8GB 本地 AI 组件及模型已全部彻底移除，空间已完美释放！".to_string(),
    );

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
