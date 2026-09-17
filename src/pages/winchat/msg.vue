<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";

import { CloseOutlined, CopyOutlined } from "@antdv-next/icons";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import VueMarkdown from "vue-markdown-render";

import PyAvatar from "@/components/py-avatar.vue";
import TypingDots from "@/components/typing-dots.vue";
import { LISTEN_KEY, WIN_MESSAGE_STATUS } from "@/constants";
import { useChatStore } from "@/stores/aichat";

type BubbleState = "idle" | "thinking" | "streaming" | "done" | "error";

const { t } = useI18n();
// 默认在右边（尖角在左）
const side = ref<"left" | "right">("right");
let posListen: UnlistenFn | undefined;
let msgListen: UnlistenFn | undefined;
let stateListen: UnlistenFn | undefined;

const appWindow = getCurrentWebviewWindow();
const chatStore = useChatStore();
const msg = ref("");
const state = ref<BubbleState>("idle");
const errorText = ref("");
const targetId = ref("");
const shellRef = ref<HTMLElement>();

// ── 窗口尺寸：卡片随内容自适应，长回答不出现内部滚动条 ──
const BUBBLE_WIDTH = 360;
const MIN_HEIGHT = 108;
const MAX_HEIGHT = 460;
let currentHeight = 0;
// 防重入：流式输出时内容高频变化，避免多个 fitWindow 叠加排队改窗口尺寸
let fitting = false;

async function fitWindow() {
  if (fitting) return;
  fitting = true;
  try {
    await nextTick();
    const el = shellRef.value;
    if (!el) return;
    const needed = Math.ceil(el.scrollHeight);
    const target = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, needed));
    // 抖动抑制：小于 8px 的差异不值得动窗口，避免流式输出时窗口狂跳
    if (Math.abs(target - currentHeight) < 8) return;
    currentHeight = target;
    await appWindow.setSize(new PhysicalSize(BUBBLE_WIDTH, target));
  } catch {
    // 窗口可能正在关闭，忽略
  } finally {
    fitting = false;
  }
}

/** 当前说话对象（气泡窗是独立窗口，优先按事件里的会话 id 找，找不到再退回全局当前会话） */
const activeConversation = computed(() => {
  if (targetId.value) {
    const matched = chatStore.conversations.find(item => item.id === targetId.value);
    if (matched) return matched;
  }
  return chatStore.currentConversation;
});

const statusText = computed(() => {
  switch (state.value) {
    case "thinking":
      return t("pages.winchat.status.thinking");
    case "streaming":
      return t("pages.winchat.status.answering");
    case "error":
      return t("pages.winchat.status.failed");
    default:
      return "";
  }
});

const curConversationLastMsg = computed(() => chatStore.currentConversation?.messages ?? []);

// 兜底：跨窗口 pinia 同步过来的会话消息也可以驱动内容更新。
// 仅在「当前会话就是本次对话对象」时生效，避免显示成别的屏友的回答。
watch(() => curConversationLastMsg.value, (m) => {
  if (!(m.length > 0)) return;
  if (targetId.value && chatStore.currentConversation?.id !== targetId.value) return;
  const last = m[m.length - 1];
  if (last.answer) {
    msg.value = last.answer;
    if (state.value === "idle") state.value = "streaming";
  }
}, { deep: true });

watch([msg, state, errorText], () => {
  fitWindow();
}, { flush: "post" });

async function handleCopy() {
  if (!msg.value) return;
  try {
    await writeText(msg.value);
  } catch {
    // 复制失败静默即可，气泡窗没有合适的 toast 容器
  }
}

onMounted(async () => {
  // 当前页面加载时，加上固定尺寸锁定的标记
  document.documentElement.classList.add("fixed-msg");
  document.body.classList.add("fixed-msg");

  // 立刻锁定宽度：主窗口据此计算气泡的左右落点，早一步设置能避免首次弹出时偏移
  try {
    await appWindow.setSize(new PhysicalSize(BUBBLE_WIDTH, MIN_HEIGHT));
    currentHeight = MIN_HEIGHT;
  } catch {
    // 忽略：某些平台在窗口尚未就绪时不允许改尺寸
  }

  // 监听主窗口发来的方向数据
  posListen = await listen<"left" | "right">(LISTEN_KEY.WINDOW_POSITION, (event) => {
    side.value = event.payload;
  });
  // 监听主窗口/输入窗发来的消息数据
  msgListen = await listen<string>(LISTEN_KEY.WINDOW_MESSAGE, (event) => {
    const payload = event.payload;
    // 兼容旧的「思考中」哨兵：输入窗先广播它、主窗口再转发一次
    if (payload === WIN_MESSAGE_STATUS.THINKING) {
      msg.value = "";
      errorText.value = "";
      state.value = "thinking";
      return;
    }
    msg.value = payload;
    if (state.value === "idle" || state.value === "thinking") state.value = "streaming";
  });
  // 状态机：与答案文本分离，避免「思考中」被流式内容冲掉
  stateListen = await listen<{ state: BubbleState, error?: string, conversationId?: string }>(LISTEN_KEY.CHAT_BUBBLE, (event) => {
    const payload = event.payload;
    if (!payload) return;
    if (payload.conversationId) targetId.value = payload.conversationId;
    state.value = payload.state;
    if (payload.state === "thinking") msg.value = "";
    errorText.value = payload.state === "error" ? (payload.error ?? "") : "";
  });

  await fitWindow();
});

onUnmounted(() => {
  // 离开当前页面时，清理类名，恢复其他页面的正常显示
  document.documentElement.classList.remove("fixed-msg");
  document.body.classList.remove("fixed-msg");
  if (posListen) posListen();
  if (msgListen) msgListen();
  if (stateListen) stateListen();
});
</script>

<template>
  <div
    ref="shellRef"
    class="bubble-shell w-full"
  >
    <!-- 气泡卡片 -->
    <div class="bubble-card">
      <!-- 指向屏友的小尖角：主窗口在右侧时用左尖角，反之用右尖角 -->
      <div
        class="bubble-tail"
        :class="side === 'right' ? 'bubble-tail--left' : 'bubble-tail--right'"
      />

      <!-- 头部：屏友身份 + 状态 + 操作 -->
      <header class="bubble-header">
        <div class="bubble-avatar">
          <PyAvatar
            :key="activeConversation?.avatar"
            style="width: 26px;height: 26px;"
            :url="activeConversation?.avatar"
          />
        </div>
        <div class="min-w-0 flex flex-1 flex-col">
          <span class="truncate text-3 text-gray-800 font-medium">
            {{ activeConversation?.title || t('pages.winchat.status.petFallback') }}
          </span>
          <span class="truncate text-2.5 text-gray-400">
            {{ statusText || t('pages.winchat.status.done') }}
          </span>
        </div>
        <div class="bubble-actions">
          <button
            class="bubble-icon-button"
            :title="t('pages.preference.chat.labels.copy')"
            type="button"
            @click="handleCopy"
          >
            <CopyOutlined />
          </button>
          <button
            class="bubble-icon-button"
            :title="t('pages.winchat.hints.close')"
            type="button"
            @click="appWindow.close()"
          >
            <CloseOutlined />
          </button>
        </div>
      </header>

      <!-- 内容：思考中 / 回答 / 出错 -->
      <div class="bubble-body">
        <div
          v-if="state === 'thinking'"
          class="h-8 flex items-center"
        >
          <TypingDots :label="t('pages.winchat.status.thinking')" />
        </div>

        <div
          v-else-if="state === 'error'"
          class="text-3.5 leading-relaxed"
        >
          <div class="text-red-500 mb-1 flex items-center gap-1.5 font-medium">
            <i class="i-lucide:circle-alert" />
            {{ t('pages.winchat.status.failed') }}
          </div>
          <div class="whitespace-pre-wrap break-words text-gray-700">
            {{ errorText || t('pages.winchat.status.unknownError') }}
          </div>
        </div>

        <div
          v-else-if="msg"
          class="bubble-markdown text-3.5 text-gray-800 leading-relaxed"
        >
          <VueMarkdown :source="msg" />
          <span
            v-if="state === 'streaming'"
            class="bubble-caret"
          />
        </div>

        <div
          v-else
          class="text-3.5 text-gray-400"
        >
          {{ t('pages.winchat.status.idle') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* 修正之前的名称不一致 BUG，统称 fixed-msg */
html.fixed-msg,
body.fixed-msg {
  margin: 0 !important;
  padding: 0 !important;
  height: 100vh !important;
  background: transparent !important; /* 背景透明，突出气泡阴影和毛玻璃 */
  overflow: hidden !important;
  display: block;
}

.bubble-shell {
  box-sizing: border-box;
  padding: 8px 10px;
  font-family: inherit;
}

/* 卡片本体：与聊天页气泡同色系，主题自适应 */
.bubble-card {
  position: relative;
  box-sizing: border-box;
  padding: 10px 12px 12px;
  background: #fff;
  border: 1px solid rgb(0 0 0 / 6%);
  border-radius: 14px;
  box-shadow:
    0 6px 20px rgb(0 0 0 / 10%),
    0 1px 3px rgb(0 0 0 / 6%);
}

.dark .bubble-card {
  background: #232323;
  border-color: rgb(255 255 255 / 8%);
}

.bubble-header {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgb(0 0 0 / 6%);
}

.dark .bubble-header {
  border-bottom-color: rgb(255 255 255 / 8%);
}

.bubble-avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
}

.bubble-actions {
  display: flex;
  flex: none;
  gap: 2px;
  align-items: center;
}

.bubble-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 13px;
  color: #9ca3af;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.bubble-icon-button:hover {
  color: #07c160;
  background: rgb(7 193 96 / 10%);
}

.bubble-body {
  max-height: 380px;
  overflow-y: auto;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
}

.bubble-body::-webkit-scrollbar {
  width: 4px;
}

.bubble-body::-webkit-scrollbar-thumb {
  background: rgb(156 163 175 / 40%);
  border-radius: 9999px;
}

/* 尖角与卡片同色，避免出现「小三角对不上底色」的割裂感 */
.bubble-tail {
  position: absolute;
  top: 22px;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 1px solid rgb(0 0 0 / 6%);
  transform: rotate(45deg);
}

.dark .bubble-tail {
  background: #232323;
  border-color: rgb(255 255 255 / 8%);
}

.bubble-tail--left {
  left: -7px;
  border-top: 0;
  border-right: 0;
}

.bubble-tail--right {
  right: -7px;
  border-bottom: 0;
  border-left: 0;
}

/* 流式输出光标 */
.bubble-caret {
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: #07c160;
  border-radius: 1px;
  animation: bubble-caret-blink 1s steps(2, start) infinite;
}

@keyframes bubble-caret-blink {
  to {
    visibility: hidden;
  }
}

/* Markdown 排版：标题/列表/代码块都要收掉浏览器默认边距 */
.bubble-markdown > :first-child {
  margin-top: 0;
}

.bubble-markdown > :last-child {
  margin-bottom: 0;
}

.bubble-markdown p {
  margin: 0 0 8px;
  line-height: 1.65;
}

.bubble-markdown h1,
.bubble-markdown h2,
.bubble-markdown h3,
.bubble-markdown h4 {
  margin: 10px 0 6px;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.4;
}

.bubble-markdown ul,
.bubble-markdown ol {
  padding-left: 1.25em;
  margin: 0 0 8px;
  list-style: revert;
}

.bubble-markdown code {
  padding: 1px 5px;
  font-size: 0.875em;
  background: rgb(0 0 0 / 5%);
  border-radius: 4px;
}

.dark .bubble-markdown code {
  background: rgb(255 255 255 / 10%);
}

.bubble-markdown pre {
  padding: 10px;
  margin: 8px 0;
  overflow-x: auto;
  background: rgb(0 0 0 / 5%);
  border-radius: 8px;
}

.dark .bubble-markdown pre {
  background: rgb(255 255 255 / 8%);
}

.bubble-markdown pre code {
  padding: 0;
  background: transparent;
}

.bubble-markdown blockquote {
  padding-left: 10px;
  margin: 8px 0;
  color: #6b7280;
  border-left: 3px solid rgb(0 0 0 / 12%);
}

.bubble-markdown table {
  width: 100%;
  margin: 8px 0;
  font-size: 12.5px;
  border-collapse: collapse;
}

.bubble-markdown th,
.bubble-markdown td {
  padding: 3px 6px;
  border: 1px solid rgb(0 0 0 / 10%);
}

.bubble-markdown a {
  color: #07c160;
}

.bubble-markdown img {
  max-width: 100%;
  border-radius: 8px;
}
</style>
