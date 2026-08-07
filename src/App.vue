<script setup lang="ts">
import { HappyProvider } from '@antdv-next/happy-work-theme'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, theme } from 'antdv-next'
import { isString } from 'es-toolkit'
import isURL from 'is-url'
import { onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'

import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { LANGUAGE, LISTEN_KEY } from './constants'
import { getAntdLocale } from './locales/index.ts'
import { hideWindow, showWindow } from './plugins/window'
import { useChatStore } from './stores/aichat.ts'
import { useProviderStore } from './stores/aiprovider.ts'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useModelStore } from './stores/model'
import { useRouteSettingStore } from './stores/route-setting.ts'
import { useShortcutStore } from './stores/shortcut.ts'

const appStore = useAppStore()
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
const chatStore = useChatStore()
const providerStore = useProviderStore()
const routerStore = useRouteSettingStore()
const appWindow = getCurrentWebviewWindow()
const { isRestored, restoreState } = useWindowState()
const { darkAlgorithm, defaultAlgorithm } = theme
const { locale } = useI18n()

onMounted(async () => {
  // 每个 store 的 $tauri.start() 从磁盘恢复持久化状态，可能因文件损坏/EOF 失败。
  // 单独 try-catch，失败时记录日志并继续使用默认状态，避免单个 store 失败导致整个应用白屏。
  try {
    await appStore.$tauri.start()
    await appStore.init()
  } catch (e) {
    console.error('[startup] appStore 恢复失败:', e)
  }
  try {
    await modelStore.$tauri.start()
    await modelStore.init()
  } catch (e) {
    console.error('[startup] modelStore 恢复失败:', e)
  }
  try {
    await catStore.$tauri.start()
    catStore.init()
  } catch (e) {
    console.error('[startup] catStore 恢复失败:', e)
  }
  try {
    await generalStore.$tauri.start()
    await generalStore.init()
  } catch (e) {
    console.error('[startup] generalStore 恢复失败:', e)
  }
  try {
    await shortcutStore.$tauri.start()
  } catch (e) {
    console.error('[startup] shortcutStore 恢复失败:', e)
  }
  try {
    await restoreState()
  } catch (e) {
    console.error('[startup] 窗口状态恢复失败:', e)
  }

  try {
    await chatStore.$tauri.start()
    await chatStore.initStore()
  } catch (e) {
    console.error('[startup] chatStore 恢复失败:', e)
  }
  try {
    await providerStore.$tauri.start()
    await providerStore.initDbProviders()
  } catch (e) {
    console.error('[startup] providerStore 恢复失败:', e)
  }
  try {
    await routerStore.$tauri.start()
  } catch (e) {
    console.error('[startup] routerStore 恢复失败:', e)
  }
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return
  showWindow()
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  hideWindow()
})

useEventListener('unhandledrejection', ({ reason }) => {
  const message = isString(reason) ? reason : JSON.stringify(reason)

  error(message)
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <HappyProvider
    v-slot="{ wave }"
    enabled
  >
    <ConfigProvider
      :locale="getAntdLocale(generalStore.appearance.language)"
      :theme="{
        algorithm: generalStore.appearance.isDark ? darkAlgorithm : defaultAlgorithm,
      }"
      :wave="wave"
    >
      <RouterView v-if="isRestored" />
    </ConfigProvider>
  </HappyProvider>
</template>
