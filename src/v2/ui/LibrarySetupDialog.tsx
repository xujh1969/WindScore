/**
 * 「先配置曲库位置」引导窗。
 *
 * 触发：进入动态谱演奏首页 / 曲库管理页时，探测发现曲库位置还没配置
 * （exe 首次运行没选目录且数据目录为空；Web 没选过文件夹）。
 *
 * exe：直接把**默认路径**亮出来（用户最常问「到底存在哪」），
 *      三选一：用默认位置 / 选其他文件夹 / 暂不用浏览器存储。
 * Web：浏览器不暴露完整路径，两选一：选文件夹 / 暂不。
 *
 * 复用导出弹窗的遮罩与卡片样式（v2-exp-mask / v2-exp）。
 */

import { useState } from 'react';
import { configureLibraryLocation, useDefaultLocation } from './storeInit';

export function LibrarySetupDialog({
  isExe,
  defaultPath,
  onDone,
  onSkip,
}: {
  /** exe 运行：给「使用默认位置」按钮并把默认路径亮出来 */
  isExe: boolean;
  /** exe 的默认曲库位置（完整路径） */
  defaultPath: string | null;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const wrap = (task: () => Promise<void> | void): void => {
    setBusy(true);
    setError('');
    Promise.resolve(task())
      .then(onDone)
      .catch((e) => {
        // 用户在系统对话框里点了取消不算错，安静收回即可
        if ((e as Error).message === '未选择文件夹') onSkip();
        else setError((e as Error).message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="v2-exp-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onSkip();
      }}
    >
      <div className="v2-exp" role="dialog" aria-label="配置曲库位置">
        <div className="v2-exp-head">
          <span className="v2-exp-song">先配置曲库位置</span>
          <button className="v2-btn" onClick={onSkip} disabled={busy}>
            暂不
          </button>
        </div>
        <div className="v2-exp-body">
          <p className="v2-exp-hint">
            还没有配置曲库存放的位置。选一个本地文件夹，你的所有曲谱、伴奏和标定都会存在那里：
          </p>
          <p className="v2-exp-hint">
            · 迁移 = 直接拷贝这个文件夹到别的电脑
            <br />· 换浏览器、重装系统也不丢
          </p>
          {isExe && defaultPath ? (
            <p className="v2-exp-hint">
              默认位置：<span className="v2-exp-link">{defaultPath}</span>
            </p>
          ) : null}
          {error ? <p className="v2-exp-err">{error}</p> : null}
        </div>
        <div className="v2-exp-foot">
          <span className="v2-exp-note">
            {busy ? '正在连接…' : isExe ? '用默认位置，或自己选一个文件夹' : '点「确定」选择一个文件夹'}
          </span>
          <div className="v2-exp-btns">
            {isExe && defaultPath ? (
              <button
                className="v2-btn v2-btn--primary"
                onClick={() => wrap(useDefaultLocation)}
                disabled={busy}
                title="曲库存进应用数据目录（上面亮出的路径）"
              >
                使用默认位置
              </button>
            ) : null}
            <button
              className={isExe ? 'v2-btn' : 'v2-btn v2-btn--primary'}
              onClick={() => wrap(configureLibraryLocation)}
              disabled={busy}
              title={isExe ? '自己挑一个文件夹存放曲库' : '选择一个本地文件夹作为曲库位置'}
            >
              {isExe ? '选择其他文件夹…' : '选择文件夹…'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
