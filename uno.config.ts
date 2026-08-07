import { presetAntd } from '@antdv-next/unocss'
import {
  defineConfig,
  presetIcons,
  presetWind3,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

export default defineConfig({
  presets: [
    presetWind3(),
    presetAntd(),
    presetIcons(),
  ],
  transformers: [
    transformerVariantGroup(),
    transformerDirectives({
      applyVariable: ['--uno'],
    }),
  ],
  // 确保 main 窗口关键 class 不被 Vite 缓存 bug 遗漏
  safelist: [
    // main/index.vue 覆盖层
    'pointer-events-none',
    'absolute',
    'left-0',
    'top-0',
    'z-30',
    'bg-black/20',
    'transition-opacity',
    'duration-300',
    'opacity-0',
    'opacity-100',
    // main/index.vue 容器与子元素
    'relative',
    'size-screen',
    'overflow-hidden',
    '-scale-x-100',
    'object-cover',
    'w-0',
    'h-0',
    'flex',
    'items-center',
    'justify-center',
    'bg-black',
    'text-center',
    // children:(absolute size-full) → transformerVariantGroup 展开后
    'children:absolute',
    'children:size-full',
  ],
})
