use fs_extra::dir::{CopyOptions, copy};
use std::fs::create_dir_all;
use std::path::Path;
use tauri::command;

#[command]
pub async fn copy_dir(from_path: String, to_path: String) -> Result<(), String> {
    if from_path.trim().is_empty() || to_path.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }

    let from = Path::new(&from_path);
    let to = Path::new(&to_path);

    // 源路径必须存在且为目录，避免复制任意文件
    if !from.is_dir() {
        return Err("source path must be an existing directory".to_string());
    }

    // 防止将目录复制到自身或自身的子目录，避免递归膨胀
    let from_abs = from.canonicalize().map_err(|err| err.to_string())?;
    if to.starts_with(&from_abs) {
        return Err("target path must not be inside source path".to_string());
    }

    let mut options = CopyOptions::new();
    options.content_only = true;

    create_dir_all(&to_path).map_err(|err| err.to_string())?;

    copy(from, to, &options).map_err(|err| err.to_string())?;

    Ok(())
}
