import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { env } from "node:process";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vite";
import vitePluginDayjs from "vite-plugin-dayjs";

const host = env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), UnoCSS(), vitePluginDayjs()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. 预转换所有页面组件，确保 UnoCSS 在任何 webview 请求 virtual:uno.css 前完成 class 扫描
    //    解决 Tauri 多窗口并发请求时的 race condition（否则部分页面的 UnoCSS class 丢失，需刷新才恢复）
    warmup: {
      clientFiles: [
        "./src/pages/main/index.vue",
        "./src/pages/preference/index.vue",
        "./src/pages/winchat/index.vue",
        "./src/pages/winchat/msg.vue",
      ],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    // 生产构建优化
    sourcemap: false,
    minify: "esbuild",
    cssMinify: true,
    // 压缩选项
    target: "es2021",
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      // 不打包测试用的 3D 模型文件（它们已在 src-tauri/assets 里）
      external: [
        /src-tauri\/assets\/models\/.*\.glb$/,
        /src-tauri\/assets\/models\/.*\.fbx$/,
      ],
      output: {
        manualChunks(id) {
          // 重量级库分包——按需加载，避免首屏加载全部
          if (id.includes("node_modules/three")) {
            return "three";
          }
          if (id.includes("node_modules/pixi.js") || id.includes("node_modules/@pixi")) {
            return "pixi";
          }
          if (id.includes("node_modules/easy-live2d") || id.includes("node_modules/pixi-live2d")) {
            return "live2d";
          }
          if (id.includes("node_modules/antdv-next") || id.includes("node_modules/@antdv-next")) {
            return "antd";
          }
          if (id.includes("node_modules/vue") || id.includes("node_modules/pinia") || id.includes("node_modules/vue-router")) {
            return "vue-vendor";
          }
          if (id.includes("node_modules/iconify") || id.includes("node_modules/@iconify")) {
            return "icons";
          }
          // 其他 node_modules 打包到 vendor
          if (id.includes("node_modules")) {
            return "vendor";
          }
        },
      },
    },
  },
}));
