import type { TauriAIChatFileOptions } from "@/stores/shard/chat-shard";

import { CHAT_IMAGE_MAX_BYTES } from "@/constants";
import { i18n } from "@/locales";

export interface ReadImageResult {
  file?: TauriAIChatFileOptions
  /** 校验失败原因（已本地化），调用方决定用 toast 还是气泡提示 */
  error?: string
}

function formatMb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * 把用户选择的文件转成可投喂给视觉模型的数据结构。
 *
 * 同时完成类型与体积校验：过大的图片 base64 后会膨胀 1/3，
 * 既拖慢请求，也容易被上游直接拒绝（网关 body 上限 64MB）。
 */
export function readImageFile(file: File): Promise<ReadImageResult> {
  if (!file.type.startsWith("image/")) {
    return Promise.resolve({ error: i18n.global.t("pages.preference.chat.messages.selectImage") });
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return Promise.resolve({
      error: i18n.global.t("pages.preference.chat.messages.imageTooLarge", {
        limit: formatMb(CHAT_IMAGE_MAX_BYTES),
      }),
    });
  }
  return new Promise<ReadImageResult>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const commaAt = dataUrl.indexOf(",");
      resolve({
        file: {
          name: file.name,
          mediaType: file.type,
          dataUrl,
          base64: commaAt >= 0 ? dataUrl.slice(commaAt + 1) : "",
        },
      });
    };
    reader.onerror = () => {
      resolve({ error: i18n.global.t("pages.preference.chat.messages.uploadFailed") });
    };
    reader.readAsDataURL(file);
  });
}

/** 从剪贴板/拖拽的 FileList 里挑出第一张图片 */
export function pickFirstImage(files: FileList | File[] | null | undefined): File | undefined {
  if (!files) return undefined;
  return Array.from(files).find(item => item.type.startsWith("image/"));
}
