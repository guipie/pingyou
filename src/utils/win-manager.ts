import { getName } from '@tauri-apps/api/app'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { message } from '@tauri-apps/plugin-dialog'

import type { RoutersName } from '@/router/roters'

import { LISTEN_KEY } from '@/constants'

// tauri的路由封装 统一管理
export async function openNewWindow(routerName: RoutersName, options?: { title?: string, width?: number, height?: number, minHeight?: number, query?: string }) {
  // 检查窗口是否已经存在，避免重复打开
  const existingWindow = await WebviewWindow.getByLabel(routerName)

  if (existingWindow) {
    // 如果已存在，则显示并聚焦
    await existingWindow.show()
    await existingWindow.setFocus()
    return
  }

  // 创建新窗口
  try {
    const webview = new WebviewWindow(routerName, {
      title: options?.title ?? (await getName()),
      width: options?.width,
      height: options?.height,
      minHeight: options?.minHeight ?? 300,
      minWidth: 400,
      // 确保窗口在屏幕内可见
      // center: true,
      // 确保 URL 格式正确。如果你的 Vue Router 使用了 history 模式，
      // 直接访问 /path 可能需要后端支持或特定的 Tauri 配置。
      // 对于单页应用，通常加载 index.html 然后通过 JS 路由跳转，
      // 但 Tauri WebviewWindow 可以直接指定 URL。
      url: `/#/${routerName}${options?.query ?? ''}`,
      resizable: true,
      decorations: true,
    })

    // 监听窗口创建失败的情况
    webview.once('tauri://error', (e) => {
      console.error('Failed to create window:', e)
    })

    // 可选：监听窗口成功加载
    webview.once('tauri://created', () => {
      // eslint-disable-next-line no-console
      console.info(`Window ${routerName} created successfully`)
    })
  } catch (error) {
    console.error('Exception creating window:', error)
  }
}

export async function openAdjacentWindow(label: string, options?: { msg?: string }) {
  const currentWin = getCurrentWebviewWindow()

  // 1. 直接通过 label 获取你在 tauri.conf.json 里配置好的窗口
  const sideWin = await WebviewWindow.getByLabel(label) // 替换为你的实际 label

  if (!sideWin) {
    message('not found message window')
    return
  }

  // 2. 获取当前窗口与显示器位置
  const currentPos = await currentWin.outerPosition()
  const currentSize = await currentWin.outerSize()
  const monitor = await currentMonitor()
  if (!monitor) return

  const screenWidth = monitor.size.width
  const screenX = monitor.position.x

  // 3. 获取新窗口配置的尺寸（或者直接写死计算用尺寸）
  const newSize = await sideWin.outerSize()
  const newWidth = newSize.width || 300

  // 4. 计算左右两侧坐标
  const rightX = currentPos.x + currentSize.width
  const leftX = currentPos.x - newWidth

  let targetX: number
  if (rightX + newWidth <= screenX + screenWidth) {
    targetX = rightX // 右侧放得下
  } else if (leftX >= screenX) {
    targetX = leftX // 左侧放得下
  } else {
    targetX = Math.max(screenX, screenX + screenWidth - newWidth) // 兜底靠边
  }

  const targetY = currentPos.y
  // 💡【核心改动】计算方向并触发事件，不涉及任何 URL 处理
  // 如果 targetX 小于当前窗口的 X 坐标，说明弹窗最终放在了左边
  const positionSide = targetX < currentPos.x ? 'left' : 'right'

  // 向目标弹窗发送方向参数
  await sideWin.emit(LISTEN_KEY.WINDOW_POSITION, positionSide)
  if (options?.msg !== undefined) {
    await sideWin.emit(LISTEN_KEY.WINDOW_MESSAGE, options.msg)
  }
  // 5. 改变位置并显示
  await sideWin.setPosition(new PhysicalPosition(targetX, targetY))
  await sideWin.show()
  await sideWin.setFocus()
}
