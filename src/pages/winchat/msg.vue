<script setup lang="ts">
import type { UnlistenFn } from '@tauri-apps/api/event'

import { CloseOutlined, CopyOutlined, LoadingOutlined } from '@antdv-next/icons'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { Button } from 'antdv-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { LISTEN_KEY } from '@/constants'
import { useChatStore } from '@/stores/aichat'
// 默认在右边（尖角在左）
const side = ref<'left' | 'right'>('right')
let posListen: UnlistenFn | undefined
let msgListen: UnlistenFn | undefined

const appWindow = getCurrentWebviewWindow()
const chatStore = useChatStore()
const msg = ref('')
const msgRef = ref<HTMLDivElement>()

const curConversationLastMsg = computed(() => chatStore.currentConversation?.messages ?? [])
// 深度监听：流式更新是对数组元素的就地替换，不加 deep 无法感知（依赖跨窗口 pinia 同步）
watch(() => curConversationLastMsg.value, (m) => {
  if (!(m.length > 0)) return
  const last = m[m.length - 1]
  if (last.answer)
    msg.value = last.answer
  nextTick(() => {
    if (msgRef.value)
      msgRef.value.scrollTop = msgRef.value.scrollHeight
  })
}, { deep: true })
onMounted(async () => {
  // 当前页面加载时，加上固定尺寸锁定的标记
  document.documentElement.classList.add('fixed-msg')
  document.body.classList.add('fixed-msg')
  // 监听主窗口发来的方向数据
  posListen = await listen<'left' | 'right'>(LISTEN_KEY.WINDOW_POSITION, (event) => {
    side.value = event.payload
  })
  // 监听主窗口/输入窗发来的消息数据
  msgListen = await listen<string>(LISTEN_KEY.WINDOW_MESSAGE, (event) => {
    msg.value = event.payload
    nextTick(() => {
      if (msgRef.value)
        msgRef.value.scrollTop = msgRef.value.scrollHeight
    })
  })
})

onUnmounted(() => {
  // 离开当前页面时，清理类名，恢复其他页面的正常显示
  document.documentElement.classList.remove('fixed-msg')
  document.body.classList.remove('fixed-msg')
  if (posListen) posListen()
  if (msgListen) msgListen()
})
</script>

<template>
  <!-- 气泡外层包裹容器（用于提供放置小尖角绝对定位的上下文环境） -->
  <div
    class="relative mb-10 mt-10 rounded-lg"
    style="background: linear-gradient(115deg, #B8F590FF, #104D016C)"
  >
    <!-- 💡 1. 气泡左侧小尖角（如果弹出框在主窗口右边，就用这个左尖角指向主窗口） -->
    <!-- 如果弹窗在主窗口左边，只需将 -left-1.5 改为 -right-1.5 即可 -->
    <div class="w-full flex justify-end">
      <Button
        type="link"
        @click="writeText(msg)"
      >
        <template #icon>
          <CopyOutlined />
        </template>
      </Button>
      <Button
        type="link"
        @click="appWindow.close()"
      >
        <template #icon>
          <CloseOutlined />
        </template>
      </Button>
    </div>
    <div
      class="absolute top-40% z-10 h-4 w-4 rotate-45 border-b border-l border-gray-100 bg-primary"
      :class="[
        side === 'right'
          ? '-left-2 border-l border-b'
          : '-right-2 border-r border-t',
      ]"
    />
    <!-- 可滚动的文本容器 -->
    <div
      id="msgPanel"
      ref="msgRef"
      class="max-h-300px overflow-y-auto px-4 text-3.5 text-gray-8 leading-relaxed"
    >
      <!-- //思考中  -->
      <p
        v-if="msg === '屏友思考中'"
      >
        <Button type="text">
          {{ msg }}...
          <template #icon>
            <LoadingOutlined />
          </template>
        </Button>
      </p>
      <p
        v-else
        class="m-0 whitespace-pre-wrap break-words"
      >
        {{ msg }}
      </p>
    </div>
  </div>
</template>

<style>
/* 修正之前的名称不一致 BUG，统称 fixed-msg */
html.fixed-msg,
body.fixed-msg {
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important; /* 背景透明，突出气泡阴影和毛玻璃 */
  overflow: hidden !important;
  display: flex;
  align-items: center;
}
#msgPanel {
  transition: all 0.3s;
}
/* 局部优雅美化滚动条 */
#msgPanel::-webkit-scrollbar {
  width: 4px; /* 更细更精致 */
  height: 4px;
}

#msgPanel::-webkit-scrollbar-track {
  background: transparent;
}

#msgPanel::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.4); /* 柔和浅灰 */
  border-radius: 9999px;
}

#msgPanel::-webkit-scrollbar-thumb:hover {
  background: rgba(107, 114, 128, 0.8);
}
</style>
