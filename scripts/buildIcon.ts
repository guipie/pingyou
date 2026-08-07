import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { env, platform } from 'node:process'

(() => {
  const isMac = env.PLATFORM?.startsWith('macos') ?? platform === 'darwin'

  const logoName = isMac ? 'logo-mac' : 'logo'
  const iconPath = `src-tauri/icons/icon.png`

  if (existsSync(iconPath)) {
    console.log('Icons already generated, skipping...')
    return
  }
  const command = `tauri icon src-tauri/assets/${logoName}.png`
  execSync(command, { stdio: 'inherit' })
})()
