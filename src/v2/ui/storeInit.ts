/**
 * 曲库存储的启动与连接编排：
 *
 *   initStore()            App 挂载时调用一次（幂等）：探测后端 → 水合曲库与标定
 *   pickAndConnectFolder() 曲库页的「把曲库放进文件夹」：选目录 → 水合
 *                          （文件夹里还没有库时，libraryStore 会自动把
 *                           localStorage 里的歌迁进去，升级不丢数据）
 *   reconnectFolder()      浏览器重启后的授权续接（必须由用户手势触发）
 */

import { armAutoReconnect, detectBackend, pickLibraryFolder, reconnectFolder } from './storeBackend';
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

export async function pickAndConnectFolder(): Promise<void> {
  await pickLibraryFolder();
  await hydrateLibrary();
  await hydrateAlign();
}

export { reconnectFolder };
