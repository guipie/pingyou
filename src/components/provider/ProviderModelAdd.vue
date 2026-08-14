<script setup lang="ts">
import { PlusCircleOutlined } from '@antdv-next/icons'
import { Button, Form, FormItem, Input, message, Modal, TextArea } from 'antdv-next'
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AIProvider } from '@/stores/shard/provider-shard'

import { useProviderStore } from '@/stores/aiprovider'

const props = defineProps<{
  provider: AIProvider
}>()
const emits = defineEmits(['modelSaved'])
const providerStore = useProviderStore()
const { t } = useI18n()
const model = reactive({
  name: '',
  modelId: '',
  desc: '',
})
const open = ref(false)
function handleOk() {
  if (!model.name || !model.modelId)
    return message.warning(t('pages.preference.provider.errors.fillComplete'))
  // 校验 modelId 在当前供应商下唯一，避免 v-for key 冲突与 Select 值冲突
  const exists = props.provider.models?.some(m => m.modelId === model.modelId)
  if (exists)
    return message.warning(t('pages.preference.provider.errors.modelIdExists'))
  providerStore.updateProviderModels(props.provider.provider, JSON.parse(JSON.stringify(model)))
  open.value = false
  emits('modelSaved', JSON.parse(JSON.stringify(model)))
}
</script>

<template>
  <div>
    <Button
      type="dashed"
      @click="open = true"
    >
      {{ t('pages.preference.provider.modelDialog.buttons.add') }}
      <template #icon>
        <PlusCircleOutlined />
      </template>
    </Button>

    <Modal
      v-model:open="open"
      :title="t('pages.preference.provider.modelDialog.hints.addModel')"
      @ok="handleOk"
    >
      <template #footer>
        <Button
          key="back"
          @click="open = false"
        >
          {{ t('pages.preference.provider.modelDialog.buttons.cancel') }}
        </Button>
        <Button
          key="submit"
          type="primary"
          @click="handleOk"
        >
          {{ t('pages.preference.provider.modelDialog.buttons.confirmAdd') }}
        </Button>
      </template>
      <Form
        auto-complete="off"
        :label-col="{ span: 8 }"
        :model="model"
        style="max-width: 600px"
        :wrapper-col="{ span: 16 }"
      >
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelName')"
          name="name"
          :rules="[{ required: true, message: t('pages.preference.provider.modelDialog.placeholders.modelName') }]"
        >
          <Input v-model:value="model.name" />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelId')"
          name="modelId"
          :rules="[{ required: true, message: t('pages.preference.provider.modelDialog.placeholders.modelId') }]"
        >
          <Input
            v-model:value="model.modelId"
            placeholder="deepseek-v4-flash"
          />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.description')"
          name="desc"
        >
          <TextArea v-model:value="model.desc" />
        </FormItem>
      </Form>
    </Modal>
  </div>
</template>

<style scoped>

</style>
