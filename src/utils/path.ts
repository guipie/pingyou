import { basename, sep } from '@tauri-apps/api/path'

export function join(...paths: string[]) {
  const joinPaths = paths.map((path, index) => {
    if (index === 0) {
      return path.replace(new RegExp(`${sep()}+$`), '')
    }

    return path.replace(new RegExp(`^${sep()}+|${sep()}+$`, 'g'), '')
  })

  return joinPaths.join(sep())
}

// 根据路径获取文件名称
export async function getFileName(path: string) {
  return basename(path)
}
