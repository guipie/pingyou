<script setup lang="ts">
import type { UploadEmits, UploadProps } from 'antdv-next'

import { PlusOutlined, RedoOutlined, SettingOutlined } from '@antdv-next/icons'
import { Button, Input, message, Modal, Popconfirm, Switch, Tag, TextArea, Upload } from 'antdv-next'
import { computed, ref } from 'vue'

import type { AIProvider } from '@/stores/shard/provider-shard.ts'

import ProList from '@/components/pro-list/index.vue'
import PyAvatar from '@/components/py-avatar.vue'
import { useProviderStore } from '@/stores/aiprovider'
import { getImgBase64 } from '@/utils/path.ts'

import Setting from './components/setting.vue'
import Ollama from './ollama.vue'

type FileType = Parameters<NonNullable<UploadProps['beforeUpload']>>[0]
const providerStore = useProviderStore()

// 设置弹框状态
const settingOpen = ref(false)
const settingProvider = ref<AIProvider | null>(null)
const providers = computed(() => providerStore.stateProviders)
// 添加自定义模型弹框状态
const addModalOpen = ref(false)
const addForm = ref({
  provider: '',
  value: '',
  avatar: '',
  desc: '',
  baseUrl: '',
  apiKey: '',
  isNeedProxy: false,
})

function openSetting(provider: AIProvider) {
  settingProvider.value = JSON.parse(JSON.stringify(provider))
  settingOpen.value = true
}

function handleOpenAddModal() {
  addForm.value = {
    provider: '',
    value: '',
    avatar: '',
    desc: '',
    baseUrl: '',
    apiKey: '',
    isNeedProxy: false,
  }
  addModalOpen.value = true
}

function handleAddProvider() {
  const { provider, value, baseUrl } = addForm.value

  if (!provider.trim()) {
    message.warning('请输入供应商名称')
    return
  }
  if (!value.trim()) {
    message.warning('请输入供应商标识')
    return
  }
  if (!baseUrl.trim()) {
    message.warning('请输入 Base URL')
    return
  }

  const existProvider = providerStore.stateProviders.find((p: AIProvider) => p.value === value.trim())
  if (existProvider) {
    message.warning('该供应商标识已存在，请更换')
    return
  }

  const newProvider: AIProvider = {
    provider: provider.trim(),
    value: value.trim(),
    avatar: addForm.value.avatar.trim() || provider.trim().charAt(0),
    desc: addForm.value.desc.trim() || '自定义供应商',
    baseUrl: baseUrl.trim(),
    isCustom: true,
    apiKey: addForm.value.apiKey.trim(),
    isNeedProxy: addForm.value.isNeedProxy,
    defaultModel: '',
    models: [],
  }
  providerStore.addProvider(newProvider)
  message.success(`已添加自定义供应商：${newProvider.provider}`)
  addModalOpen.value = false
}
const avatarChange: UploadEmits['change'] = async (info) => {
  if (info.file) {
    addForm.value.avatar = await getImgBase64(info.file as FileType)
  }
}
function handleRemoveProvider(provider: AIProvider) {
  providerStore.removeProvider(provider.provider)
  message.success(`已移除供应商：${provider.provider}`)
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 供应商列表 -->
    <ProList title="模型源">
      <template #right>
        <!-- //刷新 -->
        <Button
          size="small"
          type="text"
          @click="providerStore.initDbProviders()"
        >
          <template #icon>
            <RedoOutlined />
          </template>
        </Button>
      </template>
      <div class="flex justify-between">
        <!-- 本地模型搭建卡片 -->
        <div
          class="hover:bg-blue-50/30 dark:hover:bg-blue-900/10 min-h-36 min-w-66 rounded-xl b-dashed transition-all b-border-sec hover:b-blue-4"
        >
          <Ollama />
        </div>
        <!-- 添加自定义模型卡片 -->
        <div
          class="hover:bg-blue-50/30 dark:hover:bg-blue-900/10 min-h-36 min-w-66 flex flex-col cursor-pointer items-center justify-center gap-3 b-2 rounded-xl b-dashed transition-all b-border-sec hover:b-blue-4"
          @click="handleOpenAddModal"
        >
          <div class="bg-blue-50 dark:bg-blue-900/30 size-12 flex items-center justify-center rounded-full text-7 text-blue-5">
            <i class="i-lucide:plus" />
          </div>
          <span class="text-4.5 font-medium color-text-secondary">添加自定义模型</span>
          <span class="text-3 color-text-quaternary">接入任意 OpenAI 兼容接口</span>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <!-- 供应商卡片 -->
        <div
          v-for="provider in providers"
          :key="provider.value"
          class="flex flex-col gap-3 b-1 rounded-xl b-solid p-5 transition-all bg-elevated b-border-sec hover:shadow-md"
          :class="{ 'b-blue-5! shadow-blue-200/30!': !!provider.apiKey }"
        >
          <!-- 卡片头部：头像 + 名称 + 标签 -->
          <div class="flex items-center gap-3">
            <PyAvatar
              :icon="provider.avatar"
              :url="provider.avatar"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-4 font-semibold">{{ provider.provider }}</span>
                <Tag
                  v-if="provider.apiKey"
                  color="success"
                >
                  已配置
                </Tag>
                <!-- <Tag
                  v-if="provider.isNeedProxy"
                  color="orange"
                >
                  需代理
                </Tag> -->
              </div>
            </div>
          </div>

          <!-- 描述 -->
          <div class="line-clamp-2 min-h-10 text-3 leading-relaxed color-text-tertiary">
            {{ provider.desc }}
          </div>

          <!-- 模型标签 -->
          <div
            v-if="provider.models && provider.models.length > 0"
            class="flex flex-wrap gap-1"
          >
            <Tag
              v-for="model in provider.models.slice(0, 4)"
              :key="model.modelId"
              class="text-2.5"
              :color="model.modelId === provider.defaultModel ? 'blue' : 'default'"
            >
              {{ model.name }}
            </Tag>
            <Tag
              v-if="provider.models.length > 4"
              class="text-2.5"
            >
              +{{ provider.models.length - 4 }}
            </Tag>
          </div>

          <!-- 操作按钮 -->
          <div class="mt-auto flex gap-2 border-t pt-3 b-border-sec">
            <div class="flex-1" />
            <Button
              size="small"
              @click="openSetting(provider)"
            >
              <template #icon>
                <SettingOutlined />
              </template>
              设置
            </Button>

            <!-- <Button
              color="green"
              :disabled="!provider.apiKey"
              size="small"
              variant="solid"
              @click="handleUseProvider(provider)"
            >
              使用
            </Button> -->

            <Popconfirm
              v-if="provider.isCustom"
              description="确定要移除该供应商吗？"
              placement="topRight"
              title="移除供应商"
              @confirm="handleRemoveProvider(provider)"
            >
              <Button
                danger
                size="small"
                type="text"
              >
                <template #icon>
                  <i class="i-lucide:trash-2" />
                </template>
              </Button>
            </Popconfirm>
          </div>
        </div>
      </div>
    </ProList>

    <!-- 设置弹框 -->
    <Setting
      v-if="settingOpen"
      v-model:open="settingOpen"
      :provider="settingProvider"
    />

    <!-- 添加自定义模型弹框 -->
    <Modal
      v-model:open="addModalOpen"
      centered
      :footer="null"
      title="添加自定义模型"
      :width="520"
    >
      <div class="flex flex-col gap-4 pt-2">
        <div class="flex gap-5">
          <Upload
            accept=".png,.jpg,.jpeg"
            action="/"
            :before-upload="() => false"
            class="avatar-uploader"
            list-type="picture-card"
            name="avatar"
            :show-upload-list="false"
            style="width: 86px; height: 86px;"
            @change="avatarChange"
          >
            <PyAvatar
              v-if="addForm.avatar"
              cus-style="width: 66px; height: 66px;"
              :url="addForm.avatar"
            />
            <button
              v-else
              style="border: 0; background: none"
              type="button"
            >
              <PlusOutlined />
              <div style="margin-top: 8px">
                头像
              </div>
            </button>
          </Upload>
          <!-- 供应商名称 -->
          <div class="flex flex-1 flex-col justify-evenly gap-1.5">
            <label class="text-3.5 font-medium">
              供应商名称
              <span class="text-red-5">*</span>
            </label>
            <Input
              v-model:value="addForm.provider"
              placeholder="如：DeepSeek、硅基流动"
            />
          </div>
        </div>

        <!-- 供应商标识 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            供应商标识
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.value"
            placeholder="唯一英文标识，如：deepseek"
          />
        </div>

        <!-- 头像 URL（可选）
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">头像 URL（可选）</label>
          <Input
            v-model:value="addForm.avatar"
            placeholder="图片链接或 UnoCSS 图标名，如 i-lucide:bot"
          />
        </div> -->

        <!-- Base URL -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            Base URL
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.baseUrl"
            placeholder="如：https://api.deepseek.com/v1/chat/completions"
          />
        </div>

        <!-- API Key -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">API Key（可选）</label>
          <Input.Password
            v-model:value="addForm.apiKey"
            placeholder="也可在添加后通过设置按钮填写"
          />
        </div>

        <!-- 是否需要代理 -->
        <div class="flex items-center justify-between bg-[--ant-color-fill-quaternary] p-3 rounded-lg">
          <div>
            <div class="text-3.5 font-medium">
              需要代理
            </div>
            <div class="mt-0.5 text-2.5 color-text-quaternary">
              若接口需要科学上网访问，请开启
            </div>
          </div>
          <Switch v-model:checked="addForm.isNeedProxy" />
        </div>

        <!-- 描述 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">描述（可选）</label>
          <TextArea
            v-model:value="addForm.desc"
            placeholder="简短描述该供应商"
            :rows="4"
          />
        </div>
        <!-- 确认按钮 -->
        <Button
          block
          type="primary"
          @click="handleAddProvider"
        >
          添加供应商
        </Button>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
</style>
