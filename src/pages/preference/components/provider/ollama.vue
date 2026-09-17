<script setup lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message as dialogMessage, open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { message as AntdMessage, Button, Modal, Popconfirm, Progress, Result, Spin, Tag } from "antdv-next";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useHardwareModels } from "@/composables/useHardwareModels";
import { isSameModel, normalizeModelId, OLLAMA_HOST, useOllamaEngine } from "@/composables/useOllamaEngine";
import { WEB_BASE } from "@/config";

import LocalModelCard from "./components/local-model-card.vue";

const { t } = useI18n();
const engine = useOllamaEngine();

// ─── 本地引擎状态（引擎生命周期独立于模型下载） ────────────────────
const {
  hardware,
  engineStatus,
  engineProgress,
  engineMessage,
  engineError,
  enginePaused,
  installedModelNames,
  installJobs,
  defaultModel,
  modelDir,
  apiKey,
} = engine;

/** 卡片进度兜底状态（未开始时） */
const IDLE_JOB = { status: "idle", progress: 0, message: "" } as const;

const { allModels, installable, hasGpu } = useHardwareModels(hardware);

/**
 * 视图状态：只由引擎状态驱动。
 * 模型下载不再影响页面级视图（进度显示在各模型卡片内）。
 */
const step = computed(() => {
  switch (engineStatus.value) {
    case "unsupported": return "unsupported";
    case "ready": return "ready";
    case "starting": return "downloading";
    case "error": return "error";
    case "absent": return "ready-to-install";
    default: return "checking";
  }
});

/** 已安装模型排前面（规范化比较，`moondream` 与 `moondream:latest` 视为同一个） */
const sortedModels = computed(() =>
  [...allModels.value].sort(a => engine.installedModelNames.value.has(normalizeModelId(a.model.id)) ? -1 : 1),
);

/** 一键开启时优先安装的模型：硬件推荐 → 首个可安装 */
const recommendedModelId = computed(() =>
  hardware.value.recommend_model || installable.value[0]?.model.id || "",
);

const [messageApi, ContextHolder] = AntdMessage.useMessage();

// 拖拽导入 Ollama 引擎安装包（网盘下载后拖入）
const dropRef = ref<HTMLElement | null>(null);
const isDragging = ref<boolean>(false);
const importing = ref<boolean>(false);
// 后台配置的网盘兜底地址（下载失败时引导用户前往下载后拖拽导入）
const panelUrl = ref<string>("");

// 清理 / 停止过程中的状态文案
const isCleaning = ref<boolean>(false);
const cleanupStatusText = ref<string>("");
let cleanupUnlistenFn: UnlistenFn | null = null;

// ─── 模型安装（进度落在各自卡片内） ─────────────────────────────────

function notifyError(err: unknown) {
  const errMsg = String(err);
  if (errMsg.includes("已被用户取消") || errMsg.includes("cancelled")) {
    messageApi.info(t("pages.preference.provider.messages.downloadCancelled"));
    return;
  }
  dialogMessage(t("pages.preference.provider.messages.initFailed", { err: errMsg }));
  // 引擎权威错（组件下载失败等）→ 引导网盘兜底
  if (errMsg.includes("引擎") || errMsg.includes("AI核心组件") || errMsg.includes("下载直链")) {
    loadPanelUrl().then(p => p && showPanelFallback(p));
  }
}

async function handleInstall(modelId: string) {
  try {
    await engine.installModel(modelId);
    messageApi.success(t("pages.preference.provider.messages.modelInstalled"));
  } catch (err) {
    notifyError(err);
  }
}

/** 一键开启：启动引擎并安装推荐模型（两步分离，各自有独立进度） */
async function handleOneClick() {
  const target = recommendedModelId.value;
  if (!target) return;
  await handleInstall(target);
}

async function handlePause(modelId: string) {
  try {
    await engine.pauseInstall(modelId);
  } catch (err) {
    console.error("暂停失败:", err);
  }
}

async function handleResume(modelId: string) {
  try {
    await engine.resumeInstall(modelId);
  } catch (err) {
    console.error("继续下载失败:", err);
  }
}

async function handleCancel(modelId: string) {
  try {
    await engine.cancelInstall(modelId);
  } catch (err) {
    console.error("取消下载失败:", err);
  }
}

async function handleUninstall(modelId: string) {
  try {
    await engine.uninstallModel(modelId);
    messageApi.success(t("pages.preference.provider.messages.modelRemoved"));
  } catch (err) {
    console.error("[ollama] 卸载本地模型失败:", err);
    messageApi.error(t("pages.preference.provider.messages.modelRemoveFailed"));
  }
}

function handleSetDefault(modelId: string) {
  engine.setDefaultModel(modelId);
}

async function copyModelId(modelId: string) {
  await writeText(modelId);
  messageApi.success(t("pages.preference.provider.messages.copied"));
}

// ─── 引擎操作 ──────────────────────────────────────────────────────

async function handleStartEngine() {
  try {
    await engine.startEngine();
  } catch (err) {
    notifyError(err);
  }
}

async function copyHost() {
  try {
    await writeText(OLLAMA_HOST);
    messageApi.success(t("pages.preference.provider.messages.copied"));
  } catch {
    messageApi.error(t("pages.preference.provider.messages.copyFailed"));
  }
}

/** 复制引擎实际使用的模型目录（便于用户核对模型到底装在哪） */
async function copyModelDir() {
  if (!modelDir.value) return;
  try {
    await writeText(modelDir.value);
    messageApi.success(t("pages.preference.provider.messages.copied"));
  } catch {
    messageApi.error(t("pages.preference.provider.messages.copyFailed"));
  }
}

// ─── 本地网关 apiKey ───────────────────────────────────────────────

/** 复制 apiKey：用户拿它去配置自备客户端访问本地模型 */
async function copyApiKey() {
  if (!apiKey.value) return;
  try {
    await writeText(apiKey.value);
    messageApi.success(t("pages.preference.provider.messages.copied"));
  } catch {
    messageApi.error(t("pages.preference.provider.messages.copyFailed"));
  }
}

/** 重置 apiKey：旧 key 立即失效 */
async function handleRegenerateKey() {
  try {
    await engine.regenerateApiKey();
    messageApi.success(t("pages.preference.provider.messages.keyRegenerated"));
  } catch (err) {
    messageApi.error(
      t("pages.preference.provider.messages.keyRegenerateFailed", { err: String(err) }),
    );
  }
}

// ★ 暂停 / 继续 / 取消引擎组件下载
async function handleEnginePause() {
  try {
    await engine.pauseEngine();
    messageApi.info(t("pages.preference.provider.messages.downloadPaused"));
  } catch (err) {
    console.error("暂停失败:", err);
  }
}

async function handleEngineResume() {
  try {
    await engine.resumeEngine();
    messageApi.info(t("pages.preference.provider.messages.resuming"));
  } catch (err) {
    console.error("继续下载失败:", err);
  }
}

function handleEngineCancel() {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.cancelDownloadTitle"),
    content: t("pages.preference.provider.dialogs.cancelDownloadContent"),
    okText: t("pages.preference.provider.dialogs.confirmCancel"),
    okType: "danger",
    cancelText: t("pages.preference.provider.dialogs.continueDownload"),
    onOk: async () => {
      try {
        await engine.cancelEngine();
        messageApi.info(t("pages.preference.provider.messages.downloadCancelled"));
      } catch (err) {
        console.error("取消下载失败:", err);
      }
    },
    onCancel: () => {
      // 用户点了"继续下载"，不做任何操作
    },
  });
}

function stopModels() {
  Modal.confirm({
    title: t("pages.preference.provider.dialogs.stopTitle"),
    content: t("pages.preference.provider.dialogs.stopContent"),
    okText: t("pages.preference.provider.dialogs.confirmStop"),
    okType: "danger",
    cancelText: t("pages.preference.provider.dialogs.thinkAgain"),
    onOk: async () => {
      isCleaning.value = true;
      try {
        await engine.stopEngine();
        Modal.success({
          title: t("pages.preference.provider.dialogs.stopSuccessTitle"),
          content: t("pages.preference.provider.dialogs.stopSuccessContent"),
        });
      } catch (err) {
        dialogMessage(t("pages.preference.provider.messages.stopFailed", { err }));
        console.error(err);
      } finally {
        isCleaning.value = false;
      }
    },
  });
}

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
        cleanupUnlistenFn = await listenCleanupStatus();
        await engine.cleanupAll();
        Modal.success({
          title: t("pages.preference.provider.dialogs.cleanupSuccessTitle"),
          content: t("pages.preference.provider.dialogs.cleanupSuccessContent"),
        });
      } catch (err) {
        dialogMessage(t("pages.preference.provider.messages.cleanupFailed", { err }));
        console.error(err);
      } finally {
        isCleaning.value = false;
        cleanupStatusText.value = "";
        if (cleanupUnlistenFn) {
          cleanupUnlistenFn();
          cleanupUnlistenFn = null;
        }
      }
    },
  });
}

/** 监听 Rust 侧清理/停止过程的状态推送 */
async function listenCleanupStatus(): Promise<UnlistenFn> {
  return listen<{ success: boolean, status: string }>("cleanup-status", (event) => {
    cleanupStatusText.value = translateCleanupStatus(event.payload.status);
  });
}

function translateCleanupStatus(status: string): string {
  if (!status) return "";
  const trimmed = status.trim();
  const UNINSTALL_PREFIX = "正在从本地仓库卸载模型:";
  if (trimmed.startsWith(UNINSTALL_PREFIX) && trimmed.endsWith("...")) {
    return t("pages.preference.provider.status.uninstallingModel", {
      name: trimmed.slice(UNINSTALL_PREFIX.length, -3).trim(),
    });
  }
  const map: Record<string, string> = {
    "正在安全关闭本地 AI 引擎...": "stoppingEngine",
    "正在全量物理粉碎 AI 内核、显卡驱动及模型数据...": "shreddingData",
    "1.8GB 本地 AI 组件及模型已全部彻底移除，空间已完美释放！": "cleanupComplete",
  };
  const key = map[trimmed];
  return key ? t(`pages.preference.provider.status.${key}`) : trimmed;
}

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
    await engine.refreshModels();
    engine.syncProvider();
  } catch (err) {
    messageApi.error(t("pages.preference.provider.messages.importEngineFailed", { err: String(err) }));
  } finally {
    importing.value = false;
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

  // 幂等：应用启动时已检测过则直接复用结果，不会重复拉起引擎
  await engine.ensureEngine();
  loadPanelUrl();
});

onUnmounted(() => {
  if (cleanupUnlistenFn) {
    cleanupUnlistenFn();
    cleanupUnlistenFn = null;
  }
});
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
            :sub-title="t('pages.preference.provider.hints.memoryLow', { gb: hardware.total_memory_gb })"
            :title="t('pages.preference.provider.hints.configUnsupported')"
          />
        </div>

        <!-- 状态 3：引擎启动失败 -->
        <div
          v-else-if="step === 'error'"
          class="animate-fade-in py-6 text-center"
        >
          <div class="mx-auto h-16 w-16 flex items-center justify-center rounded-full text-amber-500">
            <div class="i-solar:danger-triangle-bold text-32px" />
          </div>
          <h3 class="mb-2 mt-2 text-18px text-slate-800 font-bold">
            {{ t('pages.preference.provider.local.labels.engineError') }}
          </h3>
          <p class="line-clamp-3 mb-4 break-all text-12px text-slate-400">
            {{ engineError || t('pages.preference.provider.local.errors.engineStartFailed') }}
          </p>
          <Button
            class="w-full rounded-lg"
            size="large"
            type="primary"
            @click="handleStartEngine"
          >
            {{ t('pages.preference.provider.labels.retry') }}
          </Button>
        </div>

        <!-- 状态 4：引擎尚未安装 → 一键开启 -->
        <div
          v-else-if="step === 'ready-to-install'"
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
            <span class="text-blue-600 font-bold">{{ hardware.total_memory_gb }}GB</span>
            <span v-if="hardware.cpu_cores"> · {{ t('pages.preference.provider.hints.cpuCores', { n: hardware.cpu_cores }) }}</span>
            <template v-if="hasGpu">
              <br>
              {{ t('pages.preference.provider.hints.gpuDetected') }}
              <span
                v-for="gpu in hardware.gpus"
                :key="gpu.name"
                class="text-blue-600 font-bold"
              >{{ gpu.name }} ({{ gpu.vram_mb ? `${Math.round(gpu.vram_mb / 1024)}GB` : '统一内存' }})</span>
            </template>
          </p>

          <p class="mb-4 text-12px color-text-quaternary">
            {{ t('pages.preference.provider.local.hints.engineAbsentDesc') }}
          </p>

          <Button
            class="w-full rounded-lg"
            :disabled="!recommendedModelId"
            size="large"
            type="primary"
            @click="handleOneClick"
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

        <!-- 状态 5：引擎组件下载 / 拉起中（仅引擎进度，与模型下载解耦） -->
        <div
          v-else-if="step === 'downloading'"
          class="animate-fade-in"
        >
          <div class="mb-1 flex items-center gap-2">
            <h4 class="text-16px text-slate-800 font-bold">
              {{ enginePaused
                ? t('pages.preference.provider.labels.downloadPaused')
                : t('pages.preference.provider.labels.initializingEngine') }}
            </h4>
            <Tag
              v-if="enginePaused"
              color="warning"
            >
              {{ t('pages.preference.provider.labels.paused') }}
            </Tag>
            <Tag
              v-else
              color="processing"
            >
              {{ t('pages.preference.provider.labels.engineDownloading') }}
            </Tag>
          </div>
          <p class="mb-6 text-12px text-slate-400 font-mono">
            {{ enginePaused ? t('pages.preference.provider.hints.pausedResumeHint') : engineMessage }}
          </p>

          <Progress
            :percent="Math.round(engineProgress)"
            :status="enginePaused ? 'normal' : 'active'"
            :stroke-color="{ '0%': '#108ee9', '100%': '#87d068' }"
          />

          <!-- 引擎组件下载操作 -->
          <div class="mt-4 flex items-center justify-center gap-3">
            <Button
              v-if="enginePaused"
              size="small"
              type="primary"
              @click="handleEngineResume"
            >
              {{ t('pages.preference.provider.buttons.resume') }}
            </Button>
            <Button
              v-else
              size="small"
              @click="handleEnginePause"
            >
              {{ t('pages.preference.provider.buttons.pause') }}
            </Button>
            <Button
              danger
              size="small"
              type="link"
              @click="handleEngineCancel"
            >
              {{ t('pages.preference.provider.buttons.cancelDownload') }}
            </Button>
          </div>
        </div>

        <!-- 状态 6：引擎已就绪 → 模型列表（进度落在每张卡片内） -->
        <div
          v-else-if="step === 'ready'"
          class="animate-fade-in"
        >
          <!-- 引擎状态条 -->
          <div class="mb-4 flex items-center gap-2">
            <Tag
              class="px-2 py-1 text-12px"
              color="success"
            >
              🟢 {{ t('pages.preference.provider.labels.running') }}
            </Tag>
            <span class="text-2.5 color-text-quaternary">{{ t('pages.preference.provider.local.hints.engineReadyDesc') }}</span>
          </div>

          <!-- 引擎操作 -->
          <div class="flex flex-wrap justify-between gap-2 border-t py-3 b-border-sec">
            <div class="min-w-0 flex flex-1 flex-col items-start">
              <Button
                size="small"
                type="link"
                @click="copyHost"
              >
                {{ t('pages.preference.provider.labels.ollamaBaseUrl') }}
                &nbsp;&nbsp;
                {{ OLLAMA_HOST }}
              </Button>
              <!-- 模型目录：让"装到哪去了 / 为什么显示未安装"这类问题可以直接核对 -->
              <Button
                v-if="modelDir"
                class="max-w-full"
                size="small"
                type="link"
                @click="copyModelDir"
              >
                <span class="truncate">
                  {{ t('pages.preference.provider.labels.modelDir') }}
                  &nbsp;&nbsp;
                  {{ modelDir }}
                </span>
              </Button>
              <span
                v-if="modelDir"
                class="pl-2 text-11px color-text-quaternary"
              >
                {{ t('pages.preference.provider.local.hints.modelDirHint') }}
              </span>

              <!-- 网关 apiKey：客户端访问本地模型必须携带，否则 401 -->
              <div class="mt-2 max-w-full flex flex-col gap-1 b-1 b-dashed px-2 py-1.5 b-border-sec rounded-lg">
                <div class="flex items-center gap-2">
                  <span class="shrink-0 text-11px color-text-tertiary">
                    {{ t('pages.preference.provider.labels.localApiKey') }}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-11px font-mono color-text-secondary">
                    {{ apiKey || '—' }}
                  </span>
                  <Button
                    size="small"
                    type="link"
                    @click="copyApiKey"
                  >
                    {{ t('pages.preference.provider.labels.copy') }}
                  </Button>
                  <Popconfirm
                    :description="t('pages.preference.provider.dialogs.regenerateKeyContent')"
                    placement="topRight"
                    :title="t('pages.preference.provider.dialogs.regenerateKeyTitle')"
                    @confirm="handleRegenerateKey"
                  >
                    <Button
                      danger
                      size="small"
                      type="link"
                    >
                      {{ t('pages.preference.provider.labels.regenerateKey') }}
                    </Button>
                  </Popconfirm>
                </div>
                <span class="text-11px color-text-quaternary">
                  {{ t('pages.preference.provider.local.hints.localApiKeyHint') }}
                </span>
              </div>
            </div>
            <div class="w-full flex items-center justify-end gap-2">
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
          <p
            v-if="isCleaning && cleanupStatusText"
            class="mb-2 text-12px text-slate-400 font-mono"
          >
            {{ cleanupStatusText }}
          </p>

          <!-- 可选模型：统一列表，已安装/未安装混合显示，各自独立进度 -->
          <div class="mb-4 text-left">
            <div class="mb-2 flex items-center justify-between text-14px text-slate-800 font-bold">
              <span>{{ t('pages.preference.provider.labels.availableModels') }}</span>
              <span class="text-12px text-slate-400 font-normal">{{ t('pages.preference.provider.hints.selectModelHint') }}</span>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <LocalModelCard
                v-for="item in sortedModels"
                :key="item.model.id"
                :installed="installedModelNames.has(normalizeModelId(item.model.id))"
                :is-default="isSameModel(defaultModel, item.model.id)"
                :item="item"
                :job="installJobs[item.model.id] ?? IDLE_JOB"
                @cancel="handleCancel"
                @copy="copyModelId"
                @install="handleInstall"
                @pause="handlePause"
                @resume="handleResume"
                @set-default="handleSetDefault"
                @uninstall="handleUninstall"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
