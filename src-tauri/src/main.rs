#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
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
async fn write_file_chunk(
    path: String,
    data_base64: String,
    create: bool,
    append: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("写入任务失败：{e}"))?
}

/// Keep live export timings available even when a release build has no developer console.
#[tauri::command]
async fn log_video_export(
    app: tauri::AppHandle,
    line: String,
    reset: bool,
) -> Result<String, String> {
    write_export_log(app, line, reset, "video-export-latest.jsonl").await
}

#[tauri::command]
async fn log_pdf_export(app: tauri::AppHandle, line: String, reset: bool) -> Result<String, String> {
    write_export_log(app, line, reset, "pdf-export-latest.jsonl").await
}

async fn write_export_log(app: tauri::AppHandle, line: String, reset: bool, filename: &'static str) -> Result<String, String> {
    let dir = app
        .path_resolver()
        .app_log_dir()
        .ok_or("无法获取诊断日志目录")?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(filename);
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(!reset)
            .truncate(reset)
            .open(&path)
            .map_err(|e| e.to_string())?;
        writeln!(file, "{}", line).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// PDF 成功提示前检查磁盘上的大小、头尾，区分编码成功与文件实际写入失败。
#[tauri::command]
async fn verify_pdf_export(path: String, expected_size: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = std::fs::File::open(path).map_err(|e| format!("PDF 写后读取失败：{e}"))?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if size != expected_size || size < 16 { return Err(format!("PDF 文件长度不符：实际 {size}，应为 {expected_size}")); }
        let mut head = [0; 5];
        file.read_exact(&mut head).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::End(-16)).map_err(|e| e.to_string())?;
        let mut tail = [0; 16];
        file.read_exact(&mut tail).map_err(|e| e.to_string())?;
        if &head != b"%PDF-" || !tail.ends_with(b"%%EOF\n") { return Err("PDF 文件头尾校验失败，请重试另存到本地目录".into()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![write_file_chunk, log_video_export, log_pdf_export, verify_pdf_export])
        .run(tauri::generate_context!())
        .expect("启动 WindScore 失败");
}
