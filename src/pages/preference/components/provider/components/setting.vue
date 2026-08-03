<script setup lang="ts">
import { Button, Input, message, Modal, Select } from 'antdv-next'
import { ref, watch } from 'vue'

import type { AIProvider, AiProviderModels } from '@/stores/shard/provider-shard'

import ProviderModelAdd from '@/components/provider/ProviderModelAdd.vue'
import PyAvatar from '@/components/py-avatar.vue'
import { useChatStore } from '@/stores/aichat'
import { useProviderStore } from '@/stores/aiprovider'

const props = defineProps<{
  provider: AIProvider | null
}>()
const emit = defineEmits<{
  (e: 'saved'): void
}>()
const open = defineModel<boolean>('open', { default: false })
const providerStore = useProviderStore()
const chatStore = useChatStore()

const formData = ref({
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
})
const modelsOptions = ref<AiProviderModels[]>([])
watch(() => props.provider, (p) => {
  if (p) {
    formData.value = {
      apiKey: p.apiKey ?? '',
      baseUrl: p.baseUrl ?? '',
      defaultModel: p.defaultModel ?? '',
    }
    const models = props.provider?.models ?? []
    modelsOptions.value = models
  }
}, { immediate: true })
function handleModelsSave(model: AiProviderModels) {
  modelsOptions.value.push(JSON.parse(JSON.stringify(model)))
}
function handleSave() {
  if (!props.provider) return message.warning('未获取到供应商')
  if (!formData.value.apiKey || !formData.value.baseUrl || !formData.value.defaultModel)
    return message.warning('请填写完整')
  const updated: AIProvider = {
    ...props.provider,
    apiKey: formData.value.apiKey,
    baseUrl: formData.value.baseUrl,
    defaultModel: formData.value.defaultModel,
    models: modelsOptions.value,
  }
  chatStore.setConversationProvider(updated)
  providerStore.updateProvider(updated)
  open.value = false
  emit('saved')
}
</script>

<template>
  <Modal
    v-model:open="open"
    centered
    :footer="null"
    title="供应商配置"
    :width="520"
  >
    <div
      v-if="provider"
      class="flex flex-col gap-5 pt-2"
    >
      <!-- 供应商信息 -->
      <div class="flex items-center gap-3 bg-[--ant-color-fill-quaternary] p-4 rounded-lg">
        <PyAvatar
          :icon="provider.avatar"
          :url="provider.avatar"
        />
        <div class="min-w-0 flex-1">
          <div class="text-4 font-medium">
            {{ provider.provider }}
          </div>
          <div class="mt-1 truncate text-3 color-text-tertiary">
            {{ provider.desc }}
          </div>
        </div>
      </div>

      <!-- API Key -->
      <div class="flex flex-col gap-1.5">
        <label class="text-3.5 font-medium">API Key</label>
        <Input.Password
          v-model:value="formData.apiKey"
          placeholder="请输入 API Key，如 sk-xxxx"
        />
        <span class="text-2.5 color-text-quaternary">密钥仅保存在本地，不会上传到任何服务器</span>
      </div>

      <!-- Base URL -->
      <div class="flex flex-col gap-1.5">
        <label class="text-3.5 font-medium">Base URL</label>
        <Input
          v-model:value="formData.baseUrl"
          placeholder="请输入接口地址"
        />
      </div>

      <!-- 模型选择 -->
      <div
        class="flex flex-col gap-1.5"
      >
        <label class="text-3.5 font-medium">默认模型</label>
        <div class="flex">
          <Select
            v-model:value="formData.defaultModel"
            class="w-full"
            :field-names="{ label: 'name', value: 'modelId' }"
            :options="modelsOptions"
            placeholder="请选择默认模型"
          />
          <ProviderModelAdd
            :provider="provider"
            @model-saved="handleModelsSave"
          />
        </div>
      </div>

      <!-- 保存按钮 -->
      <Button
        block
        type="primary"
        @click="handleSave"
      >
        保存配置
      </Button>
    </div>
  </Modal>
</template>
