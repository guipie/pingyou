<script setup lang="ts">
import { PlusCircleOutlined } from "@antdv-next/icons";
import { Button, Form, FormItem, Input, message, Modal, Radio, RadioGroup, TextArea } from "antdv-next";
import { reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import type { AIProvider, ModelCapability } from "@/stores/shard/provider-shard";

import { useProviderStore } from "@/stores/aiprovider";

const props = defineProps<{
  provider: AIProvider
}>();
const emits = defineEmits(["modelSaved"]);
const providerStore = useProviderStore();
const { t } = useI18n();
const model = reactive({
  name: "",
  modelId: "",
  desc: "",
  type: "text" as ModelCapability,
});
const open = ref(false);
function handleOk() {
  if (!model.name || !model.modelId)
    return message.warning(t("pages.preference.provider.errors.fillComplete"));
  const exists = props.provider.models?.some(m => m.modelId === model.modelId);
  if (exists)
    return message.warning(t("pages.preference.provider.errors.modelIdExists"));
  providerStore.updateProviderModels(props.provider.provider, JSON.parse(JSON.stringify(model)));
  open.value = false;
  emits("modelSaved", JSON.parse(JSON.stringify(model)));
}
function handleOpen() {
  // 重置表单
  model.name = "";
  model.modelId = "";
  model.desc = "";
  model.type = "text";
  open.value = true;
}
</script>

<template>
  <div>
    <Button
      type="dashed"
      @click="handleOpen"
    >
      {{ t('pages.preference.provider.modelDialog.buttons.add') }}
      <template #icon>
        <PlusCircleOutlined />
      </template>
    </Button>

    <Modal
      v-model:open="open"
      :title="t('pages.preference.provider.modelDialog.hints.addModel')"
      @ok="handleOk"
    >
      <template #footer>
        <Button
          key="back"
          @click="open = false"
        >
          {{ t('pages.preference.provider.modelDialog.buttons.cancel') }}
        </Button>
        <Button
          key="submit"
          type="primary"
          @click="handleOk"
        >
          {{ t('pages.preference.provider.modelDialog.buttons.confirmAdd') }}
        </Button>
      </template>
      <Form
        auto-complete="off"
        :label-col="{ span: 8 }"
        :model="model"
        style="max-width: 600px"
        :wrapper-col="{ span: 16 }"
      >
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelName')"
          name="name"
          :rules="[{ required: true, message: t('pages.preference.provider.modelDialog.placeholders.modelName') }]"
        >
          <Input v-model:value="model.name" />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.modelId')"
          name="modelId"
          :rules="[{ required: true, message: t('pages.preference.provider.modelDialog.placeholders.modelId') }]"
        >
          <Input
            v-model:value="model.modelId"
            placeholder="deepseek-v4-flash"
          />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.modelDialog.labels.description')"
          name="desc"
        >
          <TextArea v-model:value="model.desc" />
        </FormItem>
        <FormItem
          :label="t('pages.preference.provider.labels.modelType')"
          name="type"
        >
          <RadioGroup v-model:value="model.type">
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

<style scoped>

</style>
