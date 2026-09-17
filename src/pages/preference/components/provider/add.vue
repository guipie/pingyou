<script setup lang="ts">
import type { UploadEmits, UploadProps } from "antdv-next";

import { PlusCircleOutlined } from "@antdv-next/icons";
import { Button, Form, FormItem, Input, message, Modal, Radio, RadioGroup, Switch, Tag, TextArea, Upload } from "antdv-next";
import { onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { AIProvider, AiProviderModels, ModelCapability } from "@/stores/shard/provider-shard";

import PyAvatar from "@/components/py-avatar.vue";
import { LISTEN_KEY } from "@/constants";
import { useProviderStore } from "@/stores/aiprovider";
import { useGeneralStore } from "@/stores/general";
import { getImgBase64 } from "@/utils/path";

type FileType = Parameters<NonNullable<UploadProps["beforeUpload"]>>[0];

const generalStore = useGeneralStore();
const providerStore = useProviderStore();
const { t } = useI18n();

const addForm = ref({
  provider: "",
  value: "",
  avatar: "aipingyou.png",
  desc: "",
  baseUrl: "",
  apiKey: "",
  isNeedProxy: false,
});

// 多模型管理：独立于主表单的模型列表 + 弹框
interface ModelFormData {
  name: string
  modelId: string
  desc: string
  type: ModelCapability
}
const modelList = ref<ModelFormData[]>([]);
const modelModalOpen = ref(false);
const modelModalEditing = ref<number>(-1); // -1 = 新增，>=0 = 编辑
const modelModalForm = reactive<ModelFormData>({
  name: "",
  modelId: "",
  desc: "",
  type: "text",
});
const defaultModelId = ref("");

function openAddModelModal() {
  modelModalEditing.value = -1;
  modelModalForm.name = "";
  modelModalForm.modelId = "";
  modelModalForm.desc = "";
  modelModalForm.type = "text";
  modelModalOpen.value = true;
}

function openEditModelModal(index: number) {
  modelModalEditing.value = index;
  const m = modelList.value[index];
  modelModalForm.name = m.name;
  modelModalForm.modelId = m.modelId;
  modelModalForm.desc = m.desc;
  modelModalForm.type = m.type;
  modelModalOpen.value = true;
}

function handleModelModalOk() {
  if (!modelModalForm.name.trim() || !modelModalForm.modelId.trim()) {
    message.warning(t("pages.preference.provider.errors.fillComplete"));
    return;
  }
  // 校验 modelId 唯一
  const exists = modelList.value.some(
    (m, i) => m.modelId === modelModalForm.modelId.trim() && i !== modelModalEditing.value,
  );
  if (exists) {
    message.warning(t("pages.preference.provider.errors.modelIdExists"));
    return;
  }
  const data: ModelFormData = {
    name: modelModalForm.name.trim(),
    modelId: modelModalForm.modelId.trim(),
    desc: modelModalForm.desc.trim(),
    type: modelModalForm.type,
  };
  if (modelModalEditing.value === -1) {
    modelList.value.push(data);
    // 第一个模型自动设为默认
    if (modelList.value.length === 1) defaultModelId.value = data.modelId;
  } else {
    modelList.value[modelModalEditing.value] = data;
    // 如果编辑的是当前默认，更新 defaultModelId
    if (defaultModelId.value === modelModalForm.modelId.trim()) {
      defaultModelId.value = data.modelId;
    }
  }
  modelModalOpen.value = false;
}

function removeModel(index: number) {
  const removed = modelList.value[index];
  modelList.value.splice(index, 1);
  if (defaultModelId.value === removed.modelId) {
    defaultModelId.value = modelList.value[0]?.modelId ?? "";
  }
}

function setAsDefault(modelId: string) {
  defaultModelId.value = modelId;
}

// ── 暗黑模式 ─────────────────────────────────────────────────────
function applyDarkMode() {
  if (generalStore.appearance.isDark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

const stopWatch = watch(() => generalStore.appearance.isDark, applyDarkMode);
const isLocal = ref(false);
onMounted(async () => {
  try {
    await generalStore.$tauri.start();
    await generalStore.init();
  } catch {}
  applyDarkMode();
  const hash = window.location.hash;
  const queryStr = hash.includes("?") ? hash.split("?")[1] : "";
  if (queryStr) {
    const params = new URLSearchParams(queryStr);
    const baseUrl = params.get("baseUrl");
    const modelId = params.get("modelId");
    const modelName = params.get("modelName");
    const provider = params.get("provider");
    const modelType = params.get("modelType");
    isLocal.value = params.get("isLocal") === "true";
    if (baseUrl) addForm.value.baseUrl = decodeURIComponent(baseUrl);
    if (modelId) {
      const type: ModelCapability = (modelType === "vision" || modelType === "text") ? modelType : "text";
      modelList.value = [{
        name: modelName ? decodeURIComponent(modelName) : decodeURIComponent(modelId),
        modelId: decodeURIComponent(modelId),
        desc: "",
        type,
      }];
      defaultModelId.value = decodeURIComponent(modelId);
    }
    if (provider) {
      addForm.value.provider = decodeURIComponent(provider);
      if (!addForm.value.value) {
        addForm.value.value = decodeURIComponent(provider)
          .replace(/[^a-z0-9]/gi, "-")
          .toLowerCase();
      }
    }
  }
});

onUnmounted(() => {
  stopWatch();
});

// ── 提交 ─────────────────────────────────────────────────────────

async function handleSubmit() {
  const { provider, value, baseUrl } = addForm.value;

  if (!provider.trim()) {
    message.warning(t("pages.preference.provider.errors.providerNameRequired"));
    return;
  }
  if (!value.trim()) {
    message.warning(t("pages.preference.provider.errors.providerValueRequired"));
    return;
  }
  if (!baseUrl.trim()) {
    message.warning(t("pages.preference.provider.errors.baseUrlRequired"));
    return;
  }
  if (modelList.value.length === 0) {
    message.warning(t("pages.preference.provider.errors.modelRequired"));
    return;
  }

  const existProvider = providerStore.stateProviders.find(
    (p: AIProvider) => p.value === value.trim(),
  );
  if (existProvider) {
    message.warning(t("pages.preference.provider.errors.providerValueExists"));
    return;
  }

  const models: AiProviderModels[] = modelList.value.map(m => ({
    name: m.name,
    modelId: m.modelId,
    desc: m.desc,
    type: m.type,
    enabled: true,
  }));

  const newProvider: AIProvider = {
    provider: provider.trim(),
    value: value.trim(),
    avatar: addForm.value.avatar.trim() || provider.trim().charAt(0) || "logo.png",
    desc: addForm.value.desc.trim() || t("pages.preference.provider.messages.defaultCustomDesc"),
    baseUrl: baseUrl.trim(),
    isCustom: true,
    apiKey: addForm.value.apiKey.trim(),
    isNeedProxy: addForm.value.isNeedProxy,
    defaultModel: defaultModelId.value || models[0]?.modelId || "",
    models,
  };
  providerStore.addProvider(newProvider);
  message.success(t("pages.preference.provider.messages.addedCustomProvider", { provider: newProvider.provider }));

  const [{ emit }, { getCurrentWebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  await emit(LISTEN_KEY.PROVIDER_ADDED, newProvider);
  getCurrentWebviewWindow().close();
}

const avatarChange: UploadEmits["change"] = async (info) => {
  if (info.file) {
    addForm.value.avatar = await getImgBase64(info.file as FileType);
  }
};
</script>

<template>
  <div class="min-h-screen bg-[--ant-color-fill-secondary] p-6">
    <div class="mx-auto max-w-lg rounded-xl p-6 shadow-md bg-white dark:bg-warmGray-8">
      <h2 class="mb-6 text-slate-800 font-bold text-lg dark:text-white">
        {{ t('pages.preference.provider.labels.addCustomProvider') }}
      </h2>

      <div class="flex flex-col gap-4">
        <!-- 头像 + 供应商名称 -->
        <div class="flex gap-5">
          <Upload
            accept=".png,.jpg,.jpeg"
            action="/"
            :before-upload="() => false"
            class="avatar-uploader"
            list-type="picture-card"
            name="avatar"
            :show-upload-list="false"
            style="width: 86px; height: 86px"
            @change="avatarChange"
          >
            <PyAvatar
              v-if="addForm.avatar"
              cus-style="width: 66px; height: 66px"
              :url="addForm.avatar"
            />
            <button
              v-else
              style="border: 0; background: none"
              type="button"
            >
              <PlusOutlined />
              <div style="margin-top: 8px">
                {{ t('pages.preference.provider.labels.avatar') }}
              </div>
            </button>
          </Upload>

          <div class="flex flex-1 flex-col justify-evenly gap-1.5">
            <label class="text-3.5 font-medium">
              {{ t('pages.preference.provider.labels.providerName') }}
              <span class="text-red-5">*</span>
            </label>
            <Input
              v-model:value="addForm.provider"
              :disabled="isLocal"
              :placeholder="t('pages.preference.provider.placeholders.providerName')"
            />
          </div>
        </div>

        <!-- 供应商标识 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            {{ t('pages.preference.provider.labels.providerValue') }}
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.value"
            :placeholder="t('pages.preference.provider.placeholders.providerValue')"
          />
        </div>

        <!-- Base URL -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">
            Base URL
            <span class="text-red-5">*</span>
          </label>
          <Input
            v-model:value="addForm.baseUrl"
            :placeholder="t('pages.preference.provider.placeholders.baseUrl')"
          />
        </div>

        <!-- 多模型配置区：折叠式 + 弹框添加 -->
        <div class="bg-blue-50/50 border border-slate-200 p-3 rounded-lg dark:border-warmGray-600 dark:bg-warmGray-700/50">
          <div class="mb-2 flex items-center justify-between">
            <div class="text-3 text-slate-600 font-medium dark:text-warmGray-300">
              {{ t('pages.preference.provider.labels.modelConfig') }}
              <span class="text-red-5">*</span>
            </div>
            <Button
              size="small"
              type="dashed"
              @click="openAddModelModal"
            >
              <template #icon>
                <PlusCircleOutlined />
              </template>
              {{ t('pages.preference.provider.modelDialog.buttons.add') }}
            </Button>
          </div>

          <!-- 已配置模型列表 -->
          <div
            v-if="modelList.length === 0"
            class="py-4 text-center text-2.5 color-text-quaternary"
          >
            {{ t('pages.preference.provider.hints.noModelConfigured') }}
          </div>
          <div
            v-else
            class="flex flex-col gap-2"
          >
            <div
              v-for="(m, i) in modelList"
              :key="m.modelId"
              class="flex items-center justify-between gap-2 border border-slate-200 p-2.5 bg-white rounded-lg dark:border-warmGray-600 dark:bg-warmGray-900"
            >
              <div class="min-w-0 flex items-center gap-2">
                <div
                  class="shrink-0 text-14px"
                  :class="m.type === 'vision' ? 'i-solar:eye-linear text-purple-5' : 'i-solar:chat-line-bold text-blue-5'"
                />
                <span class="truncate text-13px text-slate-700 font-medium">{{ m.name }}</span>
                <span class="truncate text-11px text-slate-400 font-mono">{{ m.modelId }}</span>
                <Tag
                  v-if="defaultModelId === m.modelId"
                  class="!text-2"
                  color="blue"
                  variant="filled"
                >
                  {{ t('pages.preference.provider.cloud.labels.current') }}
                </Tag>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  v-if="defaultModelId !== m.modelId"
                  size="small"
                  type="link"
                  @click="setAsDefault(m.modelId)"
                >
                  {{ t('pages.preference.provider.cloud.labels.setDefault') }}
                </Button>
                <Button
                  size="small"
                  type="link"
                  @click="openEditModelModal(i)"
                >
                  {{ t('pages.preference.provider.modelDialog.buttons.edit') }}
                </Button>
                <Button
                  danger
                  size="small"
                  type="link"
                  @click="removeModel(i)"
                >
                  {{ t('pages.preference.provider.modelDialog.buttons.remove') }}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- API Key -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.apiKeyOptional') }}</label>
          <Input.Password
            v-model:value="addForm.apiKey"
            :placeholder="t('pages.preference.provider.placeholders.apiKey')"
          />
        </div>

        <!-- 是否需要代理 -->
        <div
          class="flex items-center justify-between bg-[--ant-color-fill-quaternary] p-3 rounded-lg"
        >
          <div>
            <div class="text-3.5 font-medium">
              {{ t('pages.preference.provider.labels.needProxy') }}
            </div>
            <div class="mt-0.5 text-2.5 color-text-quaternary">
              {{ t('pages.preference.provider.hints.proxyDesc') }}
            </div>
          </div>
          <Switch v-model:checked="addForm.isNeedProxy" />
        </div>

        <!-- 描述 -->
        <div class="flex flex-col gap-1.5">
          <label class="text-3.5 font-medium">{{ t('pages.preference.provider.labels.providerDesc') }}</label>
          <TextArea
            v-model:value="addForm.desc"
            :placeholder="t('pages.preference.provider.placeholders.providerDesc')"
            :rows="4"
          />
        </div>

        <!-- 确认按钮 -->
        <Button
          block
          type="primary"
          @click="handleSubmit"
        >
          {{ t('pages.preference.provider.labels.addProvider') }}
        </Button>
      </div>
    </div>

    <!-- 添加/编辑模型弹框 -->
    <Modal
      v-model:open="modelModalOpen"
      :title="modelModalEditing === -1
        ? t('pages.preference.provider.modelDialog.hints.addModel')
        : t('pages.preference.provider.modelDialog.hints.editModel')"
      @ok="handleModelModalOk"
    >
      <template #footer>
        <Button @click="modelModalOpen = false">
          {{ t('pages.preference.provider.modelDialog.buttons.cancel') }}
        </Button>
        <Button
          type="primary"
          @click="handleModelModalOk"
        >
          {{ t('pages.preference.provider.modelDialog.buttons.confirmAdd') }}
        </Button>
      </template>
      <Form
        auto-complete="off"
        :label-col="{ span: 6 }"
        :model="modelModalForm"
        style="max-width: 500px"
        :wrapper-col="{ span: 17 }"
      >
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelName')"
          name="name"
          :rules="[{ required: true }]"
        >
          <Input v-model:value="modelModalForm.name" />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelId')"
          name="modelId"
          :rules="[{ required: true }]"
        >
          <Input
            v-model:value="modelModalForm.modelId"
            placeholder="deepseek-v4-flash"
          />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.description')"
          name="desc"
        >
          <TextArea v-model:value="modelModalForm.desc" />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.labels.modelType')"
          name="type"
        >
          <RadioGroup v-model:value="modelModalForm.type">
            <Radio value="text">
              {{ t('pages.preference.provider.labels.modelTypeText') }}
            </Radio>
            <Radio value="vision">
              {{ t('pages.preference.provider.labels.modelTypeVision') }}
            </Radio>
          </RadioGroup>
        </FormItem>
      </Form>
    </Modal>
  </div>
</template>
