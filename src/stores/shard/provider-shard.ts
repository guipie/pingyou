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
}

export interface AiProviderState {
  curProvider: AIProvider
  aiProviders: AIProvider[]
}
export const stateSorageKey = 'ai-provider'
