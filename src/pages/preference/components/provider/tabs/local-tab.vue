<script setup lang="ts">
import { useI18n } from "vue-i18n";

import { RoutersName } from "@/router/roters";
import { openNewWindow } from "@/utils/win-manager";

import Ollama from "../ollama.vue";

const { t } = useI18n();

/** "使用本地大模型"按钮回调：打开预填了 Ollama 地址和模型名的添加窗口 */
function handleUseLocalModel(payload: { baseUrl: string, modelName: string, modelId: string, provider: string }) {
  const query = `?baseUrl=${encodeURIComponent(payload.baseUrl)}&modelId=${encodeURIComponent(payload.modelId)}&modelName=${encodeURIComponent(payload.modelName)}&provider=${encodeURIComponent(payload.provider)}`;
  openNewWindow(RoutersName.ProviderAdd, {
    isForeCreate: true,
    title: t("pages.preference.provider.labels.addLocalModel"),
    query,
  });
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 本地大模型（Ollama）默认现有逻辑 -->
    <Ollama @use-local-model="handleUseLocalModel" />
  </div>
</template>
