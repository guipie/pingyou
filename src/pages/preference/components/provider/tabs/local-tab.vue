<script setup lang="ts">
import { CheckCircleOutlined } from "@antdv-next/icons";
import { Button, Popconfirm, Tag } from "antdv-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import PyAvatar from "@/components/py-avatar.vue";
import { RoutersName } from "@/router/roters";
import { useProviderStore } from "@/stores/aiprovider.ts";
import { isBoolean } from "@/utils/is.ts";
import { openNewWindow } from "@/utils/win-manager";

import Ollama from "../ollama.vue";

const { t } = useI18n();

const providerStore = useProviderStore();
const providers = computed(() => providerStore.stateProviders.filter(p => p.provider === "本地大模型"));
/** "使用本地大模型"按钮回调：打开预填了 Ollama 地址和模型名的添加窗口 */
function handleUseLocalModel(payload: { baseUrl: string, modelName: string, modelId: string, provider: string }) {
  const query = `?baseUrl=${encodeURIComponent(payload.baseUrl)}&modelId=${encodeURIComponent(payload.modelId)}&modelName=${encodeURIComponent(payload.modelName)}&provider=${encodeURIComponent(payload.provider)}&isLocal=true`;
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

    <div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
      <div
        v-for="provider in providers"
        :key="provider.provider"
        class="flex flex-col gap-3 b-1 rounded-xl b-solid p-5 transition-all bg-warning-bg b-border-sec hover:shadow-md"
      >
        <!-- 卡片头部：头像 + 名称 + 标签 -->
        <div class="flex items-center gap-3">
          <PyAvatar
            :icon="provider.avatar"
            :url="provider.avatar"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-4 font-semibold">{{ provider.value }}</span>
              <Tag
                v-if="isBoolean(provider.isCustom) "
                color="success"
                variant="solid"
              >
                <template #icon>
                  <CheckCircleOutlined />
                </template>{{ t('pages.preference.provider.labels.localTab') }}
              </Tag>
            </div>
          </div>
        </div>

        <!-- 描述 -->
        <div class="line-clamp-2 min-h-10 text-3 leading-relaxed color-text-tertiary">
          {{ provider.desc }}
        </div>

        <!-- 模型标签 -->
        <div
          v-if="provider.models && provider.models.length > 0"
          class="flex flex-wrap gap-1"
        >
          <Tag
            v-for="model in provider.models.slice(0, 4)"
            :key="model.modelId"
            class="text-2.5"
            :color="model.modelId === provider.defaultModel ? 'blue' : 'default'"
          >
            {{ model.name }}
          </Tag>
          <Tag
            v-if="provider.models.length > 4"
            class="text-2.5"
          >
            +{{ provider.models.length - 4 }}
          </Tag>
          <div class="flex-1" />

          <Popconfirm
            v-if="provider.isCustom"
            :description="t('pages.preference.provider.dialogs.removeConfirm')"
            placement="topRight"
            :title="t('pages.preference.provider.labels.removeProvider')"
            @confirm="providerStore.removeProvider(provider.provider)"
          >
            <Button
              danger
              size="small"
              type="text"
            >
              <template #icon>
                <i class="i-lucide:trash-2" />
              </template>
            </Button>
          </Popconfirm>
        </div>
      </div>
    </div>
  </div>
</template>
