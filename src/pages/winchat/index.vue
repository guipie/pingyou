<script setup lang="ts">
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { ask } from '@tauri-apps/plugin-dialog'
import { Button, TextArea } from 'antdv-next'
import { throttle } from 'es-toolkit'
import { onMounted, onUnmounted, ref } from 'vue'

import { useTauriAIChat } from '@/composables/useTauriAIChat'
import { LISTEN_KEY } from '@/constants'
import { useRouteSettingStore } from '@/stores/route-setting'

const appWindow = getCurrentWebviewWindow()
const text = ref('')
const textRef = ref<HTMLInputElement>()

const routerStore = useRouteSettingStore()
// 持久化实例，便于后续中断控制
const chat = useTauriAIChat()
// 节流向气泡窗直推回答内容（低延迟），避免逐 chunk 重新定位/抢焦点
const pushMsg = throttle((answer: string) => {
  emit(LISTEN_KEY.WINDOW_MESSAGE, answer)
}, 60)

onMounted(async () => {
  const monitor = await currentMonitor()
  if (!monitor) return

  // 宽度统一取屏幕三分之一（限定合理区间），避免定位与实际尺寸不一致导致窗口偏移
  const width = Math.min(880, Math.max(480, Math.round(monitor.size.width / 3)))
  // 高度与 fixed-chat / tauri.conf 保持一致
  const height = 93
  const x = monitor.position.x + Math.round((monitor.size.width - width) / 2)
  const y = monitor.position.y + monitor.size.height - height - 86
  await appWindow.setSize(new PhysicalSize(width, height))
  await appWindow.setPosition(new PhysicalPosition(x, y))
  await appWindow.setFocus()
  // 当前页面加载时，加上固定
  document.documentElement.classList.add('fixed-chat')
  document.body.classList.add('fixed-chat')
})
onUnmounted(() => {
  // 离开当前页面时，清理类名，恢复其他页面的正常显示
  document.documentElement.classList.remove('fixed-chat')
  document.body.classList.remove('fixed-chat')
})
const sending = ref(false)
function submit() {
  if (!text.value.trim() || sending.value) return
  sending.value = true
  const cloneTxt = text.value.trim()
  text.value = ''
  let lastAnswer = ''
  emit(LISTEN_KEY.WIN_MESSAGE, '屏友思考中')
  chat.sendWinMessage(cloneTxt, {
    onChunk: (answer) => {
      lastAnswer = answer
      pushMsg(answer)
      textRef.value?.focus()
    },
  }).catch((error) => {
    ask(`发送失败，${error?.message ?? error}`, '消息发送提示')
  }).finally(() => {
    // 确保最终回答完整展示（避免节流丢掉尾包）
    if (lastAnswer)
      emit(LISTEN_KEY.WINDOW_MESSAGE, lastAnswer)
    sending.value = false
  })
}
function handleMouseDown() {
  appWindow.startDragging()
}
</script>

<template>
  <div
    class="max-w-3xl w-full border border-transparent rounded-3xl shadow-md transition-all duration-200 bg-white focus-within:border-gray-200 focus-within:shadow-lg"
    data-tauri-drag-region
  >
    <!-- 多行文本输入区域 -->
    <TextArea
      ref="textRef"
      v-model:value="text"
      class="chat-textarea w-full text-base text-gray-800 !bg-transparent !px-3 focus:outline-none"
      placeholder="按Enter发送给屏友，按Esc关闭窗口，拖动图标可移动窗口"
      variant="borderless"
      @keydown.enter.prevent="submit"
      @keydown.esc="appWindow.close()"
      @mousedown.stop
    />

    <!-- 底部操作与工具栏 -->
    <div class="flex items-center justify-between">
      <!-- 左侧：加号/附件按钮 -->
      <div class="flex-1 items-center" />

      <!-- 右侧：模型选择、语音和发送按钮 -->
      <div class="flex items-center">
        <Button
          class="cursor-pointer items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          type="text"
          @click.stop="routerStore.backHome(1)"
          @mousedown.stop
        >
          <template #icon>
            <i class="i-solar:quit-full-screen-bold text-lg" />
          </template>
        </Button>
        <Button
          class="cursor-move items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          title="拖动窗口"
          type="text"
          @mousedown="handleMouseDown"
        >
          <template #icon>
            <i class="i-lucide:move text-lg" />
          </template>
        </Button>
        <!-- 语音输入按钮 -->
        <Button
          class="items-center justify-center text-gray-600 !w-9 !flex hover:!bg-gray-100"
          shape="circle"
          type="text"
          @mousedown.stop
        >
          <template #icon>
            <i class="i-solar:microphone-2-bold text-lg" />
          </template>
        </Button>

        <!-- 发送按钮（有内容时激活高亮） -->
        <Button
          class="items-center justify-center transition-colors duration-200 !w-6 !flex"
          :class="[
            text.trim()
              ? '!bg-blue-400 !text-white hover:!bg-blue-500'
              : '!bg-gray-100 !text-gray-400 cursor-not-allowed border-none',
          ]"
          :disabled="!text.trim() || sending"
          :loading="sending"
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
  height: 93px !important; /* 强制设置实际高度 */
  max-height: 93px !important;
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
</style>
