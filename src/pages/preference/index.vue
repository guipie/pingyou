<script setup lang="ts">
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Flex, message, Spin, Tag, Tooltip } from "antdv-next";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";

import UpdateApp from "@/components/update-app/index.vue";
import { useTray } from "@/composables/useTray";
import { WEB_BASE } from "@/config/index.ts";
import { useAppStore } from "@/stores/app";
import { useGeneralStore } from "@/stores/general";
import { useModelStore } from "@/stores/model";
import { useRouteSettingStore } from "@/stores/route-setting";
import { useUserStore } from "@/stores/user";
import { isMac } from "@/utils/platform";
import { getStorage } from "@/utils/storage.ts";

import Chat from "./components/chat/index.vue";
import Pingyou from "./components/pingyou/index.vue";
import Provider from "./components/provider/index.vue";
import Settings from "./components/settings/index.vue";

useTray();
const appStore = useAppStore();
const routeSettingStore = useRouteSettingStore();
const current = computed(() => routeSettingStore.currentMenuIndex);
const { t } = useI18n();
const generalStore = useGeneralStore();
const modelStore = useModelStore();
const userStore = useUserStore();
const appWindow = getCurrentWebviewWindow();

/** 打开浏览器跳转到 Web 登录页 */
function openLogin() {
  openUrl(`${WEB_BASE}/login?desktop=1`);
}

/** 处理桌面端登录回调（从本地 HTTP 服务或 deep-link 触发） */
let unlistenDeepLink: (() => void) | null = null;

onMounted(async () => {
  // 检查是否有本地登录状态
  const user = await getStorage("user");
  const token = await getStorage("token");
  if (user && token) {
    try {
      const parsedUser = JSON.parse(decodeURIComponent(user));
      userStore.setLogin({ user: parsedUser, token });
    } catch (err) {
      console.error("[preference] 本地登录状态解析失败:", err);
    }
  }
  unlistenDeepLink = await listen<string>("deep-link-url", (event) => {
    const url = event.payload;
    if (!url.startsWith("pingyou://auth-callback")) return;

    try {
      const parsed = new URL(url);
      const token = parsed.searchParams.get("token") || "";
      const userStr = parsed.searchParams.get("user") || "";

      if (!token || !userStr) return;

      const user = JSON.parse(decodeURIComponent(userStr));
      userStore.setLogin({ user, token });
      message.success(`欢迎回来，${user.nickname || user.email}`);
    } catch (err) {
      console.error("[auth-callback] 解析失败:", err);
    }
  });
});

onUnmounted(() => {
  unlistenDeepLink?.();
});

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
    key: "settings",
    label: t("pages.preference.cat.title"),
    icon: "i-solar:settings-broken",
    component: Settings,
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
          v-for="item in menus"
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
        class="w-full cursor-pointer py-1 transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
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
                class="flex cursor-pointer gap-2 transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
                @click="userStore.logout(); message.success('已退出登录'); "
              >
                <div
                  class="i-solar:logout-broken size-6"
                />
                <span>退出登录</span>
              </div>
            </div>
          </template>
          <div class="w-full flex cursor-pointer items-center justify-between">
            <!-- 已登录：显示用户名 + 登出 -->
            <template v-if="userStore.loggedIn">
              <div class="min-w-0 flex flex-1 items-center gap-1.5 p-1">
                <i class="i-lucide:user-circle shrink-0 text-base c-ant-primary" />
                <span class="truncate text-sm">{{ userStore.displayName }}</span>
                <Tag
                  class="shrink-0 !m-0 !text-xs"
                  :color="userStore.user?.plan === 'pro' ? 'gold' : userStore.user?.plan === 'team' ? 'purple' : 'default'"
                >
                  {{ userStore.planLabel }}
                </Tag>
              </div>
            </template>
            <!-- 未登录：显示登录按钮 -->
            <template v-else>
              <Button
                type="link"
                @click.stop="openLogin"
              >
                登录
              </Button>
              <div
                class="i-solar:alt-arrow-right-line-duotone rounded-lg dark:color-text-secondary hover:bg-sec"
              />
            </template>
          </div>
        </Tooltip>
      </div>
    </div>

    <div
      v-for="(item, index) in menus"
      v-show="current === index && !routeSettingStore.curPage"
      :id="item.key"
      :key="item.key"
      class="custom-container relative h-full min-w-0 flex-1 bg-[--ant-color-fill-quaternary] dark:bg-container"
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
