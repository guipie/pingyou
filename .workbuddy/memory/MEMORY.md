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

## 依赖版本升级的坑（2026-09-18）
- **`webview2-com` 必须与 wry 对齐**：wry 0.55.1 依赖 `webview2-com = "0.38"`，把它单独升到 0.39.1
  会让 `with_webview` 里的 `webview.controller()`（0.38 的 `windows_core`）与我们导入的
  `PermissionRequestedEventHandler`（0.39 的）类型不匹配，报
  "multiple different versions of crate `windows_core` / `webview2_com_sys`"。
  Cargo.toml 那句「版本与 wry 对齐」的注释是对的，**改版本前先看 `wry-*/Cargo.toml`**。
- **`tauri-plugin-prevent-default` v5 没有 `permissions/` 目录、也没有任何 `invoke_handler`**
  （纯 `js_init_script` 注入），所以 `capabilities/*.json` 里**不能**出现 `prevent-default:default`，
  否则 tauri-build 的 ACL 阶段直接 `Permission ... not found` 构建失败。
- **`tauri-plugin-pinia` 与 npm `@tauri-store/pinia` 是 1:1 版本对应**（3.x↔3.x、5.x↔5.x）。
  当前 Rust 5.0.2 / JS 3.7.1 属错配，但实测：JS 调用的命令集是 Rust 的**子集**、参数形状一致，
  且 `filterKeys` 是 **JS 侧**实现（`patchBackendHelper` 先过滤再 invoke `patch`），
  所以跨窗口过滤仍然有效。要完全对齐需连带 `pinia ^3 → ^4`。
- 常见 major 升级的 API 断代（本项目已踩）：
  - `rand 0.10`：`rand::distributions` → **`rand::distr`**；`thread_rng()` → **`rng()`**；
    方法挪到 **`RngExt`**（`sample_iter` 在 `RngExt`，`fill_bytes` 在 `rand_core::Rng`）；
    `OsRng` 没了，用 `rand::rngs::SysRng` 或 `rand::rng()`。
  - `aes-gcm 0.11 / aead 0.6`：`aead::OsRng` **已移除**；`Key/Nonce` 基于 `hybrid-array`，
    `Array::from_slice` 已废弃 → `Key::<Aes256Gcm>::from([u8;32])` / `Nonce::from([u8;12])`，切片走 `try_into()`。
  - `cpal 0.18`：`sample_rate()` 直接返回 `u32`（不再有 `.0`）；`build_input_stream`
    的 config 参数**按值**收 `StreamConfig`（去掉 `&`）。
  - `zip 8`：默认特性已含 `deflate`，读取 API 未变。

## 第三方依赖内置（vendor，2026-09-18）
- 原则：**不依赖上游 GitHub 仓库存活**。需要 fork/自定义的 crate 一律拷进 `src-tauri/vendor/<name>/`，
  在 `src-tauri/Cargo.toml` 用 `path = "vendor/..."` 引用，并在注释里写明上游 URL + commit SHA。
- 根 `Cargo.toml` 的 `[workspace]` 必须 `exclude = ["src-tauri/vendor", "src-tauri/vendor/*", "src-tauri/vendor/**"]`，
  否则 path 依赖会自动成为 workspace 成员，其 dev-deps 会被解析进 Cargo.lock。
- 已验证的两个通用事实：
  1. **cargo 只给「非 path」来源的依赖加 `--cap-lints allow`**。git 依赖改 path 依赖后，上游自带告警会全部冒出来，
     需要在 vendored 清单里加 `[lints.rust]` 压掉，才能保持构建输出 0 warning。
  2. **path 依赖在 Cargo.lock 里会列出「声明的全部依赖」（含未启用的 optional）**，这是正常的、惰性的；
     判断真实启用的 feature 要看 `cargo check -v` 里 rustc 的 `--cfg 'feature="..."'`，不要看 `cargo tree`。
- vendored 副本可做的最小改动：删 `[dev-dependencies]`、加 `[lints.rust]`、删 `.git/.github/CI` 文件；
  其它保持上游原样并加 `# NOTE(vendored):` 说明。
- 当前已内置：`rdev`、`gilrs`（含 `gilrs-core`）。剩余的 git 依赖只有 `tauri-nspanel`（仅 macOS）。

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
- 优先用 Bash 工具（Git Bash）。2026-09-18 实测 `ls/cat/find/du/head/wc/tar/mv/git` 均正常；
  之前记录过 coreutils 不可用，若再遇到就退回 PowerShell（PowerShell 不回显 stdout，
  需把输出重定向到 `$env:TEMP` 下的文件再用 Read 查看）。
- **删除文件**（`rm`）仍会被 safe-delete 守卫拦下（走回收站报 `trash-failed`，报错信息里才藏着撤销；
  看到 "FAILED" 未必没删掉，以 `git status` / Glob 实际结果为准）。必要时用
  `dangerouslyDisableSandbox: true` 提权删除，且**只删自己创建的临时文件**。
  规避技巧：**用 `tar --exclude=...` 直接拷贝出需要的文件，而不是拷完再删**。
- 托管 node 目录是 `22.22.2-3`；用它跑 eslint 会 0xC0000005 崩溃，改用系统 node `C:\nvm4w\nodejs\node.exe`。

