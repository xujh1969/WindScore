/**
 * 「先配置曲库位置」引导窗。
 *
 * 触发：进入动态谱演奏首页 / 曲库管理页时，探测发现曲库位置还没配置
 * （exe 没选过目录且数据目录为空；Web 没选过文件夹）。
 *
 * 「选择文件夹」= 用户确认并选择本地目录 → 曲库落进那个文件夹（迁移即拷贝）。
 * 「暂不」= 用浏览器内置存储继续（功能完整，但数据不落在用户能看见的文件夹里）。
 *
 * 复用导出弹窗的遮罩与卡片样式（v2-exp-mask / v2-exp）。
 */

import { useState } from 'react';
import { configureLibraryLocation } from './storeInit';

export function LibrarySetupDialog({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = (): void => {
    setBusy(true);
    setError('');
    configureLibraryLocation()
      .then(onDone)
      .catch((e) => {
        // 用户在系统对话框里点了取消不算错，安静关掉即可
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
          {error ? <p className="v2-exp-err">{error}</p> : null}
        </div>
        <div className="v2-exp-foot">
          <span className="v2-exp-note">
            {busy ? '正在连接…' : '点「确定」选择一个文件夹作为曲库位置'}
          </span>
          <button className="v2-btn v2-btn--primary" onClick={pick} disabled={busy}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
