use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, command};
use zip::ZipArchive;

/// 前端事件名：模型下载/解压进度推送
pub const EVENT_MODEL_DOWNLOAD_PROGRESS: &str = "model-download-progress";

/// 计算 custom-models 根目录：`<EXEDIR>/assets/custom-models`
///
/// 例：
///   dev  -> D:\chenyanyi\aipingyou\pingyou\target\debug\assets\custom-models
///   rel  -> C:\Program Files\Pingyou\assets\custom-models
pub fn resolve_custom_models_dir_root() -> std::io::Result<PathBuf> {
    let exe = env::current_exe()?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "exe parent 不存在"))?;
    Ok(exe_dir.join("assets").join("custom-models"))
}

/// 确保 custom-models 根目录存在（dev/release 通用）
pub fn ensure_custom_models_dir() -> std::io::Result<PathBuf> {
    let dir = resolve_custom_models_dir_root()?;
    std::fs::create_dir_all(&dir)?;
    // 顺便修一次权限（Windows 兜底）
    let _ = fixup_acl_recursive(&dir);
    Ok(dir)
}

/// 给前端返回的 custom-models 根目录（绝对路径字符串）
#[command]
pub fn resolve_custom_models_dir(app: AppHandle) -> Result<String, String> {
    let _ = &app; // 保留 AppHandle 方便将来扩展
    let dir = ensure_custom_models_dir().map_err(|e| format!("创建 custom-models 目录失败: {}", e))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 进度事件（前端 listen 接收）
#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    /// 每次调用的唯一 id（前端区分多个并发下载）
    pub job_id: String,
    /// 阶段：下载中 / 解压中 / 完成 / 失败
    pub stage: String, // "download" | "extract" | "done" | "error"
    /// 已处理字节
    pub current: u64,
    /// 总字节（解压时=zip内文件数，用于显示百分比）
    pub total: u64,
    /// 百分比 0~100
    pub percent: f32,
    /// 附加信息（错误消息/友好提示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn emit_progress(app: &AppHandle, p: DownloadProgress) {
    let _ = app.emit(EVENT_MODEL_DOWNLOAD_PROGRESS, p);
}

// ---------------------------------------------------------------------------
// Windows 权限修复：解压完成后递归给当前用户(FULL CONTROL)
//
// 现象：在某些 Windows 环境下（尤其 Tauri 以 packaged / Administrator 运行时），
// std::fs::create_dir_all 继承的 ACL 会出现 "当前用户无读取权限"，
// 导致 Tauri asset 协议访问时报 ERROR_ACCESS_DENIED (os error 5)。
// ---------------------------------------------------------------------------
#[cfg(windows)]
pub fn fixup_acl_recursive(root: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 用 Windows 内置 icacls 设置：授予当前用户(或 Everyone) 完全控制 + 递归继承
    // /grant Everyone:F /T /C /Q：
    //   F = Full Control；/T 递归；/C 出错继续；/Q 静默
    // 为减少失败率同时兼顾安全，优先用当前用户；失败时再回退到 Everyone。
    let run = |args: &[&str]| -> bool {
        match Command::new("icacls").args(args).creation_flags(0x08000000).output() {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    };

    // 1. 先用更安全的当前用户：%USERNAME%
    let username = std::env::var("USERNAME").unwrap_or_default();
    if !username.is_empty() {
        let grant = format!("{}:(OI)(CI)F", username);
        if run(&[
            root.to_string_lossy().as_ref(),
            "/grant",
            grant.as_str(),
            "/T",
            "/C",
            "/Q",
        ]) {
            return Ok(());
        }
    }

    // 2. 回退：给 Everyone
    let _ = run(&[
        root.to_string_lossy().as_ref(),
        "/grant",
        "Everyone:(OI)(CI)F",
        "/T",
        "/C",
        "/Q",
    ]);
    Ok(())
}

#[cfg(not(windows))]
pub fn fixup_acl_recursive(_root: &std::path::Path) -> std::io::Result<()> {
    // macOS / Linux 上通常文件创建者就是当前用户，不需要权限修复
    Ok(())
}

/// 下载 zip 模型包并解压到目标目录，全程 emit 进度事件。
///
/// 前端可以通过 `listen("model-download-progress", ...)` 渲染进度条 UI。
#[command]
pub async fn download_and_extract_model(
    app: AppHandle,
    job_id: String,
    url: String,
    to_path: String,
    _model_type: String,
) -> Result<(), String> {
    // 1. 发起 HTTP 请求并获取 content-length（如果有）
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !resp.status().is_success() {
        let err = format!("下载失败: HTTP {}", resp.status());
        emit_progress(
            &app,
            DownloadProgress {
                job_id: job_id.clone(),
                stage: "error".into(),
                current: 0,
                total: 0,
                percent: 0.0,
                message: Some(err.clone()),
            },
        );
        return Err(err);
    }

    let total_bytes = resp.content_length().unwrap_or(0);

    // 2. 创建目标目录（先 custom-models 再到子目录）并修复父目录权限，
    //    确保父目录不是 SYSTEM/管理员创建导致的无法继承 ACL
    let dest = PathBuf::from(&to_path);
    std::fs::create_dir_all(&dest)
        .and_then(|_| {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
                let _ = fixup_acl_recursive(parent);
            }
            fixup_acl_recursive(&dest)
        })
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 3. 流式下载（边下边写）
    let temp_zip = dest.join("__temp.zip");
    let file_size: u64 = {
        let mut file = File::create(&temp_zip)
            .map_err(|e| format!("创建临时文件失败: {}", e))?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("下载流中断: {}", e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("写入临时文件失败: {}", e))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);

            let percent = if total_bytes > 0 {
                (downloaded as f64 / total_bytes as f64 * 100.0) as f32
            } else {
                (downloaded.min(1) as f32) * 0.1
            };

            emit_progress(
                &app,
                DownloadProgress {
                    job_id: job_id.clone(),
                    stage: "download".into(),
                    current: downloaded,
                    total: total_bytes,
                    percent,
                    message: None,
                },
            );
        }
        file.sync_all().ok();
        downloaded
    };

    // 4. 解压（逐文件 emit 进度）
    {
        let zip_file = File::open(&temp_zip)
            .map_err(|e| format!("打开zip失败: {}", e))?;
        let mut archive = ZipArchive::new(zip_file)
            .map_err(|e| format!("解压失败: {}", e))?;

        let total_entries = archive.len() as u64;

        for i in 0..total_entries {
            let mut entry = archive
                .by_index(i as usize)
                .map_err(|e| format!("读取zip条目失败: {}", e))?;
            let entry_path = match entry.enclosed_name() {
                Some(p) => p.to_owned(),
                None => continue,
            };
            let target_path = dest.join(&entry_path);

            if entry.is_dir() {
                std::fs::create_dir_all(&target_path)
                    .map_err(|e| format!("创建目录失败: {}", e))?;
            } else {
                if let Some(parent) = target_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("创建目录失败: {}", e))?;
                }
                {
                    let mut outfile = File::create(&target_path)
                        .map_err(|e| format!("创建文件失败: {}", e))?;
                    std::io::copy(&mut entry, &mut outfile)
                        .map_err(|e| format!("写入文件失败: {}", e))?;
                    outfile.sync_all().ok();
                }
            }

            let extract_percent = if total_entries > 0 {
                (i + 1) as f32 / total_entries as f32 * 10.0
            } else {
                10.0
            };
            emit_progress(
                &app,
                DownloadProgress {
                    job_id: job_id.clone(),
                    stage: "extract".into(),
                    current: i + 1,
                    total: total_entries,
                    percent: 90.0 + extract_percent,
                    message: None,
                },
            );
        }
    }

    // 5. 删除临时 zip
    std::fs::remove_file(&temp_zip).ok();

    // 6. ✨ 关键：解压完成后给整个模型目录递归设置 ACL（Windows 修复 os error 5）
    //    必须放在「temp zip 删除之后」，确保所有文件句柄都已 drop
    if let Err(e) = fixup_acl_recursive(&dest) {
        eprintln!(
            "[model_download] fixup ACL 失败（不影响主流程）: {} path={}",
            e,
            dest.display()
        );
    }
    // 再给上级 custom-models 也修一次（防止以后子目录继承错误 ACL）
    if let Some(parent) = dest.parent() {
        let _ = fixup_acl_recursive(parent);
    }

    emit_progress(
        &app,
        DownloadProgress {
            job_id: job_id.clone(),
            stage: "done".into(),
            current: file_size,
            total: file_size,
            percent: 100.0,
            message: Some("完成".into()),
        },
    );

    Ok(())
}
