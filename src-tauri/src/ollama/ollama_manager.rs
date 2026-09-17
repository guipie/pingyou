use futures_util::StreamExt;
use ollama_rs::Ollama;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;
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

/// 引擎下载任务在任务表中的保留键（模型名不会与它冲突）
const ENGINE_JOB_KEY: &str = "__engine__";

/// 引擎私有端口 —— **只允许本应用内部的鉴权网关访问**。
///
/// 刻意避开 Ollama 默认的 11434：用途就是让"本应用拉起的引擎"与"用户自装的 Ollama"
/// 互不干扰，同时也让"谁占着这个端口"成为一个可靠的归属判据（见 `kill_port_owner`）。
///
/// 之所以再挪一层（从 11435 到 11436），是因为 11435 现在留给鉴权网关
/// （见 `gateway.rs`）：客户端一律打 11435 并被校验 apiKey，上游 Ollama 隐藏在 11436。
pub(crate) const ENGINE_PORT: u16 = 11436;

/// 对外网关端口：客户端（本应用 / 用户自备的客户端）连接的就是它，需带 apiKey。
pub(crate) const GATEWAY_PORT: u16 = 11435;

/// 用户取消下载时的统一错误文案，前端据此区分"取消"与"真失败"
const CANCELLED_MSG: &str = "下载已被用户取消";

// ─── 任务级下载状态 ───────────────────────────────────────────────
//
// 引擎启动与模型下载是两个独立的生命周期：
//   - 引擎：键为 ENGINE_JOB_KEY，只在"引擎组件下载/解压"期间占用
//   - 模型：键为模型名，每个模型各自独立，可并发拉取
// 三张表都以"任务键"索引，从而支持"每张模型卡片各自显示进度"。

/// 进行中的任务（用于刷新后恢复 UI、以及"全部暂停/全部取消"）
fn active_jobs() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 已请求取消的任务
fn cancel_flags() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 已请求暂停的任务
fn pause_flags() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 引擎启动单飞锁：同一时刻只允许一个引擎启动流程，
/// 避免"应用启动自动拉起"与"用户点击安装"并发时重复 spawn / 互相杀进程。
fn engine_start_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn set_flag(set: &'static Mutex<HashSet<String>>, key: &str, on: bool) {
    if let Ok(mut guard) = set.lock() {
        if on {
            guard.insert(key.to_string());
        } else {
            guard.remove(key);
        }
    }
}

fn has_flag(set: &'static Mutex<HashSet<String>>, key: &str) -> bool {
    set.lock().map(|g| g.contains(key)).unwrap_or(false)
}

fn active_keys() -> Vec<String> {
    active_jobs()
        .lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

/// 任务生命周期守卫：进入作用域即登记为"进行中"，退出时自动摘除各标志位，
/// 这样即使中途 return Err / panic 也不会把状态卡死。
struct JobGuard {
    key: String,
}

impl JobGuard {
    fn new(key: &str) -> Self {
        set_flag(active_jobs(), key, true);
        set_flag(cancel_flags(), key, false);
        set_flag(pause_flags(), key, false);
        Self { key: key.to_string() }
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        set_flag(active_jobs(), &self.key, false);
        set_flag(cancel_flags(), &self.key, false);
        set_flag(pause_flags(), &self.key, false);
    }
}

#[derive(Clone, serde::Serialize)]
struct DownloadPayload {
    progress: f64,
    status: String,
    /// 下载阶段: "engine" | "model"，用于前端区分"引擎组件"与"模型权重"
    phase: String,
    /// 所属模型名；引擎阶段为空字符串。前端据此把进度派发到对应的模型卡片
    model: String,
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
fn emit_progress(app_handle: &AppHandle, progress: f64, status: String, phase: &str, model: &str) {
    if let Err(e) = app_handle.emit(
        "download-progress",
        DownloadPayload {
            progress,
            status,
            phase: phase.to_string(),
            model: model.to_string(),
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

// ─── 下载循环中的状态检查（按任务键区分） ─────────────────────────

/// 检查取消标志，若已取消返回错误
fn check_cancelled(key: &str) -> Result<(), String> {
    if has_flag(cancel_flags(), key) {
        Err(CANCELLED_MSG.to_string())
    } else {
        Ok(())
    }
}

/// 检查暂停标志，若暂停则循环 sleep 直到恢复或取消
async fn wait_if_paused(key: &str) -> Result<(), String> {
    while has_flag(pause_flags(), key) {
        // 暂停期间也要检查取消
        check_cancelled(key)?;
        sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

// ─── 引擎探活 / 模型列表 工具 ─────────────────────────────────────

fn build_ollama_client() -> Ollama {
    Ollama::builder()
        .host("http://127.0.0.1".to_string())
        .port(ENGINE_PORT)
        .build()
}

/// 引擎是否已在运行（能连上私有引擎端口 11436 并返回模型列表）。
/// 连接被拒绝时会快速返回 Err，因此这是一个廉价的探活手段。
async fn is_engine_running() -> bool {
    build_ollama_client().list_local_models().await.is_ok()
}

/// 拉取当前已安装的全部模型
async fn list_models() -> Vec<ModelInfo> {
    match build_ollama_client().list_local_models().await {
        Ok(models) => models
            .into_iter()
            .map(|m| ModelInfo {
                name: m.name,
                size: m.size,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 在本地仓库中查找模型，返回**仓库里真实存在的那个名字**。
///
/// 兼容两种写法：请求 `moondream` 时仓库里存的可能是 `moondream:latest`。
/// 之所以要返回真实名字而不是 bool —— 前端拿到它可以做两件正确的事：
///   1. 用精确名字给"已安装"打标签（避免 `moondream` vs `moondream:latest` 的错配）
///   2. 用精确名字调用卸载/推理，避免再猜一次
async fn find_local_model(name: &str) -> Option<String> {
    let with_tag = if name.contains(':') {
        name.to_string()
    } else {
        format!("{}:latest", name)
    };
    list_models()
        .await
        .into_iter()
        .find(|m| m.name == name || m.name == with_tag)
        .map(|m| m.name)
}

/// 判断某个模型是否已存在于本地仓库（兼容省略 `:latest` 的写法）
async fn local_model_exists(name: &str) -> bool {
    find_local_model(name).await.is_some()
}

/// 轮询等待引擎就绪，超时返回 false
async fn wait_engine_ready(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if is_engine_running().await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(500)).await;
    }
}

/// 拉起 Ollama 服务进程（`serve`），并指定模型仓库目录。
///
/// - 若之前拉起的子进程仍然存活 → 不重复拉起，直接返回
/// - 若已退出 → 回收句柄后重新拉起
fn spawn_engine_process(binary: &Path, model_dir: &Path) -> Result<(), String> {
    let model_dir_str = model_dir.to_string_lossy().to_string();
    log::info!("[OLLAMA] 模型存放绝对路径设置为: {}", model_dir_str);

    let mut guard = engine_child()
        .lock()
        .map_err(|_| "引擎句柄锁被污染".to_string())?;

    // 已有存活的子进程 → 幂等返回
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            log::info!("[OLLAMA] 已存在存活的引擎子进程，跳过重复拉起");
            return Ok(());
        }
        // 已退出 → 回收，避免僵尸进程
        if let Some(mut dead) = guard.take() {
            let _ = dead.wait();
        }
    }

    let child = Command::new(binary)
        .arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{}", ENGINE_PORT))
        .env("OLLAMA_MODELS", model_dir_str)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动本地AI服务失败: {}", e))?;

    *guard = Some(child);
    Ok(())
}

/// 我们跟踪的引擎子进程是否仍然存活。
///
/// 这是判断"引擎端口上那个进程是不是我们自己拉起来的"的唯一可靠依据：
/// 句柄在，说明是我们用带 `OLLAMA_MODELS` 的参数拉起的；句柄不在，则端口上那个进程
/// 要么是上一次运行遗留的孤儿进程、要么是别的程序，它的模型目录不受我们控制。
fn our_engine_alive() -> bool {
    let Ok(mut guard) = engine_child().lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// 结束占用指定端口的进程。
///
/// 用端口（而非进程名）定位，是因为引擎端口是本应用独占的：
/// 用户自装的 Ollama 固定在默认的 11434，绝不会被这里误杀。
pub(crate) fn kill_port_owner(port: u16) {
    let port = port.to_string();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 避免弹出黑色控制台窗口
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let output = match Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                log::warn!("[OLLAMA] 执行 netstat 失败，无法定位端口占用进程: {}", e);
                return;
            }
        };

        // 只匹配形如 `TCP 127.0.0.1:11436 0.0.0.0:0 LISTENING 1234` 的行。
        // netstat 输出在中文系统上含非 ASCII 字节，这里按 lossy 解码后只取 ASCII 字段。
        let text = String::from_utf8_lossy(&output.stdout);
        let needle = format!(":{}", port);
        let mut pids: Vec<String> = Vec::new();
        for line in text.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
                continue;
            }
            if !cols[3].eq_ignore_ascii_case("LISTENING") {
                continue;
            }
            if cols[1].ends_with(&needle) {
                pids.push(cols[cols.len() - 1].to_string());
            }
        }

        for pid in pids {
            log::warn!("[OLLAMA] 结束占用端口 {} 的进程 PID={}", port, pid);
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // lsof 在 macOS 上默认存在；Linux 多数发行版需要安装 lsof，失败时回退到 pkill
        let lsof = Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port)])
            .output();

        if let Ok(output) = lsof {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for pid in text.split_whitespace() {
                    log::warn!("[OLLAMA] 结束占用端口 {} 的进程 PID={}", port, pid);
                    let _ = Command::new("kill")
                        .args(["-9", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .output();
                }
                return;
            }
        }

        let _ = Command::new("pkill")
            .arg("-f")
            .arg("ollama serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
}

/// 确保"**我们自己的**引擎"在运行，并保证它使用沙箱内的模型目录。
///
/// 为什么不能只用 `is_engine_running()` 判断：该探活只说明"引擎端口上有 Ollama 在服务"，
/// 无法分辨对方是不是本应用拉起的。历史上的孤儿进程（旧版本不带 `OLLAMA_MODELS` 启动）
/// 会一直占着这个端口，导致模型被下载到默认的 `~/.ollama`，表现为：
///   - 卡片点了"安装"，提示成功，但沙箱里找不到模型文件；
///   - 沙箱里明明装好的模型，列表里却显示"未安装"。
/// 因此这里在复用前先校验归属，发现端口被非我方进程占用时强制接管。
async fn ensure_our_engine(binary: &Path, model_dir: &Path) -> Result<bool, String> {
    // ① 我们自己拉起的子进程还活着 → 只等它把端口监听起来
    if our_engine_alive() {
        if wait_engine_ready(Duration::from_secs(20)).await {
            return Ok(true);
        }
        log::warn!("[OLLAMA] 已跟踪的子进程存活但端口无响应，判定为僵死，重启引擎");
        if let Ok(mut guard) = engine_child().lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    } else if is_engine_running().await {
        // ② 端口被"不是本应用启动"的引擎占用 → 它的模型目录不是我们的沙箱目录
        log::warn!(
            "[OLLAMA] 端口 {} 被非本应用启动的引擎占用，其模型目录不受本应用控制，正在接管",
            ENGINE_PORT
        );
        kill_port_owner(ENGINE_PORT);
        // 等端口真正释放，最多 6s
        for _ in 0..40 {
            if !is_engine_running().await {
                break;
            }
            sleep(Duration::from_millis(150)).await;
        }
    }

    // ③ 拉起我们自己的引擎（带 OLLAMA_MODELS）
    spawn_engine_process(binary, model_dir)?;
    if !wait_engine_ready(Duration::from_secs(30)).await {
        return Err("本地 AI 引擎启动超时，请稍后重试（若安装了安全软件，请放行 ollama 进程）".to_string());
    }
    Ok(true)
}

// ─── 对外暴露的命令 ────────────────────────────────────────────────

/// 前端调用此命令暂停下载。
/// 传入 `model_name` 只暂停该任务；不传或为空则暂停全部进行中的任务。
#[tauri::command(rename_all = "snake_case")]
pub fn pause_download(model_name: Option<String>) {
    match model_name.filter(|n| !n.trim().is_empty()) {
        Some(name) => {
            log::info!("[OLLAMA] 暂停任务: {}", name);
            set_flag(pause_flags(), &name, true);
        }
        None => {
            let keys = active_keys();
            log::info!("[OLLAMA] 暂停全部任务: {:?}", keys);
            for key in keys {
                set_flag(pause_flags(), &key, true);
            }
        }
    }
}

/// 前端调用此命令恢复下载。语义同 `pause_download`（不传则恢复全部）。
#[tauri::command(rename_all = "snake_case")]
pub fn resume_download(model_name: Option<String>) {
    match model_name.filter(|n| !n.trim().is_empty()) {
        Some(name) => {
            log::info!("[OLLAMA] 恢复任务: {}", name);
            set_flag(pause_flags(), &name, false);
        }
        None => {
            let keys = active_keys();
            log::info!("[OLLAMA] 恢复全部任务: {:?}", keys);
            for key in keys {
                set_flag(pause_flags(), &key, false);
            }
        }
    }
}

/// 前端调用此命令取消下载，并清理临时文件。
/// 传入 `model_name` 只取消该任务；不传或为空则取消全部进行中的任务。
#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_download(app_handle: AppHandle, model_name: Option<String>) -> Result<(), String> {
    let targets: Vec<String> = match model_name.filter(|n| !n.trim().is_empty()) {
        Some(name) => vec![name],
        None => active_keys(),
    };
    log::info!("[OLLAMA] 收到取消下载请求: {:?}", targets);

    // 先设置取消标志，并清除暂停（避免 wait_if_paused 死锁）
    for key in &targets {
        set_flag(cancel_flags(), key, true);
        set_flag(pause_flags(), key, false);
    }

    // 只有引擎组件下载被取消时才需要清理引擎临时文件
    let engine_involved = targets.iter().any(|k| k == ENGINE_JOB_KEY) || targets.is_empty();
    if !engine_involved {
        return Ok(());
    }

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

/// 前端刷新/重开设置页后调用此命令查询哪些任务仍在进行（用于恢复 UI 状态）。
/// 返回任务键列表：模型名 或 ENGINE_JOB_KEY（引擎组件）。
#[tauri::command]
pub fn is_downloading() -> Vec<String> {
    active_keys()
}

/// 引擎组件下载 + 解压（仅在引擎可执行文件缺失时调用）。
/// 进度以 phase="engine" 推送，与模型下载完全分离。
async fn download_engine_component(
    app_handle: &AppHandle,
    web_base: Option<&str>,
    engine_dir: &Path,
    engine_path: &Path,
) -> Result<(), String> {
    emit_progress(
        app_handle,
        0.0,
        "正在安全请求云端环境配置...".to_string(),
        "engine",
        "",
    );

    let config = fetch_ollama_config(web_base).await;
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
        engine_path.to_path_buf()
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
        wait_if_paused(ENGINE_JOB_KEY).await?;
        // ★ 取消检查
        check_cancelled(ENGINE_JOB_KEY)?;

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
                app_handle,
                progress,
                format!("正在高速下载AI核心组件: {:.1}%", progress),
                "engine",
                "",
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
        wait_if_paused(ENGINE_JOB_KEY).await?;
        check_cancelled(ENGINE_JOB_KEY)?;

        emit_progress(
            app_handle,
            99.5,
            "正在解压并深度优化本地 AI 显卡加速环境...".to_string(),
            "engine",
            "",
        );

        let archive_path = temp_download_path.clone();
        let engine_dir_for_unzip = engine_dir.to_path_buf();
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

    Ok(())
}

// 1. 拉起内置的 Ollama 环境。**幂等**：
//    - 引擎已在运行 → 立即返回，不重复 spawn、不杀进程
//    - 引擎可执行文件缺失 → 全自动下载 + 解压（phase="engine" 进度）
//    - 引擎已就绪但未运行 → 直接拉起，并轮询等待端口可用
#[tauri::command(rename_all = "snake_case")]
pub async fn start_ollama_engine(
    app_handle: AppHandle,
    web_base: Option<String>,
) -> Result<(), String> {
    // 单飞锁：避免应用启动自动拉起与用户手动启动并发执行
    let _start_lock = engine_start_lock().lock().await;
    // 任务守卫：函数退出时自动摘除任务标志
    let _guard = JobGuard::new(ENGINE_JOB_KEY);

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

    // ★ 幂等 + 归属校验：见 `ensure_our_engine`。
    //   注意这里**不能**简单地 `if is_engine_running() { return Ok(()) }` ——
    //   那样会把上一次运行遗留的孤儿引擎（模型目录为默认 ~/.ollama）当成自己的引擎复用，
    //   从而出现"模型装到别处 / 装了却显示未安装"的问题。
    if our_engine_alive() && is_engine_running().await {
        log::info!("[OLLAMA] 本应用的引擎已在运行，跳过启动流程");
        emit_progress(
            &app_handle,
            100.0,
            "内核环境就绪，正在激活大模型通道...".to_string(),
            "engine",
            "",
        );
        return Ok(());
    }

    let engine_path = engine_dir.join(get_engine_binary_name());

    // 检查本地是否已经下载过引擎组件（兼容解压后目录嵌套的情况）
    let installed = engine_path.exists() || find_ollama_binary(&engine_dir, get_engine_binary_name()).is_some();
    if !installed {
        download_engine_component(&app_handle, web_base.as_deref(), &engine_dir, &engine_path).await?;
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
    wait_if_paused(ENGINE_JOB_KEY).await?;
    check_cancelled(ENGINE_JOB_KEY)?;

    emit_progress(
        &app_handle,
        100.0,
        "内核环境就绪，正在激活大模型通道...".to_string(),
        "engine",
        "",
    );

    // ★ 拉起（必要时先接管被占用的端口），并轮询等待真正可用
    ensure_our_engine(&real_engine_path, &model_dir).await?;

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

// 2. 带进度条的模型下载封装。
//
// 与引擎启动完全解耦：这里**不负责**下载/拉起引擎，只要求引擎已就绪。
// 每个模型的进度以 `model` 字段推送给前端，因此多张卡片可以各自显示自己的进度。
//
// 返回值：模型在本地仓库中的**真实名称**（请求 `moondream` 时可能是 `moondream:latest`）。
// 前端据此打"已安装"标签，避免名称差一个 `:latest` 就误判为未安装。
#[tauri::command(rename_all = "snake_case")]
pub async fn download_model(app_handle: AppHandle, model_name: String) -> Result<String, String> {
    let trimmed_name = model_name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err("传入模型名称为空，无法进行下载！".to_string());
    }
    log::info!("[OLLAMA] 准备下载模型: {}", trimmed_name);

    // 任务守卫：进入即登记，退出（含出错）自动摘除
    let _guard = JobGuard::new(&trimmed_name);

    // 1) 引擎必须就绪。等待一小段时间，兼容"刚启动引擎立刻点安装"的时序。
    if !is_engine_running().await && !wait_engine_ready(Duration::from_secs(20)).await {
        return Err("本地 AI 引擎未运行，请先启动引擎后再安装模型".to_string());
    }

    // 2) 幂等：模型已存在 → 直接视为成功（避免重复拉取被误判为失败）
    if let Some(existing) = find_local_model(&trimmed_name).await {
        log::info!("[OLLAMA] 模型已存在，跳过下载: {} -> {}", trimmed_name, existing);
        emit_progress(
            &app_handle,
            100.0,
            "模型初始化成功！".to_string(),
            "model",
            &trimmed_name,
        );
        return Ok(existing);
    }

    // 3) 拉取
    let ollama = build_ollama_client();
    let mut stream = ollama
        .pull_model_stream(trimmed_name.clone(), false)
        .await
        .map_err(|e| format!("连接本地模型仓库失败: {}", e))?;

    let mut last_emitted_progress = 0.0;
    let mut downloaded_any_chunk = false;
    let mut saw_success = false;
    let mut stream_error: Option<String> = None;

    while let Some(res) = stream.next().await {
        // ★ 暂停检查
        wait_if_paused(&trimmed_name).await?;
        // ★ 取消检查
        check_cancelled(&trimmed_name)?;

        match res {
            Ok(status) => {
                let message = status.message.trim().to_string();
                match (status.completed, status.total) {
                    (Some(completed), Some(total)) if total > 0 => {
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
                                &trimmed_name,
                            );
                            tokio::task::yield_now().await;
                        }
                    }
                    _ => {
                        if message.eq_ignore_ascii_case("success") {
                            saw_success = true;
                        }
                        emit_progress(
                            &app_handle,
                            last_emitted_progress,
                            message,
                            "model",
                            &trimmed_name,
                        );
                    }
                }
            }
            Err(e) => {
                // ★ 关键修复：Ollama 通过 `{"error": "..."}` 返回的失败信息原本被静默丢弃，
                //   导致前端只能看到"未接收到有效数据流"这种无意义的兜底文案。
                //   这里把它原样带出去，让用户看到真正的失败原因。
                stream_error = Some(format!("{}", e));
                break;
            }
        }
    }

    if let Some(err) = stream_error {
        // 兜底确认：个别情况下收尾阶段的报错并不代表模型没下成
        if local_model_exists(&trimmed_name).await {
            log::warn!("[OLLAMA] 拉取过程报错但模型已就位，忽略该错误: {}", err);
        } else {
            return Err(format!("模型下载失败：{err}"));
        }
    }

    if !downloaded_any_chunk && !saw_success && !local_model_exists(&trimmed_name).await {
        return Err(format!(
            "模型下载失败：未从本地服务获取到有效数据流。请确认模型名称 [{trimmed_name}] 是否正确，或检查网络能否访问模型仓库。"
        ));
    }

    // ★ 收尾前必须能在仓库里找到它 —— 否则"提示安装成功"就是假的。
    //   这是最后一道防线：宁可报错，也不让前端显示一个并不存在的"已安装"。
    let resolved = find_local_model(&trimmed_name).await.ok_or_else(|| {
        format!("模型 [{trimmed_name}] 下载流程已结束，但未能在本地仓库中找到它，请重试或联系客服")
    })?;

    emit_progress(
        &app_handle,
        100.0,
        "模型初始化成功！".to_string(),
        "model",
        &trimmed_name,
    );
    Ok(resolved)
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

/// 应用退出时**同步**回收引擎子进程。
///
/// 为什么需要它：子进程不会随父进程结束而自动消失，历史上多次出现
/// "屏友已退出、ollama.exe 仍占着引擎端口" 的孤儿进程，下一轮启动时
/// 端口被这个旧引擎劫持（它的模型目录可能还是默认的 `~/.ollama`），
/// 表现为"模型明明装了却显示未安装"，排查成本极高。
///
/// 必须放在 `RunEvent::Exit` 里同步执行：那是进程的最后时刻，不能再 spawn 异步任务。
pub fn shutdown_engine_blocking() {
    if let Ok(mut guard) = engine_child().lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            log::info!("[OLLAMA] 应用退出，已回收本应用拉起的引擎子进程");
        }
    }
}

// 命令 1：安全强制关闭正在后台运行的本地 Ollama 引擎进程
#[tauri::command]
pub async fn stop_ollama_engine() -> Result<(), String> {
    // 引擎停止 = 引擎任务结束，清掉相关标志位，避免下次启动被残留状态影响
    set_flag(cancel_flags(), ENGINE_JOB_KEY, false);
    set_flag(pause_flags(), ENGINE_JOB_KEY, false);
    set_flag(active_jobs(), ENGINE_JOB_KEY, false);

    // 优先精准关闭我们自己拉起的子进程，不去干扰用户自行安装的 Ollama
    let mut killed = false;
    if let Ok(mut guard) = engine_child().lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            killed = true;
        }
    }

    // 句柄丢失（例如应用重启后遗留的孤儿进程）时，按"端口归属"兜底收尾。
    // 用引擎私有端口而不是进程名，因此绝不会误杀用户自装的、跑在 11434 上的 Ollama。
    if !killed && is_engine_running().await {
        log::warn!(
            "[OLLAMA] 未跟踪到本应用的引擎子进程，按端口 {} 回收占用进程",
            ENGINE_PORT
        );
        kill_port_owner(ENGINE_PORT);
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    Ok(())
}

// 命令 2：卸载单个模型 / 一键彻底清除本地大模型文件
//
// ★ 两种语义严格区分（与"引擎启动 / 模型下载解耦"保持一致）：
//   - 传入 model_name → 只删这一个模型，**不触碰引擎**（引擎仍需保持运行才能删）
//   - 不传 model_name → 全量清理：先停引擎，再物理删除模型与引擎数据
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

    // ── 分支 1：卸载单个模型 ────────────────────────────────────────
    if let Some(name) = model_name.filter(|n| !n.trim().is_empty()) {
        emit_cleanup(
            &app_handle,
            false,
            format!("正在从本地仓库卸载模型: {}...", name),
        );

        // 引擎需处于运行状态才能执行删除；旧实现先停引擎再删除，必然失败
        if !is_engine_running().await && !wait_engine_ready(Duration::from_secs(10)).await {
            return Err("本地 AI 引擎未运行，无法卸载模型，请先启动引擎".to_string());
        }

        // 用仓库里的真实名字删除（请求 `moondream`、实际存的是 `moondream:latest`）
        let real_name = find_local_model(&name)
            .await
            .ok_or_else(|| format!("本地仓库中未找到模型 [{}]，无需卸载", name))?;

        build_ollama_client()
            .delete_model(real_name)
            .await
            .map_err(|e| format!("卸载模型失败: {}", e))?;

        emit_cleanup(&app_handle, true, "模型已从本地仓库卸载".to_string());
        return Ok(());
    }

    // ── 分支 2：全量清理 ──────────────────────────────────────────
    emit_cleanup(
        &app_handle,
        false,
        "正在安全关闭本地 AI 引擎...".to_string(),
    );
    let _ = stop_ollama_engine().await;

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
    let ollama = build_ollama_client();

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

/// 本地供应商就绪状态 — 启动时自动调用
#[derive(serde::Serialize)]
pub struct LocalProviderStatus {
    /// Ollama 引擎是否已安装（可执行文件存在）
    pub installed: bool,
    /// 引擎是否已在运行（能连接私有引擎端口 11436）
    pub running: bool,
    /// 已安装的模型（最多 5 个，超过截断只取前 5）
    pub models: Vec<ModelInfo>,
    /// 截断提示：当安装模型超过 5 时为 true
    pub truncated: bool,
    /// 引擎实际使用的模型仓库绝对路径（供 UI 展示，便于用户核对模型落盘位置）
    pub model_dir: String,
    /// 鉴权网关是否已就绪。false 表示模型无法通过 127.0.0.1:11435 访问
    pub gateway_ready: bool,
}

/// 启动时自动启动 Ollama + 拉取已下载模型列表。
///
/// 设计约定：
///   - **只拉起引擎，不下载模型**。模型由用户在各卡片上按需安装（或已下载的直接可用）。
///   - 幂等：引擎已在运行则直接复用，不会重复 spawn 或杀掉正在服务的进程。
///
/// 返回值：
///   - 未安装 → installed=false, running=false, models=[]
///   - 已安装但未运行 → 尝试拉起后返回（running 为**拉起后重新探测**的真实结果）
///   - 已运行 → 直接返回模型列表
#[tauri::command]
pub async fn ensure_local_provider(app_handle: AppHandle) -> LocalProviderStatus {
    // 引擎启动单飞，避免与 start_ollama_engine 并发
    let _start_lock = engine_start_lock().lock().await;

    let app_dir = app_handle.path().app_data_dir().unwrap_or_default();
    let engine_dir = app_dir.join("engine");
    let model_dir = app_dir.join("models");
    let model_dir_str = model_dir.to_string_lossy().to_string();

    // 1. 检查引擎是否安装
    let bundled_binary = find_ollama_binary(&engine_dir, get_engine_binary_name());
    let mut installed = bundled_binary.is_some();

    if !installed {
        // 也检查系统 PATH 里有没有 ollama（用户自己装的）
        installed = std::process::Command::new(get_engine_binary_name())
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if !installed {
            return LocalProviderStatus {
                installed: false,
                running: false,
                models: Vec::new(),
                truncated: false,
                model_dir: model_dir_str,
                gateway_ready: super::gateway::is_gateway_ready(),
            };
        }
    }

    let binary = bundled_binary.unwrap_or_else(|| PathBuf::from(get_engine_binary_name()));
    let _ = std::fs::create_dir_all(&model_dir);

    // 2. 确保"我们自己的"引擎在运行（带沙箱模型目录；端口被他人占用则接管后重启）
    let running = match ensure_our_engine(&binary, &model_dir).await {
        Ok(ok) => ok,
        Err(e) => {
            log::warn!("[OLLAMA] 自动拉起引擎失败: {}", e);
            false
        }
    };

    // 3. 拉取已安装模型 —— 由于引擎已绑定沙箱目录，这里的列表等价于"沙箱里真实存在的模型"
    let models = if running { list_models().await } else { Vec::new() };

    LocalProviderStatus {
        installed,
        running,
        models,
        truncated: false,
        model_dir: model_dir_str,
        gateway_ready: super::gateway::is_gateway_ready(),
    }
}
