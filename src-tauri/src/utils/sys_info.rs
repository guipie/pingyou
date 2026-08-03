use sysinfo::{IS_SUPPORTED_SYSTEM, System};

#[derive(serde::Serialize)]
pub struct HardwareReport {
    pub total_memory_gb: u64,
    pub status: String, // "Unsupported", "Low", "Standard", "High"
    pub recommend_model: String,
}

#[tauri::command]
pub fn check_hardware() -> HardwareReport {
    if !IS_SUPPORTED_SYSTEM {
        return HardwareReport {
            total_memory_gb: 0,
            status: "Unsupported".to_string(),
            recommend_model: "".to_string(),
        };
    }

    let mut sys = System::new_all();
    sys.refresh_memory();

    // 获取总内存（字节换算为 GB）
    let total_memory_bytes = sys.total_memory();
    let total_memory_gb = total_memory_bytes / 1024 / 1024 / 1024;

    let (status, recommend_model) = match total_memory_gb {
        gb if gb < 4 => ("Low", ""),
        gb if gb < 8 => ("Standard", "qwen2.5:0.5b"),
        _ => ("High", "qwen2.5:1.5b"),
    };

    HardwareReport {
        total_memory_gb,
        status: status.to_string(),
        recommend_model: recommend_model.to_string(),
    }
}
