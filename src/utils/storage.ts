import { Store } from "@tauri-apps/plugin-store";

// 实例，文件名为 app_store.json，存放在应用配置目录
let store: Store | null = null;

/**
 * 初始化 store，单例
 */
async function getStore() {
  if (!store) {
    store = await Store.load("app_store.json");
  }
  return store;
}

/**
 * 设置存储
 * @param key 键名
 * @param value 值（支持对象、数组、字符串、数字）
 */
export async function setStorage<T = any>(key: string, value: T) {
  const s = await getStore();
  await s.set(key, value);
  await s.save();
}

/**
 * 获取存储
 * @param key 键名
 * @param defaultValue 默认值
 */
export async function getStorage<T = any>(key: string, defaultValue?: T): Promise<T | null> {
  const s = await getStore();
  const val = await s.get<T>(key);
  if (val === undefined) {
    return defaultValue ?? null;
  }
  return val;
}

/**
 * 删除单个key
 */
export async function removeStorage(key: string) {
  const s = await getStore();
  await s.delete(key);
  await s.save();
}

/**
 * 清空全部存储
 */
export async function clearStorage() {
  const s = await getStore();
  await s.clear();
  await s.save();
}
