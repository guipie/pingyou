<script setup lang="ts">
import type { UnlistenFn } from '@tauri-apps/api/event'

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { message } from '@tauri-apps/plugin-dialog'
import { message as AntdMessage, Button, Modal, Progress, Result, Spin, Tag } from 'antdv-next'
import { onMounted, onUnmounted, ref } from 'vue'
// import { useI18n } from 'vue-i18n'

import type { DownloadPayload, HardwareReport, InitStep } from '@/stores/shard/app-shard'

interface CleanupPayload {
  success: boolean
  status: string
}

// 模型信息结构
interface LocalModel {
  name: string
  size: number
}

// const { t } = useI18n()
// const routerSetting = useRouteSettingStore()
const [messageApi, ContextHolder] = AntdMessage.useMessage()

// 引擎服务地址（与 Rust 启动参数配置的端口保持一致）
const OLLAMA_HOST = 'http://127.0.0.1:11435/v1/chat/completions'

// 新增 completed 状态
const step = ref<InitStep | 'completed'>('checking')
const downloadProgress = ref<number>(0)
const downloadStatusText = ref<string>('正在准备下载通道...')

const isCleaning = ref<boolean>(false)
const cleanupStatusText = ref<string>('正在准备清理环境...')

// 存储已安装的模型列表
const localModels = ref<LocalModel[]>([])

const hardwareInfo = ref<HardwareReport>({
  total_memory_gb: 0,
  status: 'Unsupported',
  recommend_model: '',
})

// 字节大小转换格式化
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`
}

// 复制 API 地址到剪贴板
async function copyHost() {
  try {
    await navigator.clipboard.writeText(OLLAMA_HOST)
    messageApi.success('服务地址已成功复制到剪贴板！')
  } catch {
    messageApi.error('复制失败，请手动复制')
  }
}
// 🟢 加载已下载的模型列表，返回布尔值代表是否有可用模型
async function fetchLocalModels(): Promise<boolean> {
  try {
    const models = await invoke<LocalModel[]>('list_local_models')
    localModels.value = models
    return models.length > 0
  } catch (err) {
    console.warn('暂未检测到已运行的模型服务:', err)
    localModels.value = []
    return false
  }
}
// 🟢 页面加载时的检测
onMounted(async () => {
  try {
    const report = await invoke<HardwareReport>('check_hardware')
    hardwareInfo.value = report

    if (report.status === 'Low' || report.total_memory_gb < 4) {
      step.value = 'unsupported'
    } else {
      // 尝试检查当前是否已有在运行的引擎和模型
      const hasModels = await fetchLocalModels()
      if (hasModels) {
        step.value = 'completed'
      } else {
        // 如果没有模型，一律保持在准备界面，引导用户点击“一键开启”
        step.value = 'ready'
      }
    }
  } catch (err) {
    message('硬件环境检测失败，请重启软件')
    console.error(err)
  }
})

onUnmounted(() => {
  if (unlistenFn) unlistenFn()
  if (cleanupUnlistenFn) cleanupUnlistenFn()
})

let unlistenFn: UnlistenFn | null = null
let cleanupUnlistenFn: UnlistenFn | null = null

async function handleInit(): Promise<void> {
  step.value = 'downloading'

  try {
    downloadStatusText.value = '正在准备初始化通道...'

    // 监听进度
    unlistenFn = await listen<DownloadPayload>('download-progress', (event) => {
      const payload = event.payload
      downloadProgress.value = payload.progress
      downloadStatusText.value = payload.status
    })

    // 1. 拉起引擎
    downloadStatusText.value = '正在拉起内核引擎...'
    await invoke<void>('start_ollama_engine')

    // 2. 下载模型
    await invoke<void>('download_model', { model_name: hardwareInfo.value.recommend_model })

    // 3. 下载完成后，验证本地是否真的存在模型！
    downloadStatusText.value = '正在校验本地模型完整性...'
    const hasModels = await fetchLocalModels()

    if (hasModels) {
      messageApi.success('AI 引擎与模型部署成功！')
      step.value = 'completed' // 只有真正校验到了模型，才进入完成状态
    } else {
      // 🟢 兜底处理：如果进度到了 100% 但查出来依然没有模型
      messageApi.error('模型加载异常，未检测到有效模型，请尝试重新初始化')
      step.value = 'ready'
    }
  } catch (err) {
    step.value = 'ready'
    message(`初始化失败: ${err}`)
  } finally {
    if (unlistenFn) {
      unlistenFn()
      unlistenFn = null
    }
  }
}

function cleanupModels() {
  Modal.confirm({
    title: '确定要彻底清除本地 AI 模型吗？',
    content: '此操作将物理删除本地下载的全部大模型数据并深度释放硬盘空间。',
    okText: '确认清理',
    okType: 'danger',
    cancelText: '我再想想',
    onOk: async () => {
      isCleaning.value = true
      try {
        cleanupUnlistenFn = await listen<CleanupPayload>('cleanup-status', (event) => {
          cleanupStatusText.value = event.payload.status
        })

        await invoke<void>('cleanup_local_models', { model_name: null })

        Modal.success({
          title: '空间深度清理成功',
          content: '所有本地大模型缓存文件已被安全、干净地物理移除。',
        })

        localModels.value = []
        step.value = 'ready'
      } catch (err) {
        message(`深度清理失败: ${err}`)
        console.error(err)
      } finally {
        isCleaning.value = false
        if (cleanupUnlistenFn) {
          cleanupUnlistenFn()
          cleanupUnlistenFn = null
        }
      }
    },
  })
}

async function stopModels(): Promise<void> {
  Modal.confirm({
    title: '确定要停止本地 AI 模型服务吗？',
    content: '此操作将停止本地 AI 模型服务，服务不可用了,但不会删除任何数据。',
    okText: '确认停止',
    okType: 'danger',
    cancelText: '我再想想',
    onOk: async () => {
      isCleaning.value = true
      try {
        cleanupUnlistenFn = await listen<CleanupPayload>('cleanup-status', (event) => {
          cleanupStatusText.value = event.payload.status
        })

        await invoke<void>('stop_ollama_engine')

        Modal.success({
          title: '服务停止成功',
          content: '所有本地大模型服务已被停止。',
        })

        localModels.value = []
        step.value = 'ready'
      } catch (err) {
        message(`深度清理失败: ${err}`)
        console.error(err)
      } finally {
        isCleaning.value = false
        if (cleanupUnlistenFn) {
          cleanupUnlistenFn()
          cleanupUnlistenFn = null
        }
      }
    },
  })
}
</script>

<template>
  <ContextHolder />
  <div class="relative w-full overflow-auto">
    <!-- <div>
      <Button
        color="primary"
        variant="text"
        @click="routerSetting.backHome(2)"
      >
        <i class="i-lucide:arrow-left" />
        {{ t('common.buttons.back') }}
      </Button>
      <span class="text-5 font-medium">
        本地模型一键配置
      </span>
    </div> -->

    <div class="flex flex-col items-center justify-center gap-6 bg-slate-50">
      <div class="max-w-md w-full border border-slate-100 rounded-xl p-4 shadow-md bg-white">
        <!-- 状态 1：正在检测 -->
        <div
          v-if="step === 'checking'"
          class="flex flex-col items-center justify-center py-6"
        >
          <Spin size="large" />
          <p class="mt-4 text-14px text-slate-500 font-medium">
            正在优化您的 AI 本地运行环境...
          </p>
        </div>

        <!-- 状态 2：配置过低 -->
        <div
          v-else-if="step === 'unsupported'"
          class="animate-fade-in"
        >
          <Result
            status="error"
            :sub-title="`检测到您的电脑内存仅为 ${hardwareInfo.total_memory_gb}GB。运行本地 AI 至少需要 4GB 内存。`"
            title="电脑配置暂不支持"
          />
        </div>

        <!-- 状态 3：准备就绪 -->
        <div
          v-else-if="step === 'ready'"
          class="animate-fade-in text-center"
        >
          <div class="bg-blue-50 text-blue-600 mx-auto mb-4 h-16 w-16 flex items-center justify-center rounded-full">
            <div class="i-carbon-cpu text-32px" />
          </div>
          <h3 class="mb-2 text-18px text-slate-800 font-bold">
            环境准备就绪
          </h3>
          <p class="mb-6 text-14px text-slate-500 leading-relaxed">
            检测到系统内存为 <span class="text-blue-600 font-bold">{{ hardwareInfo.total_memory_gb }}GB</span>。<br>
            我们将为您一键安装最适合您电脑的极速轻量模型：<br>
            <span class="mx-auto mt-2 block w-fit bg-slate-100 px-2 py-0.5 text-12px text-slate-700 font-mono rounded">
              {{ hardwareInfo.recommend_model }}
            </span>
          </p>
          <Button
            class="w-full rounded-lg"
            size="large"
            type="primary"
            @click="handleInit"
          >
            一键开启 AI 体验
          </Button>
        </div>

        <!-- 状态 4：正在下载 -->
        <div
          v-else-if="step === 'downloading'"
          class="animate-fade-in"
        >
          <h4 class="mb-1 text-16px text-slate-800 font-bold">
            正在初始化本地引擎
          </h4>
          <p class="mb-6 text-12px text-slate-400 font-mono">
            {{ downloadStatusText }}
          </p>

          <Progress
            :percent="Math.round(downloadProgress)"
            status="active"
            :stroke-color="{ '0%': '#108ee9', '100%': '#87d068' }"
          />
        </div>

        <!-- 🟢 状态 5（新）：引擎已就绪，展现服务地址与可用模型列表 -->
        <div
          v-else-if="step === 'completed'"
          class="animate-fade-in"
        >
          <div class="mb-4 flex items-center gap-2">
            <Tag
              class="px-2 py-1 text-12px"
              color="success"
            >
              🟢 本地大模型服务运行中
            </Tag>
          </div>

          <!-- 服务地址配置卡片 -->
          <div class="mb-6 border border-slate-200 bg-slate-50 p-4 rounded-lg">
            <div class="mb-1 text-12px text-slate-500 font-medium">
              Ollama API 基础地址 (Base URL):
            </div>
            <div class="flex items-center justify-between border px-3 py-2 text-13px text-slate-700 font-mono bg-white rounded">
              <span class="select-text">{{ OLLAMA_HOST }}</span>
              <Button
                size="small"
                type="link"
                @click="copyHost"
              >
                复制
              </Button>
            </div>
          </div>

          <!-- 可用模型列表 -->
          <div>
            <div class="mb-3 flex items-center justify-between text-14px text-slate-800 font-bold">
              <span>已加载的本地模型</span>
              <span class="text-12px text-slate-400 font-normal">可直接用于对话</span>
            </div>

            <div class="flex flex-col gap-2">
              <div
                v-for="model in localModels"
                :key="model.name"
                class="bg-blue-50/50 border-blue-100 flex items-center justify-between border p-3 rounded-lg"
              >
                <div class="flex items-center gap-2 overflow-hidden">
                  <div class="i-carbon-machine-learning-model text-blue-600 shrink-0 text-18px" />
                  <span
                    class="select-text truncate text-13px text-slate-700 font-bold font-mono"
                    :title="model.name"
                  >
                    {{ model.name }}
                  </span>
                </div>
                <span
                  v-if="model.size"
                  class="ml-2 shrink-0 text-11px text-slate-400 font-mono"
                >
                  {{ formatSize(model.size) }}
                </span>
                <Button
                  size="small"
                  type="link"
                  @click="writeText(model.name)"
                >
                  复制
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div
          class="flex justify-between"
        >
          <Button
            v-if="step === 'completed'"
            danger
            :loading="isCleaning"
            size="small"
            type="primary"
            @click="cleanupModels"
          >
            一键彻底清除
          </Button>
          <Button
            v-if="step === 'completed'"
            :loading="isCleaning"
            size="small"
            type="primary"
            @click="stopModels"
          >
            停止运行
          </Button>
        </div>
      </div>

      <!-- 清理瘦身工具面板 -->
      <!-- <div
        v-if="step === 'ready' || step === 'completed' || isCleaning"
        class="max-w-md w-full animate-fade-in border border-slate-100 rounded-xl p-6 shadow-sm bg-white"
      >
        <div class="flex items-start gap-4">
          <div class="h-10 w-10 flex shrink-0 items-center justify-center bg-rose-50 text-rose-500 rounded-lg">
            <div class="i-carbon-trash-can text-22px" />
          </div>
          <div>
            <h4 class="mb-1 text-15px text-slate-800 font-bold">
              本地存储空间管理
            </h4>
            <p class="text-12px text-slate-400 leading-relaxed">
              清理后，本地所有的内核与已下载模型文件将被移除。
            </p>
          </div>
        </div>

        <div class="mt-5 flex flex-col gap-3">
          <div
            v-if="isCleaning"
            class="border border-slate-100 bg-slate-50 p-3 rounded-lg"
          >
            <div class="flex items-center gap-2 text-12px text-slate-600 font-mono">
              <Spin size="small" />
              <span>{{ cleanupStatusText }}</span>
            </div>
          </div>

          <Button
            class="h-9 w-full font-medium rounded-lg"
            danger
            :loading="isCleaning"
            type="primary"
            @click="showConfirmModal"
          >
            一键彻底清除本地模型 (回收空间)
          </Button>
        </div>
      </div> -->
    </div>
  </div>
</template>
