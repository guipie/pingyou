<script setup lang="ts">
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Flex, Spin, Tooltip } from "antdv-next";
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";

import UpdateApp from "@/components/update-app/index.vue";
import { useTray } from "@/composables/useTray";
import { RoutersName } from "@/router/roters.ts";
import { useAppStore } from "@/stores/app";
import { useGeneralStore } from "@/stores/general";
import { useModelStore } from "@/stores/model";
import { useRouteSettingStore } from "@/stores/route-setting";
import { isMac } from "@/utils/platform";

import About from "./components/about/index.vue";
import Cat from "./components/cat/index.vue";
import Chat from "./components/chat/index.vue";
import General from "./components/general/index.vue";
import Pingyou from "./components/pingyou/index.vue";
import Provider from "./components/provider/index.vue";
import Shortcut from "./components/shortcut/index.vue";

useTray();
const appStore = useAppStore();
const routeSettingStore = useRouteSettingStore();
const current = computed(() => routeSettingStore.currentMenuIndex);
const { t } = useI18n();
const generalStore = useGeneralStore();
const modelStore = useModelStore();
const appWindow = getCurrentWebviewWindow();

watch(() => generalStore.appearance.language, () => {
  appWindow.setTitle(t("pages.preference.title"));
}, { immediate: true });

const menus = computed(() => [
  {
    index: 0,
    key: "model",
    label: t("name"),
    icon: "i-solar:magic-stick-3-bold",
    component: Pingyou,
  },
  {
    index: 1,
    key: "chat",
    label: t("pages.preference.chat.title"),
    icon: "i-solar:chat-round-dots-linear",
    component: Chat,
  },
  {
    index: 2,
    key: "provider",
    label: t("pages.preference.provider.title"),
    icon: "i-arcticons:openai-chatgpt",
    component: Provider,
  },
  {
    index: 3,
    key: "cat",
    label: t("pages.preference.cat.title"),
    icon: "i-solar:settings-broken",
    component: Cat,
  },
  {
    index: 4,
    key: "shortcut",
    label: t("pages.preference.shortcut.title"),
    name: RoutersName.Shortcut,
    icon: "i-solar:keyboard-bold",
    component: Shortcut,
    type: "append",
  },
  {
    index: 5,
    key: "general",
    name: RoutersName.General,
    label: t("pages.preference.general.title"),
    icon: "i-solar:settings-minimalistic-bold",
    component: General,
    type: "append",
  },
  {
    index: 6,
    key: "about",
    label: t("pages.preference.about.title"),
    name: RoutersName.About,
    icon: "i-solar:info-circle-bold",
    component: About,
    type: "append",
  },
]);
watch(() => generalStore.appearance.isDark, (value) => {
  if (value) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}, { immediate: true });
</script>

<template>
  <Spin
    class="max-h-unset!"
    :description="t('pages.main.hints.switching')"
    fullscreen
    size="large"
    :spinning="!modelStore.modelReady"
  />
  <Flex class="h-screen">
    <div
      class="h-full w-30 flex flex-col items-center gap-4 overflow-auto bg-gradient-from-blue-1 bg-gradient-to-black/1 bg-gradient-linear dark:bg-warmGray-9"
      :class="[isMac ? 'pt-8' : 'pt-4']"
      data-tauri-drag-region
    >
      <div class="flex flex-col items-center gap-2">
        <div class="b-1 rounded-2xl b-solid b-border-sec">
          <img
            class="size-16 rounded-2xl"
            data-tauri-drag-region
            :src="generalStore.appearance.isDark ? '/aipingyou-dark.png' : '/aipingyou-tm.png'"
          >
        </div>

        <span class="font-bold">{{ appStore.name }}</span>
      </div>

      <div class="flex flex-col gap-2">
        <div
          v-for="item in menus.filter(item => item.type !== 'append')"
          :key="item.key"
        >
          <div
            class="size-20 flex flex-col cursor-pointer items-center justify-center gap-2 transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
            :class="{ 'bg-container! color-blue-5! dark:color-blue-7! font-bold dark:bg-[--ant-color-fill-quaternary]!': current === item.index }"
            @click="routeSettingStore.backHome(item.index); "
          >
            <div
              class="size-8"
              :class="item.icon"
            />

            <span>{{ item.label }}</span>
          </div>
        </div>
      </div>
      <!-- 空div  填充剩余空间 -->
      <div class="flex-1" />
      <div
        class="size-8 flex cursor-pointer items-center justify-center transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
      >
        <Tooltip
          :color="generalStore.appearance.isDark ? '#1f1f1f' : '#ffffff'"
          placement="top"
          trigger="click"
          :z-index="9999"
        >
          <template #title>
            <div class="flex flex-col gap-2 overflow-auto">
              <div
                v-for="item in menus.filter(item => item.type === 'append')"
                :key="item.key"
                class="flex cursor-pointer gap-2 transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
                @click="routeSettingStore.backHome(item.index); "
              >
                <div
                  class="size-6"
                  :class="item.icon"
                />
                <span>{{ item.label }}</span>
              </div>
            </div>
          </template>
          <div
            class="i-solar:hamburger-menu-linear size-6 rounded-lg dark:color-text-secondary hover:bg-sec"
          />
        </Tooltip>
      </div>
    </div>

    <div
      v-for="(item, index) in menus"
      v-show="current === index && !routeSettingStore.curPage"
      :key="item.key"
      class="h-full min-w-0 flex-1 bg-[--ant-color-fill-quaternary] dark:bg-container"
      :class="item.key === 'chat' ? 'overflow-hidden p-0' : 'overflow-auto p-4'"
      data-tauri-drag-region
    >
      <component :is=" item.component" />
    </div>
    <div
      v-if="routeSettingStore.curPage"
      class="h-full min-w-0 flex-1 bg-[--ant-color-fill-quaternary] dark:bg-container"
      data-tauri-drag-region
    >
      <component :is="routeSettingStore.curPage.component" />
    </div>
  </Flex>

  <UpdateApp />
</template>
