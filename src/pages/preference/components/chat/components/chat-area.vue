<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";

import { PauseOutlined } from "@antdv-next/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, message, Select, TextArea, Tooltip } from "antdv-next";
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { TauriAIChatFileOptions } from "@/stores/shard/chat-shard";

import TypingDots from "@/components/typing-dots.vue";
import { useTauriAIChat } from "@/composables/useTauriAIChat";
import { useChatStore } from "@/stores/aichat";
import { pickFirstImage, readImageFile } from "@/utils/chat-image";

const chatStore = useChatStore();
const { t } = useI18n();
const selectedImage = ref<TauriAIChatFileOptions>();
const imageInputRef = useTemplateRef<HTMLInputElement>("imageInputRef");
const chatLoading = computed(() => useTauriAIChat().loading.value);
// 只要该供应商下有视觉模型就放出图片入口（不再要求「当前必须选中视觉模型」）。
// 当前模型看不了图时，会自动由视觉模型识图：只发图→视觉模型直接作答；图+文字→识图后转文本模型。
const canSendImage = computed(() => useTauriAIChat().hasVisionModel.value);
// 两段式链路第一步正在识图时，给更准确的提示文案，不让用户干等一个含糊的「思考中」
const stageLabel = computed(() => useTauriAIChat().stage.value === "describing"
  ? t("pages.preference.chat.labels.describingImage")
  : t("pages.preference.chat.labels.thinking"));

const input = ref("");
const textAreaRef = useTemplateRef<any>("textAreaRef");
const curConversation = computed(() => chatStore.currentConversation);
const canSend = computed(() => {
  return Boolean(curConversation.value && (input.value.trim() || selectedImage.value));
});

// ---- 语音输入（Rust 原生流式识别，链路见 src-tauri/src/voice/mod.rs）----
/** starting = 已点下但后端还在开麦（首次要下模型），listening = 正在采音识别 */
type VoicePhase = "idle" | "starting" | "listening";
const voicePhase = ref<VoicePhase>("idle");
/** 0~1 的实时麦克风音量，只用来驱动音量动画 */
const voiceLevel = ref(0);
const listening = computed(() => voicePhase.value === "listening");
const voiceActive = computed(() => voicePhase.value !== "idle");
const voicePhaseLabel = computed(() => voicePhase.value === "listening"
  ? t("pages.preference.chat.labels.listening")
  : t("pages.preference.chat.labels.preparingVoice"));
/**
 * 上一段 partial 写进输入框的内容。
 *
 * 每次只替换「这段在途文字」，绝不用「开始监听那一刻的输入框快照」整体重写：
 * 监听是会跨 endpoint 一直继续的，用快照的话用户在识别过程中删掉的文字，
 * 会被下一次 partial/final 原样写回来（就是「删了又回来」的成因）。
 */
let partialText = "";
const unlisteners: UnlistenFn[] = [];

/** 追加到输入框末尾，按需补一个空格 */
function appendToInput(text: string) {
  if (!text) return;
  const cur = input.value;
  if (!cur)
    input.value = text;
  else if (/\s$/.test(cur))
    input.value = cur + text;
  else
    input.value = `${cur} ${text}`;
}

/** 在途的 partial 还在原位就原地替换（增量结果越来越长），返回是否已处理 */
function replacePartial(text: string) {
  const cur = input.value;
  if (!partialText || !cur.endsWith(partialText)) return false;
  input.value = cur.slice(0, cur.length - partialText.length) + text;
  partialText = text;
  return true;
}

onMounted(async () => {
  unlisteners.push(await listen<string>("voice-partial", (e) => {
    if (!e.payload) return;
    // 在途文字已经被用户改过/删掉了：尊重编辑，按新的一段追加
    if (!replacePartial(e.payload)) {
      partialText = "";
      appendToInput(e.payload);
      partialText = e.payload;
    }
  }));
  unlisteners.push(await listen<string>("voice-final", (e) => {
    const text = e.payload;
    if (!text) return;
    if (partialText) {
      // 原位替换成确认版；替换不上说明用户已把这段删了，那就到此为止，不再写回去
      replacePartial(text);
    } else {
      appendToInput(text);
    }
    partialText = "";
  }));
  unlisteners.push(await listen<{ listening: boolean }>("voice-state", (e) => {
    // 注意：后端发的是 { listening: bool } 对象，不是裸 bool
    const on = Boolean(e.payload?.listening);
    voicePhase.value = on ? "listening" : "idle";
    message.destroy("voice-model");
    if (on) {
      message.info({
        content: t("pages.preference.chat.hints.voiceListening"),
        duration: 3000,
        key: "voice-tip",
      });
    } else {
      voiceLevel.value = 0;
      partialText = "";
      message.destroy("voice-tip");
    }
  }));
  unlisteners.push(await listen<number>("voice-level", (e) => {
    voiceLevel.value = typeof e.payload === "number" ? e.payload : 0;
  }));
  unlisteners.push(await listen<string>("voice-error", (e) => {
    message.destroy("voice-model");
    message.destroy("voice-tip");
    voicePhase.value = "idle";
    voiceLevel.value = 0;
    partialText = "";
    message.error(e.payload);
  }));
  // 模型首次下载进度：同一 key 的 loading 会原地刷新，结束后由 voice-state/error 收尾
  unlisteners.push(await listen<{ name: string, received: number, total: number }>("voice-model-progress", (e) => {
    const percent = e.payload.total > 0
      ? Math.round((e.payload.received / e.payload.total) * 100)
      : 0;
    message.loading({
      content: `${t("pages.preference.chat.labels.downloadingVoiceModel")} ${percent}%`,
      duration: 0,
      key: "voice-model",
    });
  }));
});

onUnmounted(() => {
  unlisteners.forEach(unlisten => unlisten());
  message.destroy("voice-model");
  message.destroy("voice-tip");
});

async function toggleListening() {
  if (voicePhase.value !== "idle") {
    // 复位交给 voice-state 事件（后端 flush 完尾部音频才真正结束）
    await invoke("voice_stop");
    return;
  }
  partialText = "";
  voicePhase.value = "starting";
  try {
    await invoke("voice_start");
  } catch (error) {
    voicePhase.value = "idle";
    message.error(error instanceof Error ? error.message : String(error));
  }
}

// 模型切换到不支持视觉的模型时，把已选图片撤掉并提示，避免发出去必然 400
watch(canSendImage, (ok) => {
  if (ok || !selectedImage.value) return;
  selectedImage.value = undefined;
  message.warning(t("pages.preference.chat.messages.modelImageUnsupported"));
});

function handleSelectImage() {
  if (!canSendImage.value) {
    message.warning(t("pages.preference.chat.messages.modelImageUnsupported"));
    return;
  }
  imageInputRef.value?.click();
}

async function applyImageFile(file?: File) {
  if (!file) return;
  const { file: next, error } = await readImageFile(file);
  if (error || !next) {
    message.warning(error ?? t("pages.preference.chat.messages.uploadFailed"));
    return;
  }
  selectedImage.value = next;
}

async function handleImageChange(event: Event) {
  const imageInput = event.target as HTMLInputElement;
  const file = imageInput.files?.[0];
  imageInput.value = "";
  await applyImageFile(file);
}

/** 直接粘贴截图：视觉模型下最顺手的传图方式 */
async function handlePaste(event: ClipboardEvent) {
  if (!canSendImage.value) return;
  const file = pickFirstImage(event.clipboardData?.files);
  if (!file) return;
  event.preventDefault();
  await applyImageFile(file);
}

async function sendMessage() {
  if (!canSend.value || chatLoading.value) return;

  const content = input.value.trim();
  const image = selectedImage.value;

  input.value = "";
  selectedImage.value = undefined;

  try {
    await useTauriAIChat().sendMessage(content, { file: image });
  } catch (error) {
    input.value = content;
    selectedImage.value = image;
    console.error("send error:", error);
    message.error(error instanceof Error ? error.message : String(error));
  }
}

function stopGenerating() {
  useTauriAIChat().stop();
}
</script>

<template>
  <div class="h-full flex flex-col">
    <input
      ref="imageInputRef"
      accept="image/*"
      class="hidden"
      type="file"
      @change="handleImageChange"
    >

    <!-- 工具栏：左侧弱功能，右侧模型选择 -->
    <div class="h-11 flex shrink-0 items-center gap-1 px-3">
      <Tooltip
        v-if="canSendImage"
      >
        <template #title>
          <span
            v-if="canSendImage"
            class="wechat-vision-badge"
          >
            <i class="i-lucide:scan-eye" />
            {{ t("pages.preference.chat.labels.vision") }}，
          </span>
          {{ t('pages.preference.chat.hints.pasteImage') }}
        </template>
        <button
          class="wechat-toolbar-button cursor-pointer"
          :disabled="chatLoading"
          type="button"
          @click="handleSelectImage"
        >
          <i class="i-lucide:image" />
        </button>
      </Tooltip>
      <Tooltip
        :title="listening ? t('pages.preference.chat.labels.stopRecognition') : t('pages.preference.chat.labels.startRecognition')"
      >
        <button
          class="wechat-toolbar-button cursor-pointer"
          :class="{ 'is-listening': listening, 'is-preparing': voicePhase === 'starting' }"
          :disabled="chatLoading"
          :style="listening ? { '--voice-level': voiceLevel.toFixed(2) } : undefined"
          type="button"
          @click="toggleListening"
        >
          <i
            v-if="voicePhase === 'starting'"
            class="i-lucide:loader-circle animate-spin"
          />
          <i
            v-else
            :class="listening ? 'i-lucide:mic-off' : 'i-lucide:mic'"
          />
        </button>
      </Tooltip>

      <!-- 聆听状态：音量条 + 文案 + 「再次点击结束」，点一下即可结束，别让用户猜 -->
      <button
        v-if="voiceActive"
        class="voice-status cursor-pointer"
        :class="{ 'is-live': listening }"
        type="button"
        @click="toggleListening"
      >
        <span
          v-if="listening"
          class="voice-wave"
          :style="{ '--voice-level': voiceLevel.toFixed(2) }"
        >
          <i
            v-for="n in 4"
            :key="n"
          />
        </span>
        <i
          v-else
          class="i-lucide:loader-circle animate-spin"
        />
        <span>{{ voicePhaseLabel }}</span>
        <span
          v-if="listening"
          class="voice-status-hint"
        >
          {{ t('pages.preference.chat.hints.voiceTapToStop') }}
        </span>
      </button>

      <div class="min-w-0 flex-1" />

      <Select
        v-model:value="curConversation!.provider!.defaultModel"
        :options="curConversation?.provider.models?.map(m => ({ label: m.modelId, value: m.modelId }))"
        :placeholder="t('pages.preference.chat.placeholders.model')"
        size="small"
        style="min-width: 150px;"
        @change="chatStore.updateConversation(curConversation!)"
      />
    </div>

    <!-- 待发送图片预览 -->
    <div
      v-if="selectedImage"
      class="mx-3 mb-1 max-w-[calc(100%-1.5rem)] w-fit inline-flex shrink-0 items-center gap-2 border py-1 pl-1 pr-2 bg-ant-fill-quaternary border-ant-border-sec rounded-lg"
    >
      <img
        v-if="selectedImage.dataUrl"
        alt="attachment"
        class="h-9 w-9 flex-none rounded-md object-cover"
        :src="selectedImage.dataUrl"
      >
      <i
        v-else
        class="i-lucide:image h-9 w-9 flex-none text-4 color-text-tertiary"
      />
      <span class="min-w-0 flex-1 truncate text-3">{{ selectedImage.name || "image" }}</span>
      <i
        class="i-lucide:x shrink-0 cursor-pointer text-3.5 transition-colors color-text-tertiary hover:color-text"
        @click="selectedImage = undefined"
      />
    </div>

    <!-- 输入区：TextArea 撑满，按钮浮在右下角 -->
    <div class="relative min-h-0 flex-1">
      <TextArea
        ref="textAreaRef"
        v-model:value="input"
        :auto-size="false"
        class="wechat-input"
        :disabled="chatLoading"
        :placeholder="canSendImage ? t('pages.preference.chat.placeholders.inputVision') : t('pages.preference.chat.placeholders.input')"
        @paste="handlePaste"
        @press-enter="sendMessage"
      />

      <div class="absolute bottom-2 right-4 flex items-center gap-3">
        <span
          v-if="!curConversation"
          class="mr-auto text-3 color-text-tertiary"
        >
          {{ t('pages.preference.chat.hints.enableChatFirst') }}
        </span>

        <!-- 等待回答：思考中 + 可中断 -->
        <template v-if="chatLoading">
          <TypingDots :label="stageLabel" />
          <Tooltip :title="t('pages.preference.chat.labels.stop')">
            <Button
              danger
              shape="circle"
              size="small"
              @click="stopGenerating"
            >
              <template #icon>
                <PauseOutlined />
              </template>
            </Button>
          </Tooltip>
        </template>

        <Button
          v-else
          :disabled="!canSend"
          size="small"
          type="primary"
          @click="sendMessage"
        >
          {{ t('pages.preference.chat.labels.send') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wechat-toolbar-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--ant-color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 6px;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.wechat-toolbar-button:hover:not(:disabled) {
  color: var(--ant-color-primary);
  background: var(--ant-color-fill-tertiary);
}

.wechat-toolbar-button.is-preparing {
  color: var(--ant-color-primary);
  background: var(--ant-color-fill-tertiary);
}

.wechat-toolbar-button.is-listening {
  color: var(--ant-color-error);
  background: var(--ant-color-error-bg);
}

/* 随麦克风音量呼吸的光环：既表明「正在收音」，也能看出声音有没有进去 */
.wechat-toolbar-button.is-listening::after {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: '';
  border: 1.5px solid var(--ant-color-error);
  border-radius: inherit;
  opacity: calc(0.3 + 0.55 * var(--voice-level, 0));
  transform: scale(calc(1.02 + 0.45 * var(--voice-level, 0)));
  transition:
    opacity 0.08s linear,
    transform 0.08s linear;
}

.wechat-toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* ---- 聆听状态条：音量条 + 文案 + 「再次点击结束」 ---- */
.voice-status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--ant-color-text-secondary);
  background: var(--ant-color-fill-tertiary);
  border: none;
  animation: voice-status-in 0.18s ease-out;
}

.voice-status.is-live {
  color: var(--ant-color-error);
  background: var(--ant-color-error-bg);
}

.voice-status-hint {
  font-size: 11px;
  color: var(--ant-color-text-tertiary);
}

.voice-wave {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 12px;
  /* 静音时保留基准高度（看得出在收音），说话时整体弹起 */
  transform: scaleY(calc(0.45 + 0.55 * var(--voice-level, 0)));
  transition: transform 0.08s linear;
}

.voice-wave i {
  width: 2px;
  height: 100%;
  background: currentcolor;
  border-radius: 1px;
  transform-origin: center;
  animation: voice-wave-bounce 0.72s ease-in-out infinite alternate;
}

.voice-wave i:nth-child(2) {
  animation-delay: 0.12s;
}

.voice-wave i:nth-child(3) {
  animation-delay: 0.24s;
}

.voice-wave i:nth-child(4) {
  animation-delay: 0.36s;
}

@keyframes voice-wave-bounce {
  from {
    transform: scaleY(0.3);
  }

  to {
    transform: scaleY(1);
  }
}

@keyframes voice-status-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.wechat-vision-badge {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--ant-color-success);
  border-radius: 9999px;
  background: var(--ant-color-success-bg);
}

.wechat-input {
  height: 100%;
  border: 0;
  box-shadow: none;
}

/* TextArea 的外层是 .ant-input-textarea 包裹层，真正的输入框是里面的 textarea。
   两层都要撑满，否则可点击/可输入的区域只剩默认的两行高度。 */
.wechat-input :deep(textarea) {
  box-sizing: border-box;
  height: 100%;
  padding: 4px 14px 44px;
  font-size: 14px;
  line-height: 22px;
  resize: none;
  border: 0;
  box-shadow: none;
  scrollbar-width: thin;
}

.wechat-input :deep(textarea::-webkit-scrollbar) {
  width: 5px;
}

.wechat-input :deep(textarea::-webkit-scrollbar-thumb) {
  background-color: transparent;
  border-radius: 3px;
}

.wechat-input:hover :deep(textarea::-webkit-scrollbar-thumb) {
  background-color: rgba(0, 0, 0, 0.18);
}

.wechat-input :deep(textarea:focus) {
  border: 0;
  outline: 0;
  box-shadow: none;
}
</style>
