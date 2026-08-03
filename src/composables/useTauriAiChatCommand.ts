import type { MenuItemType } from 'antdv-next'

import { DeleteOutlined, PushpinOutlined } from '@antdv-next/icons'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { h, ref } from 'vue'

import { useChatStore } from '@/stores/aichat'

export function useTauriAIChatCommand() {
//  添加右键菜单相关的状态
  const contextMenuConversationId = ref<string | null>(null)
  const chatStore = useChatStore()
  //  定义菜单项
  const getContextMenuItems = (conversationId: string): MenuItemType[] => [
    {
      key: 'pin',
      label: '置顶',
      icon: () => h(PushpinOutlined),
      onClick: async () => {
        if (!conversationId)
          return await message('请选择一个会话')
        chatStore.pinConversation(conversationId)
      },
    },
    {
      key: 'delete',
      label: '删除',
      danger: true, // 设置为危险操作（红色）
      icon: () => h(DeleteOutlined),
      onClick: () => {
        ask('确定要删除吗？', 'warning').then(async (res) => {
          if (res)
            chatStore.delConversation(conversationId)
        })
        console.warn('删除：', conversationId)
      },
    },
  ]
  return { contextMenuConversationId, getContextMenuItems }
}
