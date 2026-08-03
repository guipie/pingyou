// 定义从 Rust 后端返回的硬件检测报告接口
export interface HardwareReport {
  total_memory_gb: number
  status: 'Unsupported' | 'Low' | 'Standard' | 'High'
  recommend_model: string
}

// 定义通过 Tauri 事件发送的下载进度载荷接口
export interface DownloadPayload {
  progress: number
  status: string
}

// 定义当前 UI 视图的步骤状态
export type InitStep = 'checking' | 'unsupported' | 'ready' | 'downloading'
