/**
 * 全屏展示背景相关：内置渐变预设 + 类型解析。
 * 渐变预设供主窗背景选择面板与全屏背景层共用，保证所见即所得。
 */

/** 渐变预设：key 持久化到 catStore.bg.value；css 为该预设对应的 background 样式值 */
export interface BgPreset {
  key: string
  css: string
}

export const BG_GRADIENT_PRESETS: BgPreset[] = [
  { key: "sunset", css: "linear-gradient(160deg,#ff9a9e 0%,#fad0c4 45%,#a18cd1 100%)" },
  { key: "ocean", css: "linear-gradient(160deg,#2193b0 0%,#6dd5ed 100%)" },
  { key: "aurora", css: "linear-gradient(160deg,#0f2027 0%,#203a43 50%,#2c5364 100%)" },
  { key: "midnight", css: "linear-gradient(160deg,#141e30 0%,#243b55 100%)" },
  { key: "peach", css: "linear-gradient(160deg,#fbc2eb 0%,#a6c1ee 100%)" },
  { key: "forest", css: "linear-gradient(160deg,#134e5e 0%,#71b280 100%)" },
];

/** 渐变预设查找（找不到返回 undefined，调用方回退为无背景） */
export function getGradientPreset(key: string): BgPreset | undefined {
  return BG_GRADIENT_PRESETS.find(preset => preset.key === key);
}
