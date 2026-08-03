import type { UploadProps } from 'antdv-next'

import { basename, sep } from '@tauri-apps/api/path'

type FileType = Parameters<NonNullable<UploadProps['beforeUpload']>>[0]
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

export function getImgBase64(img: FileType) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(img)
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = error => reject(error)
  })
}
