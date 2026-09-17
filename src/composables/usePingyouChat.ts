import { convertFileSrc } from "@tauri-apps/api/core";
import { exists } from "@tauri-apps/plugin-fs";
import { message } from "antdv-next";
import { useI18n } from "vue-i18n";

import type { Model } from "@/stores/model";
import type { TauriAIConversation } from "@/stores/shard/chat-shard";

import { WINDOW_LABEL } from "@/constants";
import { showWindow } from "@/plugins/window";
import { ContainerRouters } from "@/router/roters";
import { useChatStore } from "@/stores/aichat";
import { useCatStore } from "@/stores/cat";
import { useModelStore } from "@/stores/model";
import { useRouteSettingStore } from "@/stores/route-setting";
import { isBoolean } from "@/utils/is";
import { join } from "@/utils/path";

/**
 * 屏友卡片上的「聊天 / 会话设置」入口。
 *
 * 设计要点：**一只屏友 = 一个会话**（会话 id 直接复用模型 id），
 * 因此点哪张卡就聊哪只屏友，说话历史互不串味；
 * 同时把台上模型切成该屏友，回答气泡的头像与人格才对得上。
 */
export function usePingyouChat() {
  const chatStore = useChatStore();
  const modelStore = useModelStore();
  const catStore = useCatStore();
  const routeStore = useRouteSettingStore();
  const { t } = useI18n();

  /** 取屏友立绘当会话头像；3D 模型没有 resources/cover.png，回退为空由 UI 兜底 */
  async function resolvePetAvatar(model: Model): Promise<string> {
    if (model.engine !== "live2d" || !model.path) return "";
    try {
      const cover = join(model.path, "resources", "cover.png");
      return await exists(cover) ? convertFileSrc(cover) : "";
    } catch {
      return "";
    }
  }

  /**
   * 会话是否已经「能聊」：供应商 + 凭据（apiKey 或自定义）+ baseUrl + 模型，缺一不可。
   * 判定口径与 chat-settings.vue 的 saveConversation 校验保持一致，避免两边说法不一。
   */
  function isChatConfigured(conversation?: TauriAIConversation | null): boolean {
    const provider = conversation?.provider;
    if (!provider) return false;
    const credentialReady = Boolean(provider.apiKey?.trim()) || isBoolean(provider.isCustom);
    const modelReady = Boolean(conversation?.config?.model?.trim() || provider.defaultModel?.trim());
    return credentialReady && Boolean(provider.baseUrl?.trim()) && modelReady;
  }

  /** 打开某只屏友的聊天：建/取它的会话 → 校验配置 → 切到它 → 弹出悬浮输入窗 */
  async function openChat(model: Model): Promise<void> {
    if (model.isLoadMore) return;

    const avatar = await resolvePetAvatar(model);
    const conversation = await chatStore.ensureModelConversation(model.id, avatar);

    // 未配置好模型就先别开窗，否则用户发出去只会撞一个"请先配置好模型"的报错
    if (!isChatConfigured(conversation)) {
      message.warning(t("pages.preference.chat.messages.configureModelFirst"));
      return;
    }

    // 让悬浮输入窗（独立窗口，通过 pinia 同步）知道这轮要跟谁说话
    chatStore.activeChatId = model.id;
    if (conversation) chatStore.setCurrentConversation(conversation);

    if (modelStore.currentModel?.id !== model.id) {
      modelStore.modelReady = false;
      modelStore.currentModel = model;
    }

    // 直接触发显示，不必等 500ms 的跨窗口 store 同步
    catStore.window.messageInput = true;
    showWindow(WINDOW_LABEL.WINCHAT);
  }

  /**
   * 打开该屏友的「会话设置」页：配置会话名称、模型、人格等。
   * 必须先把 currentConversation 指到它的会话，chat-settings.vue 是拿这个当数据源的
   * （否则它的 onMounted 会把用户弹回首页）。
   */
  async function openChatSettings(model: Model): Promise<void> {
    if (model.isLoadMore) return;

    const avatar = await resolvePetAvatar(model);
    const conversation = await chatStore.ensureModelConversation(model.id, avatar);
    if (conversation) chatStore.setCurrentConversation(conversation);

    showWindow(WINDOW_LABEL.PREFERENCE);
    routeStore.goCurPage(ContainerRouters.chatModelSetting);
  }

  return { openChat, openChatSettings, isChatConfigured, resolvePetAvatar };
}
