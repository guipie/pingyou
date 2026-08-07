<script setup lang="ts">
import type { UnlistenFn } from '@tauri-apps/api/event'

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { message } from '@tauri-apps/plugin-dialog'
import { message as AntdMessage, Button, Modal, Progress, Result, Spin, Tag } from 'antdv-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type { DownloadPayload, HardwareReport, InitStep } from '@/stores/shard/app-shard'

const emit = defineEmits<{
  (e: 'useLocalModel', payload: { baseUrl: string, modelName: string, modelId: string, provider: string }): void
}>()

interface CleanupPayload {
  success: boolean
  status: string
}

// 模型信息结构
interface LocalModel {
  name: string
  size: number
}

// 持久化到 localStorage 的下载状态
interface PersistedDownloadState {
  step: string
  /** Rust 侧原始进度 (0-100%) */
  rawProgress: number
  /** 前端合并后的展示进度 (0-100%) */
  displayProgress: number
  status: string
  /** 下载阶段: "engine" | "model" */
  phase: string
}

const STORAGE_KEY = 'ollama_download_state'

const [messageApi, ContextHolder] = AntdMessage.useMessage()

// 引擎服务地址（与 Rust 启动参数配置的端口保持一致）
const OLLAMA_HOST = 'http://127.0.0.1:11435/v1/chat/completions'

const step = ref<InitStep | 'completed'>('checking')
const downloadProgress = ref<number>(0)
const downloadStatusText = ref<string>('正在准备下载通道...')
/** 当前下载阶段: 空字符串表示未开始 */
const downloadPhase = ref<string>('')
/** 是否处于暂停状态 */
const isPaused = ref<boolean>(false)

const isCleaning = ref<boolean>(false)
const cleanupStatusText = ref<string>('正在准备清理环境...')

// 存储已安装的模型列表
const localModels = ref<LocalModel[]>([])

const hardwareInfo = ref<HardwareReport>({
  total_memory_gb: 0,
  status: 'Unsupported',
  recommend_model: '',
})

// ─── 合并进度：引擎 0-50%，模型 50-100%，永不回退 ─────────────

/**
 * 将 Rust 侧的两个独立阶段 (engine 0-100%, model 0-100%)
 * 合并为前端展示的单一进度条 (0-100%)，确保刷新后不会跳动。
 *
 *   引擎阶段:  raw 0-100%  →  display 0-50%
 *   模型阶段:  raw 0-100%  →  display 50-100%
 */
function computeDisplayProgress(raw: number, phase: string): number {
  if (phase === 'model') {
    return 50 + (raw / 100) * 50
  }
  // engine 阶段 (或未知阶段也按 engine 处理)
  return (raw / 100) * 50
}

/** 展示用的进度 (0-100)，只增不减 */
const displayProgress = computed(() => {
  return computeDisplayProgress(downloadProgress.value, downloadPhase.value)
})

// ─── localStorage 持久化 ──────────────────────────────────────────

function saveDownloadState() {
  const state: PersistedDownloadState = {
    step: step.value,
    rawProgress: downloadProgress.value,
    displayProgress: displayProgress.value,
    status: downloadStatusText.value,
    phase: downloadPhase.value,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function clearDownloadState() {
  localStorage.removeItem(STORAGE_KEY)
}

function loadPersistedState(): PersistedDownloadState | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PersistedDownloadState
  } catch {
    return null
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`
}

async function copyHost() {
  try {
    await navigator.clipboard.writeText(OLLAMA_HOST)
    messageApi.success('服务地址已成功复制到剪贴板！')
  } catch {
    messageApi.error('复制失败，请手动复制')
  }
}

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

// ─── 事件监听 ──────────────────────────────────────────────────────

let unlistenFn: UnlistenFn | null = null
let cleanupUnlistenFn: UnlistenFn | null = null

async function startProgressListener() {
  if (unlistenFn) return

  unlistenFn = await listen<DownloadPayload>('download-progress', (event) => {
    const payload = event.payload
    downloadProgress.value = payload.progress
    downloadStatusText.value = payload.status

    // 首次收到事件时记录阶段（避免 phase 为空导致进度计算错误）
    if (payload.phase && payload.phase !== downloadPhase.value) {
      downloadPhase.value = payload.phase
    }

    // 实时持久化到 localStorage
    saveDownloadState()
  })
}

function stopProgressListener() {
  if (unlistenFn) {
    unlistenFn()
    unlistenFn = null
  }
}

// ─── 生命周期 ──────────────────────────────────────────────────────

onMounted(async () => {
  try {
    const report = await invoke<HardwareReport>('check_hardware')
    hardwareInfo.value = report

    if (report.status === 'Low' || report.total_memory_gb < 4) {
      step.value = 'unsupported'
      clearDownloadState()
      return
    }

    // ★ 刷新恢复：检查是否有正在进行的下载
    const isActive = await invoke<boolean>('is_downloading').catch(() => false)

    if (isActive) {
      // Rust 侧有下载正在进行 → 恢复 downloading 状态
      const saved = loadPersistedState()
      if (saved && saved.step === 'downloading') {
        step.value = 'downloading'
        downloadProgress.value = saved.rawProgress
        downloadPhase.value = saved.phase || 'engine'
        downloadStatusText.value = saved.status
      } else {
        step.value = 'downloading'
        // 无持久化数据时，从 0 开始
        downloadProgress.value = 0
        downloadPhase.value = 'engine'
      }
      // 重新绑定进度监听
      await startProgressListener()
      return
    }

    // 检查持久化状态（可能刚完成）
    const saved = loadPersistedState()
    if (saved && saved.step === 'downloading') {
      const hasModels = await fetchLocalModels()
      if (hasModels) {
        step.value = 'completed'
        clearDownloadState()
      } else {
        step.value = 'ready'
        clearDownloadState()
      }
      return
    }

    // 正常检测
    const hasModels = await fetchLocalModels()
    if (hasModels) {
      step.value = 'completed'
      clearDownloadState()
    } else {
      step.value = 'ready'
      clearDownloadState()
    }
  } catch (err) {
    message('硬件环境检测失败，请重启软件')
    console.error(err)
  }
})

onUnmounted(() => {
  stopProgressListener()
  if (cleanupUnlistenFn) {
    cleanupUnlistenFn()
    cleanupUnlistenFn = null
  }
})

// ─── 下载流程 ──────────────────────────────────────────────────────

async function handleInit(): Promise<void> {
  step.value = 'downloading'
  downloadProgress.value = 0
  downloadPhase.value = 'engine'
  downloadStatusText.value = '正在准备初始化通道...'
  isPaused.value = false
  saveDownloadState()

  try {
    await startProgressListener()

    // 1. 拉起引擎
    downloadStatusText.value = '正在拉起内核引擎...'
    await invoke<void>('start_ollama_engine')

    // 2. 下载模型
    await invoke<void>('download_model', { model_name: hardwareInfo.value.recommend_model })

    // 3. 验证
    downloadStatusText.value = '正在校验本地模型完整性...'
    saveDownloadState()

    const hasModels = await fetchLocalModels()

    if (hasModels) {
      messageApi.success('AI 引擎与模型部署成功！')
      step.value = 'completed'
      clearDownloadState()
    } else {
      messageApi.error('模型加载异常，未检测到有效模型，请尝试重新初始化')
      step.value = 'ready'
      clearDownloadState()
    }
  } catch (err) {
    const errMsg = String(err)
    if (errMsg.includes('已被用户取消') || errMsg.includes('cancelled')) {
      messageApi.info('下载已取消，临时文件已清理')
    } else {
      message(`初始化失败: ${err}`)
    }
    step.value = 'ready'
    isPaused.value = false
    clearDownloadState()
  } finally {
    stopProgressListener()
  }
}

// ★ 暂停下载
async function handlePause() {
  try {
    await invoke<void>('pause_download')
    isPaused.value = true
    messageApi.info('下载已暂停')
    saveDownloadState()
  } catch (err) {
    console.error('暂停失败:', err)
  }
}

// ★ 继续下载
async function handleResume() {
  try {
    await invoke<void>('resume_download')
    isPaused.value = false
    messageApi.info('继续下载中...')
    saveDownloadState()
  } catch (err) {
    console.error('继续下载失败:', err)
  }
}

// ★ 取消下载（Rust 侧会清理临时文件）
async function handleCancel() {
  Modal.confirm({
    title: '确定要取消下载吗？',
    content: '取消后将删除所有已下载的临时文件，恢复至初始状态。',
    okText: '确认取消',
    okType: 'danger',
    cancelText: '继续下载',
    onOk: async () => {
      try {
        // 如果暂停中，先恢复再取消（避免死锁）
        if (isPaused.value) {
          await invoke<void>('resume_download')
        }
        await invoke<void>('cancel_download')
        messageApi.info('下载已取消，临时文件已清理')
        step.value = 'ready'
        isPaused.value = false
        clearDownloadState()
      } catch (err) {
        console.error('取消下载失败:', err)
        // 即使出错也重置状态
        step.value = 'ready'
        isPaused.value = false
        clearDownloadState()
      }
    },
    onCancel: () => {
      // 用户点了"继续下载"，不做任何操作
    },
  })
}

// ─── 使用本地大模型 ────────────────────────────────────────────

function handleUseLocalModel() {
  const firstModel = localModels.value[0]
  const modelName = firstModel?.name || hardwareInfo.value.recommend_model || 'local-model'

  emit('useLocalModel', {
    baseUrl: OLLAMA_HOST,
    modelName,
    modelId: modelName,
    provider: '本地大模型',
  })
}

// ─── 清理 / 停止 ──────────────────────────────────────────────────

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
        clearDownloadState()
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
        clearDownloadState()
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
  <div class="relative h-full w-full overflow-auto">
    <div class="flex flex-col items-center justify-center gap-6">
      <div class="max-w-md w-full border border-slate-100 rounded-xl p-4 shadow-md">
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
          <div class="text-blue-600 mx-auto mb-4 h-16 w-16 flex items-center justify-center rounded-full">
            <div class="i-carbon-cpu text-32px" />
          </div>
          <h3 class="mb-2 text-18px text-slate-800 font-bold">
            环境准备就绪
          </h3>
          <p class="mb-6 text-14px text-slate-500 leading-relaxed">
            检测到系统内存为 <span class="text-blue-600 font-bold">{{ hardwareInfo.total_memory_gb }}GB</span>。<br>
            我们将为您一键安装最适合您电脑的极速轻量模型：<br>
            <span class="mx-auto mt-2 block w-fit px-2 py-0.5 text-12px text-slate-700 font-mono rounded">
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

        <!-- 状态 4：正在下载 / 已暂停 -->
        <div
          v-else-if="step === 'downloading'"
          class="animate-fade-in"
        >
          <div class="mb-1 flex items-center gap-2">
            <h4 class="text-16px text-slate-800 font-bold">
              {{ isPaused ? '下载已暂停' : '正在初始化本地引擎' }}
            </h4>
            <Tag
              v-if="isPaused"
              color="warning"
            >
              已暂停
            </Tag>
            <Tag
              v-else
              color="processing"
            >
              {{ downloadPhase === 'model' ? '模型下载中' : '引擎下载中' }}
            </Tag>
          </div>
          <p class="mb-6 text-12px text-slate-400 font-mono">
            {{ isPaused ? '下载已暂停，点击"继续下载"恢复' : downloadStatusText }}
          </p>

          <Progress
            :percent="Math.round(displayProgress)"
            :status="isPaused ? 'normal' : 'active'"
            :stroke-color="{ '0%': '#108ee9', '100%': '#87d068' }"
          />

          <!-- 操作按钮组 -->
          <div class="mt-4 flex items-center justify-center gap-3">
            <!-- 暂停状态：显示"继续下载" -->
            <Button
              v-if="isPaused"
              size="small"
              type="primary"
              @click="handleResume"
            >
              继续下载
            </Button>
            <!-- 下载中状态：显示"暂停下载" -->
            <Button
              v-else
              size="small"
              @click="handlePause"
            >
              暂停下载
            </Button>
            <!-- 取消下载始终显示 -->
            <Button
              danger
              size="small"
              type="link"
              @click="handleCancel"
            >
              取消下载
            </Button>
          </div>
        </div>

        <!-- 状态 5：引擎已就绪 -->
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

          <div class="mb-6 border border-slate-200 p-4 rounded-lg">
            <div class="mb-1 text-12px text-slate-500 font-medium">
              Ollama API 基础地址 (Base URL):
            </div>
            <div class="flex items-center justify-between border px-3 py-2 text-13px text-slate-700 font-mono rounded">
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
          class="flex flex-wrap justify-between gap-2"
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
          <Button
            v-if="step === 'completed'"
            size="small"
            type="primary"
            @click="handleUseLocalModel"
          >
            使用本地大模型
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
