<script setup lang="ts">
import { ClearOutlined, PlusOutlined } from '@antdv-next/icons'
import { Button, Dropdown, Input, Popconfirm } from 'antdv-next'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import PyAvatar from '@/components/py-avatar.vue'
import { useTauriAIChatCommand } from '@/composables/useTauriAiChatCommand'
import { ContainerRouters } from '@/router/roters'
import { useChatStore } from '@/stores/aichat'
import { useRouteSettingStore } from '@/stores/route-setting'
import { formatSmartTime } from '@/utils/dateutils'

import ChatArea from './components/chat-area.vue'
import ChatMsg from './components/chat-msg.vue'

const routeSettingStore = useRouteSettingStore()
const chatStore = useChatStore()
const { t } = useI18n()
// 按照置顶，时间倒序排列
// 按照置顶优先，同状态下按时间倒序排列
const conversations = computed(() => {
  // 使用副本避免在 computed 中直接修改 store 中的数组
  return [...chatStore.conversations].sort((a, b) => {
    const isPinnedA = a.options?.isPinned ?? false
    const isPinnedB = b.options?.isPinned ?? false
    // 1. 如果置顶状态不同，置顶的(true)排在前面
    if (isPinnedA !== isPinnedB) {
      return isPinnedA ? -1 : 1
    }
    // 2. 如果置顶状态相同（都置顶或都不置顶），按时间倒序排列（新的在前）
    return b.timestamp - a.timestamp
  })
})

const curConversation = computed(() => chatStore.currentConversation)
</script>

<template>
  <div class="h-full min-h-0 overflow-hidden">
    <div class="h-full min-h-0 flex overflow-hidden">
      <aside class="h-full w-62 shrink-0 b-0 b-r-1 b-solid bg-gradient-from-blue-1 bg-gradient-to-black/2 bg-gradient-linear b-border-sec dark:bg-warmGray-9">
        <div class="flex items-center gap-2 px-2 pt-4">
          <div class="relative flex-1">
            <i class="i-lucide:search pointer-events-none absolute left-2 top-1/2 text-3.5 color-text-tertiary -translate-y-1/2" />
            <Input
              class="wechat-search"
              :placeholder="t('pages.preference.chat.placeholders.search')"
            />
          </div>
          <Button
            class="wechat-round-button"
            shape="circle"
            size="small"
          >
            <i class="i-lucide:plus" />
          </Button>
        </div>

        <div class="wechat-friend-list min-h-0 overflow-auto">
          <Button
            block
            class="my-2"
            type="dashed"
            @click="chatStore.addConversation()"
          >
            <template #icon>
              <PlusOutlined />
            </template>
            {{ t('pages.preference.chat.labels.newChat') }}
          </Button>
          <Dropdown
            v-for="item in conversations"
            :key="item.id"
            :menu="{ items: useTauriAIChatCommand().getContextMenuItems(item.id) }"
            :trigger="['contextmenu']"
          >
            <button
              class="wechat-friend-item w-full flex items-center gap-2 bg-transparent rounded"
              :class="{ 'is-pinned': item.options?.isPinned ?? false, 'is-active': chatStore.currentConversation?.id === item.id } "
              @click="chatStore.setCurrentConversation(item)"
            >
              <PyAvatar
                :key="item.avatar"
                style="width: 56px;height: 56px;"
                :url="item.avatar"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center">
                  <div class="truncate text-3.5 color-text">
                    {{ item.title }}
                  </div>
                  <div class="ml-auto shrink-0 text-2.5 color-text-tertiary">
                    {{ formatSmartTime(item.timestamp) }}
                  </div>
                </div>
                <div class="mt-2 truncate text-2.5 color-text-tertiary">
                  {{ item.config.systemPrompt ?? item.provider.desc }}
                </div>
              </div>
            </button>
          </Dropdown>
        </div>
      </aside>

      <section
        v-if="conversations.length > 0 && curConversation?.id"
        class="min-w-0 flex flex-1 flex-col overflow-hidden"
      >
        <header class="h-13 flex shrink-0 items-center b-0 b-b-1 b-solid px-5 b-border-sec">
          <div class="text-4 font-medium color-text">
            {{ curConversation?.title || t('pages.preference.chat.status.noTitle') }}
          </div>

          <div class="flex-1" />

          <Button
            class="wechat-header-button"
            shape="circle"
            type="text"

            @click="routeSettingStore.goCurPage(ContainerRouters.chatModelSetting)"
          >
            <i class="i-lucide:settings" />
          </Button>
          <Popconfirm
            :title="t('common.tips.clear')"
            @confirm="chatStore.clearChatMessages(curConversation?.id)"
          >
            <Button
              class="wechat-header-button"
              shape="circle"
              type="text"
            >
              <template #icon>
                <ClearOutlined />
              </template>
            </Button>
          </Popconfirm>
        </header>

        <main class="wechat-message-panel min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <ChatMsg />
        </main>
        <footer class="relative h-56 shrink-0 b-0 b-t-1 b-solid b-border-sec">
          <ChatArea />
        </footer>
      </section>

      <section
        v-else
        class="min-w-0 flex flex-1 flex-col overflow-hidden dark:bg-container"
      >
        <header class="h-13 flex shrink-0 items-center b-0 b-b-1 b-solid px-5 b-border-sec" />

        <main class="wechat-message-panel min-h-0 flex-1 overflow-auto px-8 py-6">
          <div
            class="h-full flex flex-col items-center justify-center gap-3 text-center color-text-tertiary"
          >
            <div class="size-16 flex items-center justify-center rounded-2xl shadow-sm bg-container">
              <i class="i-solar:cat-bold text-9 color-[#07c160]" />
            </div>
            <div class="text-4 font-medium color-text-secondary">
              {{ t('pages.preference.chat.status.emptyChat') }}
            </div>
            <div class="text-3.5">
              {{ t('pages.preference.chat.hints.chooseProviderModel') }}
            </div>
          </div>
        </main>
        <footer class="relative h-56 shrink-0 b-0 b-t-1 b-solid bg-container b-border-sec" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.wechat-search :deep(input) {
  color: var(--ant-color-text);
  background: var(--ant-color-bg-container);
  border: 0;
  box-shadow: none;
}

.wechat-round-button {
  color: var(--ant-color-text-secondary);
  background: transparent;
  border-color: var(--ant-color-border-secondary);
}

.wechat-friend-list {
  height: calc(100% - 52px);
  scrollbar-width: none;
}
.wechat-friend-list::-webkit-scrollbar,
.wechat-friend-item {
  height: 68px;
  border: none;
  border-bottom: 1px solid var(--ant-color-fill-tertiary);
}

.wechat-friend-item:hover {
  background: var(--ant-color-fill-tertiary);
}
.wechat-friend-item.is-pinned {
  background: var(--ant-color-fill-tertiary);
}
.wechat-friend-item.is-active {
  background: #1aad70;
}
.wechat-friend-item.is-active * {
  color: #fff;
}

.wechat-header-button {
  color: var(--ant-color-text-secondary);
}

.wechat-message-panel {
  scrollbar-width: none;
}

:global(:root) {
  --chat-user-bubble: #95ec69;
}

:global(.dark) {
  --chat-user-bubble: #2f8d46;
}

:global(.dark) .wechat-bubble-user {
  color: #f6fff7;
}
</style>
