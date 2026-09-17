<script setup lang="ts">
import { Button, Progress, Tag, Tooltip } from "antdv-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { ModelInstallState } from "@/composables/useOllamaEngine";
import type { ModelFitResult } from "@/constants/local-models";

const props = defineProps<{
  item: ModelFitResult
  /** 是否已安装到本地仓库 */
  installed: boolean
  /** 是否为当前默认模型 */
  isDefault: boolean
  /** 该模型自身的安装任务状态（进度显示在这张卡片里） */
  job: ModelInstallState
}>();

const emit = defineEmits<{
  install: [id: string]
  pause: [id: string]
  resume: [id: string]
  cancel: [id: string]
  uninstall: [id: string]
  setDefault: [id: string]
  copy: [id: string]
}>();

const { t } = useI18n();

/** 适配档位 → Tag 颜色 + i18n 文案 key */
const fitMeta: Record<string, { color: string, labelKey: string }> = {
  recommended: { color: "success", labelKey: "pages.preference.provider.labels.fitRecommended" },
  ok: { color: "blue", labelKey: "pages.preference.provider.labels.fitOk" },
  tight: { color: "warning", labelKey: "pages.preference.provider.labels.fitTight" },
  unsupported: { color: "error", labelKey: "pages.preference.provider.labels.fitUnsupported" },
};

const busy = computed(() => props.job.status === "installing" || props.job.status === "paused");
const paused = computed(() => props.job.status === "paused");
const failed = computed(() => props.job.status === "error");
/** 安装中/失败时占位操作区，避免用户重复触发 */
const showActions = computed(() => !busy.value && !failed.value);

const statusText = computed(() => {
  if (paused.value) return t("pages.preference.provider.hints.pausedResumeHint");
  return props.job.message || t("pages.preference.provider.status.preparingInit");
});
</script>

<template>
  <div
    class="relative flex flex-col gap-2 b-1 rounded-xl b-solid p-3 text-left transition-all"
    :class="[
      isDefault ? 'b-blue-400 bg-blue-50/60' : '',
      item.level === 'unsupported' ? 'opacity-50 b-slate-200' : 'b-slate-200 hover:border-blue-300',
    ]"
  >
    <!-- 头部：名称 + 已安装/默认/适配标签 -->
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0 flex items-center gap-1.5">
        <div
          class="shrink-0 text-16px"
          :class="item.model.type === 'vision' ? 'i-carbon-view' : 'i-carbon-chat'"
        />
        <span class="truncate text-13px text-slate-800 font-bold font-mono">{{ item.model.name }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <Tag
          v-if="installed"
          class="!text-4"
          color="success"
        >
          {{ t('pages.preference.provider.local.labels.installed') }}
        </Tag>
        <Tag
          v-if="isDefault"
          class="!text-2"
          color="blue"
          variant="filled"
        >
          {{ t('pages.preference.provider.cloud.labels.current') }}
        </Tag>
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

    <!-- ① 安装中 / 已暂停：进度直接显示在本卡片内 -->
    <div
      v-if="busy"
      class="flex flex-col gap-1.5 border-t pt-2 b-border-sec"
    >
      <div class="flex items-center gap-2">
        <span
          class="min-w-0 flex-1 truncate text-2.5"
          :class="paused ? 'text-amber-500' : 'color-text-tertiary'"
        >
          {{ statusText }}
        </span>
        <span class="shrink-0 text-2.5 text-slate-400 font-mono">{{ Math.round(job.progress) }}%</span>
      </div>
      <Progress
        :percent="Math.round(job.progress)"
        :show-info="false"
        size="small"
        :status="paused ? 'normal' : 'active'"
      />
      <div class="flex items-center gap-2">
        <Button
          v-if="paused"
          size="small"
          type="primary"
          @click="emit('resume', item.model.id)"
        >
          {{ t('pages.preference.provider.buttons.resume') }}
        </Button>
        <Button
          v-else
          size="small"
          @click="emit('pause', item.model.id)"
        >
          {{ t('pages.preference.provider.buttons.pause') }}
        </Button>
        <Button
          danger
          size="small"
          type="text"
          @click="emit('cancel', item.model.id)"
        >
          {{ t('pages.preference.provider.buttons.cancelDownload') }}
        </Button>
      </div>
    </div>

    <!-- ② 安装失败：在本卡片展示真实原因 + 重试 -->
    <div
      v-else-if="failed"
      class="flex flex-col gap-1.5 border-t pt-2 b-border-sec"
    >
      <div class="flex items-start gap-1">
        <div class="i-carbon-warning-alt text-red-500 mt-0.5 shrink-0 text-12px" />
        <span class="text-red-500 line-clamp-3 break-all text-2.5">{{ job.error }}</span>
      </div>
      <div class="flex items-center gap-2">
        <Button
          size="small"
          type="primary"
          @click="emit('install', item.model.id)"
        >
          {{ t('pages.preference.provider.labels.retry') }}
        </Button>
        <Button
          size="small"
          type="text"
          @click="emit('cancel', item.model.id)"
        >
          {{ t('pages.preference.provider.labels.dismiss') }}
        </Button>
      </div>
    </div>

    <!-- ③ 正常操作区：已安装 vs 未安装 -->
    <template v-else-if="showActions">
      <div
        v-if="installed"
        class="flex items-center gap-1 border-t pt-2 b-border-sec"
      >
        <Button
          danger
          size="small"
          @click="emit('uninstall', item.model.id)"
        >
          {{ t('pages.preference.provider.cloud.labels.uninstall') }}
        </Button>
        <div class="flex-1" />
        <Button
          v-if="!isDefault"
          size="small"
          type="link"
          @click="emit('setDefault', item.model.id)"
        >
          {{ t('pages.preference.provider.cloud.labels.setDefault') }}
        </Button>
        <Button
          size="small"
          type="link"
          @click="emit('copy', item.model.id)"
        >
          {{ t('pages.preference.provider.labels.copy') }}
        </Button>
      </div>
      <div
        v-else
        class="flex items-center gap-1 border-t pt-2 b-border-sec"
      >
        <div class="flex-1" />
        <Button
          v-if="item.level !== 'unsupported'"
          size="small"
          type="primary"
          @click="emit('install', item.model.id)"
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
    </template>

    <!-- 不支持原因 tooltip -->
    <Tooltip
      v-if="item.reasonKey"
      class="absolute right-2 top-2"
      :title="t(item.reasonKey)"
    >
      <div class="i-carbon-warning text-12px text-slate-400" />
    </Tooltip>
  </div>
</template>
