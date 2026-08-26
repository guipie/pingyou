<script setup lang="ts">
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { remove } from "@tauri-apps/plugin-fs";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Card, Masonry, message, Popconfirm, Progress, Tag } from "antdv-next";
import { nanoid } from "nanoid";
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import type { Model, ModelEngine, ModelMode } from "@/stores/model";

import { useCatStore } from "@/stores/cat";
import { useModelStore } from "@/stores/model";
import { useRouteSettingStore } from "@/stores/route-setting";
import { isExtractedModelDir, resolveEffectiveModelPath } from "@/utils/model";
import { join } from "@/utils/path";

import BehaviorModal from "./components/behavior-modal/index.vue";
import Preview3d from "./components/preview-3d/index.vue";
import Upload from "./components/upload/index.vue";

const uploadShow = ref(false);
// --------------------------------------------------------------------------
// 屏友商城 API Base
// --------------------------------------------------------------------------
const LOAD_MORE_KEY = "__load_more__";
const WEB_BASE = (() => {
  const env = import.meta.env.VITE_PINGYOU_WEB_BASE as string | undefined;
  if (env) return env.replace(/\/$/, "");
  if (import.meta.env.DEV) return "http://localhost:4000";
  return "https://py.lm56.top";
})();
const LOAD_MORE_URL = `${WEB_BASE}/pingyou`;

// --------------------------------------------------------------------------
// Stores / i18n
// --------------------------------------------------------------------------
const catStore = useCatStore();
const modelStore = useModelStore();
const { t } = useI18n();
const openBehaviorModal = ref(false);
const curType = ref<ModelEngine | "all">("all");

// --------------------------------------------------------------------------
// 下载进度 UI
// --------------------------------------------------------------------------
type DownloadStage = "download" | "extract" | "done" | "error";
interface DownloadTask {
  jobId: string
  /** 线上模型 id（可能暂无，显示 fallback 名时用） */
  remoteId: string
  name: string
  stage: DownloadStage
  current: number
  total: number
  percent: number // 0~100
  message?: string
}

/** 正在进行 / 已完成的下载任务（按 jobId 存） */
const downloadTasks = reactive<Record<string, DownloadTask>>({});

/** 按创建顺序返回任务列表（未完成的在上面） */
function activeTasks() {
  return Object.values(downloadTasks).sort((a, b) => {
    if (a.stage === "done" && b.stage !== "done") return 1;
    if (a.stage !== "done" && b.stage === "done") return -1;
    return 0;
  });
}

const STAGE_LABEL: Record<DownloadStage, string> = {
  download: "下载中",
  extract: "解压中",
  done: "已完成",
  error: "失败",
};

/** 人类可读的字节大小（下载进度里显示：已下载/总共） */
function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 清除已完成 / 失败超过 10s 的任务（避免列表无限增长） */
function sweepFinishedJobs() {
  const now = Date.now();
  for (const jobId of Object.keys(downloadTasks)) {
    const t = downloadTasks[jobId] as DownloadTask & { _finishedAt?: number };
    if ((t.stage === "done" || t.stage === "error") && t._finishedAt) {
      if (now - t._finishedAt > 15_000) delete downloadTasks[jobId];
    }
  }
}

// --------------------------------------------------------------------------
// 模型列表排序（字典序），末尾追加「加载更多」Card
// --------------------------------------------------------------------------
function getMasonryItems(models: Model[]) {
  const items = [...models]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(item => ({
      key: item.id,
      data: item,
    }));
  items.push({
    key: LOAD_MORE_KEY,
    data: {
      id: LOAD_MORE_KEY,
      path: "",
      mode: "standard" as ModelMode,
      engine: "live2d" as ModelEngine,
      isPreset: false,
      isLoadMore: true,
    },
  });
  return items;
}

function handleToggle(nextModel: Model) {
  if (modelStore.currentModel?.id === nextModel.id) return;
  modelStore.modelReady = false;
  modelStore.currentModel = nextModel;
}

async function handleDelete(item: Model) {
  const { id, path } = item;
  try {
    await remove(path, { recursive: true });
    message.success(t("pages.preference.model.hints.deleteSuccess"));
  } catch (error) {
    message.error(String(error));
  } finally {
    modelStore.models = modelStore.models.filter(item => item.id !== id);
    if (id === modelStore.currentModel?.id) {
      modelStore.currentModel = modelStore.models[0];
    }
  }
}

async function handleOpenFolder(path: string) {
  try {
    await openPath(path);
  } catch (error) {
    message.error(String(error));
  }
}

// 核心：导入模型（deep-link 触发 & 本地 HTTP 触发都走这里）
// --------------------------------------------------------------------------
async function handleDeepLink(url: string) {
  // 自动跳转到屏友 tab（index=0），确保用户能看到下载进度
  const routeSettingStore = useRouteSettingStore();
  routeSettingStore.backHome(0);

  try {
    if (!url.startsWith("pingyou://import-model")) return;
    const parsed = new URL(url);
    const remoteId = parsed.searchParams.get("id");
    if (!remoteId) return;

    // 拉取模型元信息
    const res = await fetch(`${WEB_BASE}/api/models/${remoteId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const model = (await res.json()) as {
      id: number
      name: string
      type?: "live2d" | "3d"
      modelUrl?: string
      zipUrl?: string
    };
    const is3d = model.type === "3d";
    if (!model?.modelUrl || (!is3d && !model?.zipUrl)) {
      message.error("未找到模型下载地址");
      return;
    }

    // 用「模型 key id」当目录名，保证同一模型多次点击不会重复下载。
    // 前缀加 `m` 避免纯数字目录导致的路径问题。
    const modelKeyId = `m${model.id}`;
    const root = await invoke<string>("resolve_custom_models_dir");
    const toPath = join(root, modelKeyId);

    // 先在 store 里查找：模型已存在 → 直接切换到该模型
    const existingInStore = modelStore.models.find(
      m =>
        // id 就是 modelKeyId（新版）或路径指向同一个目录（旧版兼容）
        m.id === modelKeyId || m.path === toPath,
    );
    if (existingInStore) {
      message.info(`「${model.name}」已经存在，已切换到该模型`);
      if (modelStore.currentModel?.id !== existingInStore.id) {
        modelStore.currentModel = existingInStore;
      }
      return;
    }

    // 再查磁盘：目录存在且解压完整 → 直接加入 store
    if (await isExtractedModelDir(toPath)) {
      // 剥掉外层包装目录，拿到真正的模型根路径
      const effectivePath = await resolveEffectiveModelPath(toPath);
      let mode: ModelMode = "standard";
      let engine: ModelEngine = "live2d";
      if (model.type === "3d") {
        mode = "model3d";
        engine = "3d";
      }
      modelStore.models.push({
        id: modelKeyId,
        path: effectivePath,
        mode,
        engine,
        isPreset: false,
      });
      message.success(`「${model.name}」本地已存在，已加入模型列表`);
      // 自动切换到新加入的模型
      const added = modelStore.models[modelStore.models.length - 1];
      if (added) modelStore.currentModel = added;
      return;
    }

    // 否则：真正下载
    const jobId = nanoid();
    // 注册 UI 任务
    downloadTasks[jobId] = {
      jobId,
      remoteId: String(model.id),
      name: model.name,
      stage: "download",
      current: 0,
      total: 0,
      percent: 0,
    };

    try {
      if (is3d) {
        // 3D：下载单文件
        const modelFileName = model.modelUrl!.split("/").pop()?.split("?")[0] || "model.glb";
        await invoke("download_model_file", {
          jobId,
          url: model.modelUrl,
          toPath,
          fileName: modelFileName,
        });
      } else {
        // Live2D：下载 zip 并解压
        await invoke("download_and_extract_model", {
          jobId,
          url: model.zipUrl,
          toPath,
        });
      }

      // 剥掉外层包装目录，拿到真正的模型根路径
      const effectivePath = await resolveEffectiveModelPath(toPath);

      // → done 事件会把 stage 改成 done，这里再把模型加到 store 里
      const mode: ModelMode = is3d ? "model3d" : "standard";
      const engine: ModelEngine = is3d ? "3d" : "live2d";
      modelStore.models.push({
        id: modelKeyId,
        path: effectivePath,
        mode,
        engine,
        isPreset: false,
      });
      message.success(`「${model.name}」下载完成`);
      // 自动切换到新模型
      const added = modelStore.models[modelStore.models.length - 1];
      if (added) modelStore.currentModel = added;
    } catch (error: any) {
      if (downloadTasks[jobId]) {
        downloadTasks[jobId].stage = "error";
        downloadTasks[jobId].message = String(error?.message ?? error);
      }
      message.error(String(error?.message ?? error));
      throw error;
    } finally {
      // 标记完成时间，15s 后自动从列表清理
      const t = downloadTasks[jobId] as DownloadTask & { _finishedAt?: number };
      if (t) t._finishedAt = Date.now();
      setTimeout(sweepFinishedJobs, 16_000);
    }
  } catch (error) {
    // 外层 message 已打印，这里仅兜底避免静默失败
    console.error("[handleDeepLink] failed:", error);
  }
}

// --------------------------------------------------------------------------
// Lifecycle: 监听事件
// --------------------------------------------------------------------------
let unlistenDeepLink: (() => void) | null = null;
let unlistenProgress: (() => void) | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  unlistenDeepLink = await listen<string>("deep-link-url", (event) => {
    handleDeepLink(event.payload);
  });

  // 监听 Rust 端推送的下载/解压进度
  unlistenProgress = await listen<{
    job_id: string
    jobId?: string
    stage: DownloadStage
    current: number
    total: number
    percent: number
    message?: string
  }>("model-download-progress", (event) => {
    const p = event.payload;
    const jobId = p.jobId ?? p.job_id;
    if (!jobId || !downloadTasks[jobId]) return;
    const t = downloadTasks[jobId];
    t.stage = p.stage;
    t.current = p.current;
    t.total = p.total;
    t.percent = Math.max(0, Math.min(100, p.percent));
    if (p.message) t.message = p.message;
  });

  // 定期清理已完成任务
  sweepTimer = setInterval(sweepFinishedJobs, 5000);
});

onUnmounted(() => {
  unlistenDeepLink?.();
  unlistenProgress?.();
  if (sweepTimer) clearInterval(sweepTimer);
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- ============================================================
         下载任务进度（顶部展示）
         ============================================================ -->
    <section
      v-if="activeTasks().length > 0"
      class="flex flex-col gap-4 border rounded-2xl p-5 bg-ant-container border-ant-border-sec"
    >
      <div class="c-ant-heading flex items-center gap-2 text-base font-semibold">
        <i class="i-lucide:download-cloud c-ant-primary" />
        <span>下载任务</span>
        <Tag
          class="ml-2 !m-0"
          color="blue"
        >
          {{ activeTasks().filter((t) => t.stage === "download" || t.stage === "extract").length }}
          进行中
        </Tag>
      </div>

      <div class="grid gap-4 lg:grid-cols-3 md:grid-cols-2">
        <div
          v-for="task in activeTasks()"
          :key="task.jobId"
          class="bg-ant-fill-quaternary/60 flex flex-col gap-2 b rounded-xl p-4 border-ant-border-sec"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="c-ant-heading flex-1 truncate font-medium text-sm">
              {{ task.name }}
            </div>
            <Tag
              class="shrink-0 !m-0 !text-xs"
              :color="{
                download: 'processing',
                extract: 'cyan',
                done: 'success',
                error: 'error',
              }[task.stage]"
            >
              {{ STAGE_LABEL[task.stage] }}
            </Tag>
          </div>

          <Progress
            :percent="Math.round(task.percent) || 0"
            :show-info="true"
            size="small"
            :status="
              task.stage === 'error'
                ? 'exception'
                : task.stage === 'done'
                  ? 'success'
                  : 'active'
            "
          />

          <div class="flex items-center justify-between text-xs c-ant-text-tertiary">
            <template v-if="task.stage === 'download'">
              <span>{{ formatBytes(task.current) }}</span>
              <span>/ {{ task.total > 0 ? formatBytes(task.total) : "未知" }}</span>
            </template>
            <template v-else-if="task.stage === 'extract'">
              <span>解压文件 {{ task.current }}</span>
              <span>/ {{ task.total }} 项</span>
            </template>
            <template v-else-if="task.stage === 'done'">
              <span>已加入模型列表</span>
              <span>✓</span>
            </template>
            <template v-else>
              <span class="color-error-6 truncate pr-2">{{ task.message ?? "失败" }}</span>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================
         原有的模型选择区
         ============================================================ -->
    <section class="flex flex-col gap-4">
      <div class="flex gap-4">
        <div class="flex items-center gap-2 text-base font-medium">
          <span>{{ t("pages.preference.model.title") }}</span>
          <span class="color-gray-5 text-sm">{{ t("pages.preference.model.labels.tips") }}</span>
        </div>
        <div class="flex-1" />
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          :class="{ 'text-info': curType === 'live2d' }"
          @click="curType = 'live2d'"
        >
          <i class="i-lucide:layers-2" />
          <span>live2D</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          :class="{ 'text-info': curType === '3d' }"
          @click="curType = '3d'"
        >
          <i class="i-lucide:box" />
          <span>3D</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"

          @click="() => openUrl(LOAD_MORE_URL)"
        >
          <i class="i-lucide:cloud-upload" />
          <span>更多</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"

          @click="() => uploadShow = !uploadShow"
        >
          <i class="i-lucide:upload" />
          <span>本地</span>
        </div>
        <div
          class="flex cursor-pointer items-center text-blueGray text-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          @click="curType = 'all'"
        >
          <i class="i-lucide:refresh-ccw" />
        </div>
      </div>
      <Upload v-if="uploadShow" />
      <Masonry
        :columns="{ xs: 3, lg: 4, xxl: 6 }"
        :gutter="16"
        :items="getMasonryItems(modelStore.models)"
      >
        <template #itemRender="{ data }">
          <!-- ---------- 加载更多 Card ---------- -->
          <Card
            v-if="data.isLoadMore"
            class="flex flex-col"
            :cover="false"
            hoverable
            size="small"
            @click="() => openUrl(LOAD_MORE_URL)"
          >
            <div
              class="hover:text-ant-primary flex flex-col items-center justify-center gap-3 px-3 py-12 color-blueGray hover:(c-ant-primary)"
            >
              <div class="i-lucide:plus-circle text-6xl opacity-60 c-ant-primary" />
              <div class="text-xs c-ant-text-tertiary">
                加载更多 Live2D / 3D 模型
              </div>
            </div>
          </Card>

          <!-- ---------- Live2D ---------- -->
          <Card
            v-else-if="data.engine === 'live2d'"
            v-show="curType === 'all' || curType === 'live2d'"
            :classes="{
              actions:
                '[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)',
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <img
                alt="Live2D"
                class="h-38 w-full object-cover p-3"
                :src="convertFileSrc(join(data.path, 'resources', 'cover.png'))"
              >
            </template>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
              />

              <i
                v-if="
                  catStore.model.behavior && modelStore.currentModel?.id === data.id
                "
                class="i-lucide:smile"
                @click.stop="openBehaviorModal = true"
              />

              <i
                class="i-lucide:folder-open"
                @click.stop="handleOpenFolder(data.path)"
              />

              <template v-if="!data.isPreset">
                <Popconfirm
                  :description="$t('pages.preference.model.hints.deleteModel')"
                  placement="topRight"
                  :title="$t('pages.preference.model.labels.deleteModel')"
                  @confirm="handleDelete(data)"
                >
                  <i
                    class="i-lucide:trash-2"
                    @click.stop
                  />
                </Popconfirm>
              </template>
            </template>
          </Card>

          <!-- ---------- 3D ---------- -->
          <Card
            v-else-if="data.engine === '3d'"
            v-show="curType === 'all' || curType === '3d'"
            :classes="{
              actions:
                '[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)',
            }"
            hoverable
            size="small"
            @click="handleToggle(data)"
          >
            <template #cover>
              <Preview3d
                :id="data.id"
                :key="data.id"
                :path="data.path"
              />
            </template>

            <template #actions>
              <i
                class="i-lucide:circle-check"
                :class="{ 'text-success': data.id === modelStore.currentModel?.id }"
              />

              <i class="i-lucide:play" />

              <template v-if="!data.isPreset">
                <Popconfirm
                  :description="$t('pages.preference.model.hints.deleteModel')"
                  placement="topRight"
                  :title="$t('pages.preference.model.labels.deleteModel')"
                  @confirm="handleDelete(data)"
                >
                  <i
                    class="i-lucide:trash-2"
                    @click.stop
                  />
                </Popconfirm>
              </template>
            </template>
          </Card>
        </template>
      </Masonry>
    </section>

    <BehaviorModal
      v-if="catStore.model.behavior"
      v-model="openBehaviorModal"
    />
  </div>
</template>
