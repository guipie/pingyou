import type { PhysicalPosition } from "@tauri-apps/api/dpi";

import { resolveResource, sep } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { message } from "antdv-next";
import { isNil, round } from "es-toolkit";
import { findKey, nth } from "es-toolkit/compat";
import { ref } from "vue";

import { i18n } from "@/locales";
import { useCatStore } from "@/stores/cat";
import { useModelStore } from "@/stores/model";
import Model3d from "@/utils/model3d";
import { getCursorMonitor } from "@/utils/monitor";
import { isMac } from "@/utils/platform";

import live2d from "../utils/live2d";

const appWindow = getCurrentWebviewWindow();
const digitKeys = "1234567890".split("") as readonly string[];
const letterKeys = "QWERTYUIOPASDFGHJKLZXCVBNM".split("") as readonly string[];
const model3d = new Model3d();
// 3D 模型当前按下的键集合（3D 模型无 supportKeys 图片，需单独跟踪驱动蹲/跳）
const pressed3dKeys = new Set<string>();
export interface ModelSize {
  width: number
  height: number
}

/** 模型可见内容布局：尺寸 + 在自然画布中的偏移（裁剪透明留白后内容左上角坐标） */
export interface ModelLayout extends ModelSize {
  offsetX: number
  offsetY: number
}

/** 模型加载超时时间（毫秒），防止损坏的模型导致"切换中"永久卡住 */
const LOAD_TIMEOUT = 30_000;

/** 模型窗口占屏幕的上限比例：高度最多占屏高 60%、宽度最多占屏宽 90% */
const MAX_SCREEN_HEIGHT_RATIO = 0.6;
const MAX_SCREEN_WIDTH_RATIO = 0.9;

/** 加载序号，快速连续切换模型时用于丢弃过期的加载结果 */
let loadSeq = 0;

/**
 * 为加载 Promise 包装超时，超时后抛出错误并取消"切换中"状态，
 * 避免 `model.ready` 等内部 Promise 永远 pending 导致界面卡死。
 */
function loadWithTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(i18n.global.t("utils.model.hints.loadTimeout", { seconds: LOAD_TIMEOUT / 1000 })));
    }, LOAD_TIMEOUT);
  });

  // 超时后加载仍在后台进行，提前挂上 catch 避免未处理的 Promise 拒绝
  promise.catch(() => {});

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 将模型尺寸约束到屏幕范围内，避免超大画布模型（如 hiyori/m8）的窗口铺满整个屏幕。
 * 获取不到显示器信息时原样返回。
 */
async function clampModelSize(size: ModelSize): Promise<ModelSize> {
  try {
    const monitor = await currentMonitor();

    if (!monitor) return size;

    const { width: screenWidth, height: screenHeight } = monitor.size;

    const ratio = Math.min(
      1,
      (screenWidth * MAX_SCREEN_WIDTH_RATIO) / size.width,
      (screenHeight * MAX_SCREEN_HEIGHT_RATIO) / size.height,
    );

    if (ratio >= 1) return size;

    return { width: round(size.width * ratio), height: round(size.height * ratio) };
  } catch {
    return size;
  }
}

export function useModel() {
  const modelStore = useModelStore();
  const catStore = useCatStore();
  /** 模型有效尺寸（超大画布收缩后）：窗口大小与缩放百分比的基准 */
  const modelSize = ref<ModelSize>();
  /** 模型可见内容布局（真实尺寸 + 裁剪偏移）：渲染适配的基准（与有效尺寸分离，避免收缩后模型被二次放大裁切） */
  const modelNaturalSize = ref<ModelLayout>();

  const is3dModel = () => modelStore.currentModel?.engine === "3d";

  function getBehaviorShortcut(index: number) {
    const primary = isMac ? "Command" : "Control";

    const modifierGroups = [
      [primary],
      [primary, "Shift"],
      [primary, "Alt"],
      [primary, "Shift", "Alt"],
    ];

    const tiers = [
      ...modifierGroups.map(modifiers => ({ modifiers, keys: digitKeys })),
      ...modifierGroups.map(modifiers => ({ modifiers, keys: letterKeys })),
    ];

    let nextIndex = index;

    for (const tier of tiers) {
      if (nextIndex < tier.keys.length) {
        return [...tier.modifiers, tier.keys[nextIndex]].join("+");
      }

      nextIndex -= tier.keys.length;
    }

    return "";
  }

  function getMotionShortcutId(modelId: string, groupName: string, index: number) {
    return `${modelId}:motion:${groupName}:${index}`;
  }

  function getExpressionShortcutId(modelId: string, index: number) {
    return `${modelId}:expression:${index}`;
  }

  async function handleLoad() {
    const seq = ++loadSeq;

    try {
      if (!modelStore.currentModel) return;

      const { path } = modelStore.currentModel;

      await resolveResource(path);

      if (is3dModel()) {
        live2d.destroy();
      } else {
        model3d.destroy();
      }

      // 切换模型时清空 3D 按键跟踪，避免残留按下状态
      pressed3dKeys.clear();

      const { width, height, offsetX, offsetY, motions, expressions } = is3dModel()
        ? await loadWithTimeout(model3d.load(path))
        : await loadWithTimeout(live2d.load(path));

      // 加载期间用户又切换了模型，丢弃本次过期结果
      if (seq !== loadSeq) return;

      const nextMotions = Object.entries(motions);

      // 约束模型尺寸，防止超大画布模型的窗口铺满屏幕；真实尺寸与裁剪偏移单独保留用于渲染适配
      modelNaturalSize.value = { width, height, offsetX, offsetY };
      modelSize.value = await clampModelSize({ width, height });
      modelStore.currentMotions = nextMotions;
      modelStore.currentExpressions = expressions;

      handleResize();

      const modelId = modelStore.currentModel.id;

      const behaviorIds: string[] = [];

      for (const [groupName, items] of nextMotions) {
        for (const [index] of items.entries()) {
          behaviorIds.push(getMotionShortcutId(modelId, groupName, index));
        }
      }

      for (const [index] of expressions.entries()) {
        behaviorIds.push(getExpressionShortcutId(modelId, index));
      }

      for (const [index, id] of behaviorIds.entries()) {
        if (modelStore.shortcuts[id]) continue;

        const shortcut = getBehaviorShortcut(index);

        if (!shortcut) continue;

        modelStore.shortcuts[id] = shortcut;
      }
    } catch (error) {
      // 已有更新的切换请求时静默丢弃本次失败，避免误导性报错
      if (seq !== loadSeq) return;

      message.error(String(error));
    }
  }

  function handleDestroy() {
    pressed3dKeys.clear();
    live2d.destroy();
    model3d.destroy();
  }

  /**
   * 按目标尺寸渲染模型：目标窗口 = 有效尺寸 × 缩放百分比，模型按真实自然尺寸适配进目标窗口。
   * 不依赖实际窗口尺寸（innerWidth），与窗口缩放解耦，避免窗口未完成缩放时模型被裁切。
   * 窗口尺寸由 index.vue 中 [scale, modelSize] 的 watcher 统一设置。
   */
  function handleResize() {
    const natural = modelNaturalSize.value;
    const effective = modelSize.value;

    if (!natural || !effective) return;

    const ratio = catStore.window.scale / 100;

    const target: ModelSize = {
      width: Math.max(1, round(effective.width * ratio)),
      height: Math.max(1, round(effective.height * ratio)),
    };

    if (is3dModel()) {
      model3d.resizeModel(target);
    } else {
      live2d.resizeModel(natural, target);
    }
  }

  /** 用户拖拽调整窗口大小后，根据实际窗口宽度反推缩放百分比（上限与 Shift 缩放一致） */
  async function syncWindowSize() {
    const effective = modelSize.value;

    if (!effective) return;

    const { width } = await appWindow.size();

    const scale = round((width / effective.width) * 100);

    catStore.window.scale = Math.max(10, Math.min(scale, 500));
  }

  const handlePress = (key: string) => {
    // 3D 模型：任意按键都触发整体下蹲（不依赖按键图片资源）
    if (is3dModel()) {
      pressed3dKeys.add(key);
      model3d.setKeyPressed(true);
    }

    const path = modelStore.supportKeys[key];

    if (!path) return;

    const dirName = nth(path.split(sep()), -2)!;
    const prevKey = findKey(modelStore.pressedKeys, (value) => {
      return value.includes(dirName);
    });

    if (prevKey) {
      handleRelease(prevKey);
    }

    modelStore.pressedKeys[key] = path;
  };

  const handleRelease = (key: string) => {
    // 3D 模型：所有键都抬起后才触发起跳，避免多键连击时抖动
    if (is3dModel()) {
      pressed3dKeys.delete(key);

      if (pressed3dKeys.size === 0) {
        model3d.setKeyPressed(false);
      }
    }

    delete modelStore.pressedKeys[key];
  };

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? "CatParamLeftHandDown" : "CatParamRightHandDown";

    if (is3dModel()) {
      return model3d.setHandPressed(isLeft, pressed);
    }

    live2d.setParameterValue(id, pressed);
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === "Left" ? "ParamMouseLeftDown" : "ParamMouseRightDown";

    if (is3dModel()) {
      return model3d.setMousePressed(key, pressed);
    }

    live2d.setParameterValue(id, pressed);
  }

  async function handleMouseMove(cursorPoint: PhysicalPosition) {
    if (is3dModel()) {
      return model3d.setMousePosition(cursorPoint);
    }

    const monitor = await getCursorMonitor(cursorPoint);

    if (!monitor) return;

    const { size, position } = monitor;

    const xRatio = (cursorPoint.x - position.x) / size.width;
    const yRatio = (cursorPoint.y - position.y) / size.height;

    for (const id of [
      "ParamMouseX",
      "ParamMouseY",
      "ParamAngleX",
      "ParamAngleY",
      "ParamAngleZ",
      "ParamEyeBallX",
      "ParamEyeBallY",
    ]) {
      const range = live2d.getParameterValueRange(id);

      if (!range) continue;

      const { min, max } = range;

      if (isNil(min) || isNil(max)) continue;

      const isXAxis = id.endsWith("X");
      const isYAxis = id.endsWith("Y");
      const isZAxis = id.endsWith("Z");

      let value: number;

      if (isZAxis) {
        const dragX = 1 - 2 * xRatio;
        const dragY = 1 - 2 * yRatio;

        value = dragX * dragY * min;
      } else {
        const ratio = isXAxis ? xRatio : yRatio;

        value = max - ratio * (max - min);
      }

      if (!isYAxis && catStore.model.mouseMirror) {
        value *= -1;
      }

      live2d.setParameterValue(id, value);
    }
  }

  async function handleAxisChange(id: string, value: number) {
    if (is3dModel()) {
      return model3d.setAxis(id, value);
    }

    const range = live2d.getParameterValueRange(id);

    if (!range) return;

    const { min, max } = range;

    live2d.setParameterValue(id, Math.max(min, value * max));
  }

  function setMaxFPS(fps: number) {
    live2d.setMaxFPS(fps);
    model3d.setMaxFPS(fps);
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    handleLoad,
    handleDestroy,
    handleResize,
    syncWindowSize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
    setMaxFPS,
  };
}
