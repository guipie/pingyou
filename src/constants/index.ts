export const GITHUB_LINK = "https://github.com/guipie/pingyou";

// 升级服务访问密钥已迁移至 src/config/index.ts（UPDATER_ACCESS_KEY），
// 真正敏感的密钥不应硬编码在 constants 中被打包进前端 bundle。
// 如需使用，请从 '@/config' 导入 UPDATER_ACCESS_KEY。

export const LISTEN_KEY = {
  SHOW_WINDOW: "show-window",
  HIDE_WINDOW: "hide-window",
  DEVICE_CHANGED: "device-changed",
  UPDATE_APP: "update-app",
  GAMEPAD_CHANGED: "gamepad-changed",
  START_MOTION: "start-motion",
  SET_EXPRESSION: "set-expression",
  WIN_MESSAGE: "win-message",
  // 气泡窗方向/内容同步事件
  WINDOW_POSITION: "window-position",
  WINDOW_MESSAGE: "window-message",
  // 气泡窗状态机（思考中 / 流式 / 完成 / 出错），与 WINDOW_MESSAGE 分离，避免状态被答案文本覆盖
  CHAT_BUBBLE: "chat-bubble",
  // 自定义供应商添加成功事件
  PROVIDER_ADDED: "provider-added",
};

export const INVOKE_KEY = {
  COPY_DIR: "copy_dir",
  START_DEVICE_LISTENING: "start_device_listening",
  START_GAMEPAD_LISTING: "start_gamepad_listing",
  STOP_GAMEPAD_LISTING: "stop_gamepad_listing",
};

/**
 * 快捷聊天窗口之间的状态哨兵值（跨窗口事件传输）。
 * 注意：该值仅用于事件消息判等，不要按语言本地化，展示时使用 i18n。
 */
export const WIN_MESSAGE_STATUS = {
  THINKING: "pingyou-thinking",
} as const;

/**
 * 气泡窗（winmsg）状态机。
 * 通过 LISTEN_KEY.CHAT_BUBBLE 事件发送 `{ state, error? }`，
 * 与承载答案文本的 WINDOW_MESSAGE 解耦，避免「思考中」哨兵被流式文本冲掉。
 */
export const CHAT_BUBBLE_STATE = {
  /** 已发出请求，尚未收到首个字 */
  THINKING: "thinking",
  /** 正在流式接收回答 */
  STREAMING: "streaming",
  /** 回答完成 */
  DONE: "done",
  /** 请求失败 */
  ERROR: "error",
} as const;

export type ChatBubbleState = typeof CHAT_BUBBLE_STATE[keyof typeof CHAT_BUBBLE_STATE];

/** 单张图片附件的大小上限（base64 后约 1.33 倍，过大既拖慢请求也易被上游拒绝） */
export const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const LANGUAGE = {
  ZH_CN: "zh-CN",
  ZH_TW: "zh-TW",
  EN_US: "en-US",
  VI_VN: "vi-VN",
  PT_BR: "pt-BR",
} as const;

export const WINDOW_LABEL = {
  MAIN: "main",
  PREFERENCE: "preference",
  WINCHAT: "winchat",
  WINMSG: "winmsg",
} as const;
