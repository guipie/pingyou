<script setup lang="ts">
import { CheckCircleOutlined, ExclamationCircleOutlined, SettingOutlined } from "@antdv-next/icons";
import { Button, message, Popconfirm, Tag } from "antdv-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import type { AIProvider } from "@/stores/shard/provider-shard";

import ProList from "@/components/pro-list/index.vue";
import PyAvatar from "@/components/py-avatar.vue";
import { RoutersName } from "@/router/roters";
import { useProviderStore } from "@/stores/aiprovider";
import { isBoolean } from "@/utils/is.ts";
import { openNewWindow } from "@/utils/win-manager";

import Setting from "../components/setting.vue";

const providerStore = useProviderStore();
const { t } = useI18n();

/** 云端/本地 provider 归各自 Tab 管理，此处仅展示第三方供应商 */
const EXCLUDED_PROVIDERS = new Set(["云端模型", "本地大模型"]);

/** 供应商显示名称：优先使用 i18n 映射，找不到则回退数据库中的名称 */
function providerDisplayName(provider: AIProvider) {
  return t(`providers.names.${provider.provider}`, {}, provider.provider);
}

/** 供应商描述：优先使用 i18n 映射，找不到则回退数据库中的描述 */
function providerDisplayDesc(provider: AIProvider) {
  return t(`providers.descs.${provider.provider}`, {}, provider.desc || "");
}

// 设置弹框状态
const settingOpen = ref(false);
const settingProvider = ref<AIProvider | null>(null);
const providers = computed(() => providerStore.stateProviders.filter(p => !EXCLUDED_PROVIDERS.has(p.provider)));

function openSetting(provider: AIProvider) {
  settingProvider.value = JSON.parse(JSON.stringify(provider));
  settingOpen.value = true;
}

/** 在新窗口中打开"添加自定义模型"表单，方便用户自由切换窗口复制地址/密钥 */
function handleOpenAddModal() {
  openNewWindow(RoutersName.ProviderAdd, {
    title: t("pages.preference.provider.labels.addCustomModel"),
  });
}

function handleRemoveProvider(provider: AIProvider) {
  providerStore.removeProvider(provider.provider);
  message.success(t("pages.preference.provider.messages.removedProvider", { provider: providerDisplayName(provider) }));
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 供应商列表（初始化的第三方 + 用户自定义添加的） -->
    <ProList :title="t('pages.preference.provider.labels.source')">
      <template #right>
        <!-- //刷新 -->
        <Button
          size="small"
          type="text"
          @click="providerStore.initDbProviders()"
        >
          <template #icon>
            <i class="i-lucide:refresh-ccw" />
          </template>
        </Button>
      </template>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <!-- 添加自定义模型卡片 -->
        <div
          class="hover:bg-blue-50/30 dark:hover:bg-blue-900/10 min-h-36 flex flex-col cursor-pointer items-center justify-center gap-3 b-2 rounded-xl b-dashed transition-all b-border-sec hover:b-blue-4"
          @click="handleOpenAddModal"
        >
          <div class="bg-blue-50 dark:bg-blue-900/30 size-12 flex items-center justify-center rounded-full text-7 text-blue-5">
            <i class="i-lucide:plus" />
          </div>
          <span class="text-4.5 font-medium color-text-secondary">{{ t('pages.preference.provider.labels.addCustomModel') }}</span>
          <span class="text-3 color-text-quaternary">{{ t('pages.preference.provider.hints.openAiCompatible') }}</span>
        </div>

        <!-- 供应商卡片 -->
        <div
          v-for="provider in providers"
          :key="provider.value"
          class="flex flex-col gap-3 b-1 rounded-xl b-solid p-5 transition-all bg-elevated b-border-sec hover:shadow-md"
          :class="{ 'b-blue-5! shadow-blue-200/30!': !!provider.apiKey }"
        >
          <!-- 卡片头部：头像 + 名称 + 标签 -->
          <div class="flex items-center gap-3">
            <PyAvatar
              :icon="provider.avatar"
              :url="provider.avatar"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-4 font-semibold">{{ providerDisplayName(provider) }}</span>
                <Tag
                  v-if="isBoolean(provider.isCustom) "
                  color="success"
                  variant="solid"
                >
                  <template #icon>
                    <CheckCircleOutlined />
                  </template>{{ t('pages.preference.provider.labels.custom') }}
                </Tag>
                <Tag
                  v-else-if="provider.apiKey"
                  color="success"
                  variant="filled"
                >
                  <template #icon>
                    <CheckCircleOutlined />
                  </template>{{ t('pages.preference.provider.labels.configured') }}
                </Tag>
                <Tag
                  v-else
                  color="warning"
                >
                  <template #icon>
                    <ExclamationCircleOutlined />
                  </template>
                  {{ t('pages.preference.provider.labels.unconfiguredKey') }}
                </Tag>
              </div>
            </div>
          </div>

          <!-- 描述 -->
          <div class="line-clamp-2 min-h-10 text-3 leading-relaxed color-text-tertiary">
            {{ providerDisplayDesc(provider) }}
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
          </div>

          <!-- 操作按钮 -->
          <div class="mt-auto flex gap-2 border-t pt-3 b-border-sec">
            <div class="flex-1" />
            <Button
              size="small"
              @click="openSetting(provider)"
            >
              <template #icon>
                <SettingOutlined />
              </template>
              {{ t('pages.preference.provider.labels.settings') }}
            </Button>

            <Popconfirm
              v-if="provider.isCustom"
              :description="t('pages.preference.provider.dialogs.removeConfirm')"
              placement="topRight"
              :title="t('pages.preference.provider.labels.removeProvider')"
              @confirm="handleRemoveProvider(provider)"
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
    </ProList>

    <!-- 设置弹框 -->
    <Setting
      v-if="settingOpen"
      v-model:open="settingOpen"
      :provider="settingProvider"
    />
  </div>
</template>
