use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use tauri::command;
use zip::ZipArchive;

/// 下载 zip 模型包并解压到目标目录
#[command]
pub async fn download_and_extract_model(
    url: String,
    to_path: String,
    _model_type: String,
) -> Result<(), String> {
    // 下载 zip 文件
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    // 创建目标目录
    let dest = PathBuf::from(&to_path);
    std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败: {}", e))?;

    // 写入临时 zip 文件
    let temp_zip = dest.join("__temp.zip");
    let mut file =
        File::create(&temp_zip).map_err(|e| format!("创建临时文件失败: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    // 解压
    let zip_file =
        File::open(&temp_zip).map_err(|e| format!("打开zip失败: {}", e))?;
    let mut archive =
        ZipArchive::new(zip_file).map_err(|e| format!("解压失败: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取zip条目失败: {}", e))?;
        let entry_path = match entry.enclosed_name() {
            Some(path) => path,
            None => continue,
        };
        let target_path = dest.join(entry_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&target_path)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        } else {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败: {}", e))?;
            }
            let mut outfile =
                File::create(&target_path).map_err(|e| format!("创建文件失败: {}", e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    // 删除临时 zip 文件
    std::fs::remove_file(&temp_zip).ok();

    Ok(())
}
