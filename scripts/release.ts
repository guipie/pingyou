import { execSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  argv,
  exit,
  stdin,
  stdout,
} from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(
  fileURLToPath(import.meta.url),
)

const rootDir = resolve(__dirname, '..')

const packagePath = resolve(
  rootDir,
  'package.json',
)

const cargoPath = resolve(
  rootDir,
  'src-tauri',
  'Cargo.toml',
)

// 你的 Cargo.lock 在项目根目录
const cargoLockPath = resolve(
  rootDir,
  'Cargo.lock',
)

type BumpType
  = | 'patch'
    | 'minor'
    | 'major'

interface PackageJson {
  version: string
  [key: string]: unknown
}

/**
 * 执行命令
 */
function run(command: string): void {
  console.log(`\n$ ${command}`)

  execSync(command, {
    cwd: rootDir,
    stdio: 'inherit',
  })
}

/**
 * 获取命令输出
 */
function outputOf(command: string): string {
  return execSync(command, {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim()
}

/**
 * 读取 package.json
 */
function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(packagePath, 'utf8'),
  ) as PackageJson
}

/**
 * 获取当前版本
 */
function getCurrentVersion(): string {
  const pkg = readPackageJson()

  if (!pkg.version) {
    throw new Error(
      'package.json 中没有找到 version',
    )
  }

  return pkg.version
}

/**
 * 修改 package.json 版本
 *
 * 保留原来的文件格式，并且：
 * - 不改变其他字段
 * - 保留文件原来的换行风格
 */
function setPackageVersion(
  version: string,
): void {
  const original = readFileSync(
    packagePath,
    'utf8',
  )

  const pkg = JSON.parse(
    original,
  ) as PackageJson

  pkg.version = version

  const formatted
    = JSON.stringify(pkg, null, 2)

  /*
   * 保持 package.json 原来的
   * 是否有末尾换行。
   */
  const hasTrailingNewline
    = original.endsWith('\n')

  const finalContent
    = hasTrailingNewline
      ? `${formatted}\n`
      : formatted

  writeFileSync(
    packagePath,
    finalContent,
  )
}

/**
 * 计算新版本
 */
function bumpVersion(
  version: string,
  type: BumpType,
): string {
  const match
    = /^(\d+)\.(\d+)\.(\d+)$/.exec(
      version,
    )

  if (!match) {
    throw new Error(
      `版本号 "${version}" 不是标准的 x.y.z 格式`,
    )
  }

  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])

  switch (type) {
    case 'major':
      major += 1
      minor = 0
      patch = 0
      break

    case 'minor':
      minor += 1
      patch = 0
      break

    case 'patch':
      patch += 1
      break
  }

  return `${major}.${minor}.${patch}`
}

/**
 * 同步 src-tauri/Cargo.toml
 *
 * 只修改 [package] 区块里的 version。
 */
function syncCargoToml(
  version: string,
): void {
  if (!existsSync(cargoPath)) {
    throw new Error(
      `找不到 Cargo.toml：${cargoPath}`,
    )
  }

  const content = readFileSync(
    cargoPath,
    'utf8',
  )

  const lines
    = content.split(/\r?\n/)

  let insidePackageSection = false
  let versionUpdated = false

  const updatedLines
    = lines.map((line) => {
      const sectionMatch
        = /^\s*\[([^\]]+)\]\s*$/.exec(
          line,
        )

      if (sectionMatch) {
        insidePackageSection
          = sectionMatch[1] === 'package'

        return line
      }

      if (
        insidePackageSection
        && /^\s*version\s*=/.test(line)
      ) {
        versionUpdated = true

        const indentation
          = /^\s*/.exec(line)?.[0] ?? ''

        return `${indentation}version = "${version}"`
      }

      return line
    })

  if (!versionUpdated) {
    throw new Error(
      'Cargo.toml 的 [package] 区块中没有找到 version',
    )
  }

  writeFileSync(
    cargoPath,
    updatedLines.join('\n'),
  )
}

/**
 * 使用 Cargo 自动更新根目录 Cargo.lock
 */
function updateCargoLock(): void {
  if (!existsSync(cargoLockPath)) {
    console.log(
      '\n⚠️ 当前没有找到根目录 Cargo.lock。',
    )
  }

  console.log(
    '\n正在让 Cargo 更新 Cargo.lock...',
  )

  run(
    'cargo check --manifest-path src-tauri/Cargo.toml',
  )
}

/**
 * 检查 Git 工作区
 */
function checkGitClean(): void {
  const status
    = outputOf(
      'git status --porcelain',
    )

  if (status.length > 0) {
    console.error(
      '\n❌ Git 工作区不是干净的：\n',
    )

    console.error(status)

    console.error(`
请先处理当前修改：

  git status

然后再执行：

  pnpm release
`)

    exit(1)
  }
}

/**
 * 检查当前分支
 */
function checkBranch(
  force: boolean,
): void {
  const branch
    = outputOf(
      'git branch --show-current',
    )

  if (branch === 'main') {
    return
  }

  console.warn(
    `\n⚠️ 当前 Git 分支是 "${branch}"，不是 main。`,
  )

  if (!force) {
    console.error(`
发布操作默认要求在 main 分支执行。

如果确认要继续：

  pnpm release -- --force
`)

    exit(1)
  }
}

/**
 * 检查 origin
 */
function checkRemote(): void {
  try {
    outputOf(
      'git remote get-url origin',
    )
  } catch {
    console.error(
      '\n❌ 没有配置 Git remote "origin"。',
    )

    exit(1)
  }
}

/**
 * 检查 Tag 是否已经存在
 */
function checkTagNotExists(
  tag: string,
): void {
  try {
    execSync(
      `git rev-parse --verify ${tag}`,
      {
        cwd: rootDir,
        stdio: 'ignore',
      },
    )

    console.error(
      `\n❌ Git Tag ${tag} 已经存在。`,
    )

    exit(1)
  } catch {
    // Tag 不存在，继续。
  }
}

/**
 * 用户确认
 */
async function confirm(
  message: string,
): Promise<boolean> {
  const rl
    = readline.createInterface({
      input: stdin,
      output: stdout,
    })

  const answer
    = await rl.question(
      `${message} (y/N) `,
    )

  rl.close()

  return (
    answer.trim().toLowerCase() === 'y'
  )
}

/**
 * 恢复版本文件
 */
function restoreFiles(): void {
  console.log(
    '\n正在恢复版本文件...',
  )

  try {
    run(
      'git checkout -- package.json src-tauri/Cargo.toml Cargo.lock',
    )
  } catch {
    console.error(
      '⚠️ 自动恢复失败，请手动执行 git status 检查。',
    )
  }
}

/**
 * 获取发布类型
 */
function getBumpType(
  args: string[],
): BumpType {
  if (args.includes('--major')) {
    return 'major'
  }

  if (args.includes('--minor')) {
    return 'minor'
  }

  return 'patch'
}

/**
 * 主流程
 */
async function main(): Promise<void> {
  // 使用 node:process 导入的 argv，
  // 不直接使用全局 process
  const args
    = argv.slice(2)

  const bumpType
    = getBumpType(args)

  const force
    = args.includes('--force')

  const yes
    = args.includes('--yes')

  console.log(`
╔══════════════════════════════════════════╗
║             Pingyou Release              ║
╚══════════════════════════════════════════╝
`)

  console.log(
    `发布类型：${bumpType}`,
  )

  /*
   * ========================================
   * 1. Git 基础检查
   * ========================================
   */

  checkRemote()
  checkGitClean()
  checkBranch(force)

  /*
   * ========================================
   * 2. 获取当前版本
   * ========================================
   */

  const currentVersion
    = getCurrentVersion()

  /*
   * ========================================
   * 3. 计算新版本
   * ========================================
   */

  const newVersion
    = bumpVersion(
      currentVersion,
      bumpType,
    )

  const tag
    = `v${newVersion}`

  checkTagNotExists(tag)

  console.log(`
当前版本 : ${currentVersion}
新版本   : ${newVersion}
Git Tag  : ${tag}
`)

  /*
   * ========================================
   * 4. 修改 package.json
   * ========================================
   */

  console.log(
    '\n[1/6] 修改 package.json...',
  )

  setPackageVersion(
    newVersion,
  )

  /*
   * ========================================
   * 5. 同步 Cargo.toml
   * ========================================
   */

  console.log(
    '\n[2/6] 同步 src-tauri/Cargo.toml...',
  )

  syncCargoToml(
    newVersion,
  )

  /*
   * ========================================
   * 6. 更新 Cargo.lock
   * ========================================
   */

  console.log(
    '\n[3/6] 更新 Cargo.lock...',
  )

  try {
    updateCargoLock()
  } catch (error) {
    console.error(
      '\n❌ Cargo.lock 更新失败。',
    )

    console.error(error)

    restoreFiles()

    exit(1)
  }

  /*
   * ========================================
   * 7. 显示修改
   * ========================================
   */

  console.log(`
══════════════════════════════════════════
版本同步完成：

package.json
  ${newVersion}

src-tauri/Cargo.toml
  ${newVersion}

Cargo.lock
  根目录 Cargo.lock

Git Tag
  ${tag}
══════════════════════════════════════════
`)

  console.log(
    '\n版本文件修改：',
  )

  /*
   * 关键：
   * --no-pager 防止 Windows 下进入 less
   */
  run(
    'git --no-pager diff -- package.json src-tauri/Cargo.toml Cargo.lock',
  )

  /*
   * ========================================
   * 8. 发布确认
   * ========================================
   */

  if (!yes) {
    const confirmed
      = await confirm(
        `\n确认发布 ${tag}？`,
      )

    if (!confirmed) {
      console.log(
        '\n❌ 已取消发布。',
      )

      restoreFiles()

      exit(0)
    }
  }

  /*
   * ========================================
   * 9. Git Commit
   * ========================================
   */

  console.log(
    '\n[4/6] 创建 Git commit...',
  )

  run(
    'git add package.json src-tauri/Cargo.toml Cargo.lock',
  )

  run(
    `git commit -m "release: ${tag}"`,
  )

  /*
   * ========================================
   * 10. 创建 Tag
   * ========================================
   */

  console.log(
    '\n[5/6] 创建 Git Tag...',
  )

  run(
    `git tag -a ${tag} -m "Release ${tag}"`,
  )

  /*
   * ========================================
   * 11. Push
   * ========================================
   */

  console.log(
    '\n[6/6] 推送到 GitHub...',
  )

  run(
    'git push origin main',
  )

  run(
    `git push origin ${tag}`,
  )

  /*
   * ========================================
   * 完成
   * ========================================
   */

  console.log(`
╔══════════════════════════════════════════╗
║          🎉 Release 成功！              ║
╚══════════════════════════════════════════╝

版本：
  ${newVersion}

Tag：
  ${tag}

GitHub Actions 已经开始构建。

Actions：
https://github.com/guipie/pingyou/actions
`)
}

main().catch(
  (error: unknown) => {
    console.error(
      '\n❌ Release failed:',
    )

    console.error(error)

    exit(1)
  },
)
