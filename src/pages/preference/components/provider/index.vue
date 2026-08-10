<script setup lang="ts">
import { CheckCircleOutlined, ExclamationCircleOutlined, RedoOutlined, SettingOutlined } from '@antdv-next/icons'
import { Button, message, Popconfirm, Tag } from 'antdv-next'
import { computed, onUnmounted, ref } from 'vue'

import type { AIProvider } from '@/stores/shard/provider-shard'

import ProList from '@/components/pro-list/index.vue'
import PyAvatar from '@/components/py-avatar.vue'
import { LISTEN_KEY } from '@/constants'
import { RoutersName } from '@/router/roters'
import { useProviderStore } from '@/stores/aiprovider'
import { isBoolean } from '@/utils/is.ts'
import { openNewWindow } from '@/utils/win-manager'

import Setting from './components/setting.vue'
import Ollama from './ollama.vue'

const providerStore = useProviderStore()

// 设置弹框状态
const settingOpen = ref(false)
const settingProvider = ref<AIProvider | null>(null)
const providers = computed(() => providerStore.stateProviders)

// 监听来自 add 子窗口的供应商添加事件
let unlistenAdd: (() => void) | null = null

import('@tauri-apps/api/event').then(({ listen }) => {
  listen(LISTEN_KEY.PROVIDER_ADDED, () => {
    providerStore.initDbProviders()
  }).then((fn) => {
    unlistenAdd = fn
  })
})

onUnmounted(() => {
  unlistenAdd?.()
})

function openSetting(provider: AIProvider) {
  settingProvider.value = JSON.parse(JSON.stringify(provider))
  settingOpen.value = true
}

/** 在新窗口中打开"添加自定义模型"表单，方便用户自由切换窗口复制地址/密钥 */
function handleOpenAddModal() {
  openNewWindow(RoutersName.ProviderAdd, {
    title: '添加自定义模型',
  })
}

/** "使用本地大模型"按钮回调：打开预填了 Ollama 地址和模型名的添加窗口 */
function handleUseLocalModel(payload: { baseUrl: string, modelName: string, modelId: string, provider: string }) {
  const query = `?baseUrl=${encodeURIComponent(payload.baseUrl)}&modelId=${encodeURIComponent(payload.modelId)}&modelName=${encodeURIComponent(payload.modelName)}&provider=${encodeURIComponent(payload.provider)}`
  openNewWindow(RoutersName.ProviderAdd, {
    isForeCreate: true,
    title: '添加本地大模型',
    query,
  })
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
          <Ollama @use-local-model="handleUseLocalModel" />
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
                  v-if="isBoolean(provider.isCustom) "
                  color="success"
                  variant="solid"
                >
                  <template #icon>
                    <CheckCircleOutlined />
                  </template>自定义
                </Tag>
                <Tag
                  v-else-if="provider.apiKey"
                  color="success"
                  variant="filled"
                >
                  <template #icon>
                    <CheckCircleOutlined />
                  </template>已配置
                </Tag>
                <Tag
                  v-else
                  color="warning"
                >
                  <template #icon>
                    <ExclamationCircleOutlined />
                  </template>
                  未配置Key
                </Tag>
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
  </div>
</template>
