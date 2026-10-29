import { isTauri } from '../io';

/** 不记录谱面文本或保存路径；故障电脑无需开发者控制台即可提供阶段日志。 */
export async function logPdfExport(record: object, reset = false): Promise<string | undefined> {
  const line = { at: new Date().toISOString(), ...record };
  console.info('[pdf]', line);
  if (!isTauri()) return;
  try {
    return await (await import('@tauri-apps/api/tauri')).invoke<string>('log_pdf_export', { line: JSON.stringify(line), reset });
  } catch (error) { console.debug('[pdf] 诊断日志写入失败', error); }
}
