<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { Button, message, Spin } from "antdv-next";
import { nanoid } from "nanoid";
import { onMounted, ref, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { ModelEngine, ModelMode } from "@/stores/model";

import { INVOKE_KEY } from "@/constants";
import { useModelStore } from "@/stores/model";
import {
  is3DModelFileName,
  isLive2DModelFileName,
  isModelFileName,
  resolveEffectiveModelPath,
  validateModelDir,
} from "@/utils/model";
import { join } from "@/utils/path";

const { t } = useI18n();
const dropRef = useTemplateRef("drop");
const dragenter = ref(false);
const selectPaths = ref<string[]>([]);
const importing = ref(false);
const modelStore = useModelStore();

onMounted(() => {
  const appWindow = getCurrentWebviewWindow();

  appWindow.onDragDropEvent(({ payload }) => {
    const { type } = payload;

    if (type === "over") {
      const { x, y } = payload.position;

      if (dropRef.value) {
        const { left, right, top, bottom } = dropRef.value.getBoundingClientRect();

        const inBoundsX = x >= left && x <= right;
        const inBoundsY = y >= top && y <= bottom;

        dragenter.value = inBoundsX && inBoundsY;
      }
    } else if (type === "drop" && dragenter.value) {
      dragenter.value = false;

      selectPaths.value = payload.paths;
    } else {
      dragenter.value = false;
    }
  });
});

// 选择 zip 文件或 3d 单文件
async function handleUploadZip() {
  const selected = await open({
    multiple: true,
    filters: [
      { name: "模型文件", extensions: ["zip", "glb", "gltf", "vrm", "fbx"] },
    ],
  });

  if (!selected) return;

  selectPaths.value = selected;
}

// 选择目录
async function handleUploadDir() {
  const selected = await open({ directory: true, multiple: true });

  if (!selected) return;

  selectPaths.value = selected;
}

/**
 * 检测目录是 Live2D 还是 3D 模型，并返回引擎和模式。
 * 同时检测 keyboard/gamepad 模式（Live2D 专用）。
 */
async function detectModelType(dirPath: string): Promise<{ mode: ModelMode, engine: ModelEngine }> {
  let mode: ModelMode = "standard";
  let engine: ModelEngine = "live2d";

  // BFS 扫描所有层级找模型文件
  const queue: string[] = [dirPath];
  let found3D = false;
  let foundLive2D = false;
  let checkRightKeys = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readDir(current).catch(() => []);
    if (!entries?.length) continue;

    for (const e of entries) {
      const n = e.name.toLowerCase();
      if (!e.isDirectory) {
        if (is3DModelFileName(n)) {
          found3D = true;
        }
        if (isLive2DModelFileName(n)) {
          foundLive2D = true;
        }
      } else if (n === "right-keys") {
        checkRightKeys = true;
      }
    }

    for (const e of entries) {
      if (e.isDirectory) queue.push(join(current, e.name));
    }
  }

  if (found3D) {
    mode = "model3d";
    engine = "3d";
  } else if (foundLive2D) {
    // 检测 keyboard/gamepad 模式
    if (checkRightKeys) {
      const rightKeysPath = join(dirPath, "resources", "right-keys");
      const files = await readDir(rightKeysPath).catch(() => []);
      if (files.length > 0) {
        const fileNames = files.map(file => file.name.split(".")[0]);
        if (fileNames.includes("East")) {
          mode = "gamepad";
        } else {
          mode = "keyboard";
        }
      }
    }
  }

  return { mode, engine };
}

watch(selectPaths, async (paths) => {
  if (importing.value || paths.length === 0) return;
  importing.value = true;

  for (const fromPath of paths) {
    try {
      const id = nanoid();
      const root = await invoke<string>("resolve_custom_models_dir");
      const toPath = join(root, id);

      const isZip = fromPath.toLowerCase().endsWith(".zip");
      const isSingleModelFile = isModelFileName(fromPath);

      if (isZip) {
        // zip 文件 → 解压
        await invoke("extract_local_zip", {
          zipPath: fromPath,
          toPath,
        });
      } else if (isSingleModelFile) {
        // 单个模型文件 → 复制到 toPath/{filename}
        await invoke("copy_model_file", {
          filePath: fromPath,
          destDir: toPath,
        });
      } else {
        // 目录 → 复制
        await invoke(INVOKE_KEY.COPY_DIR, {
          fromPath,
          toPath,
        });
      }

      // 剥掉外层包装目录，拿到真正的模型根路径
      const effectivePath = await resolveEffectiveModelPath(toPath);
      // 验证模型文件存在
      const isValid = await validateModelDir(effectivePath);
      if (!isValid) {
        // （.model3.json / .glb / .gltf / .vrm / .moc3）
        message.error("不是本软件支持的模型文件，请检查目录结构");
        continue;
      }

      // 检测模型类型
      const { mode, engine } = await detectModelType(effectivePath);

      // 检查是否已存在相同路径的模型
      const existing = modelStore.models.find(m => m.path === effectivePath);
      if (existing) {
        message.info("该模型已存在，已切换到该模型");
        modelStore.currentModel = existing;
        continue;
      }

      modelStore.models.push({
        id,
        path: effectivePath,
        mode,
        engine,
        isPreset: false,
      });

      const typeName = engine === "3d" ? "3D" : "Live2D";
      message.success(`导入成功（${typeName}）`);
    } catch (error) {
      message.error(String(error));
    }
  }

  importing.value = false;
  selectPaths.value = [];
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 拖拽区 -->
    <div
      ref="drop"
      class="w-full flex flex-col cursor-pointer items-center justify-center gap-3 b-1 b-dashed bg-[--ant-color-fill-quaternary] py-6 transition b-border rounded-lg hover:border-primary"
      :class="{ 'border-primary': dragenter }"
      @click="handleUploadZip"
    >
      <div class="i-solar:upload-square-outline text-12 text-primary" />
      <span>{{ t('pages.preference.model.hints.clickOrDragToImport') }}</span>
      <span class="text-xs c-ant-text-tertiary">支持 .zip / 文件夹 / .glb .gltf .vrm .fbx 单文件拖拽</span>
    </div>

    <!-- 操作按钮 -->
    <div class="flex gap-2">
      <Button
        block
        :loading="importing"
        @click="handleUploadZip"
      >
        <template #icon>
          <i class="i-lucide:file-archive" />
        </template>
        选择文件
      </Button>
      <Button
        block
        :loading="importing"
        @click="handleUploadDir"
      >
        <template #icon>
          <i class="i-lucide:folder-open" />
        </template>
        选择文件夹
      </Button>
    </div>

    <!-- 导入中提示 -->
    <div
      v-if="importing"
      class="flex items-center gap-2 c-ant-primary text-sm"
    >
      <Spin size="small" />
      <span>正在导入模型…</span>
    </div>
  </div>
</template>
