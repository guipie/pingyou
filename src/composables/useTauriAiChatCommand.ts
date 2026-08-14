import type { MenuItemType } from 'antdv-next'

import { DeleteOutlined, PushpinOutlined } from '@antdv-next/icons'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { h, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useChatStore } from '@/stores/aichat'

export function useTauriAIChatCommand() {
//  添加右键菜单相关的状态
  const contextMenuConversationId = ref<string | null>(null)
  const chatStore = useChatStore()
  const { t } = useI18n()
  //  定义菜单项
  const getContextMenuItems = (conversationId: string): MenuItemType[] => [
    {
      key: 'pin',
      label: t('composables.useTauriAiChatCommand.labels.pin'),
      icon: () => h(PushpinOutlined),
      onClick: async () => {
        if (!conversationId)
          return await message(t('composables.useTauriAiChatCommand.errors.selectConversation'))
        chatStore.pinConversation(conversationId)
      },
    },
    {
      key: 'delete',
      label: t('composables.useTauriAiChatCommand.labels.delete'),
      danger: true, // 设置为危险操作（红色）
      icon: () => h(DeleteOutlined),
      onClick: () => {
        ask(t('composables.useTauriAiChatCommand.hints.deleteConfirm'), 'warning').then(async (res) => {
          if (res)
            await chatStore.delConversation(conversationId)
        })
      },
    },
  ]
  return { contextMenuConversationId, getContextMenuItems }
}
