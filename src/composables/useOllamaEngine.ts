import type { UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { computed, ref } from "vue";

import type { DownloadPayload, HardwareReport } from "@/stores/shard/app-shard";
import type { AIProvider, AiProviderModels, ModelCapability } from "@/stores/shard/provider-shard";

import { WEB_BASE } from "@/config";
import { LOCAL_MODEL_CATALOG } from "@/constants/local-models";
import { i18n } from "@/locales";
import { useProviderStore } from "@/stores/aiprovider";

/**
 * 本地 Ollama 引擎 & 模型安装的全局单例状态。
 *
 * 设计要点（与旧实现的关键差异）：
 *   1. **引擎生命周期与模型下载彻底解耦**
 *      - 引擎：开机自动拉起（`ensureEngine`），进度事件 `phase === "engine"`
 *      - 模型：用户在卡片上按需安装，进度事件 `phase === "model"` 且带 `model` 字段
 *   2. **进度按模型名路由**，因此每张模型卡片可以各自显示自己的安装进度
 *   3. 模块级单例，设置页与主窗口共享同一份状态，多次挂载不会重复监听
 */

/** 本地大模型供应商标识（数据库主键，不可按语言翻译） */
export const LOCAL_MODEL_PROVIDER = "本地大模型";
const LOCAL_MODEL_VALUE = "local-ollama";
/**
 * 本地模型网关地址（Rust 侧鉴权网关监听此处，校验 apiKey 后再转发给引擎）。
 * 注意 11435 是网关端口，真正的 Ollama 引擎在 11436，不对客户端暴露。
 */
export const OLLAMA_GATEWAY = "http://127.0.0.1:11435";
/**
 * 对话补全端点 —— 必须写**完整端点**，不能只写到 `/v1`。
 *
 * 本项目 `provider.baseUrl` 的约定就是"可直接 POST 的完整地址"（见 `constants/provider.ts`，
 * 其它供应商同样带 `/chat/completions`），`useTauriAIChat` 会把它**原样**作为请求 URL
 * 发出去。之前这里只写到 `/v1`，请求就打到了 Ollama 并不存在的路由上，
 * 表现为界面报 `404 page not found`（那句纯文本 404 正是 Ollama 的默认返回）。
 */
export const OLLAMA_BASE_URL = `${OLLAMA_GATEWAY}/v1/chat/completions`;
/** UI 上展示、复制的地址，与 baseUrl 保持一致，用户可以直接贴到其它客户端使用 */
export const OLLAMA_HOST = OLLAMA_BASE_URL;

/** 引擎组件下载任务的保留键（与 Rust 端 ENGINE_JOB_KEY 一致） */
export const ENGINE_JOB_KEY = "__engine__";

/**
 * 把模型名规范化成 Ollama 的完整写法。
 *
 * Ollama 里 `moondream` 与 `moondream:latest` 是同一个模型：请求时两种写法都合法，
 * 但 `GET /api/tags` 只会返回带 tag 的规范名。因此**任何名称比较都必须先规范化**，
 * 否则会出现"已经装好了却显示未安装"或"点了安装立刻提示成功、但卡片状态没变"。
 */
export function normalizeModelId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (!trimmed) return "";
  return trimmed.includes(":") ? trimmed : `${trimmed}:latest`;
}

/** 两个模型名是否指向同一个模型（忽略 `:latest` 差异） */
export function isSameModel(a: string, b: string): boolean {
  return normalizeModelId(a) === normalizeModelId(b);
}

export interface LocalModel {
  name: string
  size: number
}

/** 引擎整体状态 */
export type EngineStatus
  = | "idle" // 尚未检测
    | "checking" // 正在检测硬件/引擎
    | "unsupported" // 硬件不满足
    | "absent" // 未安装引擎组件
    | "starting" // 正在下载/拉起引擎
    | "ready" // 引擎运行中
    | "error"; // 启动失败

/** 单个模型的安装状态 */
export type ModelInstallStatus
  = | "idle"
    | "installing"
    | "paused"
    | "done"
    | "error";

export interface ModelInstallState {
  status: ModelInstallStatus
  /** 0-100 */
  progress: number
  /** 当前阶段文案（已翻译） */
  message: string
  /** 失败原因 */
  error?: string
}

interface LocalProviderStatus {
  installed: boolean
  running: boolean
  models: LocalModel[]
  truncated: boolean
  /** 引擎实际使用的模型仓库绝对路径 */
  model_dir: string
  /** 鉴权网关是否已就绪（未就绪则模型无法通过 11435 访问） */
  gateway_ready: boolean
}

function t(key: string, params?: Record<string, unknown>) {
  return params ? i18n.global.t(key, params) : i18n.global.t(key);
}

// ─── 全局状态 ──────────────────────────────────────────────────────

const hardware = ref<HardwareReport>({
  total_memory_gb: 0,
  cpu_cores: 0,
  status: "Unsupported",
  recommend_model: "",
  gpus: [],
  max_vram_mb: 0,
});

const engineStatus = ref<EngineStatus>("idle");
const engineProgress = ref(0);
const engineMessage = ref("");
const engineError = ref("");

/** 已安装的本地模型（引擎侧真实数据） */
const installedModels = ref<LocalModel[]>([]);
/** 各模型的安装进度，按模型 id 索引 */
const installJobs = ref<Record<string, ModelInstallState>>({});
/** 引擎实际使用的模型仓库目录（来自 Rust，供 UI 展示便于核对） */
const modelDir = ref("");
/**
 * 本地模型网关的 apiKey。
 *
 * 引擎本身没有任何鉴权能力（Ollama 官方就不提供本地鉴权），所以由应用自己的网关
 * （127.0.0.1:11435）来校验这个 key：不带 key 或 key 不匹配一律 401。
 * 网关只监听回环地址，因此局域网内其它机器根本无法建立连接 —— key 主要用来挡住
 * 同机的其它用户/程序，同时也是将来对外开放时的唯一防线。
 */
const apiKey = ref("");

const hardwareChecked = computed(() => hardware.value.total_memory_gb > 0);
const engineReady = computed(() => engineStatus.value === "ready");
/** 引擎是否正在执行"下载组件 / 拉起进程" */
const engineBusy = computed(() => engineStatus.value === "starting");
/** 引擎组件下载是否被暂停 */
const enginePaused = ref(false);
/** 已安装模型名（**规范化**后的集合，直接用 catalog id 查询即可，无需再关心 `:latest`） */
const installedModelNames = computed(
  () => new Set(installedModels.value.map(m => normalizeModelId(m.name))),
);
/** 已安装模型数量等信息供 UI 直接使用 */
const modelCount = computed(() => installedModels.value.length);

/** 查某个模型在本地仓库中的真实名字（未安装则返回 null） */
function findInstalledName(modelId: string): string | null {
  return installedModels.value.find(m => isSameModel(m.name, modelId))?.name ?? null;
}
/** 本地供应商（pinia store 中的那条记录） */
const localProvider = computed(() =>
  useProviderStore().stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER),
);
/** 当前默认模型 id */
const defaultModel = computed(() => localProvider.value?.defaultModel ?? "");

let unlistenFn: UnlistenFn | null = null;
let bootPromise: Promise<void> | null = null;

// ─── 状态文案翻译（Rust 侧推送的是中文原始状态） ────────────────

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

// ─── 事件监听（全局只注册一次） ─────────────────────────────────────

function ensureListener() {
  if (unlistenFn) return;
  listen<DownloadPayload>("download-progress", ({ payload }) => {
    // 引擎组件阶段 → 更新页面级引擎进度
    if (payload.phase === "engine") {
      engineProgress.value = payload.progress;
      engineMessage.value = translateStatus(payload.status);
      return;
    }

    // 模型阶段 → 按模型名路由到对应卡片
    const key = payload.model;
    if (!key) return;
    const prev = installJobs.value[key];
    installJobs.value = {
      ...installJobs.value,
      [key]: {
        status: prev?.status === "paused" ? "paused" : "installing",
        progress: payload.progress,
        message: translateStatus(payload.status),
      },
    };
  }).then((fn) => {
    unlistenFn = fn;
  });
}

// ─── 数据刷新 & 供应商同步 ──────────────────────────────────────────

/** 从引擎拉取已安装模型列表 */
async function refreshModels(): Promise<LocalModel[]> {
  try {
    const models = await invoke<LocalModel[]>("list_local_models");
    installedModels.value = models;
    return models;
  } catch (err) {
    console.warn("[local-engine] 获取本地模型列表失败:", err);
    installedModels.value = [];
    return [];
  }
}

/**
 * 把已安装模型同步到本地供应商（单一数据源）。
 * 自动创建（首次）或更新（后续）provider；超过 5 个时只同步前 5 个。
 */
function syncProvider() {
  const providerStore = useProviderStore();
  const take = installedModels.value.slice(0, 5);
  const providerModels: AiProviderModels[] = take.map((m) => {
    // 用规范化比较找预设，`moondream` 与 `moondream:latest` 视为同一个模型
    const preset = LOCAL_MODEL_CATALOG.find(p => isSameModel(p.id, m.name));
    const type: ModelCapability = preset?.type === "vision" ? "vision" : "text";
    return {
      // 用仓库里的真实名字，保证发给 Ollama 的 model 字段一定能命中
      name: m.name,
      modelId: m.name,
      desc: preset?.descKey ? t(preset.descKey) : "",
      type,
      enabled: true,
    };
  });

  const existing = providerStore.stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER);
  let defaultModel = providerModels[0]?.modelId ?? "";
  // 沿用用户此前选择的默认模型；规范化比较，避免 `moondream` vs `moondream:latest` 导致选择被静默重置
  const kept = providerModels.find(m => isSameModel(m.modelId, existing?.defaultModel ?? ""));
  if (kept) defaultModel = kept.modelId;

  const provider: AIProvider = {
    provider: LOCAL_MODEL_PROVIDER,
    value: LOCAL_MODEL_VALUE,
    avatar: "i-lucide:brain",
    desc: t("pages.preference.provider.local.desc"),
    baseUrl: OLLAMA_BASE_URL,
    // 本地网关要求携带 apiKey，聊天链路会自动带上 Authorization: Bearer。
    // 兜底保留旧值：万一 apiKey 拉取失败也不能把已配置好的 key 抹成空串。
    apiKey: apiKey.value || existing?.apiKey || "",
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

// ─── 引擎生命周期 ──────────────────────────────────────────────────

let apiKeyPromise: Promise<string> | null = null;

/**
 * 读取本地网关 apiKey（首次由 Rust 生成并落盘）。幂等：同一进程内只请求一次。
 * 必须在 `syncProvider()` 之前完成，否则供应商会拿到一个空 key 而无法通过网关校验。
 */
async function loadApiKey(): Promise<string> {
  if (apiKey.value) return apiKey.value;
  if (!apiKeyPromise) {
    apiKeyPromise = invoke<string>("get_local_api_key")
      .then((key) => {
        apiKey.value = key;
        return key;
      })
      .catch((err) => {
        console.warn("[local-engine] 获取本地网关 apiKey 失败:", err);
        apiKeyPromise = null;
        return "";
      });
  }
  return apiKeyPromise;
}

/** 重置本地网关 apiKey —— 旧 key 立即失效，已配置的外部客户端需同步更新 */
async function regenerateApiKey(): Promise<string> {
  const key = await invoke<string>("regenerate_local_api_key");
  apiKey.value = key;
  apiKeyPromise = Promise.resolve(key);
  syncProvider();
  return key;
}

/** 检测硬件 + 恢复进行中的任务（不启动引擎） */
async function detectHardware(): Promise<HardwareReport> {
  const report = await invoke<HardwareReport>("check_hardware");
  hardware.value = report;
  return report;
}

/**
 * 应用启动入口：检测硬件 → 自动拉起 Ollama → 同步已下载模型。
 * 幂等：同一进程内只会真正执行一次。
 */
function ensureEngine(): Promise<void> {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    engineStatus.value = "checking";
    try {
      const report = await detectHardware();

      if (report.status === "Low" || report.total_memory_gb < 4) {
        engineStatus.value = "unsupported";
        return;
      }

      ensureListener();

      // 先拿到本地网关 apiKey，后面写供应商配置时才能带上
      await loadApiKey();

      // 引擎状态以 Rust 侧的探测结果为准（幂等，已在运行则直接复用）
      const status = await invoke<LocalProviderStatus>("ensure_local_provider");
      installedModels.value = status.models;
      modelDir.value = status.model_dir;

      if (status.running && !status.gateway_ready) {
        // 引擎是好的，但鉴权网关没起来（端口被占）：模型实际不可用，
        // 必须在启动检测阶段就报出来，不能让用户到发起对话时才发现。
        engineStatus.value = "error";
        engineError.value = t("pages.preference.provider.local.errors.gatewayUnavailable");
      } else if (status.running) {
        engineStatus.value = "ready";
        // 引擎可用才同步供应商，避免在引擎不可用时把已配置的模型清空
        syncProvider();
      } else if (status.installed) {
        engineStatus.value = "error";
        engineError.value = t("pages.preference.provider.local.errors.engineStartTimeout");
      } else {
        engineStatus.value = "absent";
      }

      // 恢复仍在进行中的任务（模型下载 / 引擎组件下载）
      await restoreActiveJobs();
    } catch (err) {
      console.error("[local-engine] 启动检测失败:", err);
      engineStatus.value = "error";
      engineError.value = String(err);
    }
  })();

  return bootPromise;
}

/** 刷新/重开设置页后，把仍在进行的任务恢复成"安装中" */
async function restoreActiveJobs() {
  try {
    const active = await invoke<string[]>("is_downloading");
    if (!active.length) return;

    // 引擎组件仍在下载（另一窗口触发）且引擎尚未就绪 → 回到"启动中"
    if (active.includes(ENGINE_JOB_KEY) && engineStatus.value !== "ready") {
      engineStatus.value = "starting";
    }
    const next = { ...installJobs.value };
    for (const key of active) {
      if (key === ENGINE_JOB_KEY) continue;
      next[key] = {
        status: "installing",
        progress: next[key]?.progress ?? 0,
        message: t("pages.preference.provider.status.resumingInstall"),
      };
    }
    installJobs.value = next;
  } catch {
    // 忽略：旧版本后端可能返回 bool
  }
}

/**
 * 显式启动引擎（缺少引擎组件时自动下载）。
 * 引擎已在运行时 Rust 侧会幂等返回，不会重复拉起。
 */
async function startEngine(): Promise<void> {
  if (engineStatus.value === "starting") return;
  ensureListener();
  engineStatus.value = "starting";
  engineProgress.value = 0;
  enginePaused.value = false;
  engineMessage.value = t("pages.preference.provider.status.preparingInit");
  engineError.value = "";

  try {
    await invoke<void>("start_ollama_engine", { web_base: WEB_BASE });
    await loadApiKey();
    // 启动流程结束后统一以 Rust 的探测结果为准（模型列表 + 引擎实际使用的模型目录）
    const status = await invoke<LocalProviderStatus>("ensure_local_provider");
    installedModels.value = status.models;
    modelDir.value = status.model_dir;
    if (status.running && !status.gateway_ready) {
      engineStatus.value = "error";
      engineError.value = t("pages.preference.provider.local.errors.gatewayUnavailable");
    } else if (status.running) {
      engineStatus.value = "ready";
      syncProvider();
    } else {
      engineStatus.value = "error";
      engineError.value = t("pages.preference.provider.local.errors.engineStartTimeout");
    }
  } catch (err) {
    engineStatus.value = "error";
    engineError.value = String(err);
    throw err;
  }
}

/** 暂停引擎组件下载（仅组件下载阶段有意义） */
async function pauseEngine() {
  await invoke<void>("pause_download", { model_name: ENGINE_JOB_KEY });
  enginePaused.value = true;
}

/** 继续引擎组件下载 */
async function resumeEngine() {
  await invoke<void>("resume_download", { model_name: ENGINE_JOB_KEY });
  enginePaused.value = false;
}

/** 取消引擎组件下载（Rust 侧会清理临时文件） */
async function cancelEngine() {
  if (enginePaused.value) {
    await invoke<void>("resume_download", { model_name: ENGINE_JOB_KEY }).catch(() => {});
    enginePaused.value = false;
  }
  await invoke<void>("cancel_download", { model_name: ENGINE_JOB_KEY });
  engineStatus.value = "absent";
  engineProgress.value = 0;
}

/**
 * 停止引擎（不删除任何数据）。
 * 模型文件仍在磁盘上，因此这里刻意不清空已安装列表、也不改供应商配置，
 * 避免用户的默认模型选择被误清空。
 */
async function stopEngine(): Promise<void> {
  await invoke<void>("stop_ollama_engine");
  engineStatus.value = "absent";
}

/** 一键彻底清除引擎与全部模型 */
async function cleanupAll(): Promise<void> {
  await invoke<void>("cleanup_local_models", { model_name: null });
  installedModels.value = [];
  installJobs.value = {};
  engineStatus.value = "absent";
  syncProvider();
}

// ─── 模型安装 ──────────────────────────────────────────────────────

/** 读取某个模型的安装状态（未开始时返回 idle 兜底） */
function getInstallState(modelId: string): ModelInstallState {
  return installJobs.value[modelId] ?? { status: "idle", progress: 0, message: "" };
}

function resetInstallState(modelId: string) {
  const next = { ...installJobs.value };
  delete next[modelId];
  installJobs.value = next;
}

/**
 * 安装（拉取）单个模型。
 * 引擎未就绪时先自动拉起引擎，再单独下载该模型 —— 两者互不耦合。
 */
async function installModel(modelId: string) {
  const current = getInstallState(modelId);
  if (current.status === "installing") return;

  installJobs.value = {
    ...installJobs.value,
    [modelId]: {
      status: "installing",
      progress: 0,
      message: t("pages.preference.provider.status.preparingInit"),
    },
  };
  ensureListener();

  try {
    if (engineStatus.value !== "ready") {
      installJobs.value = {
        ...installJobs.value,
        [modelId]: {
          status: "installing",
          progress: 0,
          message: t("pages.preference.provider.status.preparingEngine"),
        },
      };
      await startEngine();
    }

    // Rust 返回模型在仓库中的真实名字（请求 `moondream` 时可能是 `moondream:latest`）
    const resolvedName = await invoke<string>("download_model", { model_name: modelId });

    await refreshModels();

    // ★ 装完必须真的能在本地仓库里找到它，否则"安装成功"就是假的。
    //   （历史 bug：名称差一个 `:latest` 时后端判定"已存在"直接返回成功，
    //     前端却因为精确匹配失败而认为未安装，于是出现"提示成功但没装"的错位。）
    if (!findInstalledName(resolvedName || modelId)) {
      throw new Error(
        t("pages.preference.provider.local.errors.modelNotFoundAfterInstall", { name: modelId }),
      );
    }

    installJobs.value = {
      ...installJobs.value,
      [modelId]: {
        status: "done",
        progress: 100,
        message: t("pages.preference.provider.status.modelReady"),
      },
    };
    syncProvider();

    // 成功态短暂展示后回到 idle（已安装列表本身会显示"已安装"标记）
    setTimeout(() => {
      if (getInstallState(modelId).status === "done") resetInstallState(modelId);
    }, 3000);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("已被用户取消") || errMsg.includes("cancelled")) {
      resetInstallState(modelId);
      return;
    }
    installJobs.value = {
      ...installJobs.value,
      [modelId]: {
        status: "error",
        progress: 0,
        message: "",
        error: errMsg,
      },
    };
    throw err;
  }
}

async function pauseInstall(modelId: string) {
  await invoke<void>("pause_download", { model_name: modelId });
  const prev = getInstallState(modelId);
  installJobs.value = {
    ...installJobs.value,
    [modelId]: { ...prev, status: "paused", message: t("pages.preference.provider.hints.pausedResumeHint") },
  };
}

async function resumeInstall(modelId: string) {
  await invoke<void>("resume_download", { model_name: modelId });
  const prev = getInstallState(modelId);
  installJobs.value = {
    ...installJobs.value,
    [modelId]: { ...prev, status: "installing", message: t("pages.preference.provider.status.resumingInstall") },
  };
}

async function cancelInstall(modelId: string) {
  const prev = getInstallState(modelId);
  // 暂停中先恢复，否则 Rust 侧的暂停循环会挡住取消
  if (prev.status === "paused") {
    await invoke<void>("resume_download", { model_name: modelId }).catch(() => {});
  }
  await invoke<void>("cancel_download", { model_name: modelId });
  resetInstallState(modelId);
}

async function uninstallModel(modelId: string) {
  // 用仓库里的真实名字卸载（请求 `moondream`、实际存的是 `moondream:latest`）
  const realName = findInstalledName(modelId) ?? modelId;
  await invoke<void>("cleanup_local_models", { model_name: realName });
  resetInstallState(modelId);
  await refreshModels();
  syncProvider();
}

/** 设为默认模型（写回供应商配置） */
function setDefaultModel(modelId: string) {
  const providerStore = useProviderStore();
  const existing = providerStore.stateProviders.find(p => p.provider === LOCAL_MODEL_PROVIDER);
  if (!existing) return;
  // 写仓库里的真实名字，避免 `moondream` 与 `moondream:latest` 不一致导致下次同步时选择被重置
  const realName = findInstalledName(modelId) ?? modelId;
  providerStore.updateProvider({ ...existing, defaultModel: realName });
}

// ─── 对外导出 ──────────────────────────────────────────────────────

export function useOllamaEngine() {
  return {
    // 状态
    hardware,
    hardwareChecked,
    engineStatus,
    engineProgress,
    engineMessage,
    engineError,
    engineReady,
    engineBusy,
    enginePaused,
    installedModels,
    installedModelNames,
    modelCount,
    modelDir,
    apiKey,
    installJobs,
    localProvider,
    defaultModel,

    // 查询
    getInstallState,
    findInstalledName,

    // 网关凭据
    loadApiKey,
    regenerateApiKey,

    // 引擎
    detectHardware,
    ensureEngine,
    startEngine,
    stopEngine,
    cleanupAll,
    pauseEngine,
    resumeEngine,
    cancelEngine,
    refreshModels,
    syncProvider,

    // 模型
    installModel,
    pauseInstall,
    resumeInstall,
    cancelInstall,
    uninstallModel,
    setDefaultModel,
  };
}

/**
 * 供非组件上下文（如 App.vue 启动流程）直接调用的单例入口。
 * 结构与 `useOllamaEngine()` 的返回值保持一致，方便在组件外复用。
 */
export const ollamaEngine = {
  ensureEngine,
  startEngine,
  stopEngine,
  cleanupAll,
  refreshModels,
  syncProvider,
  installModel,
  uninstallModel,
  getInstallState,
  findInstalledName,
  loadApiKey,
  regenerateApiKey,
  engineStatus,
  engineProgress,
  engineMessage,
  engineError,
  enginePaused,
  installedModels,
  installedModelNames,
  modelDir,
  apiKey,
  installJobs,
  hardware,
  defaultModel,
};
