<script setup lang="ts">
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Empty, Input, message, Select, Spin, Tag } from "antdv-next";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { AIProvider, AiProviderModels, ModelCapability } from "@/stores/shard/provider-shard";

import { WEB_BASE } from "@/config";
import { useProviderStore } from "@/stores/aiprovider";
import { useUserStore } from "@/stores/user";

const { t } = useI18n();
const userStore = useUserStore();
const providerStore = useProviderStore();

/** 云端模型供应商标识 — 单例 */
const CLOUD_PROVIDER = "云端模型";
const CLOUD_VALUE = "cloud-models";
/** 七牛大模型推理 OpenAI 兼容接入点 */
const QINIU_BASE_URL = "https://api.qnaigc.com/v1/chat/completions";

// ---- 模型数据类型（与云端字典 API 对齐） ----
interface CloudModelInfo {
  id: string
  name: string
  description: string
  avatar: string
  hot_tags: string[]
  features: string[]
  issuer: { name: string, avatar: string }
  architecture: {
    input_modalities: string[]
    output_modalities: string[]
    function_calling: { supported: boolean }
    reasoning: { supported: boolean }
    schema_output: { supported: boolean }
  }
  model_constraints: { context_length: number }
  support_api_protocols: string[]
  retirement_at: string
  release_at: string
  rank: number
}
interface QuotaItem { limitYuan: number }
interface AiQuotaResponse {
  plan: "free" | "pro" | "team"
  planPeriod?: "monthly" | "yearly" | null
  apiKey: string | null
  quota: { daily: QuotaItem | null, monthly: QuotaItem | null, total: QuotaItem | null } | null
}

// ---- 状态 ----
const loading = ref(false);
const apiKey = ref<string>("");
const quota = ref<AiQuotaResponse | null>(null);
const allModels = ref<CloudModelInfo[]>([]);

// ---- 筛选 ----
const searchText = ref("");
const selectedIssuers = ref<string[]>([]);
const selectedFeatures = ref<string[]>([]);
const selectedModality = ref<string>(""); // "" 全部 / "text-only" / "multimodal"
const showRetired = ref(false);

// ---- 云端供应商（从 store 取，单一数据源） ----
const cloudProvider = computed(() => providerStore.stateProviders.find(x => x.provider === CLOUD_PROVIDER));
/** 已启用的模型 ID 集合（从 store 派生，保证不漂移） */
const enabledModelIds = computed(() => {
  const ids = new Set<string>();
  cloudProvider.value?.models?.forEach((m) => {
    if (m.enabled !== false) ids.add(m.modelId);
  });
  return ids;
});
/** 当前默认模型 ID（从 store 派生） */
const currentDefault = computed(() => cloudProvider.value?.defaultModel ?? "");

const issuerOptions = computed(() => {
  const set = new Set<string>();
  allModels.value.forEach((m) => {
    if (m.issuer?.name) set.add(m.issuer.name);
  });
  return [...set].sort();
});
const featureOptions = computed(() => {
  const set = new Set<string>();
  allModels.value.forEach(m => (m.features ?? []).forEach(f => set.add(f)));
  return [...set].sort();
});
function isRetired(m: CloudModelInfo) {
  if (!m.retirement_at) return false;
  const d = new Date(m.retirement_at).getTime();
  return d > 0 && d < Date.now();
}
const filteredModels = computed(() => {
  let list = allModels.value;
  const kw = searchText.value.trim().toLowerCase();
  if (kw) {
    list = list.filter(m =>
      m.id.toLowerCase().includes(kw)
      || m.name.toLowerCase().includes(kw)
      || (m.description ?? "").toLowerCase().includes(kw),
    );
  }
  if (selectedIssuers.value.length) {
    list = list.filter(m => selectedIssuers.value.includes(m.issuer?.name ?? ""));
  }
  if (selectedFeatures.value.length) {
    list = list.filter(m => selectedFeatures.value.some(f => (m.features ?? []).includes(f)));
  }
  if (selectedModality.value === "text-only") {
    list = list.filter(m =>
      (m.architecture?.input_modalities ?? []).length === 1
      && m.architecture?.input_modalities?.[0] === "text",
    );
  } else if (selectedModality.value === "multimodal") {
    list = list.filter(m =>
      (m.architecture?.input_modalities ?? []).some(m2 => m2 !== "text"),
    );
  }
  if (!showRetired.value) list = list.filter(m => !isRetired(m));
  return [...list].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
});

// ---- 工具 ----
function formatYuan(n: number): string {
  return `¥${Number(n).toFixed(2)}`;
}
function formatContext(len: number): string {
  if (!len || len <= 0) return "—";
  if (len >= 1000000) return `${(len / 1000000).toFixed(len % 1000000 ? 1 : 0)}M`;
  if (len >= 1000) return `${(len / 1000).toFixed(0)}K`;
  return String(len);
}
function openLogin() {
  openUrl(`${WEB_BASE}/login?desktop=1`);
}

/** 根据云端模型的 input_modalities 判定能力类型 */
function inferModelType(m: CloudModelInfo): ModelCapability {
  const mods = m.architecture?.input_modalities ?? [];
  return mods.some(x => x !== "text") ? "vision" : "text";
}

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

async function loadModels() {
  if (!userStore.loggedIn) return;
  loading.value = true;
  try {
    if (!apiKey.value) apiKey.value = await loadQuotaAndKey();
    const res = await tauriFetch(`${WEB_BASE}/api/dictionaries/cloud-models`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dict = (await res.json()) as { value: { status: boolean, data: CloudModelInfo[] } };
    allModels.value = dict.value?.data ?? [];
  } catch (err) {
    console.error("[cloud-tab] 拉取模型列表失败：", err);
    message.error(t("pages.preference.provider.cloud.messages.loadModelsFailed"));
  } finally {
    loading.value = false;
  }
}

// ---- 核心：确保云端供应商存在 ----
function ensureCloudProvider(): AIProvider {
  let provider = cloudProvider.value;
  if (provider) return provider;
  provider = {
    provider: CLOUD_PROVIDER,
    value: CLOUD_VALUE,
    avatar: "i-lucide:cloud",
    desc: t("pages.preference.provider.cloud.desc"),
    baseUrl: QINIU_BASE_URL,
    isCustom: false,
    isNeedProxy: false,
    apiKey: apiKey.value,
    defaultModel: "",
    models: [],
  };
  providerStore.addProvider(provider);
  return provider;
}

// ---- 启用模型（追加到 provider.models） ----
function enableModel(cloudModel: CloudModelInfo) {
  const provider = ensureCloudProvider();
  if (!provider.apiKey) {
    message.warning(t("pages.preference.provider.cloud.messages.loginFirst"));
    return;
  }
  const models = provider.models ? [...provider.models] : [];
  // 已存在则跳过
  if (models.some(m => m.modelId === cloudModel.id)) {
    message.info(t("pages.preference.provider.cloud.messages.alreadyEnabled"));
    return;
  }
  const newModel: AiProviderModels = {
    name: cloudModel.name,
    modelId: cloudModel.id,
    desc: cloudModel.description ?? "",
    type: inferModelType(cloudModel),
    enabled: true,
  };
  models.push(newModel);
  const updated: AIProvider = {
    ...provider,
    models,
    defaultModel: provider.defaultModel || cloudModel.id, // 第一个启用的自动设为默认
  };
  providerStore.updateProvider(updated);
  message.success(t("pages.preference.provider.cloud.messages.enabled"));
}

// ---- 停用模型（从 provider.models 移除） ----
function disableModel(cloudModelId: string) {
  const provider = cloudProvider.value;
  if (!provider) return;
  const models = (provider.models ?? []).filter(m => m.modelId !== cloudModelId);
  let defaultModel = provider.defaultModel;
  // 停用时如果是当前默认，自动切到剩余第一个
  if (defaultModel === cloudModelId) {
    defaultModel = models[0]?.modelId ?? "";
  }
  providerStore.updateProvider({ ...provider, models, defaultModel });
  message.info(t("pages.preference.provider.cloud.messages.disabled"));
}

// ---- 设为默认 ----
function setDefault(cloudModelId: string) {
  const provider = cloudProvider.value;
  if (!provider) return;
  providerStore.updateProvider({ ...provider, defaultModel: cloudModelId });
}

// ---- 生命周期 ----
onMounted(() => {
  // 从已有 provider 恢复 apiKey
  if (cloudProvider.value?.defaultModel) {
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
    allModels.value = [];
    apiKey.value = "";
    quota.value = null;
  }
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 未登录 -->
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

    <!-- 已登录 -->
    <template v-else>
      <!-- 顶部：标题 + 会员信息 + 额度 + 刷新 + 已启用计数 -->
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center gap-2">
          <i class="i-lucide:cloud-cog text-blue-5 text-lg" />
          <span class="text-4 font-semibold">{{ t('pages.preference.provider.cloud.title') }}</span>
          <Tag :color="userStore.user?.plan === 'pro' ? 'gold' : userStore.user?.plan === 'team' ? 'purple' : 'default'">
            {{ userStore.planLabel }}
          </Tag>
        </div>
        <div class="flex-1" />
        <span
          v-if="enabledModelIds.size"
          class="text-3 font-medium color-text-quaternary"
        >
          {{ t('pages.preference.provider.cloud.labels.enabledCount', { n: enabledModelIds.size }) }}
        </span>
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

      <!-- 筛选栏 -->
      <div class="flex flex-col gap-3 border rounded-xl border-solid p-4 bg-elevated border-border-sec">
        <div class="flex flex-wrap items-center gap-3">
          <Input
            v-model:value="searchText"
            allow-clear
            class="!min-w-50 !flex-1"
            placeholder="搜索模型名称、ID 或描述"
          >
            <template #prefix>
              <i class="i-lucide:search color-text-quaternary" />
            </template>
          </Input>
          <Select
            v-model:value="selectedModality"
            allow-clear
            class="!w-40"
            :options="[
              { value: '', label: '全部模态' },
              { value: 'text-only', label: '纯文本' },
              { value: 'multimodal', label: '多模态' },
            ]"
            placeholder="输入模态"
          />
          <label class="flex cursor-pointer items-center gap-1.5 text-3 color-text-secondary">
            <input
              v-model="showRetired"
              class="size-3.5"
              type="checkbox"
            >
            显示已退役
          </label>
        </div>
        <div
          v-if="issuerOptions.length"
          class="flex flex-wrap items-center gap-2"
        >
          <span class="shrink-0 text-2.5 color-text-quaternary">厂商</span>
          <Tag
            v-for="issuer in issuerOptions"
            :key="issuer"
            class="cursor-pointer select-none"
            :color="selectedIssuers.includes(issuer) ? 'blue' : 'default'"
            @click="selectedIssuers.includes(issuer)
              ? (selectedIssuers = selectedIssuers.filter(i => i !== issuer))
              : selectedIssuers.push(issuer)"
          >
            {{ issuer }}
          </Tag>
        </div>
        <div
          v-if="featureOptions.length"
          class="flex flex-wrap items-center gap-2"
        >
          <span class="shrink-0 text-2.5 color-text-quaternary">特性</span>
          <Tag
            v-for="feat in featureOptions"
            :key="feat"
            class="cursor-pointer select-none"
            :color="selectedFeatures.includes(feat) ? 'blue' : 'default'"
            @click="selectedFeatures.includes(feat)
              ? (selectedFeatures = selectedFeatures.filter(f => f !== feat))
              : selectedFeatures.push(feat)"
          >
            {{ feat }}
          </Tag>
        </div>
        <div class="text-2.5 color-text-quaternary">
          共 {{ filteredModels.length }} 个模型
          <span v-if="showRetired && allModels.some(isRetired)">
            （含 {{ allModels.filter(isRetired).length }} 个已退役）
          </span>
        </div>
      </div>

      <!-- 模型列表 -->
      <div
        v-if="loading"
        class="flex justify-center py-16"
      >
        <Spin size="large" />
      </div>
      <div
        v-else-if="filteredModels.length === 0"
        class="py-16"
      >
        <Empty description="没有符合条件的模型" />
      </div>
      <div
        v-else
        class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4"
      >
        <div
          v-for="model in filteredModels"
          :key="model.id"
          class="flex flex-col gap-3 border rounded-xl border-solid p-4 transition-all bg-elevated border-border-sec hover:shadow-md"
          :class="{
            'b-blue-5! shadow-blue-200/30!': currentDefault === model.id,
            'opacity-50!': isRetired(model),
          }"
        >
          <!-- 头部 -->
          <div class="flex items-start gap-3">
            <div class="bg-blue-50/60 dark:bg-blue-900/20 size-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full">
              <img
                v-if="model.avatar"
                :alt="model.issuer?.name"
                class="size-12 object-contain"
                :src="model.avatar"
              >
              <i
                v-else
                class="i-lucide:brain text-blue-5 text-lg"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span
                  class="truncate text-3.5 font-medium"
                  :title="model.id"
                >{{ model.name }}</span>
                <Tag
                  v-if="model.hot_tags?.length"
                  class="!text-2"
                  color="volcano"
                  variant="filled"
                >
                  {{ model.hot_tags[0] }}
                </Tag>
                <Tag
                  v-if="isRetired(model)"
                  class="!text-2"
                  color="red"
                >
                  已退役
                </Tag>
                <Tag
                  v-if="currentDefault === model.id"
                  class="!text-2"
                  color="blue"
                  variant="filled"
                >
                  {{ t('pages.preference.provider.cloud.labels.current') }}
                </Tag>
              </div>
              <span class="text-2.5 color-text-quaternary">{{ model.issuer?.name }}</span>
            </div>
          </div>

          <!-- 描述 -->
          <p
            v-if="model.description"
            class="line-clamp-2 text-2.5 leading-relaxed color-text-tertiary"
          >
            {{ model.description }}
          </p>

          <!-- 特性标签 -->
          <div
            v-if="model.features?.length"
            class="flex flex-wrap gap-1"
          >
            <Tag
              v-for="feat in model.features"
              :key="feat"
              class="!text-2"
              :color="selectedFeatures.includes(feat) ? 'blue' : 'default'"
              size="small"
            >
              {{ feat }}
            </Tag>
          </div>

          <!-- 底部信息 -->
          <div class="mt-auto flex items-center gap-3 text-2.5 color-text-quaternary">
            <span class="flex items-center gap-1">
              <i class="i-lucide:fold-vertical" />
              {{ formatContext(model.model_constraints?.context_length ?? 0) }}
            </span>
            <span
              v-if="model.architecture?.input_modalities?.some(m => m !== 'text')"
              class="flex items-center gap-1"
            >
              <i class="i-lucide:image" />
              {{ model.architecture.input_modalities.filter(m => m !== 'text').join(' / ') }}
            </span>
            <span
              v-if="model.support_api_protocols?.length"
              class="flex items-center gap-1"
            >
              <i class="i-lucide:plug" />
              {{ model.support_api_protocols.join(' / ') }}
            </span>
          </div>

          <!-- 操作区 -->
          <div class="flex items-center gap-2 pt-1">
            <div class="flex-1" />
            <!-- 未启用：显示"启用" -->
            <template v-if="!enabledModelIds.has(model.id)">
              <Button
                :disabled="isRetired(model)"
                size="small"
                type="primary"
                @click="enableModel(model)"
              >
                {{ t('pages.preference.provider.cloud.labels.use') }}
              </Button>
            </template>
            <!-- 已启用：显示"停用"+"设为默认" -->
            <template v-else>
              <Button
                v-if="currentDefault !== model.id"
                size="small"
                @click="setDefault(model.id)"
              >
                {{ t('pages.preference.provider.cloud.labels.setDefault') }}
              </Button>
              <Button
                danger
                size="small"
                type="link"
                @click="disableModel(model.id)"
              >
                {{ t('pages.preference.provider.cloud.labels.disable') }}
              </Button>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
