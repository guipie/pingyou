import type { MotionInfo } from "easy-live2d";

import { convertFileSrc } from "@tauri-apps/api/core";
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { Config, CubismSetting, Live2DSprite, Priority } from "easy-live2d";
import { groupBy } from "es-toolkit/compat";
import JSON5 from "json5";
import { Application, Ticker } from "pixi.js";

import type { ModelLayout, ModelSize } from "@/composables/useModel";

import { i18n } from "@/locales";

import { join } from "./path";

/** Windows 安全版：convertFileSrc 前统一把 \ 换成 /，防止 asset scope 匹配失败 */
function toAssetUrl(path: string): string {
  return convertFileSrc(path.split("\\").join("/"));
}

Config.MouseFollow = false;

class Live2d {
  private app: Application | null = null;
  public model: Live2DSprite | null = null;

  constructor() { }

  private initApp() {
    if (this.app) return;

    const view = document.getElementById("live2dCanvas") as HTMLCanvasElement;

    this.app = new Application();

    return this.app.init({
      view,
      resizeTo: window,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    });
  }

  public async load(path: string) {
    await this.initApp();

    this.destroy();

    // 递归搜索 .model3.json（zip 可能套多层目录）
    const modelFile = await this.findModel3Json(path);
    if (!modelFile) {
      throw new Error(i18n.global.t("utils.live2d.hints.notFound"));
    }

    // modelFile 是完整文件路径，模型目录 = 文件所在目录
    const modelDir = modelFile.substring(0, modelFile.lastIndexOf("/") + 1) || modelFile.substring(0, modelFile.lastIndexOf("\\") + 1) || path;

    const modelJSON = JSON5.parse(await readTextFile(modelFile));

    const modelSetting = new CubismSetting({
      modelJSON,
    });

    modelSetting.redirectPath(({ file }) => {
      return toAssetUrl(join(modelDir, file));
    });

    this.model = new Live2DSprite({
      modelSetting,
      ticker: Ticker.shared,
    });

    this.app?.stage.addChild(this.model);

    try {
      await this.model.ready;
    } catch (error) {
      // 加载失败时清理半初始化的模型，避免残留脏数据影响下一次切换
      this.destroy();

      throw error;
    }

    const { width, height } = this.model;

    const motions = groupBy(this.model.getMotions(), "group");
    const expressions = this.model.getExpressions();

    // 无背景图时裁掉画布四周的透明留白，让窗口贴合角色可见区域
    const hasBackground = await exists(join(path, "resources", "background.png")).catch(() => false);
    const content = hasBackground ? null : this.measureContentBounds();

    return {
      width: content?.width ?? width,
      height: content?.height ?? height,
      offsetX: content?.offsetX ?? 0,
      offsetY: content?.offsetY ?? 0,
      motions,
      expressions,
    };
  }

  /**
   * 从渲染主画布读取像素，计算角色可见内容在整张画布画面中的物理包围盒。
   *
   * easy-live2d 的 Live2DSprite 用原始 WebGL（renderable=false）直接绘制 Cubism，
   * 完全绕过 pixi 的 extract 渲染管线，因此 renderer.extract 拿不到内容（实测为空白）。
   * 正确做法是把画布临时放大到能容纳整张画布画面、scale 归位后手动渲染一帧，
   * 再通过 WebGL readPixels 从主画布读出真实像素来定位内容边界。
   *
   * 返回的坐标基于「scale=1 时 sprite 的完整画布画面」（宽=model.width，高=model.height，
   * 画面左上角为原点），与 resizeModel 的目标窗口为同一物理像素尺度。
   * 失败时返回 null（调用方回退为完整画布尺寸）。
   */
  private measureContentBounds(): ModelLayout | null {
    const renderer = this.app?.renderer;
    const model = this.model;

    if (!renderer || !model) return null;

    const canvasWidth = model.width;
    const canvasHeight = model.height;

    if (!canvasWidth || !canvasHeight) return null;

    // pixi v8 的 WebGL 上下文未在公开类型中暴露，运行时确实存在（easy-live2d 的 ModelRenderer 也直接使用）。
    // 统一按 WebGL1 接口调用（readPixels 使用 7 参数旧签名，WebGL2 也兼容）。
    const gl = (renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl as WebGLRenderingContext | undefined;

    if (!gl) return null;

    // 记录进入前的视口/缩放状态，无论成功失败都在 finally 中恢复，避免污染正常渲染
    const prevScaleX = model.scale.x;
    const prevScaleY = model.scale.y;
    const prevX = model.x;
    const prevY = model.y;
    const prevAnchorX = model.anchor.x;
    const prevAnchorY = model.anchor.y;

    try {
      const scanFactor = Math.min(1, 384 / Math.max(canvasWidth, canvasHeight));

      // 临时把画布缩放到便于读像素的尺寸，再渲染完整画布画面（scale=scanFactor）。
      // viewport(完整画布) 与 canvas 同步缩小，内容相对画布的比例保持不变，
      // 因此只要测出内容在 scanCanvas 中的归一化包围盒，就能换算出画布坐标系里的物理框。
      const scanWidth = Math.max(1, Math.round(canvasWidth * scanFactor));
      const scanHeight = Math.max(1, Math.round(canvasHeight * scanFactor));

      renderer.resize(scanWidth, scanHeight);

      model.anchor.set(0);
      model.scale.set(scanFactor, scanFactor);
      model.x = 0;
      model.y = 0;

      // 手动渲染两帧后立即读取（同一调用栈内 buffer 仍有效，无需 preserveDrawingBuffer）
      renderer.render(this.app!.stage);
      renderer.render(this.app!.stage);

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);

      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < height; y++) {
        const row = y * width * 4;

        for (let x = 0; x < width; x++) {
          if (pixels[row + x * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // 全透明（读取失败或模型未画出来），视为无法标定
      if (maxX < 0) return null;

      // 归一化包围盒（0~1，相对扫描画布）
      const left = minX / width;
      const top = minY / height;
      const right = (maxX + 1) / width;
      const bottom = (maxY + 1) / height;

      // 换算到完整画布坐标系（像素），四周留 1.5% 边距防止动作幅度大时裁到手脚
      const padX = canvasWidth * 0.015;
      const padY = canvasHeight * 0.015;

      const offsetX = Math.max(0, left * canvasWidth - padX);
      const offsetY = Math.max(0, top * canvasHeight - padY);
      const widthBound = Math.min(canvasWidth - offsetX, (right - left) * canvasWidth + padX * 2);
      const heightBound = Math.min(canvasHeight - offsetY, (bottom - top) * canvasHeight + padY * 2);

      return {
        width: Math.round(widthBound),
        height: Math.round(heightBound),
        offsetX: Math.round(offsetX),
        offsetY: Math.round(offsetY),
      };
    } catch {
      return null;
    } finally {
      model.anchor.set(prevAnchorX, prevAnchorY);
      model.scale.set(prevScaleX, prevScaleY);
      model.x = prevX;
      model.y = prevY;
    }
  }

  public destroy() {
    if (!this.model) return;

    this.model?.destroy();

    this.model = null;

    this.app?.renderer.clear();
  }

  /**
   * 递归搜索目录下的 .model3.json 文件（支持多层嵌套）。
   * 返回完整文件路径，找不到返回 null。
   */
  private async findModel3Json(dir: string): Promise<string | null> {
    const queue: string[] = [dir];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await readDir(current).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory && entry.name.endsWith(".model3.json")) {
          return join(current, entry.name);
        }
        if (entry.isDirectory) {
          queue.push(join(current, entry.name));
        }
      }
    }
    return null;
  }

  /**
   * 按目标窗口尺寸渲染模型。
   * 不读取 innerWidth（实际窗口尺寸），避免窗口尚未完成缩放时按旧尺寸计算导致模型被裁切。
   * @param natural 模型可见内容的自然尺寸与偏移（裁剪透明留白后）
   * @param target 目标窗口尺寸（物理像素）
   */
  public resizeModel(natural: ModelLayout, target: ModelSize) {
    if (!this.model) return;

    const dpr = devicePixelRatio || 1;

    const logicalWidth = target.width / dpr;
    const logicalHeight = target.height / dpr;

    this.app?.renderer.resize(logicalWidth, logicalHeight);

    const scale = Math.min(logicalWidth / natural.width, logicalHeight / natural.height);

    // 内容左上角（含裁剪偏移）对齐窗口左上角，可见内容恰好铺满窗口
    this.model.anchor.set(0);
    this.model.scale.set(scale);
    this.model.x = -natural.offsetX * scale;
    this.model.y = -natural.offsetY * scale;
  }

  public startMotion(motion: MotionInfo) {
    return this.model?.startMotion({
      ...motion,
      priority: Priority.Normal,
    });
  }

  public setExpression(index: number) {
    return this.model?.setExpression({ index });
  }

  public getParameterValueRange(id: string) {
    return this.model?.getParameterValueRangeById(id);
  }

  public setParameterValue(id: string, value: number | boolean) {
    return this.model?.setParameterValueById(id, Number(value));
  }

  public setMotionSoundEnabled(enabled: boolean) {
    Config.MotionSound = enabled;
  }

  public setMaxFPS(fps: number) {
    Ticker.shared.maxFPS = fps;
  }
}

const live2d = new Live2d();

export default live2d;
