<script setup lang="ts">
import { PauseOutlined } from "@antdv-next/icons";
import { Button, message, Select, TextArea, Tooltip } from "antdv-next";
import { computed, ref, useTemplateRef, watch } from "vue";
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

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike
}
const input = ref("");
const listening = ref(false);
const recognition = ref<SpeechRecognitionLike>();
const textAreaRef = useTemplateRef<any>("textAreaRef");
const curConversation = computed(() => chatStore.currentConversation);
const canSend = computed(() => {
  return Boolean(curConversation.value && (input.value.trim() || selectedImage.value));
});
/** 当前 webview 是否提供语音识别（WebView2 有，WKWebView 没有） */
const speechSupported = computed(() => Boolean(
  (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition
  ?? (window as Window & { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition,
));

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

function toggleListening() {
  recognition.value ??= createSpeechRecognition();

  if (!recognition.value) {
    message.warning(t("pages.preference.chat.messages.webviewNotSupportVoice"));

    return;
  }

  if (listening.value) {
    recognition.value.stop();
    listening.value = false;

    return;
  }

  listening.value = true;
  recognition.value.start();
}

function createSpeechRecognition() {
  const SpeechRecognition = (window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }).SpeechRecognition ?? (window as Window & {
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }).webkitSpeechRecognition;

  if (!SpeechRecognition) return;

  const nextRecognition = new SpeechRecognition();

  nextRecognition.lang = "zh-CN";
  nextRecognition.continuous = false;
  nextRecognition.interimResults = false;
  nextRecognition.onresult = (event) => {
    const transcript = event.results[0]?.[0]?.transcript;

    if (transcript)
      input.value = input.value ? `${input.value} ${transcript}` : transcript;
  };
  nextRecognition.onerror = (event) => {
    message.error(event.error ?? t("pages.preference.chat.messages.voiceRecognitionFailed"));
  };
  nextRecognition.onend = () => {
    listening.value = false;
  };

  return nextRecognition;
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
        v-if="speechSupported"
        :title="t('pages.preference.chat.labels.startRecognition')"
      >
        <button
          class="wechat-toolbar-button cursor-pointer"
          :class="{ 'is-listening': listening }"
          :disabled="chatLoading"
          type="button"
          @click="toggleListening"
        >
          <i :class="listening ? 'i-lucide:mic-off' : 'i-lucide:mic'" />
        </button>
      </Tooltip>

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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
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

.wechat-toolbar-button.is-listening {
  color: var(--ant-color-error);
  background: var(--ant-color-error-bg);
}

.wechat-toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
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
