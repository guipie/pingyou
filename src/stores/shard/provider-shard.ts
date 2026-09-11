export type ModelCapability = "text" | "vision";

export interface AIProvider {
  provider: string
  value: string
  avatar: string
  desc: string
  baseUrl: string
  isCustom: boolean
  apiKey?: string
  isNeedProxy: boolean
  defaultModel?: string
  models?: AiProviderModels[]
}
export interface AiProviderModels {
  name: string
  modelId: string
  desc: string
  /** 模型能力类型：text 纯文本 / vision 支持多模态看图。历史数据缺省时按 text 处理 */
  type?: ModelCapability
  /** 是否已启用。本地 Ollama 模型启动时自动全挂，云端模型需手动启用 */
  enabled?: boolean
}

export interface AiProviderState {
  curProvider: AIProvider
  aiProviders: AIProvider[]
}
export const stateSorageKey = "ai-provider";
