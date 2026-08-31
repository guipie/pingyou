<script setup lang="ts">
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Empty, message, Spin, Tag } from "antdv-next";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { AIProvider } from "@/stores/shard/provider-shard";

import { useProviderStore } from "@/stores/aiprovider";
import { useUserStore } from "@/stores/user";

const emit = defineEmits<{
  (e: "useCloudModel", payload: { baseUrl: string, modelName: string, modelId: string, provider: string, apiKey: string }): void
}>();

const { t } = useI18n();
const userStore = useUserStore();
const providerStore = useProviderStore();

/** 云端模型供应商标识（数据库主键，展示时通过 i18n 映射） */
const CLOUD_PROVIDER = "云端模型";

/** 七牛大模型推理 OpenAI 兼容接入点 */
const QINIU_BASE_URL = "https://api.qnaigc.com/v1/chat/completions";
/** 七牛可用模型列表（OpenAI 兼容） */
const QINIU_MODELS_URL = "https://api.qnaigc.com/v1/models";

/** 屏友 Web 后端地址（与 preference/index.vue 保持一致） */
const WEB_BASE = (() => {
  const env = import.meta.env.VITE_PINGYOU_WEB_BASE as string | undefined;
  if (env) return env.replace(/\/$/, "");
  if (import.meta.env.DEV) return "http://localhost:4000";
  return "https://py.lm56.top";
})();

interface CloudModel { id: string, name: string }
interface QuotaItem { limitYuan: number }
interface AiQuotaResponse {
  plan: "free" | "pro" | "team"
  planPeriod?: "monthly" | "yearly" | null
  apiKey: string | null
  quota: { daily: QuotaItem | null, monthly: QuotaItem | null, total: QuotaItem | null } | null
}

const loading = ref(false);
const enabling = ref(false);
const apiKey = ref<string>("");
const quota = ref<AiQuotaResponse | null>(null);
const models = ref<CloudModel[]>([]);
const currentDefault = ref("");

/** 已启用的云端 provider（若有） */
const cloudProvider = computed(() => providerStore.stateProviders.find(x => x.provider === CLOUD_PROVIDER));

function formatYuan(n: number): string {
  return `¥${Number(n).toFixed(2)}`;
}

/** 登录：打开浏览器跳转 Web 登录页 */
function openLogin() {
  openUrl(`${WEB_BASE}/login?desktop=1`);
}

/** 拉取当前用户的 key + 额度（复用 /api/ai/quota，一次请求同时拿两份数据） */
async function loadQuotaAndKey(): Promise<string> {
  const res = await tauriFetch(`${WEB_BASE}/api/ai/quota`, {
    method: "GET",
    headers: { Authorization: `Bearer ${userStore.token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as AiQuotaResponse;
  quota.value = data;
  if (!data.apiKey) throw new Error("NO_KEY");
  return data.apiKey;
}

/** 拉取七牛所有可用模型（OpenAI 兼容 /v1/models） */
async function loadModels() {
  if (!userStore.loggedIn) return;
  loading.value = true;
  try {
    if (!apiKey.value) apiKey.value = await loadQuotaAndKey();

    const res = await tauriFetch(QINIU_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    models.value = (data.data ?? []).map(m => ({ id: m.id, name: m.id }));
  } catch (err) {
    console.error("[cloud-tab] 拉取模型列表失败：", err);
    message.error(t("pages.preference.provider.cloud.messages.loadModelsFailed"));
  } finally {
    loading.value = false;
  }
}

/** 启用某个模型：注册云端 provider，默认模型设为该模型 */
async function handleUse(model: CloudModel) {
  if (!apiKey.value) {
    message.warning(t("pages.preference.provider.cloud.messages.loginFirst"));
    return;
  }
  enabling.value = true;
  try {
    const provider: AIProvider = {
      provider: CLOUD_PROVIDER,
      value: CLOUD_PROVIDER,
      avatar: "i-lucide:cloud",
      desc: t("pages.preference.provider.cloud.desc"),
      baseUrl: QINIU_BASE_URL,
      isCustom: false,
      isNeedProxy: false,
      apiKey: apiKey.value,
      defaultModel: model.id,
      models: models.value.map(m => ({ name: m.name, desc: "", modelId: m.id })),
    };
    providerStore.addProvider(provider);
    currentDefault.value = model.id;
    message.success(t("pages.preference.provider.cloud.messages.enabled"));
    emit("useCloudModel", {
      baseUrl: QINIU_BASE_URL,
      modelName: model.name,
      modelId: model.id,
      provider: CLOUD_PROVIDER,
      apiKey: apiKey.value,
    });
  } catch (err) {
    console.error("[cloud-tab] 启用模型失败：", err);
    message.error(String(err));
  } finally {
    enabling.value = false;
  }
}

onMounted(() => {
  // 若已有云端 provider，同步当前默认模型
  if (cloudProvider.value?.defaultModel) {
    currentDefault.value = cloudProvider.value.defaultModel;
    apiKey.value = cloudProvider.value.apiKey ?? "";
  }
  loadModels();
});

watch(() => userStore.loggedIn, (v) => {
  if (v) {
    apiKey.value = "";
    quota.value = null;
    loadModels();
  } else {
    models.value = [];
    apiKey.value = "";
    quota.value = null;
    currentDefault.value = "";
  }
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 未登录：提醒登录卡片 -->
    <div
      v-if="!userStore.loggedIn"
      class="flex flex-col items-center justify-center gap-4 b-1 rounded-xl b-dashed py-20 b-border-sec"
    >
      <div class="bg-blue-50/60 dark:bg-blue-900/20 size-16 flex items-center justify-center rounded-full">
        <i class="i-lucide:cloud-cog text-3xl text-blue-5" />
      </div>
      <span class="text-4 font-semibold">{{ t('pages.preference.provider.cloud.title') }}</span>
      <span class="text-3 color-text-tertiary">{{ t('pages.preference.provider.cloud.hints.loginToUse') }}</span>
      <Button
        type="primary"
        @click="openLogin"
      >
        {{ t('pages.preference.provider.cloud.labels.login') }}
      </Button>
    </div>

    <!-- 已登录：额度 + 全部可用模型 -->
    <template v-else>
      <!-- 顶部：标题 + 会员信息 + 额度 + 刷新 -->
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center gap-2">
          <i class="i-lucide:cloud-cog text-blue-5 text-lg" />
          <span class="text-4 font-semibold">{{ t('pages.preference.provider.cloud.title') }}</span>
          <Tag :color="userStore.user?.plan === 'pro' ? 'gold' : userStore.user?.plan === 'team' ? 'purple' : 'default'">
            {{ userStore.planLabel }}
          </Tag>
        </div>
        <div class="flex-1" />
        <!-- 到期日期 -->
        <span class="text-3 color-text-quaternary">{{ userStore.user?.planExpiresAt ? new Date(userStore.user.planExpiresAt).toLocaleDateString() : "free" }}</span>
        <Button
          :loading="loading"
          size="small"
          type="text"
          @click="loadModels"
        >
          <template #icon>
            <i class="i-lucide:refresh-ccw" />
          </template>
        </Button>
      </div>

      <!-- 额度卡片 -->
      <div
        v-if="loading && !quota"
        class="flex justify-center py-2"
      >
        <Spin size="small" />
      </div>
      <div
        v-else-if="quota?.quota"
        class="flex flex-wrap items-center gap-x-8 gap-y-2 border rounded-xl border-solid p-4 bg-elevated border-border-sec"
      >
        <div class="text-2.5 font-medium color-text-quaternary">
          {{ t('pages.preference.provider.cloud.labels.quota') }}
        </div>
        <div
          v-if="quota.quota.monthly"
          class="flex items-center gap-2 text-3"
        >
          <span class="color-text-secondary">{{ t('pages.preference.provider.cloud.labels.monthlyQuota') }}</span>
          <span class="font-medium">{{ formatYuan(quota.quota.monthly.limitYuan) }}</span>
        </div>
        <div
          v-if="quota.quota.total"
          class="flex items-center gap-2 text-3"
        >
          <span class="color-text-secondary">{{ t('pages.preference.provider.cloud.labels.yearlyQuota') }}</span>
          <span class="font-medium">{{ formatYuan(quota.quota.total.limitYuan) }}</span>
        </div>
        <div
          v-if="quota.quota.daily"
          class="flex items-center gap-2 text-3"
        >
          <span class="color-text-secondary">{{ t('pages.preference.provider.cloud.labels.dailyQuota') }}</span>
          <span class="font-medium">{{ formatYuan(quota.quota.daily.limitYuan) }}</span>
        </div>
        <div
          v-if="!quota.quota.monthly && !quota.quota.total && !quota.quota.daily"
          class="text-3 color-text-quaternary"
        >
          {{ t('pages.preference.provider.cloud.hints.unlimited') }}
        </div>
      </div>
      <div
        v-else-if="quota && !quota.apiKey"
        class="text-3 color-text-quaternary"
      >
        {{ t('pages.preference.provider.cloud.hints.noKey') }}
      </div>

      <!-- 模型列表 -->
      <div
        v-if="loading"
        class="flex justify-center py-16"
      >
        <Spin size="large" />
      </div>
      <div
        v-else-if="models.length === 0"
        class="py-16"
      >
        <Empty :description="t('pages.preference.provider.cloud.hints.noModels')" />
      </div>
      <div
        v-else
        class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4"
      >
        <div
          v-for="model in models"
          :key="model.id"
          class="flex flex-col gap-3 border rounded-xl border-solid p-4 transition-all bg-elevated border-border-sec hover:shadow-md"
          :class="{ 'b-blue-5! shadow-blue-200/30!': currentDefault === model.id }"
        >
          <div class="flex items-center gap-2">
            <div class="bg-blue-50/60 dark:bg-blue-900/20 size-10 flex shrink-0 items-center justify-center rounded-full">
              <i class="i-lucide:brain text-blue-5 text-lg" />
            </div>
            <span
              class="min-w-0 flex-1 truncate text-3.5 font-medium font-mono"
              :title="model.id"
            >
              {{ model.name }}
            </span>
          </div>

          <div class="mt-auto flex items-center gap-2">
            <div class="flex-1" />
            <Tag
              v-if="currentDefault === model.id"
              color="blue"
              variant="filled"
            >
              {{ t('pages.preference.provider.cloud.labels.current') }}
            </Tag>
            <Button
              :loading="enabling"
              size="small"
              type="primary"
              @click="handleUse(model)"
            >
              {{ currentDefault === model.id ? t('pages.preference.provider.cloud.labels.switchTo') : t('pages.preference.provider.cloud.labels.use') }}
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
