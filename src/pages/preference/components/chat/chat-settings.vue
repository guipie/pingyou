<script setup lang="ts">
import type { UploadEmits, UploadProps } from "antdv-next";

import { PlusOutlined } from "@antdv-next/icons";
import { Button, Input, InputPassword, message, Select, Space, Switch, Tag, TextArea, Upload } from "antdv-next";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { TauriAIConversation } from "@/stores/shard/chat-shard";
import type { AIProvider, AiProviderModels } from "@/stores/shard/provider-shard";

import ProListItem from "@/components/pro-list-item/index.vue";
import ProList from "@/components/pro-list/index.vue";
import PyAvatar from "@/components/py-avatar.vue";
import { useChatStore } from "@/stores/aichat";
import { useProviderStore } from "@/stores/aiprovider";
import { useRouteSettingStore } from "@/stores/route-setting";
import { isBoolean } from "@/utils/is";
import { getImgBase64 } from "@/utils/path";

type FileType = Parameters<NonNullable<UploadProps["beforeUpload"]>>[0];
const pvStore = useProviderStore();
const chatStore = useChatStore();
const routeStore = useRouteSettingStore();
const curConversation = ref<TauriAIConversation | null>(JSON.parse(JSON.stringify(chatStore.currentConversation ?? "null")));
const curSelectedProviderVal = ref<string | null>(curConversation.value?.provider.value ?? null);
const curSeletedProvider = computed(() => pvStore.stateProviders.find((item: AIProvider) => item.value === curSelectedProviderVal.value));
const curSeletedModel = ref(curSeletedProvider.value?.defaultModel);
watch(() => curSelectedProviderVal.value, (_) => {
  curSeletedModel.value = curSeletedProvider.value?.defaultModel;
});
const { t } = useI18n();
const cloneConversation = ref<TauriAIConversation | null>(null);
// const customModel = ref("");
onMounted(() => {
  if (!curConversation.value) {
    routeStore.backHome();
    return;
  }
  cloneConversation.value = JSON.parse(JSON.stringify(curConversation.value));
});
function handleRecovery() {
  if (cloneConversation.value && curConversation.value) {
    curConversation.value = cloneConversation.value;
  }
}

const avatarChange: UploadEmits["change"] = async (info) => {
  if (!curConversation.value) return;
  if (info.file) {
    curConversation.value.avatar = await getImgBase64(info.file as FileType);
  } else {
    message.warning(t("pages.preference.chat.messages.uploadFailed"));
  }
};
function saveConversation() {
  if (!curConversation.value) return;
  if (!curSeletedProvider.value || (!curSeletedProvider.value.apiKey && !isBoolean(curSeletedProvider.value.isCustom))) {
    return message.warning(t("pages.preference.chat.messages.configureProvider"));
  }
  if (!curSeletedModel.value)
    return message.warning(t("pages.preference.chat.messages.selectModel"));
  if (!curConversation.value.title.trim())
    return message.warning(t("pages.preference.chat.messages.fillName"));
  curConversation.value.provider = curSeletedProvider.value;
  curConversation.value.provider.defaultModel = curSeletedModel.value;
  chatStore.updateConversation(curConversation.value);
  message.success(t("pages.preference.chat.messages.saveSuccess"));
}
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <Button
          color="primary"
          variant="text"
          @click="routeStore.backHome(1)"
        >
          <i class="i-lucide:arrow-left" />
          {{ t('common.buttons.back') }}
        </Button>
        <span class="text-5 font-medium">
          {{ t('pages.preference.chat.labels.conversationConfig') }}
        </span>
      </div>
      <div>
        <Button
          type="text"
          @click="handleRecovery"
        >
          <i class="i-lucide:settings-2" />
          {{ t('common.buttons.resetToDefault') }}
        </Button>
        <!-- 保存 -->
        <Button
          color="green"
          variant="text"
          @click="saveConversation"
        >
          <i class="i-lucide:save" />
          {{ t('common.buttons.save') }}
        </Button>
      </div>
    </div>

    <ProList
      v-if="curConversation"
      title=""
    >
      <ProListItem
        :description="t('pages.preference.chat.hints.enableChatDesc')"
        :title="t('pages.preference.chat.labels.enableChat')"
      >
        <Switch
          :checked="true"
          disabled
        />

        <Upload
          accept=".png,.jpg,.jpeg"
          action="/"
          :before-upload="() => false"
          class="avatar-uploader"
          list-type="picture-card"
          name="avatar"
          :show-upload-list="false"
          style="width: 66px; height: 66px;"
          @change="avatarChange"
        >
          <PyAvatar
            v-if="curConversation?.avatar"
            :key="curConversation!.avatar"
            cus-style="width: 66px; height: 66px;"
            :url="curConversation!.avatar"
          />
          <button
            v-else
            style="border: 0; background: none"
            type="button"
          >
            <PlusOutlined />
            <div style="margin-top: 8px">
              {{ t('pages.preference.chat.labels.avatarUpload') }}
            </div>
          </button>
        </Upload>
      </ProListItem>
      <ProListItem
        :title="t('pages.preference.chat.labels.petName')"
      >
        <Input
          v-model:value="curConversation!.title"
          class="w-80"
          :placeholder="t('pages.preference.chat.placeholders.petName')"
        />
      </ProListItem>
      <ProListItem
        :description="t('pages.preference.chat.hints.openAiCompatibleDesc')"
        :title="t('pages.preference.chat.labels.provider')"
        vertical
      >
        <div class="flex flex-col gap-2">
          <div>
            <Select
              v-model:value="curSelectedProviderVal"
              :options="pvStore.stateProviders.map((item:AIProvider) => ({ label: t(`providers.names.${item.provider}`, {}, item.provider), value: item.value, provider: item }))"
              :placeholder="t('pages.preference.chat.placeholders.selectProvider')"
              style="width: 80%;"
            >
              <template #optionRender="{ option }">
                <Space>
                  <span
                    :aria-label="option.data.value"
                    role="img"
                  >
                    {{ option.label }}
                  </span>
                  <Tag
                    color="#108ee9"
                    size="small"
                  >
                    {{ option.value }}
                  </Tag>
                  <Tag
                    size="small"
                  >
                    {{ (option.data.provider?.apiKey?.length > 0 || isBoolean(option.data.provider.isCustom)) ? `✅${t('pages.preference.chat.status.configured')}` : `❌${t('pages.preference.chat.status.unconfigured')}` }}
                  </Tag>
                </Space>
              </template>
            </Select>
            <Button
              color="primary"
              variant="text"
              @click="routeStore.backHome(2)"
            >
              {{ t('common.buttons.settingNow') }}
            </Button>
          </div>
          <div>
            <ProListItem title="API Key">
              <InputPassword
                class="w-80"
                disabled
                placeholder="sk-..."
                :value="curSeletedProvider?.apiKey"
              />
            </ProListItem>

            <ProListItem
              :description="t('pages.preference.chat.hints.baseUrlDesc')"
              title="Base URL"
            >
              <Input
                class="w-80"
                disabled
                placeholder="https://api.openai.com/v1/chat/completions"
                :value="curSeletedProvider?.baseUrl"
              />
            </ProListItem>

            <ProListItem
              :description="t('pages.preference.chat.hints.modelNameDesc')"
              :title="t('pages.preference.chat.labels.modelName')"
            >
              <div class="flex items-center gap-2">
                <div class="mt-2 text-red-5 text-xl">
                  *
                </div>
                <Select
                  v-model:value="curSeletedModel"
                  class="w-80"
                  :options="(curSeletedProvider?.models ?? []).map((item:AiProviderModels) => ({ label: `${item.modelId}`, value: item.modelId }))"
                />
                <!-- <Popover
                  :title="t('pages.preference.chat.labels.customModelTitle')"
                  trigger="click"
                >
                  <template #content>
                    <div>
                      <Input
                        v-model:value="customModel"
                        class="w-80"
                        placeholder="model"
                      />
                      <Button
                        type="primary"
                        @click="curSeletedModel = customModel"
                      >
                        {{ t('pages.preference.chat.buttons.save') }}
                      </Button>
                    </div>
                  </template>
                  <Button>
                    {{ t('pages.preference.chat.labels.custom') }}
                  </Button>
                </Popover> -->
              </div>
            </ProListItem>
          </div>
        </div>
      </ProListItem>

      <ProListItem
        :title="t('pages.preference.chat.labels.persona')"
        vertical
      >
        <TextArea
          v-model:value="curConversation!.config.systemPrompt"
          :auto-size="{ minRows: 3, maxRows: 6 }"
          :placeholder="t('pages.preference.chat.placeholders.persona')"
        />
      </ProListItem>
    </ProList>
  </div>
</template>

<style scoped>

</style>
