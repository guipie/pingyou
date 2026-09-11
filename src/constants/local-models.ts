/**
 * 本地大模型目录（可安装的 Ollama 模型注册表）。
 *
 * 新增模型只需在此处加一条记录，无需改动 Rust 或业务逻辑。
 * 字段说明：
 *   - id:           Ollama pull 的 tag，如 "llava:7b"
 *   - name:         展示名（i18n key 前缀，实际文案走 local-models.* 映射）
 *   - desc:         一句话描述（i18n key）
 *   - size_gb:      下载体积（4-bit 量化后的磁盘占用估算）
 *   - vram_mb:      推理所需显存（MB）；0 表示可纯 CPU 跑
 *   - ram_gb:       最低系统内存（GB）
 *   - type:         'text' 文本模型 / 'vision' 视觉模型
 *   - tags:         标签：['视觉', '中文', '轻量', '推理']
 *   - featured:     是否在列表顶部标记为"推荐"
 */
export type LocalModelType = "text" | "vision";

export interface LocalModelPreset {
  id: string
  name: string
  descKey: string
  size_gb: number
  vram_mb: number
  ram_gb: number
  type: LocalModelType
  tags: string[]
  featured?: boolean
}

export const LOCAL_MODEL_CATALOG: LocalModelPreset[] = [
  // ─── 轻量文本（低配首选） ─────────────────────────────
  {
    id: "qwen2.5:0.5b",
    name: "Qwen2.5 0.5B",
    descKey: "local-models.qwen05b.desc",
    size_gb: 0.5,
    vram_mb: 0,
    ram_gb: 4,
    type: "text",
    tags: ["轻量", "极速"],
    featured: true,
  },
  {
    id: "qwen2.5:1.5b",
    name: "Qwen2.5 1.5B",
    descKey: "local-models.qwen15b.desc",
    size_gb: 1.2,
    vram_mb: 0,
    ram_gb: 8,
    type: "text",
    tags: ["轻量", "中文"],
    featured: true,
  },
  {
    id: "qwen2.5:7b",
    name: "Qwen2.5 7B",
    descKey: "local-models.qwen7b.desc",
    size_gb: 4.7,
    vram_mb: 6000,
    ram_gb: 16,
    type: "text",
    tags: ["中文", "推理"],
  },
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 3B",
    descKey: "local-models.llama32.desc",
    size_gb: 2.0,
    vram_mb: 0,
    ram_gb: 8,
    type: "text",
    tags: ["英文", "轻量"],
  },

  // ─── 视觉模型（P0 视觉感知路径） ───────────────────────
  {
    id: "moondream",
    name: "Moondream2 1.8B",
    descKey: "local-models.moondream.desc",
    size_gb: 1.8,
    vram_mb: 2000,
    ram_gb: 8,
    type: "vision",
    tags: ["视觉", "轻量", "极速"],
    featured: true,
  },
  {
    id: "llava:7b",
    name: "LLaVA 7B",
    descKey: "local-models.llava7b.desc",
    size_gb: 4.7,
    vram_mb: 5000,
    ram_gb: 16,
    type: "vision",
    tags: ["视觉", "主流"],
    featured: true,
  },
  {
    id: "minicpm-v:8b",
    name: "MiniCPM-V 8B",
    descKey: "local-models.minicpmv.desc",
    size_gb: 5.5,
    vram_mb: 7000,
    ram_gb: 16,
    type: "vision",
    tags: ["视觉", "中文", "OCR"],
  },
];

/** 适配档位：根据硬件判定每个模型的"可装性" */
export type ModelFitLevel = "recommended" | "ok" | "tight" | "unsupported";

export interface ModelFitResult {
  model: LocalModelPreset
  level: ModelFitLevel
  /** 不可装时的原因（i18n key），如显存不足 / 内存不足 */
  reasonKey?: string
}
