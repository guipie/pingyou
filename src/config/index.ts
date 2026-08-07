/**
 * 应用运行时配置（敏感/环境相关项集中管理）
 *
 * ⚠️ 发布前请填充下列占位符：
 *  - UPDATER_ACCESS_KEY：升级服务器的访问密钥（建议通过 Rust 端代理，不打包进前端 bundle）
 *  - 相关 HTTPS endpoint 在 src-tauri/tauri.conf.json 中配置
 *
 * 注意：此文件中的值会被打包进前端 bundle，请勿在此放置高敏感密钥。
 * 真正敏感的密钥应放在 Rust 后端或通过环境变量在构建时注入。
 */

// 升级服务访问密钥（占位符，发布前由开发者填充）
// 理想方案：由 Rust 端在 invoke 中注入请求头，避免暴露到前端
export const UPDATER_ACCESS_KEY = ''

// Ollama 本地服务地址
export const OLLAMA_HOST = '127.0.0.1'
export const OLLAMA_PORT = 11435
