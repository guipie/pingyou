# 项目长期约定（pingyou）

## provider 配置
- `provider.baseUrl` 必须是**可直接 POST 的完整端点**（如 `https://api.deepseek.com/v1/chat/completions`）。
  `useTauriAIChat.resolveEndpoint()` 在没有额外 path 时**原样**使用它，不会自动补 `/chat/completions`；
  只写到 `/v1` 会被 Ollama 之类的上游返回 `404 page not found`。
- 本地大模型链路：客户端 → **11435 鉴权网关**（校验 apiKey，`gateway.rs`）→ **11436 Ollama 引擎**（仅回环）。
  用户自装的 Ollama 在 11434，我们绝不触碰。Rust 常量见 `ollama_manager::{GATEWAY_PORT, ENGINE_PORT}`。
- 本地 provider 的 `provider` 字段是数据库主键固定值 `"本地大模型"`，**不可随语言翻译**；
  其 apiKey 由网关生成（落盘 `local-gateway.json`），入库时由 `provider-repository` AES 加密。
- 模型名比较一律走 `normalizeModelId()` / `isSameModel()`（补 `:latest`），否则会出现
  "装好了显示未安装""提示成功但没装"这类前后端错位。

## 跨窗口状态同步（@tauri-store/pinia）——最容易踩的坑
- 插件默认 **`sync: true` + `save: true`**，用 `watch(store.$state, patchBackend, {deep:true})` 把
  **整个 store 状态**推给后端，收到广播时 `store.$patch(payload.state)` 回灌本地 →
  **跨窗口「最后写入者获胜」**。
- 更坑的是 `BaseStore.processChangeQueue` 在 `patchSelf` 前会 `unwatch`、之后才 `watch()`，
  所以被别的窗口用旧状态覆盖后**本地不会把正确状态顶回去，回滚会「粘住」**。
- 结论：**数据库承载的数据集（如 chat store 的 `conversations`）绝不能参与同步**。
  用 `defineStore(id, setup, { tauri: { filterKeys: [...], filterKeysStrategy: "omit" } })` 排除，
  各窗口自己从库加载；只保留小的跨窗口信号（如 `activeChatId`）。
- 每个窗口（main/preference/winchat/winmsg/provider-add 都在 tauri.conf.json 里声明，**启动即创建**）
  的 `App.vue` 都会 `$tauri.start()` + 各自的 `initStore()`，所以「每窗口自行读库」是现成可用的。
- 补充：`syncInterval` 单独传（不传 `syncStrategy`）时策略仍是 `"immediate"`，那个 interval **不生效**。

## 代码风格与校验
- ESLint `style/quotes: double`。但 `src/App.vue` / `src/constants/index.ts` / `src/stores/shard/chat-shard.ts` /
  `src/database/*-repository.ts` 等历史文件是单引号 + 无分号且自带大量既有 error，
  **对这些文件跳过 `--fix`**，新增代码保持与文件内既有风格一致（还原时以 `git show HEAD:<file>` 为准）。
- `src/locales/*.json` 是 **CRLF + 无结尾换行**。回写必须 `JSON.stringify(o, null, 2)` 转 CRLF
  并去掉结尾换行，否则会产生整文件 diff。（追加键会让「原最后一行」补上逗号，这部分 diff 不可避免。）
- 校验清单：`cargo check`（src-tauri）、`cargo test --lib gateway`（网关是安全边界，有真实 TCP 单测）、
  `node ./node_modules/eslint/bin/eslint.js <files>`（**逐文件跑，批量会崩**）、
  `node ./node_modules/vite/bin/vite.js build --outDir <tmp> --emptyOutDir`
  （项目无 vue-tsc，构建即语法/引用校验；**必须输出到临时目录**，否则会撞 safe-delete 守卫删 `dist/` 失败）。
- Rust 改动必须**重新编译**才生效，交付时要提醒用户重启应用。

## 本机环境
- 终端用 **PowerShell**（此环境 bash 的 coreutils 基本不可用：`ls/grep/head/tail/wc/dirname` 全部 not found）；
  PowerShell 工具不回显 stdout，把输出重定向到 `$env:TEMP` 下的文件再用 Read 查看。
- 托管 node 目录是 `22.22.2-3`；用它跑 eslint 会 0xC0000005 崩溃，改用系统 node `C:\nvm4w\nodejs\node.exe`。
- **删除文件会被 safe-delete 守卫拦下**（走回收站报 `trash-failed`，报错信息里才藏着撤销；
  看到 "FAILED" 未必没删掉，以 `git status` / Glob 实际结果为准）。必要时用
  `dangerouslyDisableSandbox: true` 提权删除，且**只删自己创建的临时文件**。

