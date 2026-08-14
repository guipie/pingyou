<script setup lang="ts">
import type { UploadEmits, UploadProps } from 'antdv-next'

import { PlusOutlined } from '@antdv-next/icons'
import { Button, Input, message, Switch, TextArea, Upload } from 'antdv-next'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AIProvider } from '@/stores/shard/provider-shard'

import PyAvatar from '@/components/py-avatar.vue'
import { LISTEN_KEY } from '@/constants'
import { useProviderStore } from '@/stores/aiprovider'
import { useGeneralStore } from '@/stores/general'
import { getImgBase64 } from '@/utils/path'

type FileType = Parameters<NonNullable<UploadProps['beforeUpload']>>[0]

const generalStore = useGeneralStore()
const providerStore = useProviderStore()
const { t } = useI18n()

const addForm = ref({
  provider: '',
  value: '',
  avatar: '',
  desc: '',
  baseUrl: '',
  apiKey: '',
  isNeedProxy: false,
  /** 模型名称（展示用） */
  modelName: '',
  /** 模型标识（API 调用用） */
  modelId: '',
})

// ── 暗黑模式 ─────────────────────────────────────────────────────
function applyDarkMode() {
  if (generalStore.appearance.isDark) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

const stopWatch = watch(() => generalStore.appearance.isDark, applyDarkMode)

onMounted(async () => {
  // 确保 store 已初始化（App.vue 的 onMounted 可能还未执行完）
  try {
    await generalStore.$tauri.start()
    await generalStore.init()
  } catch {
    // store 可能已由 App.vue 初始化，忽略重复 start 错误
  }
  applyDarkMode()
  // ── 解析 URL query 参数，预填表单 ──
  const hash = window.location.hash // e.g. "#/provider-add?baseUrl=xxx&modelId=yyy"
  const queryStr = hash.includes('?') ? hash.split('?')[1] : ''

  if (queryStr) {
    const params = new URLSearchParams(queryStr)
    const baseUrl = params.get('baseUrl')
    const modelId = params.get('modelId')
    const modelName = params.get('modelName')
    const provider = params.get('provider')

    if (baseUrl) addForm.value.baseUrl = decodeURIComponent(baseUrl)
    if (modelId) addForm.value.modelId = decodeURIComponent(modelId)
    if (modelName) addForm.value.modelName = decodeURIComponent(modelName)
    if (provider) {
      addForm.value.provider = decodeURIComponent(provider)
      // 自动生成标识
      if (!addForm.value.value) {
        addForm.value.value = decodeURIComponent(provider)
          .replace(/[^a-z0-9]/gi, '-')
          .toLowerCase()
      }
    }
  }
})

onUnmounted(() => {
  stopWatch()
})

// ── 提交 ─────────────────────────────────────────────────────────

async function handleSubmit() {
  const { provider, value, baseUrl } = addForm.value

  if (!provider.trim()) {
    message.warning(t('pages.preference.provider.errors.providerNameRequired'))
    return
  }
  if (!value.trim()) {
    message.warning(t('pages.preference.provider.errors.providerValueRequired'))
    return
  }
  if (!baseUrl.trim()) {
    message.warning(t('pages.preference.provider.errors.baseUrlRequired'))
    return
  }

  const existProvider = providerStore.stateProviders.find(
    (p: AIProvider) => p.value === value.trim(),
  )
  if (existProvider) {
    message.warning(t('pages.preference.provider.errors.providerValueExists'))
    return
  }

  // 构建模型列表
  const models = []
  const modelName = addForm.value.modelName.trim()
  const modelId = addForm.value.modelId.trim()
  if (modelId) {
    models.push({
      name: modelName || modelId,
      modelId,
      desc: modelName || modelId,
    })
  }

  const newProvider: AIProvider = {
    provider: provider.trim(),
    value: value.trim(),
    avatar: addForm.value.avatar.trim() || provider.trim().charAt(0),
    desc: addForm.value.desc.trim() || t('pages.preference.provider.messages.defaultCustomDesc'),
    baseUrl: baseUrl.trim(),
    isCustom: true,
    apiKey: addForm.value.apiKey.trim(),
    isNeedProxy: addForm.value.isNeedProxy,
    defaultModel: modelId || '',
    models,
  }
  providerStore.addProvider(newProvider)
  message.success(t('pages.preference.provider.messages.addedCustomProvider', { provider: newProvider.provider }))

  // 通知主窗口刷新供应商列表
  const [{ emit }, { getCurrentWebviewWindow }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/webviewWindow'),
  ])
  await emit(LISTEN_KEY.PROVIDER_ADDED, newProvider)
  getCurrentWebviewWindow().close()
}

const avatarChange: UploadEmits['change'] = async (info) => {
  if (info.file) {
    addForm.value.avatar = await getImgBase64(info.file as FileType)
  }
}
</script>

<template>
  <div class="min-h-screen bg-[--ant-color-fill-secondary] p-6">
    <div class="mx-auto max-w-lg rounded-xl p-6 shadow-md bg-white dark:bg-warmGray-8">
      <h2 class="mb-6 text-slate-800 font-bold text-lg dark:text-white">
        {{ t('pages.preference.provider.labels.addCustomModel') }}
      </h2>

      <div class="flex flex-col gap-4">
        <!-- 头像 + 供应商名称 -->
        <div class="flex gap-5">
          <Upload
            accept=".png,.jpg,.jpeg"
            action="/"
            :before-upload="() => false"
            class="avatar-uploader"
            list-type="picture-card"
            name="avatar"
            :show-upload-list="false"
            style="width: 86px; height: 86px"
            @change="avatarChange"
          >
            <PyAvatar
              v-if="addForm.avatar"
              cus-style="width: 66px; height: 66px"
              :url="addForm.avatar"
            />
            <button
              v-else
              style="border: 0; background: none"
              type="button"
            >
              <PlusOutlined />
              <div style="margin-top: 8px">
                {{ t('pages.preference.provider.labels.avatar') }}
              </div>
            </button>
          </Upload>

          <div class="flex flex-1 flex-col justify-evenly gap-1.5">
            <label class="text-3.5 font-medium">
              {{ t('pages.preference.provider.labels.providerName') }}
              <span class="text-red-5">*</span>
            </label>
            <Input
              v-model:value="addForm.provider"
              :placeholder="t('pages.preference.provider.placeholders.providerName')"
            />
          </div>
        </div>

        <!-- 供应商标识 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            {{ t('pages.preference.provider.labels.providerValue') }}
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.value"
            :placeholder="t('pages.preference.provider.placeholders.providerValue')"
          />
        </div>

        <!-- Base URL -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            Base URL
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.baseUrl"
            :placeholder="t('pages.preference.provider.placeholders.baseUrl')"
          />
        </div>

        <!-- 模型名称 + 模型标识 -->
        <div class="bg-blue-50/50 border border-slate-200 p-3 rounded-lg dark:border-warmGray-600 dark:bg-warmGray-700/50">
          <div class="mb-2 text-3 text-slate-600 font-medium dark:text-warmGray-300">
            {{ t('pages.preference.provider.labels.modelConfig') }}
          </div>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1.5">
              <label class="text-3 font-medium">{{ t('pages.preference.provider.labels.modelName') }}</label>
              <Input
                v-model:value="addForm.modelName"
                :placeholder="t('pages.preference.provider.placeholders.modelName')"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-3 font-medium">{{ t('pages.preference.provider.labels.modelId') }}</label>
              <Input
                v-model:value="addForm.modelId"
                :placeholder="t('pages.preference.provider.placeholders.modelId')"
              />
            </div>
          </div>
        </div>

        <!-- API Key -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.apiKeyOptional') }}</label>
          <Input.Password
            v-model:value="addForm.apiKey"
            :placeholder="t('pages.preference.provider.placeholders.apiKey')"
          />
        </div>

        <!-- 是否需要代理 -->
        <div
          class="flex items-center justify-between bg-[--ant-color-fill-quaternary] p-3 rounded-lg"
        >
          <div>
            <div class="text-3.5 font-medium">
              {{ t('pages.preference.provider.labels.needProxy') }}
            </div>
            <div class="mt-0.5 text-2.5 color-text-quaternary">
              {{ t('pages.preference.provider.hints.proxyDesc') }}
            </div>
          </div>
          <Switch v-model:checked="addForm.isNeedProxy" />
        </div>

        <!-- 描述 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.providerDesc') }}</label>
          <TextArea
            v-model:value="addForm.desc"
            :placeholder="t('pages.preference.provider.placeholders.providerDesc')"
            :rows="4"
          />
        </div>

        <!-- 确认按钮 -->
        <Button
          block
          type="primary"
          @click="handleSubmit"
        >
          {{ t('pages.preference.provider.labels.addProvider') }}
        </Button>
      </div>
    </div>
  </div>
</template>
