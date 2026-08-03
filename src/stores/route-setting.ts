import { defineStore } from 'pinia'
import { markRaw, ref, shallowRef } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import Page404 from '@/pages/preference/404.vue'
import ChatSetting from '@/pages/preference/components/chat/chat-settings.vue'
import OllamaSetting from '@/pages/preference/components/provider/ollama.vue'
import { showWindow } from '@/plugins/window'
import { ContainerRouters } from '@/router/roters'

interface ConPage { name: ContainerRouters, path: string, component: any }
const ContainerPages: ConPage[] = [
  { name: ContainerRouters.chatModelSetting, path: '/chat/setting', component: markRaw(ChatSetting) },
  { name: ContainerRouters.providerOllamaSetting, path: '/provider/ollama', component: markRaw(OllamaSetting) },
  { name: ContainerRouters.notFound, path: '/404', component: markRaw(Page404) },
]
const currentMenuIndex = ref(0)

export const useRouteSettingStore = defineStore('route-setting', () => {
  const curPage = shallowRef<ConPage | null>(null)
  const goCurPage = (page: ContainerRouters) => {
    curPage.value = ContainerPages.find(p => p.name === page) || null
    if (!curPage.value) {
      curPage.value = ContainerPages.find(p => p.name === ContainerRouters.notFound) || null
    }
  }
  const backHome = (menuIndex?: number) => {
    showWindow(WINDOW_LABEL.PREFERENCE)
    curPage.value = null
    currentMenuIndex.value = menuIndex || 0
  }
  return {
    curPage,
    currentMenuIndex,
    goCurPage,
    backHome,
  }
})
