export const GITHUB_LINK = 'https://github.com/guipie/pingyou'

// 升级服务访问密钥已迁移至 src/config/index.ts（UPDATER_ACCESS_KEY），
// 真正敏感的密钥不应硬编码在 constants 中被打包进前端 bundle。
// 如需使用，请从 '@/config' 导入 UPDATER_ACCESS_KEY。

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  DEVICE_CHANGED: 'device-changed',
  UPDATE_APP: 'update-app',
  GAMEPAD_CHANGED: 'gamepad-changed',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
  WIN_MESSAGE: 'win-message',
  // 气泡窗方向/内容同步事件
  WINDOW_POSITION: 'window-position',
  WINDOW_MESSAGE: 'window-message',
}

export const INVOKE_KEY = {
  COPY_DIR: 'copy_dir',
  START_DEVICE_LISTENING: 'start_device_listening',
  START_GAMEPAD_LISTING: 'start_gamepad_listing',
  STOP_GAMEPAD_LISTING: 'stop_gamepad_listing',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
  WINCHAT: 'winchat',
  WINMSG: 'winmsg',
} as const
