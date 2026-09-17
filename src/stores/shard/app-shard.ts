// 定义从 Rust 后端返回的硬件检测报告接口
export interface GpuInfo {
  name: string
  /** 显存（MB），0 表示未识别到独显 */
  vram_mb: number
}

export interface HardwareReport {
  total_memory_gb: number
  cpu_cores: number
  status: "Unsupported" | "Low" | "Standard" | "High"
  recommend_model: string
  /** 检测到的 GPU 列表（可能为空） */
  gpus?: GpuInfo[]
  /** 最大独显显存（MB），0 表示无独显或未识别 */
  max_vram_mb?: number
}

// 定义通过 Tauri 事件发送的下载进度载荷接口
export interface DownloadPayload {
  progress: number
  status: string
  /** 下载阶段: "engine" | "model"，前端据此合并进度避免刷新跳动 */
  phase: string
  /**
   * 该进度所属的模型名；引擎组件阶段为空字符串。
   * 前端按这个字段把进度派发到对应的模型卡片（见 composables/useOllamaEngine.ts）。
   */
  model?: string
}

// 定义当前 UI 视图的步骤状态
export type InitStep = "checking" | "unsupported" | "ready" | "downloading";
