/**
 * 曲库存储的启动与连接编排：
 *
 *   initStore()               App 挂载时调用一次（幂等）：探测后端 → 水合曲库与标定
 *   configureLibraryLocation() 引导窗的「确定」：选一个本地目录当曲库（exe 系统对话框
 *                              / Web 文件夹选择），选完水合并自动迁移兜底里的旧数据
 *   pickAndConnectFolder()    Web 专用的文件夹选择（与上面同一路径的 Web 分支别名）
 *   reconnectFolder()         浏览器重启后的授权续接（必须由用户手势触发）
 */

import { isTauri } from '../io';
import {
  armAutoReconnect,
  connectTauriDir,
  detectBackend,
  pickLibraryFolder,
  reconnectFolder,
  useDefaultTauriDir,
} from './storeBackend';
import { hydrateLibrary } from './libraryStore';
import { hydrateAlign } from './alignStore';

let started: Promise<void> | null = null;

async function doInit(): Promise<void> {
  await detectBackend();
  await hydrateLibrary();
  await hydrateAlign();
  // 浏览器重启后文件夹授权会掉回「待确认」：用户一点页面就静默续权，
  // 重连后重新水合（把断连期间写进本地的歌合并回文件夹），数据不分家
  armAutoReconnect(() => {
    void hydrateLibrary();
    void hydrateAlign();
  });
}

export function initStore(): Promise<void> {
  if (!started) started = doInit();
  return started;
}

/** 引导窗「确定」后的统一入口：按运行环境选目录 → 水合（旧数据自动迁移） */
export async function configureLibraryLocation(): Promise<void> {
  if (isTauri()) {
    const dialog = await import('@tauri-apps/api/dialog');
    const dir = await dialog.open({ directory: true, title: '选择曲库文件夹' });
    if (typeof dir !== 'string' || !dir) throw new Error('未选择文件夹');
    connectTauriDir(dir);
  } else {
    await pickLibraryFolder();
  }
  await hydrateLibrary();
  await hydrateAlign();
}

export async function pickAndConnectFolder(): Promise<void> {
  await pickLibraryFolder();
  await hydrateLibrary();
  await hydrateAlign();
}

/** 引导窗「使用默认位置」：曲库存进应用数据目录（路径在弹窗里亮出来） */
export async function useDefaultLocation(): Promise<void> {
  useDefaultTauriDir();
  await hydrateLibrary();
  await hydrateAlign();
}

export { reconnectFolder };
