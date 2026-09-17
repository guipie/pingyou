import { message } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { computed, ref } from "vue";

import type { TauriAIChatFileOptions, TauriAIChatMessage, TauriAIChatRequestOptions, TauriAIConversation } from "@/stores/shard/chat-shard";
import type { AIProvider, AiProviderModels } from "@/stores/shard/provider-shard";

import { ChatMsgRepo } from "@/database/chat-msg-repository";
import { i18n } from "@/locales";
import { useChatStore } from "@/stores/aichat";
import { useModelStore } from "@/stores/model";
import { defaultProvider, getDefaultSystemPrompt } from "@/stores/shard/chat-shard";
import { isBoolean } from "@/utils/is";

type ProviderFamily = "anthropic" | "openai-compatible";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

function isAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function getProviderFamily(provider: AIProvider): ProviderFamily {
  const baseUrl = (provider.baseUrl || "").toLowerCase();

  // 仅依据 baseUrl 判定 anthropic 协议，避免 OpenAI 兼容网关（如 OpenRouter 上的 claude 模型）被误判
  if (baseUrl.includes("anthropic.com") || baseUrl.includes("/v1/messages"))
    return "anthropic";

  return "openai-compatible";
}

function resolveEndpoint(provider: AIProvider, path?: string) {
  const baseUrl = trimTrailingSlash(provider.baseUrl);

  if (!baseUrl)
    throw new Error("Provider baseUrl is empty.");

  if (!path || baseUrl.endsWith(path) || baseUrl.includes(`${path}?`))
    return baseUrl;

  return `${baseUrl}/${trimLeadingSlash(path)}`;
}

function getJsonError(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const record = data as Record<string, any>;
    const raw = record.error?.message
      || record.error?.type
      || record.message
      || fallback;

    // 七牛大模型推理常见错误友好化：上游模型临时不可用 / 无可用通道
    const errType = record.error?.type || "";
    const lower = String(raw).toLowerCase();
    if (errType === "upstream_error" || lower.includes("service temporarily unavailable")) {
      return i18n.global.t("composables.useTauriAIChat.errors.modelUnavailable");
    }
    if (errType === "rate_limit_error" || lower.includes("rate limit")) {
      return i18n.global.t("composables.useTauriAIChat.errors.rateLimited");
    }
    if (lower.includes("quota") || lower.includes("insufficient") || errType === "insufficient_quota") {
      return i18n.global.t("composables.useTauriAIChat.errors.quotaExceeded");
    }

    return raw;
  }

  return fallback;
}
function buildCommonHeaders(ctx: TauriAIChatRequestOptions) {
  return {
    "Content-Type": "application/json",
    ...ctx.headers,
  };
}

/** OpenAI 兼容协议的多模态内容块 */
interface OpenAITextPart {
  type: "text"
  text: string
}
interface OpenAIImagePart {
  type: "image_url"
  image_url: { url: string }
}
/** Anthropic Messages 协议的多模态内容块 */
interface AnthropicImagePart {
  type: "image"
  source: { type: "base64", media_type: string, data: string }
}
type UserContentPart = OpenAITextPart | OpenAIImagePart | AnthropicImagePart;

/** 把附件还原成可直接投喂给视觉模型的 data URL */
function toImageDataUrl(file: TauriAIChatFileOptions): string {
  if (file.dataUrl) return file.dataUrl;
  return `data:${file.mediaType || "image/png"};base64,${file.base64}`;
}

/**
 * 构建一条 user 消息的 content。
 *
 * 三种形态：
 * - 图片 + 支持视觉 → 真·多模态：OpenAI 兼容 `[{type:"text"}, {type:"image_url"}]`
 *   / Anthropic Messages `[{type:"image",source:{type:"base64"}}, {type:"text"}]`
 * - 图片 + 不支持视觉 + 已有图片描述 → 用「视觉模型产出的文字描述」顶替图片，
 *   文本模型照样能"看到"这张图（这就是「识图后再问文本模型」的落点）
 * - 其余 → 依旧是纯字符串，行为与改造前完全一致
 */
function buildUserContent(
  text: string,
  file: TauriAIChatFileOptions | undefined,
  isAnthropic: boolean,
  allowVision: boolean,
  imageDescription?: string,
): string | UserContentPart[] {
  const trimmed = (text ?? "").trim();

  if (file?.base64 && allowVision) {
    // 只发图、没文字时给个默认指令：部分上游会拒绝空 text
    const prompt = trimmed || i18n.global.t("composables.useTauriAIChat.imageOnlyPrompt");

    if (isAnthropic) {
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: file.mediaType || "image/png",
            data: file.base64,
          },
        },
        { type: "text", text: prompt },
      ];
    }

    return [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: toImageDataUrl(file) } },
    ];
  }

  if (imageDescription?.trim()) {
    const prefix = i18n.global.t("composables.useTauriAIChat.imageContextPrefix");
    return trimmed
      ? `${prefix}\n${imageDescription.trim()}\n\n${trimmed}`
      : `${prefix}\n${imageDescription.trim()}`;
  }

  return text;
}

function buildOpenAIMessages(content: string, ctx: TauriAIChatRequestOptions, isOpenAI: boolean = true) {
  const isAnthropic = !isOpenAI;
  // 只有当前模型确实支持视觉时才把图片塞进请求，否则退化为纯文本，
  // 避免给纯文本模型发送 image_url 导致上游 400。
  const allowVision = ctx.allowVision === true;
  const sendMessages: any[] = [];
  // 只携带最近 N 轮有回复的历史（负数切片取末尾），默认 6 轮
  const messages = ctx.messages.filter(m => m.answer).slice(-(ctx.context ?? 6));
  for (const message of messages) {
    sendMessages.push({
      role: "user",
      // 历史轮次若带图：当前模型是视觉模型就带上原图，否则用当时存下的图片描述兜底
      content: buildUserContent(message.question, message.file, isAnthropic, allowVision, message.imageDescription),
    });
    sendMessages.push({
      role: "assistant",
      content: message.answer,
    });
  }
  sendMessages.push({
    role: "user",
    content: buildUserContent(content, ctx.file, isAnthropic, allowVision, ctx.imageDescription),
  });
  if (isOpenAI) {
    return [
      {
        role: "system",
        content: ctx.systemPrompt || getDefaultSystemPrompt(),
      },
      ...sendMessages,
    ];
  } else {
    return sendMessages;
  }
}

// 解析单行 SSE 数据，返回其中的文本增量（无内容返回空串）
function parseSSELine(line: string, isAnthropic: boolean): string {
  const cleanedLine = line.trim();
  if (!cleanedLine) return "";

  // 兼容 "data:" 后带或不带空格两种格式
  if (!cleanedLine.startsWith("data:")) return "";
  const jsonStr = cleanedLine.slice(5).trim();

  // 结束标志
  if (!jsonStr || jsonStr === "[DONE]") return "";

  try {
    const parsed = JSON.parse(jsonStr);
    if (isAnthropic) {
      if (parsed.type === "content_block_delta")
        return parsed.delta?.text ?? "";
      return "";
    }
    return parsed.choices?.[0]?.delta?.content ?? "";
  } catch (e) {
    // 忽略解析失败的断行（半包/心跳等），不污染回答内容
    if (import.meta.env.DEV) {
      console.error("[SSE parse]", e, jsonStr);
    }
    return "";
  }
}

async function tauriFetchChat(content: string, ctx: TauriAIChatRequestOptions) {
  let response: Response | null = null;
  const provider = ctx.provider;
  if (!provider) throw new Error(i18n.global.t("composables.useTauriAIChat.errors.providerNotConfigured"));
  const isAnthropic = getProviderFamily(provider) === "anthropic";
  if (isAnthropic) {
    response = await tauriFetch(resolveEndpoint(provider, "/v1/messages"), {
      method: "POST",
      headers: {
        ...buildCommonHeaders(ctx),
        "anthropic-version": "2023-06-01",
        "x-api-key": provider.apiKey ?? "",
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
    });
  } else {
    const reqBody = JSON.stringify({
      model: ctx.model,
      messages: buildOpenAIMessages(content, ctx),
      temperature: ctx.temperature,
      max_tokens: ctx.maxTokens,
      stream: true,
    });
    response = await tauriFetch(resolveEndpoint(provider), {
      method: "POST",
      headers: {
        ...buildCommonHeaders(ctx),
        Authorization: `Bearer ${provider.apiKey ?? ""}`,
      },
      body: reqBody,
      signal: ctx.signal,
    });
    if (import.meta.env.DEV) {
      console.warn("[chat] 请求已发送");
    }
  }

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch {
      errText = "";
    }
    let errData: unknown = errText;
    try {
      errData = JSON.parse(errText);
    } catch {
      // 非 JSON 错误体，保留原始文本
    }
    throw new Error(getJsonError(errData, errText || response.statusText));
  }
  // 读取 SSE 流
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  if (!reader) throw new Error(i18n.global.t("composables.useTauriAIChat.errors.createStreamReaderFailed"));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // 保留最后一行未写完的碎块
    buffer = lines.pop() || "";

    for (const line of lines) {
      const chunk = parseSSELine(line, isAnthropic);
      if (chunk) ctx.onChunk(chunk);
    }
  }
  // 处理最后剩余的 buffer（服务端末行可能不带换行符，这是合法的 SSE 场景）
  const tail = parseSSELine(buffer, isAnthropic);
  if (tail) ctx.onChunk(tail);

  if (ctx.onDone) ctx.onDone();
}

function assertProviderReady(provider: AIProvider, model?: string) {
  if ((!(provider.apiKey?.trim() || isBoolean(provider.isCustom))))
    throw new Error("Provider API key is empty.");

  if (!provider.baseUrl?.trim() || !isAbsoluteUrl(provider.baseUrl))
    throw new Error("Provider baseUrl is empty or invalid.");

  if (!model?.trim())
    throw new Error("Provider model is empty.");
}

function toModelOption(model: AiProviderModels) {
  return {
    label: model.name || model.modelId,
    value: model.modelId || model.name,
  };
}

/**
 * 单例可变状态。
 *
 * `useTauriAIChat()` 会被多个组件调用，如果每次调用都新建 ref，
 * 调用方拿到的永远是「自己那一份」状态：典型症状是主聊天页
 * `computed(() => useTauriAIChat().loading.value)` 永远为 false ——
 * 依赖的 ref 每次求值都是新的，computed 缓存后再也不会更新，
 * 于是「思考中 / 停止按钮」永不出现。这些状态必须模块级共享。
 */
const hisMessages = ref<TauriAIChatMessage[]>([]);
const loading = ref(false);
const error = ref<Error>();
/**
 * 本轮请求所处阶段：
 * - describing：两段式链路的第一步，正由视觉模型识别图片
 * - answering：正在等模型作答
 * UI 据此把「思考中」换成更准确的文案，不再让用户干等一个含糊的提示。
 */
export type ChatStage = "idle" | "describing" | "answering";
const stage = ref<ChatStage>("idle");
// 当前请求的中断控制器
let abortController: AbortController | null = null;

export function useTauriAIChat() {
  const chatStore = useChatStore();

  const provider = computed(() => chatStore.currentConversation?.provider ?? defaultProvider.value);
  const modelOptions = computed(() => provider.value.models?.map(toModelOption) ?? []);
  const conversations = computed(() => chatStore.conversations);
  // 实际生效的模型：用户选择 > 会话配置 > 供应商默认 > 模型列表首项
  const resolvedModel = computed(() => {
    return (
      provider.value.defaultModel?.trim()
      || provider.value.models?.[0]?.modelId
      || chatStore.currentConversation?.config?.model?.trim()
      || ""
    );
  });
  // 当前模型是否为视觉模型（支持多模态看图）。历史数据缺省时按文本处理。
  const isVisionModel = computed(() => {
    const mid = resolvedModel.value;
    if (!mid) return false;
    const target = provider.value.models?.find(m => m.modelId === mid)
      ?? provider.value.models?.find(m => m.name === mid);
    return target?.type === "vision";
  });
  // 供应商下第一个视觉模型：当前模型看不了图时，由它来完成「识图」这一步
  const providerVisionModel = computed(() => provider.value.models?.find(m => m.type === "vision"));
  // 供应商是否具备看图能力 —— 决定要不要放出图片入口。
  // 注意：不再要求「必须选中视觉模型才能发图」，只要供应商下有视觉模型就允许。
  const hasVisionModel = computed(() => Boolean(providerVisionModel.value));
  const isReady = computed(() => {
    return Boolean(
      (provider.value.apiKey?.trim() || isBoolean(provider.value.isCustom))
      && provider.value.baseUrl?.trim()
      && resolvedModel.value,
    );
  });
  async function sendWinMessage(content: string, options: { file?: TauriAIChatFileOptions, onChunk?: (text: string) => void, onDone?: () => void }) {
    const modelStore = useModelStore();
    // 优先使用「卡片上点聊天」时选定的会话，回退到当前台上的屏友
    const targetId = chatStore.activeChatId || modelStore.currentModel?.id;
    if (!targetId) {
      return message(i18n.global.t("composables.useTauriAIChat.errors.selectPetFirst"));
    }
    if (!content.trim() && !options.file) {
      return message(i18n.global.t("composables.useTauriAIChat.errors.inputMessageRequired"));
    }
    let conversation = conversations.value.find((item: TauriAIConversation) => item.id === targetId);
    if (!conversation) {
      // conversations 不再跨窗口同步，本窗口可能没加载过该会话 → 先从库里取，取不到才新建
      conversation = await chatStore.loadConversation(targetId);
    }
    if (!conversation) {
      conversation = await chatStore.addConversation(targetId);
    }
    if (!conversation) {
      return message(i18n.global.t("composables.useTauriAIChat.errors.createConversationFailed"));
    }
    // 悬浮输入窗是独立窗口，store 里可能还没加载过该会话的历史，
    // 这里补一次，保证多轮对话的上下文不丢。
    if (!conversation.messages?.length) {
      try {
        const history = await ChatMsgRepo.getHistoryByConversationId(conversation.id);
        conversation.messages = history.reverse();
      } catch {
        conversation.messages = conversation.messages ?? [];
      }
    }
    chatStore.setCurrentConversation(conversation);
    return sendMessage(content, options);
  }
  // 中断正在进行的流式生成
  function stop() {
    abortController?.abort();
    abortController = null;
    loading.value = false;
    stage.value = "idle";
  }
  /**
   * 用视觉模型把图片转成文字描述（两段式链路的第一段）。
   * 复用同一条请求链路：只换模型、清空历史、只带这一张图；结果不流式展示给用户，
   * 而是作为「图片上下文」交给后面的文本模型，并在气泡里以可折叠提示呈现。
   */
  async function describeImage(file: TauriAIChatFileOptions, visionModelId: string, signal: AbortSignal): Promise<string> {
    let description = "";
    await tauriFetchChat("", {
      provider: provider.value,
      model: visionModelId,
      contents: "",
      messages: [],
      baseUrl: provider.value.baseUrl ?? "",
      signal,
      systemPrompt: i18n.global.t("composables.useTauriAIChat.imageDescribePrompt"),
      maxTokens: 1024,
      file,
      allowVision: true,
      onChunk(text: string): void {
        description += text;
      },
    });
    return description.trim();
  }
  async function sendMessage(content: string, options: { file?: TauriAIChatFileOptions, onChunk?: (text: string) => void, onDone?: () => void }) {
    const file = options.file;
    const trimmed = content.trim();
    const currentIsVision = isVisionModel.value;
    const visionModel = providerVisionModel.value;

    if (!trimmed && !file)
      throw new Error(i18n.global.t("composables.useTauriAIChat.errors.inputMessageRequired"));
    if (!isReady.value)
      throw new Error(i18n.global.t("composables.useTauriAIChat.errors.configureModelFirst"));
    // 供应商下没有任何视觉模型 → 这张图无从处理，只能拦住
    if (file && !currentIsVision && !visionModel)
      throw new Error(i18n.global.t("composables.useTauriAIChat.errors.modelNotVision"));
    if (!chatStore.currentConversation || !chatStore.currentConversation.id)
      throw new Error(i18n.global.t("composables.useTauriAIChat.errors.selectConversation"));

    const convId = chatStore.currentConversation.id;

    // 两段式：图片 + 文字，且当前模型看不了图 → 先识图，再把「描述 + 文字」交给文本模型
    const needBridge = Boolean(file) && !currentIsVision && Boolean(trimmed);
    // 单段式但要换将：只发图片、没文字，且当前模型看不了图 → 直接让视觉模型作答
    const visionAnswers = Boolean(file) && !currentIsVision && !trimmed;

    const userMessage: TauriAIChatMessage = {
      role: "user",
      question: trimmed,
      file,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      options: undefined,
    };

    // 本轮真正使用的模型，以及是否允许把图片本体发给模型
    let requestModel = visionAnswers && visionModel ? visionModel.modelId : resolvedModel.value;
    let allowVision = Boolean(file) && (currentIsVision || visionAnswers);

    hisMessages.value = chatStore.currentConversation?.messages || [];
    loading.value = true;
    error.value = undefined;
    stage.value = "answering";
    abortController = new AbortController();
    chatStore.addChatMsg(convId, userMessage);
    try {
      if (needBridge && file && visionModel) {
        // 第一段：视觉模型识图（中间产物，不展示流式过程）
        stage.value = "describing";
        const description = await describeImage(file, visionModel.modelId, abortController.signal);
        if (!description)
          throw new Error(i18n.global.t("composables.useTauriAIChat.errors.imageDescribeFailed"));
        userMessage.imageDescription = description;
        userMessage.visionModel = visionModel.modelId;
        chatStore.addChatMsg(convId, userMessage, false);
        // 第二段交给文本模型：图片本体不再上传，由 imageDescription 顶替
        requestModel = resolvedModel.value;
        allowVision = false;
        stage.value = "answering";
      }

      const chatRequestOptions: TauriAIChatRequestOptions = {
        provider: provider.value,
        model: requestModel,
        contents: content,
        messages: hisMessages.value,
        baseUrl: provider.value.baseUrl ?? "",
        signal: abortController.signal,
        systemPrompt: chatStore.currentConversation.config?.systemPrompt ?? getDefaultSystemPrompt(),
        temperature: chatStore.currentConversation.config?.temperature,
        maxTokens: chatStore.currentConversation.config?.maxTokens,
        file,
        allowVision,
        imageDescription: userMessage.imageDescription,
        onChunk(text: string): void {
          userMessage.answer = (userMessage.answer ?? "") + text;
          userMessage.timestampAnswer = Date.now();
          chatStore.addChatMsg(convId, userMessage, false);
          options.onChunk?.call(this, userMessage.answer);
        },
        onDone(): void {
          chatStore.addChatMsg(convId, userMessage, true);
          options.onDone?.call(this);
        },
      };
      assertProviderReady(chatRequestOptions.provider ?? {} as AIProvider, chatRequestOptions.model);
      await tauriFetchChat(content, chatRequestOptions);
    } catch (caught) {
      error.value = caught instanceof Error ? caught : new Error(String(caught));
      // 中断属于用户主动行为，保留已生成的内容，不当作错误招出
      if (error.value.name === "AbortError") {
        chatStore.addChatMsg(convId, userMessage, true);
      } else {
        userMessage.error = error.value.message;
        chatStore.addChatMsg(convId, userMessage, true);
        throw error.value;
      }
    } finally {
      loading.value = false;
      stage.value = "idle";
      abortController = null;
    }
  }

  return {
    provider,
    resolvedModel,
    isVisionModel,
    providerVisionModel,
    hasVisionModel,
    modelOptions,
    loading,
    stage,
    error,
    isReady,
    sendMessage,
    sendWinMessage,
    stop,
  };
}
