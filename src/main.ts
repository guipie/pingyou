import { createPlugin } from '@tauri-store/pinia'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './locales'
import router from './router'

import 'antdv-next/dist/reset.css'
import 'virtual:uno.css'

import './assets/css/global.scss'
// 只在开发环境（npm run tauri dev）下启用日志转发
// if (import.meta.env.DEV && (window as any).__TAURI_INTERNALS__) {
//   import('@tauri-apps/plugin-log').then(({ attachConsole }) => {
//     // attachConsole()
//     console.warn('Tauri v2 日志转发已成功启用！', (window as any).__TAURI_INTERNALS__)
//   }).catch((err) => {
//     console.error('加载 Tauri 日志插件失败:', err)
//   })
// }
console.warn(import.meta.env, (window as any).__TAURI_INTERNALS__)
const pinia = createPinia()
pinia.use(createPlugin({ saveOnChange: true, syncInterval: 100 }))

createApp(App).use(router).use(pinia).use(i18n).mount('#app')
