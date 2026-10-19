#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// 分块写大文件（视频导出用）。
///
/// Tauri v1 的 `fs.writeBinaryFile` 把整个字节按 **JSON 数字数组** 走 IPC——
/// 100MB 的视频要发几百 MB 的 JSON，WebView 主线程直接冻住（用户实测：
/// 选完保存位置后界面卡死几分钟）。这里改为 JS 端把字节转 base64、
/// 按块（几 MB）走 IPC，Rust 解码后直接写盘：
///   - 首块 create = true：截断建文件；
///   - 其后 append = true：追加。
/// 字符串 IPC 比数字数组便宜一个数量级以上，且分块期间界面保持响应。
#[tauri::command]
fn write_file_chunk(path: String, data_base64: String, create: bool, append: bool) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    let path = PathBuf::from(&path);
    if let Some(dir) = path.parent() {
        // 目录由对话框保证存在，这里不主动建，避免误建错路径
        if !dir.exists() {
            return Err(format!("目录不存在：{}", dir.display()));
        }
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create(create) // 首块：截断建文件
        .append(append) // 后续块：追加
        .truncate(create && !append)
        .open(&path)
        .map_err(|e| format!("打开文件失败（{}）：{e}", path.display()))?;
    f.write_all(&bytes)
        .map_err(|e| format!("写入失败（{}）：{e}", path.display()))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![write_file_chunk])
        .run(tauri::generate_context!())
        .expect("启动 WindScore 失败");
}
