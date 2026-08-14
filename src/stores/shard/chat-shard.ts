import { computed } from 'vue'

import { DefaultProviders } from '@/constants/provider'
import { ConversationRepo } from '@/database/conversation-repository'
import { i18n } from '@/locales'

import type { AIProvider } from './provider-shard'

import { useProviderStore } from '../aiprovider'

type ChatRole = 'system' | 'user' | 'assistant'

export interface TauriAIChatFileOptions {
  name?: string
  mediaType: string
  dataUrl?: string
  base64: string
}

export interface TauriAIChatMessage {
  id: string
  role: ChatRole
  question: string
  answer?: string
  error?: any
  timestamp: number
  timestampAnswer?: number
  options: any
  file?: TauriAIChatFileOptions
}

export interface TauriAIChatRequestOptions {
  provider?: AIProvider
  model: string
  contents: string
  messages: TauriAIChatMessage[]
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  // 上下文引入个数（最近 N 轮），默认6
  context?: number
  baseUrl: string
  signal?: AbortSignal
  headers?: Record<string, string>
  onChunk: (text: string) => void
  onDone?: () => void
}

export interface TauriAIChatResponse {
  content: string
  raw: unknown
  provider: AIProvider
  model: string
}
// 会话
export interface TauriAIConversation {
  id: string
  avatar: string
  title: string
  messages: TauriAIChatMessage[]
  timestamp: number
  provider: AIProvider
  config: TauriAIConversationConfig
  options?: { isPinned?: boolean }
}
export interface TauriAIConversationConfig {
  enabled: boolean
  systemPrompt: string
  model: string
  temperature?: number
  maxTokens?: number
}
/** 默认系统提示词：按当前界面语言获取，避免写入数据库的种子数据被语言写死 */
export function getDefaultSystemPrompt(): string {
  return i18n.global.t('stores.chat.defaultSystemPrompt')
}
export const defaultProvider = computed(() => useProviderStore().stateProviders.find((m: AIProvider) => !!m.apiKey) ?? useProviderStore().stateProviders[0] ?? DefaultProviders[0])
// 初始化会话列表
export function initConversations(): Promise<TauriAIConversation[]> {
  return ConversationRepo.getConversations().then(async (conversations) => {
    if (conversations.length > 0) {
      return conversations
    } else {
      await addConversationDb()
      return ConversationRepo.getConversations()
    }
  }).catch((err) => {
    console.error(err)
    return []
  })
}

export async function addConversationDb(proverder?: AIProvider, id?: string): Promise<TauriAIConversation> {
  const conversation: TauriAIConversation = {
    id: id || crypto.randomUUID(),
    title: i18n.global.t('stores.chat.defaultConversationTitle'),
    avatar: proverder?.avatar || defaultProvider.value.avatar,
    messages: [],
    timestamp: Date.now(),
    provider: proverder || defaultProvider.value,
    config: {
      enabled: true,
      systemPrompt: getDefaultSystemPrompt(),
      model: proverder?.defaultModel || defaultProvider.value.defaultModel || defaultProvider.value.models?.[0]?.modelId || '',
    },
  }
  return ConversationRepo.saveConversation(conversation).then(() => conversation)
}
