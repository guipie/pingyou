<script setup lang="ts">
import { CopyOutlined } from "@antdv-next/icons";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message, Tooltip } from "antdv-next";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import VueMarkdown from "vue-markdown-render";

import PyAvatar from "@/components/py-avatar.vue";
import TypingDots from "@/components/typing-dots.vue";
import { useTauriAIChat } from "@/composables/useTauriAIChat";
import { useChatStore } from "@/stores/aichat";

const { t } = useI18n();
const chatContainerRef = ref<HTMLElement | null>(null);
// 状态：标记用户是否手动滚动过（偏离底部）
const isUserScrolled = ref(false);
// 阈值：距离底部多少像素以内视为“在底部”
const SCROLL_THRESHOLD = 1;
const chatStore = useChatStore();
const curConversation = computed(() => chatStore.currentConversation);
const chatLoading = computed(() => useTauriAIChat().loading.value);

const messages = computed(() => curConversation.value?.messages ?? []);
/** 最后一条消息仍在等待/生成回答 —— 用来决定是否渲染「思考中」气泡与光标 */
const pendingIndex = computed(() => {
  if (!chatLoading.value || messages.value.length === 0) return -1;
  const last = messages.value[messages.value.length - 1];
  // 只对「用户发出、尚无答案」的那条挂思考态
  return last && last.role === "user" && !last.answer ? messages.value.length - 1 : -1;
});

// 修复后的 scrollToBottom 函数
function scrollToBottom() {
  if (!chatContainerRef.value) return;

  const container = chatContainerRef.value;
  // 正确的最大滚动位置 = 内容总高度 - 容器可视高度
  const maxScrollTop = container.scrollHeight - container.clientHeight;

  // 使用 requestAnimationFrame 确保在浏览器重绘后执行，提高可靠性
  requestAnimationFrame(() => {
    container.scrollTop = maxScrollTop;
  });
}

//  监听消息变化，自动滚动
watch(
  () => curConversation.value?.messages,
  async (newMessages) => {
    if (!newMessages || newMessages.length === 0) return;
    await nextTick();
    // 只有当用户没有手动向上滚动时，才自动跟随
    if (!isUserScrolled.value) {
      scrollToBottom();
    }
  },
  { deep: true, immediate: true }, // immediate 确保初始化时也执行
);

// 5. 处理用户滚动事件
function handleScroll() {
  if (!chatContainerRef.value) return;

  const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.value;
  const distanceToBottom = scrollHeight - scrollTop - clientHeight;

  // 如果距离底部超过阈值，认为用户正在查看历史消息，停止自动滚动
  if (distanceToBottom > SCROLL_THRESHOLD) {
    isUserScrolled.value = true;
  } else {
    // 如果用户又滚回了底部，恢复自动滚动状态
    isUserScrolled.value = false;
  }
}

async function handleCopy(text?: string) {
  if (!text) return;
  try {
    await writeText(text);
    message.success(t("pages.preference.chat.messages.copied"));
  } catch {
    message.error(t("pages.preference.chat.messages.copyFailed"));
  }
}

// 初始化时确保滚动到底部
onMounted(async () => {
});
// //  暴露方法给父/兄弟组件
defineExpose({
  scrollToBottom: () => scrollToBottom(),
  // 可选：暴露重置状态的方法，如果兄弟组件发送消息后希望强制回到底部
  resetScrollState: () => {
    isUserScrolled.value = false;
    scrollToBottom();
  },
});
</script>

<template>
  <div
    ref="chatContainerRef"
    class="chat-container mx-auto h-full max-w-260 flex flex-col gap-6 overflow-y-auto"
    @scroll="handleScroll"
  >
    <div
      v-for="(item, index) in messages"
      :key="item.id"
      class="flex flex-col gap-3"
    >
      <!-- ---------- 用户提问 ---------- -->
      <div
        :id="`question${index}`"
        class="group flex justify-end gap-3"
      >
        <div class="flex flex-col items-end gap-1">
          <div class="wechat-bubble wechat-bubble-user select-text px-3.5 py-2.5 text-3.5 leading-6 shadow-sm">
            <img
              v-if="item.file?.dataUrl"
              alt="attachment"
              class="mb-2 max-h-60 max-w-full cursor-pointer object-cover rounded-lg"
              :src="item.file.dataUrl"
            >
            <div
              v-if="item.question"
              class="whitespace-pre-wrap"
            >
              {{ item.question }}
            </div>
          </div>
          <Tooltip :title="t('pages.preference.chat.labels.copy')">
            <button
              class="chat-copy-button opacity-0 transition-opacity group-hover:opacity-100"
              type="button"
              @click="handleCopy(item.question)"
            >
              <CopyOutlined />
            </button>
          </Tooltip>
        </div>
        <div>
          <PyAvatar
            icon="i-lucide:user-round"
            style="width: 32px;height: 32px;padding:2px;"
          />
        </div>
      </div>

      <!-- ---------- 屏友回答 ---------- -->
      <div
        :id="`answer${index}`"
        class="group flex justify-start gap-3"
      >
        <div class="h-46px w-46px rounded-lg">
          <PyAvatar
            :key="curConversation?.avatar"
            style="width: 46px;height: 46px;"
            :url="curConversation?.avatar"
          />
        </div>

        <!-- 等待首个字：思考中占位，避免长时间空白 -->
        <div
          v-if="pendingIndex === index"
          class="wechat-bubble wechat-bubble-pet h-10 flex items-center bg-[--chat-pet-bubble] px-4 shadow-sm"
        >
          <TypingDots :label="t('pages.preference.chat.labels.thinking')" />
        </div>

        <!-- 请求出错：就地展示原因，不要把错误吞掉 -->
        <div
          v-else-if="item.error"
          class="wechat-bubble wechat-bubble-error max-w-[70%] select-text px-3.5 py-2.5 text-3.5 leading-6"
        >
          <div class="mb-1 flex items-center gap-1.5 font-medium">
            <i class="i-lucide:circle-alert" />
            {{ t('pages.preference.chat.labels.sendFailed') }}
          </div>
          <div class="whitespace-pre-wrap break-words opacity-90">
            {{ item.error }}
          </div>
        </div>

        <div
          v-else
          class="wechat-bubble wechat-bubble-pet mb-20px max-w-[70%] min-w-0 select-text bg-[--chat-pet-bubble] px-3.5 py-3 text-3.5 leading-6 shadow-sm"
        >
          <!-- 两段式链路：视觉模型对图片的描述。默认折叠，点开才看，不抢正文的注意力 -->
          <details
            v-if="item.imageDescription"
            class="chat-image-note"
          >
            <summary class="chat-image-note-summary">
              <i class="i-lucide:scan-eye" />
              <span>{{ t('pages.preference.chat.labels.imageDescription') }}</span>
              <span
                v-if="item.visionModel"
                class="chat-image-note-model"
              >
                {{ item.visionModel }}
              </span>
            </summary>
            <div class="chat-image-note-body">
              {{ item.imageDescription }}
            </div>
          </details>
          <VueMarkdown
            class="chat-markdown"
            :source="item.answer ?? ''"
          />
          <span
            v-if="chatLoading && index === messages.length - 1"
            class="chat-caret"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-container {
  /* Firefox */
  scrollbar-width: thin;
  scrollbar-color: rgba(250, 247, 247, 0.2) transparent;

  /* 初始状态：透明 */
  transition: scrollbar-color 0.3s;
}

.chat-container:hover {
  scrollbar-color: rgba(145, 142, 142, 0.4) transparent;
}

/* Webkit */
.chat-container::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.chat-container::-webkit-scrollbar-track {
  background: transparent;
}

.chat-container::-webkit-scrollbar-thumb {
  background-color: transparent; /* 默认透明 */
  border-radius: 3px;
  transition: background-color 0.3s;
}

.chat-container:hover::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.2); /* 悬停时显示 */
}

.chat-container::-webkit-scrollbar-thumb:hover {
  background-color: rgba(0, 0, 0, 0.4);
}

.wechat-bubble {
  position: relative;
  border-radius: 10px;
  word-break: break-word;
}

.wechat-bubble-pet::before,
.wechat-bubble-user::after {
  position: absolute;
  top: 12px;
  width: 0;
  height: 0;
  content: '';
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}

.wechat-bubble-pet::before {
  left: -6px;
  border-right: 6px solid var(--chat-pet-bubble);
}

.wechat-bubble-user::after {
  right: -6px;
  border-left: 6px solid var(--chat-user-bubble);
}

.wechat-bubble-user {
  color: #1f2a1f;
  background: var(--chat-user-bubble);
}

/* 出错气泡：用错误色系，和正常回答一眼区分 */
.wechat-bubble-error {
  color: var(--ant-color-error-text);
  border: 1px solid var(--ant-color-error-border);
  background: var(--ant-color-error-bg);
}

/* 图片识别提示：折叠态只占一行，展开后是一段说明 */
.chat-image-note {
  padding: 6px 8px;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--ant-color-text-secondary);
  background: var(--ant-color-fill-quaternary);
  border-radius: 8px;
}

.chat-image-note-summary {
  display: flex;
  gap: 5px;
  align-items: center;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.chat-image-note-summary::-webkit-details-marker {
  display: none;
}

.chat-image-note-model {
  padding: 0 6px;
  font-size: 11px;
  color: var(--ant-color-primary);
  background: var(--ant-color-primary-bg);
  border-radius: 9999px;
}

.chat-image-note-body {
  padding-top: 6px;
  margin-top: 6px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px dashed var(--ant-color-border-secondary);
}

.chat-copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--ant-color-text-tertiary);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.chat-copy-button:hover {
  color: var(--ant-color-primary);
  background: var(--ant-color-fill-tertiary);
}

/* 流式输出时的光标 */
.chat-caret {
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--ant-color-primary);
  border-radius: 1px;
  animation: chat-caret-blink 1s steps(2, start) infinite;
}

@keyframes chat-caret-blink {
  to {
    visibility: hidden;
  }
}

/* Markdown 排版：气泡内不要出现浏览器默认的大边距 */
.chat-markdown :deep(> :first-child) {
  margin-top: 0;
}

.chat-markdown :deep(> :last-child) {
  margin-bottom: 0;
}

.chat-markdown :deep(p) {
  margin: 0 0 8px;
  line-height: 1.7;
}

.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3),
.chat-markdown :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}

.chat-markdown :deep(ul),
.chat-markdown :deep(ol) {
  padding-left: 1.25em;
  margin: 0 0 8px;
  list-style: revert;
}

.chat-markdown :deep(li) {
  margin: 2px 0;
}

.chat-markdown :deep(code) {
  padding: 1px 5px;
  font-size: 0.875em;
  background: var(--ant-color-fill-secondary);
  border-radius: 4px;
}

.chat-markdown :deep(pre) {
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
  background: var(--ant-color-fill-secondary);
  border-radius: 8px;
}

.chat-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
}

.chat-markdown :deep(blockquote) {
  padding-left: 10px;
  margin: 8px 0;
  color: var(--ant-color-text-secondary);
  border-left: 3px solid var(--ant-color-border);
}

.chat-markdown :deep(table) {
  width: 100%;
  margin: 8px 0;
  font-size: 13px;
  border-collapse: collapse;
}

.chat-markdown :deep(th),
.chat-markdown :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--ant-color-border-secondary);
}

.chat-markdown :deep(th) {
  background: var(--ant-color-fill-tertiary);
}

.chat-markdown :deep(a) {
  color: var(--ant-color-primary);
}

.chat-markdown :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}
</style>
