use futures_util::StreamExt;
use ollama_rs::Ollama;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

// 🟢 线上远程配置文件地址
const CONFIG_URL: &str = "https://hz.hkzh56.com/ollama.json";

// 我们自己拉起的 Ollama 子进程句柄，用于精准关闭（而非杀掉系统上所有同名进程）
fn engine_child() -> &'static Mutex<Option<Child>> {
    static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, serde::Serialize)]
struct DownloadPayload {
    progress: f64,
    status: String,
}

// 🟢 严格对应你提供的 JSON 嵌套层级结构
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

// 1. 后台静默拉起内置的 Ollama 环境（若不存在则全自动下载解压）
#[tauri::command]
pub async fn start_ollama_engine(app_handle: AppHandle) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let engine_dir = app_dir.join("engine");
    let model_dir = app_dir.join("models");

    std::fs::create_dir_all(&engine_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let engine_path = engine_dir.join(get_engine_binary_name());

    // 检查本地是否已经下载过引擎组件
    if !engine_path.exists() {
        app_handle
            .emit(
                "download-progress",
                DownloadPayload {
                    progress: 0.0,
                    status: "正在安全请求云端环境配置...".to_string(),
                },
            )
            .unwrap();

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
            } // 智能兜底
        };

        let mut file = File::create(&temp_download_path)
            .await
            .map_err(|e| format!("创建本地缓存文件失败: {}", e))?;
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = 0;

        // 🟢 关键优化 1：引入变量记录第一步组件下载上一次发送给前端的进度值
        let mut last_emitted_progress = 0.0;

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("网络传输中断: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入硬盘失败: {}", e))?;

            downloaded += chunk.len() as u64;
            let mut progress = (downloaded as f64 / total_size as f64) * 100.0;

            // 将第一步的核心组件下载进度安全控制在 0 ~ 99.0% 之间
            if progress > 99.0 {
                progress = 99.0;
            }
            if progress < 0.0 || progress.is_nan() {
                progress = 0.0;
            }

            // 🟢 关键优化 2：【第一步下载引入节流策略】
            // 只有当进度相比上一次增加了 0.5% 以上，才允许调用 emit 发送事件
            if progress - last_emitted_progress >= 0.5 || progress >= 99.0 {
                last_emitted_progress = progress;

                app_handle
                    .emit(
                        "download-progress",
                        DownloadPayload {
                            progress,
                            status: format!("正在高速下载AI核心组件: {:.1}%", progress),
                        },
                    )
                    .unwrap();

                // 🟢 关键优化 3：【第一步循环体引入时间片让渡】
                // 强行命令密集的网络写入流稍微歇一歇，给 Tauri 腾出发送 IPC 进度的空闲时间
                tokio::task::yield_now().await;
            }
        }
        file.flush().await.map_err(|e| format!("刷新硬盘缓存失败: {}", e))?;
        drop(file); // 显式释放文件锁

        // 如果是 Windows 常见的 ZIP 包，自动解压
        if is_zip {
            app_handle
                .emit(
                    "download-progress",
                    DownloadPayload {
                        progress: 99.5,
                        status: "正在解压并深度优化本地 AI 显卡加速环境...".to_string(),
                    },
                )
                .unwrap();

            let zip_file = std::fs::File::open(&temp_download_path).map_err(|e| e.to_string())?;
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
                    let mut outfile =
                        std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                    std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
                }
            }
            let _ = std::fs::remove_file(temp_download_path);
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

    // 最终拉起沙箱中的自定义本地服务
    app_handle
        .emit(
            "download-progress",
            DownloadPayload {
                progress: 99.9,
                status: "内核环境就绪，正在激活大模型通道...".to_string(),
            },
        )
        .unwrap();
    // 🟢 转换为规范化的绝对路径字符串
    let model_dir_str = model_dir.to_string_lossy().to_string();
    println!("[OLLAMA] 模型存放绝对路径设置为: {}", model_dir_str);
    let _child = Command::new(&real_engine_path)
        .arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11435")
        .env("OLLAMA_MODELS", model_dir.to_str().unwrap())
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

    // 预留 4 秒反应时间，确保内核就绪后再进入后面的模型下载阶段
    tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;

    Ok(())
}

// 2. 带进度条的模型下载封装不变
// 🟢 加上这一行，强制让 Tauri 保持蛇形命名（即下划线命名风格），与前端严格对应
#[tauri::command(rename_all = "snake_case")]
pub async fn download_model(app_handle: AppHandle, model_name: String) -> Result<(), String> {
    // 🟢 如果传入的模型名字为空，直接拦截并报错！
    let trimmed_name = model_name.trim();
    if trimmed_name.is_empty() {
        return Err("传入推荐模型名称为空，无法进行下载！".to_string());
    }
    println!("[OLLAMA] 准备下载模型: {}", trimmed_name);

    let ollama = Ollama::builder()
        .host("http://127.0.0.1".to_string())
        .port(11435)
        .build();

    let mut stream = ollama
        .pull_model_stream(model_name.clone(), false)
        .await
        .map_err(|e| format!("连接大模型仓库失败: {}", e))?;

    // 🟢 优化点 1：引入变量记录上一次发送给前端的进度值
    let mut last_emitted_progress = 0.0;
    let mut downloaded_any_chunk = false; // 记录是否真的接收到了下载数据

    while let Some(res) = stream.next().await {
        if let Ok(status) = res {
            // 🟢 如果有具体字节进度，计算百分比
            if let (Some(completed), Some(total)) = (status.completed, status.total) {
                downloaded_any_chunk = true; // 标记为真的接收到了下载数据
                let mut progress = (completed as f64 / total as f64) * 100.0;

                // 防御性安全边界：锁在 0~99.5 之间
                if progress > 99.5 {
                    progress = 99.5;
                }
                if progress < 0.0 || progress.is_nan() {
                    progress = 0.0;
                }

                // 🟢 优化点 2：【进度节流策略】
                // 只有当进度相比上一次增加了 0.5% 以上，才允许往前端发送事件
                // 这能将高频的几万次 IPC 通信骤降到精准的 200 次左右，极大减轻前端与 Tauri 的排队压力
                if progress - last_emitted_progress >= 0.5 || progress >= 99.5 {
                    last_emitted_progress = progress;

                    app_handle
                        .emit(
                            "download-progress",
                            DownloadPayload {
                                progress,
                                status: format!("正在高速下载AI大模型: {:.1}%", progress),
                            },
                        )
                        .unwrap();

                    // 🟢 优化点 3：【异步时间片让渡】
                    // 强行让密集的下载流循环线程歇一歇（微秒级），主动把 CPU 时间让给 Tauri 的系统事件发送线程
                    // 这样前端的 Vue 就能立刻收到这一帧的进度并刷新 Antdv 进度条，而不会卡到最后才闪现
                    tokio::task::yield_now().await;
                }
            } else {
                // 🟢 如果没有具体字节（比如处于 "verifying sha256" 或 "manifest" 阶段），实时把文字状态也推给前端
                app_handle
                    .emit(
                        "download-progress",
                        DownloadPayload {
                            progress: last_emitted_progress, // 保持上一次的进度
                            status: status.message.clone(), // 显示 Ollama 当前的真实文字状态 (如: "writing manifest")
                        },
                    )
                    .unwrap();
            }
        }
    }
    // 如果循环结束了，但一次有效的数据流都没收到，说明没有真正触发下载过程
    if !downloaded_any_chunk {
        return Err(format!(
            "模型下载失败：未接收到来自本地服务的有效数据流，请检查模型名称 [{}] 是否正确存在于官方仓库中。",
            trimmed_name
        ));
    }
    // 🟢 下载完成后，让线程休眠 1 秒，等待 Ollama 完成本地 Manifest 索引写入
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // 4. 下载并校验彻底完成后，最终泵送 100% 通知
    app_handle
        .emit(
            "download-progress",
            DownloadPayload {
                progress: 100.0,
                status: "模型初始化成功！".to_string(),
            },
        )
        .unwrap();
    Ok(())
}

// -------------------------------------------------一键清理本地模型-----------------------------------------------
// 🟢 一键清理本地数据的事件载荷
#[derive(Clone, serde::Serialize)]
struct CleanupPayload {
    success: bool,
    status: String,
}

// 🟢 命令 1：安全强制关闭正在后台运行的本地 Ollama 引擎进程
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
    // 才回退到按名字杀进程，避免正常情况下误杀用户自己的 Ollama
    if !killed {
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

    // 给系统留出 500 毫秒释放硬盘文件锁的时间
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    Ok(())
}

// 🟢 命令 2：一键彻底清除本地大模型文件（支持全量清理和按名称精准清理）
// 加上 rename_all 确保兼容前端蛇形/驼峰命名
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

    // 1. 先安全关闭引擎，防止进程占用文件导致 Windows 拒绝删除（Permission Denied）
    app_handle
        .emit(
            "cleanup-status",
            CleanupPayload {
                success: false,
                status: "正在安全关闭本地 AI 引擎...".to_string(),
            },
        )
        .unwrap();
    let _ = stop_ollama_engine().await;

    // 2. 执行物理深度文件移除逻辑
    if let Some(name) = model_name {
        // 单个模型卸载模式保持不变
        app_handle
            .emit(
                "cleanup-status",
                CleanupPayload {
                    success: false,
                    status: format!("正在从本地仓库卸载模型: {}...", name),
                },
            )
            .unwrap();
        let ollama = Ollama::builder()
            .host("http://127.0.0.1".to_string())
            .port(11435)
            .build();
        let _ = ollama.delete_model(name).await;
    } else {
        app_handle
            .emit(
                "cleanup-status",
                CleanupPayload {
                    success: false,
                    status: "正在全量物理粉碎 AI 内核、显卡驱动及模型数据...".to_string(),
                },
            )
            .unwrap();

        // 🟢 A. 彻底物理删除大模型大脑数据文件夹 (数 GB)
        if model_dir.exists() {
            tokio::fs::remove_dir_all(&model_dir)
                .await
                .map_err(|e| format!("大模型仓库清理失败: {}", e))?;
            // 重新创建一个空文件夹，方便下次直接再次下载
            tokio::fs::create_dir_all(&model_dir).await.unwrap();
        }

        // 🟢 B. 彻底物理删除包含了 1.8GB lib 文件的 engine 文件夹！
        if engine_dir.exists() {
            tokio::fs::remove_dir_all(&engine_dir)
                .await
                .map_err(|e| format!("1.8GB AI 核心组件清理失败: {}", e))?;
            // 💡 注意：这里绝对不要再用 create_dir_all 创建它了，让它彻底从用户电脑上消失！
        }
    }

    // 3. 通知前端清理大功告成
    app_handle
        .emit(
            "cleanup-status",
            CleanupPayload {
                success: true,
                status: "1.8GB 本地 AI 组件及模型已全部彻底移除，空间已完美释放！".to_string(),
            },
        )
        .unwrap();

    Ok(())
}

// ----------------------模型管理----------------------

// 🟢 对应 Ollama 返回的模型信息结构
#[derive(serde::Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub size: u64,
}

// 🟢 获取本地已安装的所有模型列表
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
