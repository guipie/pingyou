<script setup lang="ts">
import { message, TabPane, Tabs } from "antdv-next";
import { onUnmounted } from "vue";
import { useI18n } from "vue-i18n";

import { LISTEN_KEY } from "@/constants";
import { useProviderStore } from "@/stores/aiprovider";

import CloudTab from "./tabs/cloud-tab.vue";
import CustomTab from "./tabs/custom-tab.vue";
import LocalTab from "./tabs/local-tab.vue";

const providerStore = useProviderStore();
const { t } = useI18n();

// 监听来自 add 子窗口的供应商添加事件
let unlistenAdd: (() => void) | null = null;

import("@tauri-apps/api/event").then(({ listen }) => {
  listen(LISTEN_KEY.PROVIDER_ADDED, () => {
    providerStore.initDbProviders();
  }).then((fn) => {
    unlistenAdd = fn;
  });
});

onUnmounted(() => {
  unlistenAdd?.();
});

/** "使用云端模型"回调：云端模型已直接注册进 provider store，这里仅提示并刷新列表 */
function handleUseCloudModel(payload: { baseUrl: string, modelName: string, modelId: string, provider: string, apiKey: string }) {
  providerStore.initDbProviders();
  message.success(t("pages.preference.provider.messages.cloudEnabled", { provider: payload.modelName }));
}
</script>

<template>
  <Tabs default-active-key="cloud">
    <!-- Tab 1：云端模型（未登录提醒登录，登录后展示所有可用模型） -->
    <TabPane
      key="cloud"
      :tab="t('pages.preference.provider.labels.cloudTab')"
    >
      <div class="pt-4">
        <CloudTab @use-cloud-model="handleUseCloudModel" />
      </div>
    </TabPane>

    <!-- Tab 2：自定义第三方（初始化供应商 + 自定义添加） -->
    <TabPane
      key="custom"
      :tab="t('pages.preference.provider.labels.customTab')"
    >
      <div class="pt-4">
        <CustomTab />
      </div>
    </TabPane>

    <!-- Tab 3：本地模型（默认现有逻辑） -->
    <TabPane
      key="local"
      :tab="t('pages.preference.provider.labels.localTab')"
    >
      <div class="pt-4">
        <LocalTab />
      </div>
    </TabPane>
  </Tabs>
</template>
