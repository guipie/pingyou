import { createPlugin } from '@tauri-store/pinia'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './locales'
import router from './router'

import 'antdv-next/dist/reset.css'
import 'virtual:uno.css'

import './assets/css/global.scss'
// 开发环境下输出环境信息，便于调试；生产构建中通过 Vite drop 移除 console
if (import.meta.env.DEV) {
  console.warn(import.meta.env)
}
const pinia = createPinia()
// syncInterval 提升至 500ms，降低流式聊天时高频状态更新的 IPC 同步流量
pinia.use(createPlugin({ saveOnChange: true, syncInterval: 500 }))

createApp(App).use(router).use(pinia).use(i18n).mount('#app')
