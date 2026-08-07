import { invoke } from '@tauri-apps/api/core'

/**
 * 加密字符串（调用 Rust 端 AES-256-GCM）
 * 对空字符串和已加密数据（ENC: 前缀）直接返回，避免重复加密。
 */
export async function encryptString(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.startsWith('ENC:')) {
    return plaintext
  }
  try {
    return await invoke<string>('encrypt_string', { plaintext })
  } catch (err) {
    console.error('[encryptString] 加密失败，回退为明文:', err)
    return plaintext
  }
}

/**
 * 解密字符串（调用 Rust 端 AES-256-GCM）
 * 对非密文格式（无 ENC: 前缀的旧版明文数据）原样返回，实现平滑迁移。
 */
export async function decryptString(ciphertext: string): Promise<string> {
  if (!ciphertext || !ciphertext.startsWith('ENC:')) {
    return ciphertext
  }
  try {
    return await invoke<string>('decrypt_string', { ciphertext })
  } catch (err) {
    console.error('[decryptString] 解密失败，返回原始值:', err)
    return ciphertext
  }
}
