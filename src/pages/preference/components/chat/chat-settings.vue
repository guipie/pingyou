<script setup lang="ts">
import type { UploadEmits, UploadProps } from 'antdv-next'

import { PlusOutlined } from '@antdv-next/icons'
import { Button, Input, InputPassword, message, Popover, Select, Space, Switch, Tag, TextArea, Upload } from 'antdv-next'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { TauriAIConversation } from '@/stores/shard/chat-shard'
import type { AIProvider, AiProviderModels } from '@/stores/shard/provider-shard'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import PyAvatar from '@/components/py-avatar.vue'
import { useChatStore } from '@/stores/aichat'
import { useProviderStore } from '@/stores/aiprovider'
import { useRouteSettingStore } from '@/stores/route-setting'
import { getImgBase64 } from '@/utils/path'

type FileType = Parameters<NonNullable<UploadProps['beforeUpload']>>[0]
const pvStore = useProviderStore()
const chatStore = useChatStore()
const routeStore = useRouteSettingStore()
const curConversation = ref<TauriAIConversation | null>(JSON.parse(JSON.stringify(chatStore.currentConversation ?? 'null')))
const curSelectedProviderVal = ref<string | null>(curConversation.value?.provider.value ?? null)
const curSeletedProvider = computed(() => pvStore.stateProviders.find((item: AIProvider) => item.value === curSelectedProviderVal.value))
const curSeletedModel = ref(curSeletedProvider.value?.defaultModel)
watch(() => curSelectedProviderVal.value, (_) => {
  curSeletedModel.value = curSeletedProvider.value?.defaultModel
})
const { t } = useI18n()
const cloneConversation = ref<TauriAIConversation | null>(null)
const customModel = ref('')
onMounted(() => {
  if (!curConversation.value) {
    routeStore.backHome()
    return
  }
  cloneConversation.value = JSON.parse(JSON.stringify(curConversation.value))
})
function handleRecovery() {
  if (cloneConversation.value && curConversation.value) {
    curConversation.value = cloneConversation.value
  }
}

const avatarChange: UploadEmits['change'] = async (info) => {
  if (!curConversation.value) return
  if (info.file) {
    curConversation.value.avatar = await getImgBase64(info.file as FileType)
  } else {
    message.warning('上传失败')
  }
}
function saveConversation() {
  if (!curConversation.value) return
  if (!curSeletedProvider.value || !curSeletedProvider.value.apiKey) {
    return message.warning('请配置模型供应商')
  }
  if (!curSeletedModel.value)
    return message.warning('请选择模型')
  if (!curConversation.value.title.trim())
    return message.warning('请填写会话名称')
  curConversation.value.provider = curSeletedProvider.value
  curConversation.value.provider.defaultModel = curSeletedModel.value
  chatStore.updateConversation(curConversation.value)
  message.success('保存成功')
}
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <Button
          color="primary"
          variant="text"
          @click="routeStore.backHome(1)"
        >
          <i class="i-lucide:arrow-left" />
          {{ t('common.buttons.back') }}
        </Button>
        <span class="text-5 font-medium">
          会话配置
        </span>
      </div>
      <div>
        <Button
          type="text"
          @click="handleRecovery"
        >
          <i class="i-lucide:settings-2" />
          {{ t('common.buttons.resetToDefault') }}
        </Button>
        <!-- 保存 -->
        <Button
          color="green"
          variant="text"
          @click="saveConversation"
        >
          <i class="i-lucide:save" />
          {{ t('common.buttons.save') }}
        </Button>
      </div>
    </div>

    <ProList
      v-if="curConversation"
      title=""
    >
      <ProListItem
        description="启用后，可以和桌宠聊天。API Key 会保存在本机配置中。"
        title="启用聊天"
      >
        <Switch
          :checked="true"
          disabled
        />

        <Upload
          accept=".png,.jpg,.jpeg"
          action="/"
          :before-upload="() => false"
          class="avatar-uploader"
          list-type="picture-card"
          name="avatar"
          :show-upload-list="false"
          style="width: 66px; height: 66px;"
          @change="avatarChange"
        >
          <PyAvatar
            v-if="curConversation?.avatar"
            :key="curConversation!.avatar"
            cus-style="width: 66px; height: 66px;"
            :url="curConversation!.avatar"
          />
          <button
            v-else
            style="border: 0; background: none"
            type="button"
          >
            <PlusOutlined />
            <div style="margin-top: 8px">
              头像上传
            </div>
          </button>
        </Upload>
      </ProListItem>
      <ProListItem
        title="屏友名称"
      >
        <Input
          v-model:value="curConversation!.title"
          class="w-80"
          placeholder="屏友名称"
        />
      </ProListItem>
      <ProListItem
        description="大多数供应商使用 OpenAI-compatible 接口，Anthropic 会自动走 Claude Messages 接口。"
        title="模型供应商"
        vertical
      >
        <div class="flex flex-col gap-2">
          <div>
            <Select
              v-model:value="curSelectedProviderVal"
              :options="pvStore.stateProviders.map((item:AIProvider) => ({ label: item.provider, value: item.value, provider: item }))"
              placeholder="请选择模型供应商"
              style="width: 80%;"
            >
              <template #optionRender="{ option }">
                <Space>
                  <span
                    :aria-label="option.data.value"
                    role="img"
                  >
                    {{ option.label }}
                  </span>
                  <Tag
                    color="#108ee9"
                    size="small"
                  >
                    {{ option.value }}
                  </Tag>
                  <Tag
                    size="small"
                  >
                    {{ option.data.provider?.apiKey?.length > 0 ? '✅已配置' : '❌未配置' }}
                  </Tag>
                </Space>
              </template>
            </Select>
            <Button
              color="primary"
              variant="text"
              @click="routeStore.backHome(2)"
            >
              {{ t('common.buttons.settingNow') }}
            </Button>
          </div>
          <div>
            <ProListItem title="API Key">
              <InputPassword
                class="w-80"
                disabled
                placeholder="sk-..."
                :value="curSeletedProvider?.apiKey"
              />
            </ProListItem>

            <ProListItem
              description="如果使用代理、兼容网关或私有部署，可以修改这里。"
              title="Base URL"
            >
              <Input
                class="w-80"
                disabled
                placeholder="https://api.openai.com/v1/chat/completions"
                :value="curSeletedProvider?.baseUrl"
              />
            </ProListItem>

            <ProListItem
              description="优先使用这里的模型；留空时会使用供应商默认模型。"
              title="模型名称"
            >
              <div>
                <Select
                  v-model:value="curSeletedModel"
                  class="w-80"
                  :options="(curSeletedProvider?.models ?? []).map((item:AiProviderModels) => ({ label: `${item.modelId}`, value: item.modelId }))"
                />
                <Popover
                  title="自定义模型-(可以在官方供应商模型列表中查找)"
                  trigger="click"
                >
                  <template #content>
                    <div>
                      <Input
                        v-model:value="customModel"
                        class="w-80"
                        placeholder="model"
                      />
                      <Button
                        type="primary"
                        @click="curSeletedModel = customModel"
                      >
                        保存
                      </Button>
                    </div>
                  </template>
                  <Button>
                    自定义
                  </Button>
                </Popover>
              </div>
            </ProListItem>
          </div>
        </div>
      </ProListItem>

      <ProListItem
        title="屏友人格"
        vertical
      >
        <TextArea
          v-model:value="curConversation!.config.systemPrompt"
          :auto-size="{ minRows: 3, maxRows: 6 }"
          placeholder="告诉模型应该如何扮演你的屏友"
        />
      </ProListItem>
    </ProList>
  </div>
</template>

<style scoped>

</style>
