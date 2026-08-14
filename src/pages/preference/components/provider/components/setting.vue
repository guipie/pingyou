<script setup lang="ts">
import { Button, Input, message, Modal, Select } from 'antdv-next'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

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
const { t } = useI18n()
const open = defineModel<boolean>('open', { default: false })
const providerStore = useProviderStore()
const chatStore = useChatStore()

const formData = ref({
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
})

/** 供应商显示名称：优先使用 i18n 映射，找不到则回退数据库中的名称 */
function providerDisplayName(p: AIProvider) {
  return t(`providers.names.${p.provider}`, {}, p.provider)
}
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
  if (!props.provider) return message.warning(t('pages.preference.provider.errors.noProvider'))
  if (!formData.value.apiKey || !formData.value.baseUrl || !formData.value.defaultModel)
    return message.warning(t('pages.preference.provider.errors.fillComplete'))
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
    :title="t('pages.preference.provider.dialogs.providerConfigTitle')"
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
            {{ providerDisplayName(provider) }}
          </div>
          <div class="mt-1 truncate text-3 color-text-tertiary">
            {{ provider.desc }}
          </div>
        </div>
      </div>

      <!-- API Key -->
      <div class="flex flex-col gap-1.5">
        <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.apiKey') }}</label>
        <Input.Password
          v-model:value="formData.apiKey"
          :placeholder="t('pages.preference.provider.placeholders.apiKey')"
        />
        <span class="text-2.5 color-text-quaternary">{{ t('pages.preference.provider.hints.apiKeyLocalOnly') }}</span>
      </div>

      <!-- Base URL -->
      <div class="flex flex-col gap-1.5">
        <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.baseUrl') }}</label>
        <Input
          v-model:value="formData.baseUrl"
          :placeholder="t('pages.preference.provider.placeholders.baseUrlInput')"
        />
      </div>

      <!-- 模型选择 -->
      <div
        class="flex flex-col gap-1.5"
      >
        <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.defaultModel') }}</label>
        <div class="flex">
          <Select
            v-model:value="formData.defaultModel"
            class="w-full"
            :field-names="{ label: 'name', value: 'modelId' }"
            :options="modelsOptions"
            :placeholder="t('pages.preference.provider.placeholders.defaultModel')"
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
        {{ t('pages.preference.provider.buttons.saveConfig') }}
      </Button>
    </div>
  </Modal>
</template>
