use sysinfo::{CpuRefreshKind, System, IS_SUPPORTED_SYSTEM};

// GPU 信息
#[derive(serde::Serialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    /// 显存（MB），0 表示未识别到独显
    pub vram_mb: u64,
}

#[derive(serde::Serialize)]
pub struct HardwareReport {
    pub total_memory_gb: u64,
    pub cpu_cores: u64,
    pub status: String, // "Unsupported", "Low", "Standard", "High"
    pub recommend_model: String,
    /// 检测到的 GPU 列表（可能为空）
    #[serde(default)]
    pub gpus: Vec<GpuInfo>,
    /// 最大独显显存（MB），0 表示无独显或未识别
    #[serde(default)]
    pub max_vram_mb: u64,
}

/// 通过 nvidia-smi 解析 N 卡显存（跨平台，N 卡用户最常见）。
/// 返回 (gpu_name, vram_mb)，未装驱动或非 N 卡返回 None。
fn detect_nvidia_gpu() -> Option<GpuInfo> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next()?.trim();
    // 格式: "NVIDIA GeForce RTX 4060, 8188"
    let mut parts = first_line.split(',');
    let name = parts.next()?.trim().to_string();
    let vram_mb = parts.next()?.trim().parse::<u64>().ok()?;
    if name.is_empty() || vram_mb == 0 {
        return None;
    }
    Some(GpuInfo { name, vram_mb })
}

/// macOS 下通过 system_profiler 解析 GPU 显存（Apple Silicon 统一内存按需取值）。
#[cfg(target_os = "macos")]
fn detect_macos_gpu() -> Option<GpuInfo> {
    let output = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // 提取芯片名称
    let name = stdout
        .lines()
        .find_map(|l| {
            let trimmed = l.trim();
            trimmed
                .strip_prefix("Chipset Model: ")
                .or_else(|| trimmed.strip_prefix("Chipset: "))
                .map(str::trim)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Apple GPU".to_string());
    // Apple Silicon 的显存等于系统内存的可用部分，这里保守返回 0（由内存兜底推荐）
    Some(GpuInfo {
        name,
        vram_mb: 0,
    })
}

/// 收集所有可检测的 GPU 信息。
fn detect_gpus() -> Vec<GpuInfo> {
    let mut gpus: Vec<GpuInfo> = Vec::new();
    if let Some(nv) = detect_nvidia_gpu() {
        gpus.push(nv);
    }
    #[cfg(target_os = "macos")]
    if let Some(mac) = detect_macos_gpu() {
        gpus.push(mac);
    }
    gpus
}

#[tauri::command]
pub fn check_hardware() -> HardwareReport {
    if !IS_SUPPORTED_SYSTEM {
        return HardwareReport {
            total_memory_gb: 0,
            cpu_cores: 0,
            status: "Unsupported".to_string(),
            recommend_model: "".to_string(),
            gpus: Vec::new(),
            max_vram_mb: 0,
        };
    }

    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_specifics(CpuRefreshKind::nothing());

    // 获取总内存（字节换算为 GB）
    let total_memory_bytes = sys.total_memory();
    let total_memory_gb = total_memory_bytes / 1024 / 1024 / 1024;

    // CPU 核心数
    let cpu_cores = sys.cpus().len() as u64;

    // GPU 检测
    let gpus = detect_gpus();
    let max_vram_mb = gpus.iter().map(|g| g.vram_mb).max().unwrap_or(0);

    // 综合内存与显存推荐模型：
    //   - 有 N 卡显存 ≥ 6GB → qwen2.5:7b（能力更强）
    //   - 内存 ≥ 16GB 且显存 ≥ 4GB → qwen2.5:7b
    //   - 内存 ≥ 8GB → qwen2.5:1.5b
    //   - 内存 ≥ 4GB → qwen2.5:0.5b
    let (status, recommend_model) = if max_vram_mb >= 6144 || (total_memory_gb >= 16 && max_vram_mb >= 4096) {
        ("High", "qwen2.5:7b")
    } else if total_memory_gb >= 16 || (total_memory_gb >= 8 && max_vram_mb >= 2048) {
        ("High", "qwen2.5:1.5b")
    } else if total_memory_gb >= 8 {
        ("Standard", "qwen2.5:1.5b")
    } else if total_memory_gb >= 4 {
        ("Standard", "qwen2.5:0.5b")
    } else {
        ("Low", "")
    };

    HardwareReport {
        total_memory_gb,
        cpu_cores,
        status: status.to_string(),
        recommend_model: recommend_model.to_string(),
        gpus,
        max_vram_mb,
    }
}
