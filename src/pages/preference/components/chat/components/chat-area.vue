<script setup lang="ts">
import { PauseOutlined } from '@antdv-next/icons'
import { Button, message, Select, TextArea } from 'antdv-next'
import { computed, ref, useTemplateRef } from 'vue'

import { useTauriAIChat } from '@/composables/useTauriAIChat'
import { useChatStore } from '@/stores/aichat'

const chatStore = useChatStore()
const selectedImage = ref<any>()
const imageInputRef = useTemplateRef<HTMLInputElement>('imageInputRef')
const chatLoading = computed(() => useTauriAIChat().loading.value)

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
const input = ref('')
const voiceMode = ref(false)
const listening = ref(false)
const recognition = ref<SpeechRecognitionLike>()
const curConversation = computed(() => chatStore.currentConversation)
const canSend = computed(() => {
  return Boolean(curConversation.value && (input.value.trim() || selectedImage.value))
})

function handleSelectImage() {
  imageInputRef.value?.click()
}

function handleImageChange(event: Event) {
  const imageInput = event.target as HTMLInputElement
  const file = imageInput.files?.[0]

  imageInput.value = ''

  if (!file) return

  if (!file.type.startsWith('image/')) {
    message.warning('请选择图片文件。')

    return
  }

  const reader = new FileReader()

  reader.onload = () => {
    const dataUrl = String(reader.result)
    const [, base64 = ''] = dataUrl.split(',')

    selectedImage.value = {
      name: file.name,
      mediaType: file.type,
      dataUrl,
      base64,
    }
  }
  reader.readAsDataURL(file)
}

async function sendMessage() {
  if (!canSend.value || chatLoading.value) return

  const content = input.value.trim()
  const image = selectedImage.value

  input.value = ''
  selectedImage.value = undefined

  try {
    await useTauriAIChat().sendMessage(content, { file: image })
  } catch (error) {
    input.value = content
    console.error('send error:', error)
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function toggleListening() {
  if (!voiceMode.value) return

  recognition.value ??= createSpeechRecognition()

  if (!recognition.value) {
    message.warning('当前 WebView 不支持语音识别。')

    return
  }

  if (listening.value) {
    recognition.value.stop()
    listening.value = false

    return
  }

  listening.value = true
  recognition.value.start()
}

function createSpeechRecognition() {
  const SpeechRecognition = (window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }).SpeechRecognition ?? (window as Window & {
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }).webkitSpeechRecognition

  if (!SpeechRecognition) return

  const nextRecognition = new SpeechRecognition()

  nextRecognition.lang = 'zh-CN'
  nextRecognition.continuous = false
  nextRecognition.interimResults = false
  nextRecognition.onresult = (event) => {
    const transcript = event.results[0]?.[0]?.transcript

    if (transcript)
      input.value = input.value ? `${input.value} ${transcript}` : transcript
  }
  nextRecognition.onerror = (event) => {
    message.error(event.error ?? '语音识别失败。')
  }
  nextRecognition.onend = () => {
    listening.value = false
  }

  return nextRecognition
}
</script>

<template>
  <div class="dark:border-ant-border-secondary">
    <input
      ref="imageInputRef"
      accept="image/*"
      class="hidden"
      type="file"
      @change="handleImageChange"
    >

    <div class="h-10 flex items-center justify-end px-1 color-text-secondary">
      <div
        v-show="false"
      >
        <button
          class="wechat-toolbar-button"
          title="表情"
        >
          <i class="i-lucide:smile" />
        </button>
        <button
          class="wechat-toolbar-button"
          title="图片"
          @click="handleSelectImage"
        >
          <i class="i-lucide:image" />
        </button>
        <button
          class="wechat-toolbar-button"
          title="文件"
          @click="handleSelectImage"
        >
          <i class="i-lucide:folder" />
        </button>
        <button
          class="wechat-toolbar-button"
          :class="{ 'is-active': voiceMode }"
          title="语音"
          @click="voiceMode = !voiceMode"
        >
          <i class="i-lucide:mic" />
        </button>
        <button
          v-if="voiceMode"
          class="wechat-toolbar-button"
          :class="{ 'is-active': listening }"
          title="开始识别"
          @click="toggleListening"
        >
          <i :class="listening ? 'i-lucide:mic-off' : 'i-lucide:audio-lines'" />
        </button>
      </div>
      <Select
        :options="curConversation?.provider.models?.map(m => ({ label: m.modelId, value: m.modelId }))"
        placeholder="模型"
        size="small"
        :value="curConversation?.provider?.defaultModel"
      />
    </div>

    <div
      v-if="selectedImage"
      class="mx-5 mb-1 max-w-[calc(100%-2.5rem)] inline-flex items-center gap-2 rounded-md bg-[--ant-color-fill-tertiary] px-2.5 py-1.5 text-3"
    >
      <i class="i-lucide:image shrink-0" />
      <span class="truncate">{{ selectedImage.name }}</span>
      <i
        class="i-lucide:x shrink-0 cursor-pointer"
        @click="selectedImage = undefined"
      />
    </div>

    <TextArea
      v-model:value="input"
      :auto-size="false"
      class="wechat-input dark:border-ant-base"
      :disabled="chatLoading"
      @press-enter="sendMessage"
    />
    <div class="absolute bottom-1 right-0 h-10 flex items-center justify-end gap-3 px-5">
      <span
        v-if="!curConversation"
        class="mr-auto text-3 color-text-tertiary"
      >
        请先启用聊天，并在供应商设置中填写 API Key、Base URL 和模型。
      </span>
      <Button v-if="chatLoading">
        思考中
        <template #icon>
          <PauseOutlined />
        </template>
      </Button>
      <Button
        v-else
        :disabled="!canSend"

        size="small"
        type="primary"
        @click="sendMessage"
      >
        发送
      </Button>
    </div>
  </div>
</template>

<style scoped>
.wechat-toolbar-button {
  cursor: not-allowed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--ant-color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 4px;
}

.wechat-toolbar-button:hover,
.wechat-toolbar-button.is-active {
  color: var(--ant-color-text);
  background: var(--ant-color-fill-tertiary);
}

.wechat-input {
  height: 180px;
}

.wechat-input :deep(textarea) {
  padding: 4px 10px;
  font-size: 14px;
  line-height: 22px;
  resize: none;
  background: transparent;
  border: 0;
  box-shadow: none;
  scrollbar-width: none;
}

.wechat-input :deep(textarea::-webkit-scrollbar) {
  display: none;
}

.wechat-input :deep(textarea:focus) {
  border: 0;
  box-shadow: none;
}
</style>
