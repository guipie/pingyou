<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message, open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { message as AntdMessage, Button, Modal, Progress, Result, Spin, Tag, Tooltip } from "antdv-next";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import type { DownloadPayload, HardwareReport, InitStep } from "@/stores/shard/app-shard";
import type { AIProvider, AiProviderModels, ModelCapability } from "@/stores/shard/provider-shard";

import { useHardwareModels } from "@/composables/useHardwareModels";
import { WEB_BASE } from "@/config";
import { LOCAL_MODEL_CATALOG } from "@/constants/local-models";
import { useProviderStore } from "@/stores/aiprovider";

const { t } = useI18n();
const providerStore = useProviderStore();

/** 本地大模型供应商标识（数据库主键，不可按语言翻译，展示时通过 i18n 映射） */
const LOCAL_MODEL_PROVIDER = "本地大模型";
const LOCAL_MODEL_VALUE = "local-ollama";
const OLLAMA_BASE_URL = "http://127.0.0.1:11435/v1";

/**
 * 引擎就绪时，将当前已安装模型同步到本地供应商。
 * 自动创建（首次）或更新（后续）provider，保证单一数据源。
 * 超过 5 个模型时只同步前 5 个。
 */
function updateLocalProvider(models: LocalModel[]) {
  // 超过 5 个只取前 5（截断）
  const take = models.slice(0, 5);
  const providerModels: AiProviderModels[] = take.map((m) => {
    // 从目录反查能力类型
    const preset = LOCAL_MODEL_CATALOG.find(p => p.id === m.name);
    const type: ModelCapability = preset?.type === "vision" ? "vision" : "text";
    return {
      name: m.name,
      modelId: m.name,
      desc: preset?.descKey ? t(preset.descKey) : "",
      type,
      enabled: true,
    };
  });

  const existing = providerStore.stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER);
  let defaultModel = providerModels[0]?.modelId ?? "";
  if (existing?.defaultModel && providerModels.some(m => m.modelId === existing.defaultModel)) {
    defaultModel = existing.defaultModel; // 保留用户选的默认
  }

  const provider: AIProvider = {
    provider: LOCAL_MODEL_PROVIDER,
    value: LOCAL_MODEL_VALUE,
    avatar: "i-carbon-cpu",
    desc: t("pages.preference.provider.local.desc"),
    baseUrl: OLLAMA_BASE_URL,
    isCustom: false,
    isNeedProxy: false,
    models: providerModels,
    defaultModel,
  };

  if (existing) {
    providerStore.updateProvider(provider);
  } else {
    providerStore.addProvider(provider);
  }
}

/** 卸载某个本地模型（ollama rm） */
async function uninstallLocalModel(modelId: string) {
  try {
    await invoke<void>("cleanup_local_models", { model_name: modelId });
    messageApi.success(t("pages.preference.provider.messages.modelRemoved"));
    // 刷新列表
    await fetchLocalModels();
    updateLocalProvider(localModels.value);
  } catch (err) {
    console.error("[ollama] 卸载本地模型失败:", err);
    messageApi.error(t("pages.preference.provider.messages.modelRemoveFailed"));
  }
}

/** 设为默认模型 */
function setLocalDefault(modelId: string) {
  const existing = providerStore.stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER);
  if (!existing) return;
  providerStore.updateProvider({ ...existing, defaultModel: modelId });
}

/**
 * 将 Rust 侧推送的中文状态文本翻译为当前语言。
 * 未匹配到的状态（例如 Ollama 自身的英文状态消息）原样返回。
 */
function translateStatus(status: string): string {
  if (!status) return "";
  const trimmed = status.trim();

  const engineDownload = /^正在高速下载AI核心组件:\s*([\d.]+)%$/.exec(trimmed);
  if (engineDownload) {
    return t("pages.preference.provider.status.downloadingCore", { progress: engineDownload[1] });
  }
  const modelDownload = /^正在高速下载AI大模型:\s*([\d.]+)%$/.exec(trimmed);
  if (modelDownload) {
    return t("pages.preference.provider.status.downloadingModel", { progress: modelDownload[1] });
  }
  const UNINSTALL_PREFIX = "正在从本地仓库卸载模型:";
  if (trimmed.startsWith(UNINSTALL_PREFIX) && trimmed.endsWith("...")) {
    return t("pages.preference.provider.status.uninstallingModel", {
      name: trimmed.slice(UNINSTALL_PREFIX.length, -3).trim(),
    });
  }

  const statusKeyMap: Record<string, string> = {
    "正在安全请求云端环境配置...": "requestingConfig",
    "正在解压并深度优化本地 AI 显卡加速环境...": "extractingEnv",
    "内核环境就绪，正在激活大模型通道...": "activatingChannel",
    "模型初始化成功！": "modelReady",
    "正在安全关闭本地 AI 引擎...": "stoppingEngine",
    "正在全量物理粉碎 AI 内核、显卡驱动及模型数据...": "shreddingData",
    "1.8GB 本地 AI 组件及模型已全部彻底移除，空间已完美释放！": "cleanupComplete",
  };
  const key = statusKeyMap[trimmed];
  return key ? t(`pages.preference.provider.status.${key}`) : status;
}

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

const STORAGE_KEY = "ollama_download_state";

const [messageApi, ContextHolder] = AntdMessage.useMessage();

// 引擎服务地址（与 Rust 启动参数配置的端口保持一致）
const OLLAMA_HOST = "http://127.0.0.1:11435/v1/chat/completions";

const step = ref<InitStep | "completed">("checking");
const downloadProgress = ref<number>(0);
const downloadStatusText = ref<string>(t("pages.preference.provider.status.preparingDownload"));
/** 当前下载阶段: 空字符串表示未开始 */
const downloadPhase = ref<string>("");
/** 是否处于暂停状态 */
const isPaused = ref<boolean>(false);

const isCleaning = ref<boolean>(false);
const cleanupStatusText = ref<string>(t("pages.preference.provider.status.preparingCleanup"));

// 拖拽导入 Ollama 引擎安装包（网盘下载后拖入）
const dropRef = ref<HTMLElement | null>(null);
const isDragging = ref<boolean>(false);
const importing = ref<boolean>(false);
// 后台配置的网盘兜底地址（下载失败时引导用户前往下载后拖拽导入）
const panelUrl = ref<string>("");

// 存储已安装的模型列表
const localModels = ref<LocalModel[]>([]);

const hardwareInfo = ref<HardwareReport>({
  total_memory_gb: 0,
  cpu_cores: 0,
  status: "Unsupported",
  recommend_model: "",
  gpus: [],
  max_vram_mb: 0,
});

// 按硬件过滤模型目录
const { allModels, installable, hasGpu } = useHardwareModels(hardwareInfo);
// 当前选中的模型（默认取推荐项，在 onMounted 检测后回填）
const selectedModelId = ref<string>("");

// 已安装模型名集合（computed，单一数据源）
const installedModelNames = computed(() => new Set(localModels.value.map(m => m.name)));
const localProvider = computed(() => providerStore.stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER));

// 已安装模型在前面
const sortModes = computed(() => [...allModels.value].sort(a => installedModelNames.value.has(a.model.id) ? -1 : 1));
/** 适配档位 → Tag 颜色 + i18n 文案 key */
const fitMeta: Record<string, { color: string, labelKey: string }> = {
  recommended: { color: "success", labelKey: "pages.preference.provider.labels.fitRecommended" },
  ok: { color: "blue", labelKey: "pages.preference.provider.labels.fitOk" },
  tight: { color: "warning", labelKey: "pages.preference.provider.labels.fitTight" },
  unsupported: { color: "error", labelKey: "pages.preference.provider.labels.fitUnsupported" },
};

// ─── 合并进度：引擎 0-50%，模型 50-100%，永不回退 ─────────────

/**
 * 将 Rust 侧的两个独立阶段 (engine 0-100%, model 0-100%)
 * 合并为前端展示的单一进度条 (0-100%)，确保刷新后不会跳动。
 *
 *   引擎阶段:  raw 0-100%  →  display 0-50%
 *   模型阶段:  raw 0-100%  →  display 50-100%
 */
function computeDisplayProgress(raw: number, phase: string): number {
  if (phase === "model") {
    return 50 + (raw / 100) * 50;
  }
  // engine 阶段 (或未知阶段也按 engine 处理)
  return (raw / 100) * 50;
}

/** 展示用的进度 (0-100)，只增不减 */
const displayProgress = computed(() => {
  return computeDisplayProgress(downloadProgress.value, downloadPhase.value);
});

// ─── localStorage 持久化 ──────────────────────────────────────────

function saveDownloadState() {
  const state: PersistedDownloadState = {
    step: step.value,
    rawProgress: downloadProgress.value,
    displayProgress: displayProgress.value,
    status: downloadStatusText.value,
    phase: downloadPhase.value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearDownloadState() {
  localStorage.removeItem(STORAGE_KEY);
}

function loadPersistedState(): PersistedDownloadState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedDownloadState;
  } catch {
    return null;
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────

// function formatSize(bytes: number): string {
//   if (bytes === 0) return "0 B";
//   const k = 1024;
//   const sizes = ["B", "KB", "MB", "GB", "TB"];
//   const i = Math.floor(Math.log(bytes) / Math.log(k));
//   return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
// }

async function copyHost() {
  try {
    await navigator.clipboard.writeText(OLLAMA_HOST);
    messageApi.success(t("pages.preference.provider.messages.copied"));
  } catch {
    messageApi.error(t("pages.preference.provider.messages.copyFailed"));
  }
}

async function fetchLocalModels(): Promise<boolean> {
  try {
    const models = await invoke<LocalModel[]>("list_local_models");
    localModels.value = models;
    return models.length > 0;
  } catch (err) {
    console.warn("暂未检测到已运行的模型服务:", err);
    localModels.value = [];
    return false;
  }
}

// ─── 事件监听 ──────────────────────────────────────────────────────

let unlistenFn: UnlistenFn | null = null;
let cleanupUnlistenFn: UnlistenFn | null = null;

async function startProgressListener() {
  if (unlistenFn) return;

  unlistenFn = await listen<DownloadPayload>("download-progress", (event) => {
    const payload = event.payload;
    downloadProgress.value = payload.progress;
    downloadStatusText.value = translateStatus(payload.status);

    // 首次收到事件时记录阶段（避免 phase 为空导致进度计算错误）
    if (payload.phase && payload.phase !== downloadPhase.value) {
      downloadPhase.value = payload.phase;
    }

    // 实时持久化到 localStorage
    saveDownloadState();
  });
}

function stopProgressListener() {
  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
  }
}

// ─── 生命周期 ──────────────────────────────────────────────────────

onMounted(async () => {
  // 拖拽导入：监听系统拖入的文件，落在拖拽区内时触发导入
  const appWindow = getCurrentWebviewWindow();
  appWindow.onDragDropEvent(({ payload }) => {
    const { type } = payload;
    if (type === "over") {
      const { x, y } = payload.position;
      if (dropRef.value) {
        const { left, right, top, bottom } = dropRef.value.getBoundingClientRect();
        isDragging.value = x >= left && x <= right && y >= top && y <= bottom;
      }
    } else if (type === "drop" && isDragging.value) {
      isDragging.value = false;
      const file = payload.paths[0];
      if (file) importEngineFile(file);
    } else {
      isDragging.value = false;
    }
  });

  try {
    const report = await invoke<HardwareReport>("check_hardware");
    hardwareInfo.value = report;

    // 回填选中模型：优先硬件推荐项，否则取首个可安装项
    selectedModelId.value = report.recommend_model
      || installable.value[0]?.model.id
      || "";

    if (report.status === "Low" || report.total_memory_gb < 4) {
      step.value = "unsupported";
      clearDownloadState();
      return;
    }
    loadPanelUrl();
    // ★ 刷新恢复：检查是否有正在进行的下载
    const isActive = await invoke<boolean>("is_downloading").catch(() => false);

    if (isActive) {
      // Rust 侧有下载正在进行 → 恢复 downloading 状态
      const saved = loadPersistedState();
      if (saved && saved.step === "downloading") {
        step.value = "downloading";
        downloadProgress.value = saved.rawProgress;
        downloadPhase.value = saved.phase || "engine";
        downloadStatusText.value = saved.status;
      } else {
        step.value = "downloading";
        // 无持久化数据时，从 0 开始
        downloadProgress.value = 0;
        downloadPhase.value = "engine";
      }
      // 重新绑定进度监听
      await startProgressListener();
      return;
    }

    // 检查持久化状态（可能刚完成）
    const saved = loadPersistedState();
    if (saved && saved.step === "downloading") {
      const hasModels = await fetchLocalModels();
      if (hasModels) {
        step.value = "completed";
        clearDownloadState();
      } else {
        step.value = "ready";
        clearDownloadState();
      }
      return;
    }

    // ★ 启动时自动拉起 Ollama + 拉模型列表（引擎启动 = 供应商启用）
    try {
      const status = await invoke<{ installed: boolean, running: boolean, models: LocalModel[], truncated: boolean }>("ensure_local_provider");
      if (status.installed && status.running && status.models.length > 0) {
        localModels.value = status.models;
        updateLocalProvider(status.models); // 自动创建本地供应商
        step.value = "completed";
      } else if (status.installed && status.running) {
        // 引擎就绪但还没装模型
        step.value = "completed"; // 也进入 completed 态，让用户选模型安装
        localModels.value = [];
        updateLocalProvider([]);
      } else {
        // 未安装或引擎起不来
        step.value = "ready";
      }
      clearDownloadState();
    } catch (e) {
      console.warn("ensure_local_provider 失败，降级手动检测:", e);
      const hasModels = await fetchLocalModels();
      if (hasModels) {
        updateLocalProvider(localModels.value);
        step.value = "completed";
      } else {
        step.value = "ready";
      }
      clearDownloadState();
    }
  } catch (err) {
    message(t("pages.preference.provider.messages.hardwareCheckFailed"));
    console.error(err);
  }
});

onUnmounted(() => {
  stopProgressListener();
  if (cleanupUnlistenFn) {
    cleanupUnlistenFn();
    cleanupUnlistenFn = null;
  }
});

// ─── 下载流程 ──────────────────────────────────────────────────────

async function handleInit(modelName?: string): Promise<void> {
  // 优先用传入的模型名，其次用用户选中的，最后用硬件推荐
  const targetModel = modelName
    || selectedModelId.value
    || hardwareInfo.value.recommend_model
    || "qwen2.5:1.5b";
  step.value = "downloading";
  downloadProgress.value = 0;
  downloadPhase.value = "engine";
  downloadStatusText.value = t("pages.preference.provider.status.preparingInit");
  isPaused.value = false;
  saveDownloadState();

  try {
    await startProgressListener();

    // 1. 拉起引擎
    downloadStatusText.value = t("pages.preference.provider.status.pullingEngine");
    await invoke<void>("start_ollama_engine", { web_base: WEB_BASE });

    // 2. 下载模型
    await invoke<void>("download_model", { model_name: targetModel });

    // 3. 验证
    downloadStatusText.value = t("pages.preference.provider.status.verifyingModel");
    saveDownloadState();

    const hasModels = await fetchLocalModels();

    if (hasModels) {
      updateLocalProvider(localModels.value); // ★ 引擎就绪 → 自动同步本地供应商
      messageApi.success(t("pages.preference.provider.messages.deploySuccess"));
      step.value = "completed";
      clearDownloadState();
    } else {
      messageApi.error(t("pages.preference.provider.messages.modelLoadError"));
      step.value = "ready";
      clearDownloadState();
    }
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("已被用户取消") || errMsg.includes("cancelled")) {
      messageApi.info(t("pages.preference.provider.messages.downloadCancelled"));
    } else {
      message(t("pages.preference.provider.messages.initFailed", { err }));
      const panel = await loadPanelUrl();
      if (panel) showPanelFallback(panel);
    }
    step.value = "ready";
    isPaused.value = false;
    clearDownloadState();
  } finally {
    stopProgressListener();
  }
}

// ★ 暂停下载
async function handlePause() {
  try {
    await invoke<void>("pause_download");
    isPaused.value = true;
    messageApi.info(t("pages.preference.provider.messages.downloadPaused"));
    saveDownloadState();
  } catch (err) {
    console.error("暂停失败:", err);
  }
}

// ★ 继续下载
async function handleResume() {
  try {
    await invoke<void>("resume_download");
    isPaused.value = false;
    messageApi.info(t("pages.preference.provider.messages.resuming"));
    saveDownloadState();
  } catch (err) {
    console.error("继续下载失败:", err);
  }
}

// ★ 取消下载（Rust 侧会清理临时文件）
async function handleCancel() {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.cancelDownloadTitle"),
    content: t("pages.preference.provider.dialogs.cancelDownloadContent"),
    okText: t("pages.preference.provider.dialogs.confirmCancel"),
    okType: "danger",
    cancelText: t("pages.preference.provider.dialogs.continueDownload"),
    onOk: async () => {
      try {
        // 如果暂停中，先恢复再取消（避免死锁）
        if (isPaused.value) {
          await invoke<void>("resume_download");
        }
        await invoke<void>("cancel_download");
        messageApi.info(t("pages.preference.provider.messages.downloadCancelled"));
        step.value = "ready";
        isPaused.value = false;
        clearDownloadState();
      } catch (err) {
        console.error("取消下载失败:", err);
        // 即使出错也重置状态
        step.value = "ready";
        isPaused.value = false;
        clearDownloadState();
      }
    },
    onCancel: () => {
      // 用户点了"继续下载"，不做任何操作
    },
  });
}

// ─── 使用本地大模型 ────────────────────────────────────────────

// handleUseLocalModel 已废弃：引擎启动 = 供应商自动启用，无需手动"使用"

// ─── 拖拽导入 Ollama 引擎安装包 ──────────────────────────────────

/** 拉取后台配置的网盘兜底地址（下载失败时引导用户前往下载后拖拽导入），结果缓存 */
async function loadPanelUrl(): Promise<string> {
  if (panelUrl.value) return panelUrl.value;
  try {
    const res = await tauriFetch(`${WEB_BASE}/api/ollama/config`, { method: "GET" });
    if (!res.ok) return "";
    const data = await res.json() as { panelUrl?: string };
    panelUrl.value = (data.panelUrl || "").trim();
    return panelUrl.value;
  } catch {
    return "";
  }
}

/** 下载失败时弹出网盘兜底提示，用户可前往网盘下载后拖拽导入 */
function showPanelFallback(panel: string) {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.downloadFailedTitle"),
    content: t("pages.preference.provider.dialogs.downloadFailedContent"),
    okText: t("pages.preference.provider.dialogs.openPanel"),
    cancelText: t("pages.preference.provider.dialogs.later"),
    onOk: () => openUrl(panel),
  });
}

/** 点击拖拽区，通过系统文件选择器选取安装包（zip/tgz/tar.gz），随后走同一导入流程 */
async function selectEngineFile() {
  if (importing.value) return;
  const selected = await open({
    multiple: false,
    filters: [{ name: "Ollama 安装包", extensions: ["zip", "tgz", "tar.gz"] }],
  });
  if (!selected) return;
  const filePath = Array.isArray(selected) ? selected[0] : selected;
  if (filePath) await importEngineFile(filePath);
}

/** 将拖入的安装包（zip/tgz/裸二进制）导入到沙箱 engine 目录，随后可直接一键部署 */
async function importEngineFile(filePath: string) {
  if (importing.value) return;
  importing.value = true;
  try {
    await invoke<void>("import_engine_file", { file_path: filePath });
    messageApi.success(t("pages.preference.provider.messages.importEngineSuccess"));
    // 导入成功后重新检测：若已有模型则进入完成态，否则回到就绪态
    const hasModels = await fetchLocalModels();
    if (hasModels) {
      step.value = "completed";
      clearDownloadState();
    } else {
      step.value = "ready";
      clearDownloadState();
    }
  } catch (err) {
    messageApi.error(t("pages.preference.provider.messages.importEngineFailed", { err: String(err) }));
  } finally {
    importing.value = false;
  }
}

// ─── 清理 / 停止 ──────────────────────────────────────────────────

function cleanupModels() {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.cleanupTitle"),
    content: t("pages.preference.provider.dialogs.cleanupContent"),
    okText: t("pages.preference.provider.dialogs.confirmCleanup"),
    okType: "danger",
    cancelText: t("pages.preference.provider.dialogs.thinkAgain"),
    onOk: async () => {
      isCleaning.value = true;
      try {
        cleanupUnlistenFn = await listen<CleanupPayload>("cleanup-status", (event) => {
          cleanupStatusText.value = translateStatus(event.payload.status);
        });

        await invoke<void>("cleanup_local_models", { model_name: null });

        Modal.success({
          title: t("pages.preference.provider.dialogs.cleanupSuccessTitle"),
          content: t("pages.preference.provider.dialogs.cleanupSuccessContent"),
        });

        localModels.value = [];
        step.value = "ready";
        clearDownloadState();
      } catch (err) {
        message(t("pages.preference.provider.messages.cleanupFailed", { err }));
        console.error(err);
      } finally {
        isCleaning.value = false;
        if (cleanupUnlistenFn) {
          cleanupUnlistenFn();
          cleanupUnlistenFn = null;
        }
      }
    },
  });
}

async function stopModels(): Promise<void> {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.stopTitle"),
    content: t("pages.preference.provider.dialogs.stopContent"),
    okText: t("pages.preference.provider.dialogs.confirmStop"),
    okType: "danger",
    cancelText: t("pages.preference.provider.dialogs.thinkAgain"),
    onOk: async () => {
      isCleaning.value = true;
      try {
        cleanupUnlistenFn = await listen<CleanupPayload>("cleanup-status", (event) => {
          cleanupStatusText.value = translateStatus(event.payload.status);
        });

        await invoke<void>("stop_ollama_engine");

        Modal.success({
          title: t("pages.preference.provider.dialogs.stopSuccessTitle"),
          content: t("pages.preference.provider.dialogs.stopSuccessContent"),
        });

        localModels.value = [];
        step.value = "ready";
        clearDownloadState();
      } catch (err) {
        message(t("pages.preference.provider.messages.stopFailed", { err }));
        console.error(err);
      } finally {
        isCleaning.value = false;
        if (cleanupUnlistenFn) {
          cleanupUnlistenFn();
          cleanupUnlistenFn = null;
        }
      }
    },
  });
}
</script>

<template>
  <ContextHolder />
  <div class="relative h-full w-full overflow-auto rounded-xl bg-elevated">
    <div class="flex flex-col items-center justify-center gap-6">
      <div class="w-full border border-slate-100 rounded-xl px-4">
        <!-- 状态 1：正在检测 -->
        <div
          v-if="step === 'checking'"
          class="flex flex-col items-center justify-center py-6"
        >
          <Spin size="large" />
          <p class="mt-4 text-14px text-slate-500 font-medium">
            {{ t('pages.preference.provider.hints.optimizingEnv') }}
          </p>
        </div>

        <!-- 状态 2：配置过低 -->
        <div
          v-else-if="step === 'unsupported'"
          class="animate-fade-in"
        >
          <Result
            status="error"
            :sub-title="t('pages.preference.provider.hints.memoryLow', { gb: hardwareInfo.total_memory_gb })"
            :title="t('pages.preference.provider.hints.configUnsupported')"
          />
        </div>

        <!-- 状态 3：准备就绪 -->
        <div
          v-else-if="step === 'ready'"
          class="animate-fade-in text-center"
        >
          <div class="text-blue-600 mx-auto h-16 w-16 flex items-center justify-center rounded-full">
            <div class="i-solar:cpu-bolt-bold text-32px" />
          </div>
          <h3 class="mb-2 text-18px text-slate-800 font-bold">
            {{ t('pages.preference.provider.hints.environmentReady') }}
          </h3>
          <!-- 硬件摘要 -->
          <p class="mb-4 text-14px text-slate-500 leading-relaxed">
            {{ t('pages.preference.provider.hints.systemMemory') }}
            <span class="text-blue-600 font-bold">{{ hardwareInfo.total_memory_gb }}GB</span>
            <span v-if="hardwareInfo.cpu_cores"> · {{ t('pages.preference.provider.hints.cpuCores', { n: hardwareInfo.cpu_cores }) }}</span>
            <template v-if="hasGpu">
              <br>
              {{ t('pages.preference.provider.hints.gpuDetected') }}
              <span
                v-for="gpu in hardwareInfo.gpus"
                :key="gpu.name"
                class="text-blue-600 font-bold"
              >{{ gpu.name }} ({{ gpu.vram_mb ? `${Math.round(gpu.vram_mb / 1024)}GB` : '统一内存' }})</span>
            </template>
          </p>

          <Button
            class="w-full rounded-lg"
            :disabled="!selectedModelId"
            size="large"
            type="primary"
            @click="handleInit()"
          >
            {{ t('pages.preference.provider.labels.oneClickAI') }}
          </Button>

          <!-- 拖拽导入引擎安装包（网盘下载后拖入，或点击选择文件） -->
          <div
            ref="dropRef"
            class="mt-4 w-full flex flex-col cursor-pointer items-center justify-center gap-2 b-1 b-dashed py-4 transition-colors rounded-lg"
            :class="isDragging ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-primary'"
            @click="selectEngineFile"
          >
            <div class="i-solar:upload-square-outline text-blue-600 text-24px" />
            <span class="text-13px text-slate-500 font-medium">
              {{ t('pages.preference.provider.hints.dragEngineHint') }}
            </span>
            <span
              v-if="importing"
              class="text-blue-600 flex items-center gap-2 text-12px"
            >
              <Spin size="small" />
              {{ t('pages.preference.provider.hints.importingEngine') }}
            </span>
            <span class="text-11px text-slate-400">
              {{ t('pages.preference.provider.hints.dragEngineFormats') }}
            </span>
          </div>
          <!-- 下载地址 -->
          <div
            v-if="panelUrl"
            class="mt-4 text-center text-12px text-slate-400 font-mono"
          >
            <a
              class="text-blue-600 hover:underline"
              :href="panelUrl"
              target="_blank"
            >
              download link
            </a>
          </div>
        </div>

        <!-- 状态 4：正在下载 / 已暂停 -->
        <div
          v-else-if="step === 'downloading'"
          class="animate-fade-in"
        >
          <div class="mb-1 flex items-center gap-2">
            <h4 class="text-16px text-slate-800 font-bold">
              {{ isPaused ? t('pages.preference.provider.labels.downloadPaused') : t('pages.preference.provider.labels.initializingEngine') }}
            </h4>
            <Tag
              v-if="isPaused"
              color="warning"
            >
              {{ t('pages.preference.provider.labels.paused') }}
            </Tag>
            <Tag
              v-else
              color="processing"
            >
              {{ downloadPhase === 'model' ? t('pages.preference.provider.labels.modelDownloading') : t('pages.preference.provider.labels.engineDownloading') }}
            </Tag>
          </div>
          <p class="mb-6 text-12px text-slate-400 font-mono">
            {{ isPaused ? t('pages.preference.provider.hints.pausedResumeHint') : downloadStatusText }}
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
              {{ t('pages.preference.provider.buttons.resume') }}
            </Button>
            <!-- 下载中状态：显示"暂停下载" -->
            <Button
              v-else
              size="small"
              @click="handlePause"
            >
              {{ t('pages.preference.provider.buttons.pause') }}
            </Button>
            <!-- 取消下载始终显示 -->
            <Button
              danger
              size="small"
              type="link"
              @click="handleCancel"
            >
              {{ t('pages.preference.provider.buttons.cancelDownload') }}
            </Button>
          </div>
        </div>

        <!-- 状态 5：引擎已就绪 → 统一"可使用模型"列表 -->
        <div
          v-else-if="step === 'completed'"
          class="animate-fade-in"
        >
          <!-- 引擎状态条 -->
          <div
            v-if="step === 'completed'"
            class="mb-4 flex items-center gap-2"
          >
            <Tag
              class="px-2 py-1 text-12px"
              color="success"
            >
              🟢 {{ t('pages.preference.provider.labels.running') }}
            </Tag>
            <span class="text-2.5 color-text-quaternary">{{ t('pages.preference.provider.local.hints.engineReadyDesc') }}</span>
          </div>

          <!-- 引擎操作（仅 completed 态显示） -->
          <div
            v-if="step === 'completed'"
            class="flex flex-wrap justify-between gap-2 border-t py-3 b-border-sec"
          >
            <Button
              size="small"
              type="link"
              @click="copyHost"
            >
              {{ t('pages.preference.provider.labels.ollamaBaseUrl') }}
              &nbsp;&nbsp;
              {{ OLLAMA_HOST }}
            </Button>
            <div>
              <Button
                :loading="isCleaning"
                size="small"
                @click="stopModels"
              >
                {{ t('pages.preference.provider.labels.stopRunning') }}
              </Button>
              &nbsp;&nbsp;
              <Button
                danger
                :loading="isCleaning"
                size="small"
                type="primary"
                @click="cleanupModels"
              >
                {{ t('pages.preference.provider.labels.oneClickClean') }}
              </Button>
            </div>
          </div>
          <!-- 可使用模型：统一列表，已安装/未安装混合显示 -->
          <div class="mb-4 text-left">
            <div class="mb-2 flex items-center justify-between text-14px text-slate-800 font-bold">
              <span>{{ t('pages.preference.provider.labels.availableModels') }}</span>
              <span class="text-12px text-slate-400 font-normal">{{ t('pages.preference.provider.hints.selectModelHint') }}</span>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div
                v-for="item in sortModes"
                :key="item.model.id"
                class="relative flex flex-col cursor-pointer gap-2 b-1 rounded-xl b-solid p-3 text-left transition-all"
                :class="[
                  localProvider?.defaultModel === item.model.id ? 'b-blue-400 bg-blue-50/60' : '',
                  item.level === 'unsupported' ? 'opacity-50 cursor-not-allowed b-slate-200' : 'b-slate-200 hover:border-blue-300',
                ]"
              >
                <!-- 头部：名称 + 适配标签 + 已安装标记 -->
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0 flex items-center gap-1.5">
                    <div
                      class="shrink-0 text-16px"
                      :class="item.model.type === 'vision' ? 'i-carbon-view' : 'i-carbon-chat'"
                    />
                    <span class="truncate text-13px text-slate-800 font-bold font-mono">{{ item.model.name }}</span>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <!-- 已安装标记 -->
                    <Tag
                      v-if="installedModelNames.has(item.model.id)"
                      class="!text-4"
                      color="success"
                    >
                      {{ t('pages.preference.provider.local.labels.installed') }}
                    </Tag>
                    <!-- 当前默认 -->
                    <Tag
                      v-if="localProvider?.defaultModel === item.model.id"
                      class="!text-2"
                      color="blue"
                      variant="filled"
                    >
                      {{ t('pages.preference.provider.cloud.labels.current') }}
                    </Tag>
                    <!-- 适配档位 -->
                    <Tag
                      class="!text-2"
                      :color="fitMeta[item.level].color"
                    >
                      {{ t(fitMeta[item.level].labelKey) }}
                    </Tag>
                  </div>
                </div>

                <!-- 描述 -->
                <div class="line-clamp-2 text-2.5 leading-relaxed color-text-tertiary">
                  {{ t(item.model.descKey) }}
                </div>

                <!-- 底部：大小 + 显存 + 标签 -->
                <div class="flex items-center gap-1.5 text-2.5 text-slate-400">
                  <span class="font-mono">{{ item.model.size_gb }}GB</span>
                  <span>·</span>
                  <span v-if="item.model.vram_mb">{{ Math.round(item.model.vram_mb / 1024) }}GB {{ t('pages.preference.provider.labels.vram') }}</span>
                  <span v-else>CPU</span>
                  <div class="flex-1" />
                  <Tag
                    v-for="tag in item.model.tags"
                    :key="tag"
                    class="!text-2"
                  >
                    {{ tag }}
                  </Tag>
                </div>

                <!-- 操作区：已安装 vs 未安装 -->
                <div
                  v-if="installedModelNames.has(item.model.id)"
                  class="flex items-center gap-1 pt-1"
                  @click.stop
                >
                  <Button
                    danger
                    :loading="isCleaning"
                    size="small"
                    @click="uninstallLocalModel(item.model.id)"
                  >
                    {{ t('pages.preference.provider.cloud.labels.uninstall') }}
                  </Button>
                  <!-- 已安装：复制 / 设为默认 / 停用 -->
                  <div class="flex-1" />
                  <Button
                    v-if="localProvider?.defaultModel !== item.model.id"
                    size="small"
                    type="link"
                    @click="setLocalDefault(item.model.id)"
                  >
                    {{ t('pages.preference.provider.cloud.labels.setDefault') }}
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    @click="writeText(item.model.id)"
                  >
                    {{ t('pages.preference.provider.labels.copy') }}
                  </Button>
                </div>
                <div
                  v-else
                  class="flex items-center gap-1 pt-1"
                  @click.stop
                >
                  <!-- 未安装：安装按钮 -->
                  <div class="flex-1" />
                  <Button
                    v-if="item.level !== 'unsupported'"

                    size="small"
                    type="primary"
                    @click="handleInit(item.model.id)"
                  >
                    {{ t('pages.preference.provider.labels.install') }}
                  </Button>
                  <Tooltip
                    v-else
                    :title="t(item.reasonKey || '')"
                  >
                    <div class="i-carbon-close text-12px text-slate-400" />
                  </Tooltip>
                </div>

                <!-- 不支持原因 tooltip -->
                <Tooltip
                  v-if="item.reasonKey"
                  class="absolute right-2 top-2"
                  :title="t(item.reasonKey)"
                >
                  <div class="i-carbon-warning text-12px text-slate-400" />
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
