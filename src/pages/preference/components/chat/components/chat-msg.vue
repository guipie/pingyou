<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import VueMarkdown from "vue-markdown-render";

import PyAvatar from "@/components/py-avatar.vue";
import { useChatStore } from "@/stores/aichat";

const chatContainerRef = ref<HTMLElement | null>(null);
// 状态：标记用户是否手动滚动过（偏离底部）
const isUserScrolled = ref(false);
// 阈值：距离底部多少像素以内视为“在底部”
const SCROLL_THRESHOLD = 1;
const chatStore = useChatStore();
const curConversation = computed(() => chatStore.currentConversation);

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
    class="chat-container mx-auto h-full max-w-260 flex flex-col gap-5 overflow-y-auto"
    @scroll="handleScroll"
  >
    <div
      v-for="(item, index) in curConversation?.messages"
      :key="item.id"
      class="flex flex-col gap-2"
    >
      <div
        :id="`question${index}`"
        class="flex justify-end gap-3"
      >
        <!-- 需要复制 -->

        <div
          class="wechat-bubble wechat-bubble-user max-w-[62%] select-text whitespace-pre-wrap px-3.5 py-2.5 text-3.5 leading-6 shadow-sm"
        >
          {{ item.question }}
        </div>
        <div>
          <PyAvatar
            icon="i-lucide:user-round"
            style="width: 32px;height: 32px;padding:2px;"
          />
        </div>
      </div>

      <div
        :id="`answer${index}`"
        class="flex justify-start gap-3"
      >
        <div class="h-46px w-46px rounded-lg">
          <PyAvatar
            :key="curConversation?.avatar"
            style="width: 46px;height: 46px;"
            :url="curConversation?.avatar"
          />
        </div>
        <div
          class="wechat-bubble wechat-bubble-pet mb-20px max-w-[70%] select-text whitespace-pre-wrap bg-[--ant-color-fill-quaternary] px-2.5 pt-3.5 text-3.5 leading-6 shadow-sm"
        >
          <VueMarkdown
            class="max-h-2000 overflow-auto"
            :source="item.answer ?? ''"
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
  border-radius: 4px;
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
  border-right: 6px solid var(--ant-color-bg-container);
}

.wechat-bubble-user::after {
  right: -6px;
  border-left: 6px solid var(--chat-user-bubble);
}
.wechat-bubble-user {
  color: #1f2a1f;
  background: var(--chat-user-bubble);
}
.wechat-bubble-pet :deep(p) {
  margin-bottom: 0; /* 移除默认上下边距，防止气泡内间距过大 */

  /* 你可以在这里添加其他样式，例如： */
  /* line-height: 1.6; */
  /* color: #333; */
}
</style>
