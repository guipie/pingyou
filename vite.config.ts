import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { env } from 'node:process'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import vitePluginDayjs from 'vite-plugin-dayjs'

const host = env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), UnoCSS(), vitePluginDayjs()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
    // 4. 预转换所有页面组件，确保 UnoCSS 在任何 webview 请求 virtual:uno.css 前完成 class 扫描
    //    解决 Tauri 多窗口并发请求时的 race condition（否则部分页面的 UnoCSS class 丢失，需刷新才恢复）
    warmup: {
      clientFiles: [
        './src/pages/main/index.vue',
        './src/pages/preference/index.vue',
        './src/pages/winchat/index.vue',
        './src/pages/winchat/msg.vue',
      ],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInclude: ['**/*.glb', '**/*.fbx', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.svg'],
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 将 node_modules 中的依赖单独打包
          if (id.includes('node_modules')) {
            return 'vendor' // 所有第三方依赖打包到 vendor.js
          }
        },
      },
      // external: ['/src-tauri/assets/models/*dev.glb', '/src-tauri/assets/models/*dev.fbx'],
    },
  },
}))
