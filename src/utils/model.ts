import type { DirEntry } from "@tauri-apps/plugin-fs";

import { exists, readDir } from "@tauri-apps/plugin-fs";

import { join } from "@/utils/path";

/** 单个模型文件扩展名（3D + Live2D） */
export const MODEL_FILE_EXTS = ["glb", "gltf", "vrm", "fbx", "moc3"];

/** 3D 模型文件扩展名 */
export const MODEL_3D_EXTS = ["glb", "gltf", "vrm", "fbx"];

/** Live2D 模型文件扩展名 */
export const MODEL_LIVE2D_EXTS = ["model3.json", "moc3"];

/** 判断文件名是否是模型主文件 */
export function isModelFileName(name: string): boolean {
  const n = name.toLowerCase();
  return MODEL_FILE_EXTS.some(ext =>
    ext === "model3.json" ? n.endsWith(`.${ext}`) : n.endsWith(`.${ext}`),
  );
}

/** 判断文件名是否是 3D 模型文件 */
export function is3DModelFileName(name: string): boolean {
  const n = name.toLowerCase();
  return MODEL_3D_EXTS.some(ext => n.endsWith(`.${ext}`));
}

/** 判断文件名是否是 Live2D 模型文件 */
export function isLive2DModelFileName(name: string): boolean {
  const n = name.toLowerCase();
  return MODEL_LIVE2D_EXTS.some(ext => n.endsWith(`.${ext}`));
}

/** 目录条目列表中是否包含模型文件 */
export function hasModelFile(entries: DirEntry[]): boolean {
  return entries.some(e => !e.isDirectory && isModelFileName(e.name));
}

/**
 * 自动「剥掉」外层包装目录，返回真正包含模型文件的目录路径。
 * 规则：如果 dirPath 下已经有模型文件 → 直接返回；
 * 如果只有一个子目录 → 递归进入；
 * 如果多个子目录 → 返回第一个包含模型文件的子目录。
 */
export async function resolveEffectiveModelPath(dirPath: string): Promise<string> {
  try {
    const entries = await readDir(dirPath);
    if (!entries || entries.length === 0) return dirPath;

    if (hasModelFile(entries)) return dirPath;

    const dirs = entries.filter(e => e.isDirectory);
    if (dirs.length === 1) {
      return resolveEffectiveModelPath(join(dirPath, dirs[0].name));
    }

    for (const d of dirs) {
      const sub = join(dirPath, d.name);
      const subEntries = await readDir(sub).catch(() => []);
      if (hasModelFile(subEntries)) return sub;
    }

    return dirPath;
  } catch {
    return dirPath;
  }
}

/** BFS 递归扫描目录，确认包含有效模型文件 */
export async function validateModelDir(dirPath: string): Promise<boolean> {
  const queue: string[] = [dirPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readDir(current).catch(() => []);
    if (!entries?.length) continue;
    if (hasModelFile(entries)) return true;
    for (const e of entries) {
      if (e.isDirectory) queue.push(join(current, e.name));
    }
  }
  return false;
}

/**
 * 判定一个目录"看起来"是已经解压成功的模型目录。
 * 递归扫描所有层级，避免多层嵌套的压缩包被误判为未完成；
 * 同时排除存在 __temp.zip 的下载中途目录。
 */
export async function isExtractedModelDir(folder: string): Promise<boolean> {
  if (!(await exists(folder))) return false;
  try {
    const queue: string[] = [folder];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await readDir(current).catch(() => []);
      if (!entries?.length) continue;
      if (entries.some(e => e.name === "__temp.zip")) return false;
      if (hasModelFile(entries)) return true;
      for (const e of entries) {
        if (e.isDirectory) queue.push(join(current, e.name));
      }
    }
    return false;
  } catch {
    return false;
  }
}
