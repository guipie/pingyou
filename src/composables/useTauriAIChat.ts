import { message } from '@tauri-apps/plugin-dialog'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { computed, ref } from 'vue'

import type { TauriAIChatFileOptions, TauriAIChatMessage, TauriAIChatRequestOptions, TauriAIConversation } from '@/stores/shard/chat-shard'
import type { AIProvider, AiProviderModels } from '@/stores/shard/provider-shard'

import { i18n } from '@/locales'
import { useChatStore } from '@/stores/aichat'
import { useModelStore } from '@/stores/model'
import { defaultProvider, getDefaultSystemPrompt } from '@/stores/shard/chat-shard'
import { isBoolean } from '@/utils/is'

type ProviderFamily = 'anthropic' | 'openai-compatible'

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, '')
}

function isAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function getProviderFamily(provider: AIProvider): ProviderFamily {
  const baseUrl = (provider.baseUrl || '').toLowerCase()

  // 仅依据 baseUrl 判定 anthropic 协议，避免 OpenAI 兼容网关（如 OpenRouter 上的 claude 模型）被误判
  if (baseUrl.includes('anthropic.com') || baseUrl.includes('/v1/messages'))
    return 'anthropic'

  return 'openai-compatible'
}

function resolveEndpoint(provider: AIProvider, path?: string) {
  const baseUrl = trimTrailingSlash(provider.baseUrl)

  if (!baseUrl)
    throw new Error('Provider baseUrl is empty.')

  if (!path || baseUrl.endsWith(path) || baseUrl.includes(`${path}?`))
    return baseUrl

  return `${baseUrl}/${trimLeadingSlash(path)}`
}

function getJsonError(data: unknown, fallback: string) {
  if (data && typeof data === 'object') {
    const record = data as Record<string, any>

    return record.error?.message
      || record.error?.type
      || record.message
      || fallback
  }

  return fallback
}
function buildCommonHeaders(ctx: TauriAIChatRequestOptions) {
  return {
    'Content-Type': 'application/json',
    ...ctx.headers,
  }
}

function buildOpenAIMessages(content: string, ctx: TauriAIChatRequestOptions, isOpenAI: boolean = true) {
  const sendMessages = []
  // 只携带最近 N 轮有回复的历史（负数切片取末尾），默认 6 轮
  const messages = ctx.messages.filter(m => m.answer).slice(-(ctx.context ?? 6))
  for (const message of messages) {
    sendMessages.push({
      role: 'user',
      content: message.question,
    })
    sendMessages.push({
      role: 'assistant',
      content: message.answer,
    })
  }
  sendMessages.push({
    role: 'user',
    content,
  })
  if (isOpenAI) {
    return [
      {
        role: 'system',
        content: ctx.systemPrompt || getDefaultSystemPrompt(),
      },
      ...sendMessages,
    ]
  } else {
    return sendMessages
  }
}

// 解析单行 SSE 数据，返回其中的文本增量（无内容返回空串）
function parseSSELine(line: string, isAnthropic: boolean): string {
  const cleanedLine = line.trim()
  if (!cleanedLine) return ''

  // 兼容 "data:" 后带或不带空格两种格式
  if (!cleanedLine.startsWith('data:')) return ''
  const jsonStr = cleanedLine.slice(5).trim()

  // 结束标志
  if (!jsonStr || jsonStr === '[DONE]') return ''

  try {
    const parsed = JSON.parse(jsonStr)
    if (isAnthropic) {
      if (parsed.type === 'content_block_delta')
        return parsed.delta?.text ?? ''
      return ''
    }
    return parsed.choices?.[0]?.delta?.content ?? ''
  } catch (e) {
    // 忽略解析失败的断行（半包/心跳等），不污染回答内容
    if (import.meta.env.DEV) {
      console.error('[SSE parse]', e, jsonStr)
    }
    return ''
  }
}

async function tauriFetchChat(content: string, ctx: TauriAIChatRequestOptions) {
  let response: Response | null = null
  const provider = ctx.provider
  if (!provider) throw new Error(i18n.global.t('composables.useTauriAIChat.errors.providerNotConfigured'))
  const isAnthropic = getProviderFamily(provider) === 'anthropic'
  if (isAnthropic) {
    response = await tauriFetch(resolveEndpoint(provider, '/v1/messages'), {
      method: 'POST',
      headers: {
        ...buildCommonHeaders(ctx),
        'anthropic-version': '2023-06-01',
        'x-api-key': provider.apiKey ?? '',
      },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: ctx.maxTokens ?? 4096,
        system: ctx.systemPrompt || getDefaultSystemPrompt(),
        messages: buildOpenAIMessages(content, ctx, false),
        temperature: ctx.temperature,
        stream: true,
      }),
      signal: ctx.signal,
    })
  } else {
    const reqBody = JSON.stringify({
      model: ctx.model,
      messages: buildOpenAIMessages(content, ctx),
      temperature: ctx.temperature,
      max_tokens: ctx.maxTokens,
      stream: true,
    })
    response = await tauriFetch(resolveEndpoint(provider), {
      method: 'POST',
      headers: {
        ...buildCommonHeaders(ctx),
        Authorization: `Bearer ${provider.apiKey ?? ''}`,
      },
      body: reqBody,
      signal: ctx.signal,
    })
    if (import.meta.env.DEV) {
      console.warn('[chat] 请求已发送')
    }
  }

  if (!response.ok) {
    let errText = ''
    try {
      errText = await response.text()
    } catch {
      errText = ''
    }
    let errData: unknown = errText
    try {
      errData = JSON.parse(errText)
    } catch {
      // 非 JSON 错误体，保留原始文本
    }
    throw new Error(getJsonError(errData, errText || response.statusText))
  }
  // 读取 SSE 流
  const reader = response.body?.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  if (!reader) throw new Error(i18n.global.t('composables.useTauriAIChat.errors.createStreamReaderFailed'))

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    // 保留最后一行未写完的碎块
    buffer = lines.pop() || ''

    for (const line of lines) {
      const chunk = parseSSELine(line, isAnthropic)
      if (chunk) ctx.onChunk(chunk)
    }
  }
  // 处理最后剩余的 buffer（服务端末行可能不带换行符，这是合法的 SSE 场景）
  const tail = parseSSELine(buffer, isAnthropic)
  if (tail) ctx.onChunk(tail)

  if (ctx.onDone) ctx.onDone()
}

function assertProviderReady(provider: AIProvider, model?: string) {
  if ((!(provider.apiKey?.trim() || isBoolean(provider.isCustom))))
    throw new Error('Provider API key is empty.')

  if (!provider.baseUrl?.trim() || !isAbsoluteUrl(provider.baseUrl))
    throw new Error('Provider baseUrl is empty or invalid.')

  if (!model?.trim())
    throw new Error('Provider model is empty.')
}

function toModelOption(model: AiProviderModels) {
  return {
    label: model.name || model.modelId,
    value: model.modelId || model.name,
  }
}

export function useTauriAIChat() {
  const chatStore = useChatStore()
  const hisMessages = ref<TauriAIChatMessage[]>([])
  const loading = ref(false)
  const error = ref<Error>()
  // 当前请求的中断控制器
  let abortController: AbortController | null = null

  const provider = computed(() => chatStore.currentConversation?.provider ?? defaultProvider.value)
  const modelOptions = computed(() => provider.value.models?.map(toModelOption) ?? [])
  const conversations = computed(() => chatStore.conversations)
  // 实际生效的模型：用户选择 > 会话配置 > 供应商默认 > 模型列表首项
  const resolvedModel = computed(() => {
    return (
      provider.value.defaultModel?.trim()
      || provider.value.models?.[0]?.modelId
      || chatStore.currentConversation?.config?.model?.trim()
      || ''
    )
  })
  const isReady = computed(() => {
    return Boolean(
      (provider.value.apiKey?.trim() || isBoolean(provider.value.isCustom))
      && provider.value.baseUrl?.trim()
      && resolvedModel.value,
    )
  })
  async function sendWinMessage(content: string, options: { onChunk?: (text: string) => void, onDone?: () => void }) {
    const modelStore = useModelStore()
    if (!modelStore.currentModel) {
      return message(i18n.global.t('composables.useTauriAIChat.errors.selectPetFirst'))
    }
    if (!content.trim()) {
      return message(i18n.global.t('composables.useTauriAIChat.errors.inputMessageRequired'))
    }
    let conversation = conversations.value.find((item: TauriAIConversation) => item.id === modelStore.currentModel?.id)
    if (!conversation) {
      conversation = await chatStore.addConversation(modelStore.currentModel?.id)
    }
    if (!conversation) {
      return message(i18n.global.t('composables.useTauriAIChat.errors.createConversationFailed'))
    }
    chatStore.currentConversation = conversation
    return sendMessage(content, options)
  }
  // 中断正在进行的流式生成
  function stop() {
    abortController?.abort()
    abortController = null
    loading.value = false
  }
  async function sendMessage(content: string, options: { file?: TauriAIChatFileOptions, onChunk?: (text: string) => void, onDone?: () => void }) {
    const userMessage: TauriAIChatMessage = {
      role: 'user',
      question: content.trim(),
      file: options.file,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      options: undefined,
    }

    if (!userMessage.question && !userMessage.file)
      throw new Error(i18n.global.t('composables.useTauriAIChat.errors.inputMessageRequired'))
    if (!isReady.value)
      throw new Error(i18n.global.t('composables.useTauriAIChat.errors.configureModelFirst'))
    if (!chatStore.currentConversation || !chatStore.currentConversation.id)
      throw new Error(i18n.global.t('composables.useTauriAIChat.errors.selectConversation'))

    hisMessages.value = chatStore.currentConversation?.messages || []
    loading.value = true
    error.value = undefined
    abortController = new AbortController()
    chatStore.addChatMsg(chatStore.currentConversation.id, userMessage)
    try {
      const chatRequestOptions: TauriAIChatRequestOptions = {
        provider: provider.value,
        model: resolvedModel.value,
        contents: content,
        messages: hisMessages.value,
        baseUrl: provider.value.baseUrl ?? '',
        signal: abortController.signal,
        systemPrompt: chatStore.currentConversation.config?.systemPrompt ?? getDefaultSystemPrompt(),
        temperature: chatStore.currentConversation.config?.temperature,
        maxTokens: chatStore.currentConversation.config?.maxTokens,
        onChunk(text: string): void {
          userMessage.answer = (userMessage.answer ?? '') + text
          userMessage.timestampAnswer = Date.now()
          const convId = chatStore.currentConversation?.id
          if (convId) chatStore.addChatMsg(convId, userMessage, false)
          options.onChunk?.call(this, userMessage.answer)
        },
        onDone(): void {
          const convId = chatStore.currentConversation?.id
          if (convId) chatStore.addChatMsg(convId, userMessage, true)
          options.onDone?.call(this)
        },
      }
      assertProviderReady(chatRequestOptions.provider ?? {} as AIProvider, chatRequestOptions.model)
      await tauriFetchChat(content, chatRequestOptions)
    } catch (caught) {
      error.value = caught instanceof Error ? caught : new Error(String(caught))
      // 会话可能在异步过程中被删除，使用可选链安全获取 id
      const convId = chatStore.currentConversation?.id
      // 中断属于用户主动行为，保留已生成的内容，不当作错误招出
      if (error.value.name === 'AbortError') {
        if (convId) chatStore.addChatMsg(convId, userMessage, true)
      } else {
        userMessage.error = error.value.message
        if (convId) chatStore.addChatMsg(convId, userMessage, true)
        throw error.value
      }
    } finally {
      loading.value = false
      abortController = null
    }
  }

  return {
    provider,
    resolvedModel,
    modelOptions,
    loading,
    error,
    isReady,
    sendMessage,
    sendWinMessage,
    stop,
  }
}
