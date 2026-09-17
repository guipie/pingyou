//! 语音模型管理：路径解析 + 按需下载。
//!
//! 模型为流式 zipformer 中英双语 int8（约 190MB，Apache-2.0），从
//! HuggingFace 国内镜像（hf-mirror.com）按单文件下载到
//! `APPDATA/voice-models/<repo>/`，安装包不因此增重。
//! 下载进度通过 `voice-model-progress` 事件回传前端展示。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const MODEL_REPO: &str = "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
/// int8 权重 + 词表，hf-mirror 上按单文件下载，避免整包（含 fp32）数百 MB 的浪费
const MODEL_FILES: [&str; 4] = [
    "encoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.int8.onnx",
    "joiner-epoch-99-avg-1.int8.onnx",
    "tokens.txt",
];

/// 模型下载进度事件载荷（received/total 为当前文件累计字节数）
#[derive(Clone, Serialize)]
pub struct ModelProgress {
    pub name: String,
    pub received: u64,
    pub total: u64,
}

pub fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析应用数据目录失败: {e}"))?
        .join("voice-models")
        .join(MODEL_REPO);
    Ok(dir)
}

pub fn is_model_ready(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|f| dir.join(f).is_file())
}

/// 确保模型就绪；缺失的文件逐个从镜像下载。
pub async fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = model_dir(app)?;
    if is_model_ready(&dir) {
        return Ok(dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败: {e}"))?;

    for file in MODEL_FILES {
        let dest = dir.join(file);
        if dest.is_file() {
            continue;
        }
        let url = format!("https://hf-mirror.com/{MODEL_REPO}/resolve/main/{file}");
        download_file(app, &url, &dest, file).await?;
    }
    Ok(dir)
}

async fn download_file(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    name: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("模型下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("模型下载失败: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("创建模型文件失败: {e}"))?;

    let mut received: u64 = 0;
    let mut last_emitted: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("模型下载中断: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入模型文件失败: {e}"))?;
        received += chunk.len() as u64;
        // 每 1MB 回传一次进度，避免事件风暴
        if received - last_emitted >= 1024 * 1024 {
            last_emitted = received;
            let _ = app.emit(
                "voice-model-progress",
                ModelProgress {
                    name: name.to_string(),
                    received,
                    total,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("保存模型文件失败: {e}"))?;
    Ok(())
}
