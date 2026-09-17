<script setup lang="ts">
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { ask, message as nativeMessage } from "@tauri-apps/plugin-dialog";
import { Button, TextArea, Tooltip } from "antdv-next";
import { throttle } from "es-toolkit";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { TauriAIChatFileOptions } from "@/stores/shard/chat-shard";

import TypingDots from "@/components/typing-dots.vue";
import { useTauriAIChat } from "@/composables/useTauriAIChat";
import { CHAT_BUBBLE_STATE, LISTEN_KEY, WIN_MESSAGE_STATUS } from "@/constants";
import { useChatStore } from "@/stores/aichat";
import { useModelStore } from "@/stores/model";
import { useRouteSettingStore } from "@/stores/route-setting";
import { pickFirstImage, readImageFile } from "@/utils/chat-image";

const appWindow = getCurrentWebviewWindow();
const text = ref("");
const textRef = ref<HTMLInputElement>();
const imageInputRef = ref<HTMLInputElement>();
const selectedImage = ref<TauriAIChatFileOptions>();

const { t } = useI18n();
const routerStore = useRouteSettingStore();
const chatStore = useChatStore();
const modelStore = useModelStore();
// 持久化实例，便于后续中断控制
const chat = useTauriAIChat();
// 节流向气泡窗直推回答内容（低延迟），避免逐 chunk 重新定位/抢焦点
const pushMsg = throttle((answer: string) => {
  emit(LISTEN_KEY.WINDOW_MESSAGE, answer);
}, 60);

/** 本轮对话对象：优先「卡片上点聊天」选定的会话，回退到当前台上的屏友 */
const targetId = computed(() => chatStore.activeChatId || modelStore.currentModel?.id || "");
/** 当前正在对话的屏友（用于展示头像与名称，让用户知道在跟谁说话） */
const activeConversation = computed(() =>
  chatStore.conversations.find(item => item.id === targetId.value) ?? chatStore.currentConversation,
);
// 供应商下有视觉模型即可发图；当前模型看不了图时，自动由视觉模型识图后再作答/转文本模型
const canSendImage = computed(() => chat.hasVisionModel.value);
// 两段式链路识图阶段的更准确提示
const stageLabel = computed(() => chat.stage.value === "describing"
  ? t("pages.preference.chat.labels.describingImage")
  : t("pages.winchat.status.thinking"));

// ── 窗口尺寸：默认 93px，附带图片时加高一行，保证附件预览不被裁掉 ──
const BASE_HEIGHT = 93;
const ATTACH_HEIGHT = 62;
const winWidth = ref(520);
let monitorBounds: { x: number, y: number, width: number, height: number } | null = null;

const winHeight = computed(() => BASE_HEIGHT + (selectedImage.value ? ATTACH_HEIGHT : 0));

async function applyLayout() {
  if (!monitorBounds) return;
  const height = winHeight.value;
  const x = monitorBounds.x + Math.round((monitorBounds.width - winWidth.value) / 2);
  const y = monitorBounds.y + monitorBounds.height - height - 86;
  await appWindow.setSize(new PhysicalSize(winWidth.value, height));
  await appWindow.setPosition(new PhysicalPosition(x, y));
}

onMounted(async () => {
  const monitor = await currentMonitor();
  if (monitor) {
    // 宽度统一取屏幕三分之一（限定合理区间），避免定位与实际尺寸不一致导致窗口偏移
    winWidth.value = Math.min(880, Math.max(480, Math.round(monitor.size.width / 3)));
    monitorBounds = {
      x: monitor.position.x,
      y: monitor.position.y,
      width: monitor.size.width,
      height: monitor.size.height,
    };
    await applyLayout();
  }
  await appWindow.setFocus();
  // 当前页面加载时，加上固定
  document.documentElement.classList.add("fixed-chat");
  document.body.classList.add("fixed-chat");
  textRef.value?.focus();
});

// 附件出现/消失时同步窗口高度（底部保持不动，向上长高）
watch(winHeight, () => {
  applyLayout();
});

onUnmounted(() => {
  // 离开当前页面时，清理类名，恢复其他页面的正常显示
  document.documentElement.classList.remove("fixed-chat");
  document.body.classList.remove("fixed-chat");
});
const sending = ref(false);

function notifyBubble(state: string, error?: string) {
  // 带上会话 id：气泡窗据此确定要显示屏友的头像/名称，不必依赖 500ms 的跨窗口 store 同步
  emit(LISTEN_KEY.CHAT_BUBBLE, {
    state,
    error,
    conversationId: targetId.value,
  });
}

async function applyImageFile(file?: File) {
  if (!file) return;
  const { file: next, error } = await readImageFile(file);
  if (error || !next) {
    await nativeMessage(error ?? t("pages.preference.chat.messages.uploadFailed"), { title: t("pages.winchat.hints.sendFailedTitle"), kind: "warning" });
    return;
  }
  selectedImage.value = next;
}

function handleSelectImage() {
  if (!canSendImage.value) {
    nativeMessage(t("pages.preference.chat.messages.modelImageUnsupported"), { title: t("pages.winchat.hints.sendFailedTitle"), kind: "warning" });
    return;
  }
  imageInputRef.value?.click();
}

async function handleImageChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  await applyImageFile(file);
}

/** 直接粘贴截图给视觉模型 */
async function handlePaste(event: ClipboardEvent) {
  if (!canSendImage.value) return;
  const file = pickFirstImage(event.clipboardData?.files);
  if (!file) return;
  event.preventDefault();
  await applyImageFile(file);
}

function stopGenerating() {
  chat.stop();
  sending.value = false;
  notifyBubble(CHAT_BUBBLE_STATE.DONE);
}

function submit() {
  if ((!text.value.trim() && !selectedImage.value) || sending.value) return;
  sending.value = true;
  const cloneTxt = text.value.trim();
  const image = selectedImage.value;
  text.value = "";
  selectedImage.value = undefined;
  let lastAnswer = "";
  let streamNotified = false;

  // ① 让主窗口把气泡窗弹出来（主窗口负责定位）
  emit(LISTEN_KEY.WIN_MESSAGE, WIN_MESSAGE_STATUS.THINKING);
  // ② 直接给气泡窗状态：思考中。与答案文本分离，避免被流式内容冲掉
  notifyBubble(CHAT_BUBBLE_STATE.THINKING);

  chat.sendWinMessage(cloneTxt, {
    file: image,
    onChunk: (answer) => {
      if (!streamNotified) {
        streamNotified = true;
        notifyBubble(CHAT_BUBBLE_STATE.STREAMING);
      }
      lastAnswer = answer;
      pushMsg(answer);
      textRef.value?.focus();
    },
  }).then(() => {
    notifyBubble(CHAT_BUBBLE_STATE.DONE);
  }).catch((error) => {
    const reason = error?.message ?? String(error);
    // 出错时就地显示在气泡里，比弹一个原生对话框更不容易错过上下文
    notifyBubble(CHAT_BUBBLE_STATE.ERROR, reason);
    ask(t("pages.winchat.hints.sendFailed", { error: reason }), t("pages.winchat.hints.sendFailedTitle"));
  }).finally(() => {
    // 确保最终回答完整展示（避免节流丢掉尾包）
    if (lastAnswer)
      emit(LISTEN_KEY.WINDOW_MESSAGE, lastAnswer);
    sending.value = false;
  });
}

function handleMouseDown() {
  appWindow.startDragging();
}
</script>

<template>
  <div
    class="max-w-3xl w-full border border-transparent rounded-3xl shadow-md transition-all duration-200 bg-white focus-within:border-gray-200 focus-within:shadow-lg"
    data-tauri-drag-region
  >
    <input
      ref="imageInputRef"
      accept="image/*"
      class="hidden"
      type="file"
      @change="handleImageChange"
    >

    <!-- 待发送图片预览 -->
    <div
      v-if="selectedImage"
      class="mx-3 mt-2 flex items-center gap-2 rounded-xl bg-gray-50 px-2 py-1.5"
      @mousedown.stop
    >
      <img
        v-if="selectedImage.dataUrl"
        alt="attachment"
        class="h-10 w-10 flex-none object-cover rounded-lg"
        :src="selectedImage.dataUrl"
      >
      <span class="min-w-0 flex-1 truncate text-3 text-gray-600">
        {{ selectedImage.name || 'image' }}
      </span>
      <button
        class="h-6 w-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-600"
        type="button"
        @click="selectedImage = undefined"
      >
        <i class="i-lucide:x text-3.5" />
      </button>
    </div>

    <!-- 多行文本输入区域 -->
    <TextArea
      ref="textRef"
      v-model:value="text"
      class="chat-textarea w-full text-base text-gray-800 !bg-transparent !px-3 focus:outline-none"
      :placeholder="activeConversation?.title
        ? t('pages.winchat.placeholders.inputTo', { name: activeConversation.title })
        : t('pages.winchat.placeholders.input')"
      variant="borderless"
      @keydown.enter.exact.prevent="submit"
      @keydown.esc="appWindow.close()"
      @mousedown.stop
      @paste="handlePaste"
    />

    <!-- 底部操作与工具栏 -->
    <div class="flex items-center justify-between px-2 pb-1">
      <!-- 左侧：思考中 / 附件入口 -->
      <div
        class="min-w-0 flex flex-1 items-center gap-2 px-1"
        @mousedown.stop
      >
        <template v-if="sending">
          <TypingDots :label="stageLabel" />
        </template>
        <template v-else-if="canSendImage">
          <Tooltip :title="t('pages.preference.chat.labels.image')">
            <button
              class="winchat-tool-button"
              type="button"
              @click="handleSelectImage"
            >
              <i class="i-lucide:image" />
            </button>
          </Tooltip>
          <span class="truncate text-2.5 text-gray-400">
            {{ t('pages.preference.chat.hints.pasteImage') }}
          </span>
        </template>
      </div>

      <!-- 右侧：中断/发送、拖拽与关闭 -->
      <div class="flex items-center">
        <Button
          v-if="sending"
          class="cursor-pointer items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          :title="t('pages.preference.chat.labels.stop')"
          type="text"
          @click.stop="stopGenerating"
          @mousedown.stop
        >
          <template #icon>
            <i class="i-solar:stop-circle-bold text-lg" />
          </template>
        </Button>
        <Button
          class="cursor-pointer items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          type="text"
          @click.stop="appWindow.close(); routerStore.backHome(1)"
          @mousedown.stop
        >
          <template #icon>
            <i class="i-solar:quit-full-screen-bold text-lg" />
          </template>
        </Button>
        <Button
          class="cursor-move items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          :title="t('pages.winchat.hints.dragWindow')"
          type="text"
          @mousedown="handleMouseDown"
        >
          <template #icon>
            <i class="i-lucide:move text-lg" />
          </template>
        </Button>

        <!-- 发送按钮（有内容时激活高亮） -->
        <Button
          class="items-center justify-center transition-colors duration-200 !w-6 !flex"
          :class="[
            (text.trim() || selectedImage)
              ? '!bg-blue-400 !text-white hover:!bg-blue-500'
              : '!bg-gray-100 !text-gray-400 cursor-not-allowed border-none',
          ]"
          :disabled="(!text.trim() && !selectedImage) || sending"
          shape="circle"
          type="primary"
          @click="submit"
          @mousedown.stop
        >
          <template #icon>
            <i class="i-solar:arrow-up-line-duotone text-lg" />
          </template>
        </Button>
      </div>
    </div>
  </div>
</template>

<style>
html.fixed-chat,
body.fixed-chat {
  margin: 0 !important;
  padding: 0 !important;
  /* 跟随窗口实际高度：附带图片时窗口会加高一行，写死 93px 会把预览裁掉 */
  height: 100vh !important;
  max-height: 100vh !important;
  overflow: hidden !important; /* 隐藏溢出内容 */
  position: fixed !important; /* 固定定位，确保不会滚动 */
  top: 0;
  left: 0;
  right: 0;
}
/* 覆盖 antdv textarea 的默认 box-shadow 与 focus 样式（非 scoped，直接命中真实类名） */
.chat-textarea,
.chat-textarea:focus,
.chat-textarea textarea,
.chat-textarea textarea:focus {
  box-shadow: none !important;
  outline: none !important;
  resize: none !important;
}
.winchat-tool-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: #6b7280;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.winchat-tool-button:hover {
  color: #2563eb;
  background: #f3f4f6;
}
</style>
