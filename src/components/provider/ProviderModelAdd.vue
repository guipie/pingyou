<script setup lang="ts">
import { PlusCircleOutlined } from '@antdv-next/icons'
import { Button, Form, FormItem, Input, message, Modal, TextArea } from 'antdv-next'
import { reactive, ref } from 'vue'

import type { AIProvider } from '@/stores/shard/provider-shard'

import { useProviderStore } from '@/stores/aiprovider'

const props = defineProps<{
  provider: AIProvider
}>()
const emits = defineEmits(['modelSaved'])
const providerStore = useProviderStore()
const model = reactive({
  name: '',
  modelId: '',
  desc: '',
})
const open = ref(false)
function handleOk() {
  if (!model.name || !model.modelId)
    return message.warning('请填写完整')
  // 校验 modelId 在当前供应商下唯一，避免 v-for key 冲突与 Select 值冲突
  const exists = props.provider.models?.some(m => m.modelId === model.modelId)
  if (exists)
    return message.warning('该模型ID已存在，请更换')
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
      添加
      <template #icon>
        <PlusCircleOutlined />
      </template>
    </Button>

    <Modal
      v-model:open="open"
      title="在供应商官网查询发布的模型"
      @ok="handleOk"
    >
      <template #footer>
        <Button
          key="back"
          @click="open = false"
        >
          取消
        </Button>
        <Button
          key="submit"
          type="primary"
          @click="handleOk"
        >
          确定添加
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
          label="模型名称"
          name="name"
          :rules="[{ required: true, message: '输入模型显示名称' }]"
        >
          <Input v-model:value="model.name" />
        </FormItem>
        <FormItem
          label="模型ID"
          name="modelId"
          :rules="[{ required: true, message: '输入模型ID,用于调用模型' }]"
        >
          <Input
            v-model:value="model.modelId"
            placeholder="deepseek-v4-flash"
          />
        </FormItem>
        <FormItem
          label="描述"
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
