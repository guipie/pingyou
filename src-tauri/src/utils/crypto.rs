use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{Engine as _, engine::general_purpose};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 加密后数据的前缀标记，用于区分明文与密文（兼容旧版明文数据）
const CIPHER_PREFIX: &str = "ENC:";

/// 获取或创建密钥文件路径（位于 app data 目录下）
fn key_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
    fs::create_dir_all(&app_dir).map_err(|e| format!("创建 app data 目录失败: {}", e))?;
    Ok(app_dir.join(".secret_key"))
}

/// 读取或生成 256 位密钥（首次运行时随机生成并写入文件）
fn get_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = key_file_path(app)?;

    // 尝试读取已有密钥
    if let Ok(key_bytes) = fs::read(&path) {
        if key_bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&key_bytes);
            return Ok(key);
        }
        log::warn!("密钥文件长度异常，将重新生成");
    }

    // 生成新密钥
    let mut key = [0u8; 32];
    use aes_gcm::aead::rand_core::RngCore;
    OsRng.fill_bytes(&mut key);

    // 写入文件（限制权限：仅当前用户可读写）
    let mut file = fs::File::create(&path).map_err(|e| format!("创建密钥文件失败: {}", e))?;
    file.write_all(&key)
        .map_err(|e| format!("写入密钥文件失败: {}", e))?;

    // 在 Unix 上设置 0600 权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| format!("读取密钥文件元数据失败: {}", e))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms).map_err(|e| format!("设置密钥文件权限失败: {}", e))?;
    }

    log::info!("已生成新的加密密钥: {:?}", path);
    Ok(key)
}

/// 加密字符串：返回 Base64(nonce + ciphertext)，带 ENC: 前缀
fn encrypt_internal(app: &AppHandle, plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    // 已经是密文格式则直接返回，避免重复加密
    if plaintext.starts_with(CIPHER_PREFIX) {
        return Ok(plaintext.to_string());
    }

    let key_bytes = get_or_create_key(app)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    // 生成 12 字节随机 nonce
    let mut nonce_bytes = [0u8; 12];
    use aes_gcm::aead::rand_core::RngCore;
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("加密失败: {}", e))?;

    // 合并 nonce + ciphertext 后 Base64 编码
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    let encoded = general_purpose::STANDARD.encode(&combined);
    Ok(format!("{}{}", CIPHER_PREFIX, encoded))
}

/// 解密字符串：接受带 ENC: 前缀的 Base64 密文，返回明文
/// 若输入不是密文格式（旧版明文数据），则原样返回以保持兼容
fn decrypt_internal(app: &AppHandle, ciphertext: &str) -> Result<String, String> {
    if ciphertext.is_empty() {
        return Ok(String::new());
    }

    // 不带前缀说明是旧版明文数据，直接返回
    if !ciphertext.starts_with(CIPHER_PREFIX) {
        return Ok(ciphertext.to_string());
    }

    let encoded = &ciphertext[CIPHER_PREFIX.len()..];
    let combined = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    if combined.len() < 12 {
        return Err("密文数据长度不足".to_string());
    }

    let key_bytes = get_or_create_key(app)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce = Nonce::from_slice(&combined[..12]);
    let plaintext = cipher
        .decrypt(nonce, &combined[12..])
        .map_err(|e| format!("解密失败: {}", e))?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 解码失败: {}", e))
}

/// 加密字符串（Tauri 命令，供前端调用）
#[tauri::command]
pub fn encrypt_string(app: AppHandle, plaintext: String) -> Result<String, String> {
    encrypt_internal(&app, &plaintext)
}

/// 解密字符串（Tauri 命令，供前端调用）
/// 对非密文格式的输入（旧版明文）原样返回，实现平滑迁移
#[tauri::command]
pub fn decrypt_string(app: AppHandle, ciphertext: String) -> Result<String, String> {
    decrypt_internal(&app, &ciphertext)
}
