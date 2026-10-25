/**
 * 已装音色包列表弹窗（曲库页「音色列表」按钮打开）：
 * 一列已导入的音色包（名称 / 大小 / GM 编号），旁边就是删除——
 * 不搞分区，进来一眼看到装了什么、能删什么。
 *
 * 删除是两步确认（点「移除」→「确认移除」），因为会**连包文件一起删掉**，
 * 误触一次就得重新找文件导入。删除后音色立刻回落内置（unregisterBank）。
 *
 * 弹窗规范（全站统一）：关闭按钮只有右上角 ×，遮罩点击 / ESC 同样关闭。
 */
import { useRef, useState } from 'react';
import { ExpClose } from './ExpClose';
import { listBanks, removeBank, saveBank, type BankInfo } from './instrumentBank';

interface Props {
  banks: BankInfo[];
  /** 删除 / 导入后把最新列表递回去（父组件里它同时喂着曲库页头部的计数） */
  onBanks: (banks: BankInfo[]) => void;
  onNotify: (msg: string) => void;
  onClose: () => void;
}

export function BankManagerDialog({ banks, onBanks, onNotify, onClose }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImport = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setBusy(true);
    let ok = 0;
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      try {
        await saveBank(f);
        ok += 1;
      } catch (e) {
        bad.push(`${f.name}（${(e as Error).message}）`);
      }
    }
    onBanks(await listBanks());
    setBusy(false);
    onNotify(bad.length === 0 ? `已装入 ${ok} 个音色包` : `已装入 ${ok} 个；失败：${bad.join('、')}`);
  };

  const handleRemove = async (name: string): Promise<void> => {
    await removeBank(name);
    onBanks(await listBanks());
    setConfirming(null);
    onNotify(`已移除音色包「${name}」：包文件已删除，音色回落内置`);
  };

  return (
    <div className="v2-exp-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-exp v2-bank-dialog" role="dialog" aria-modal="true" aria-label="已装音色包" onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab') {
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'));
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="v2-exp-head"><strong>已装音色包</strong><ExpClose onClose={onClose} /></div>
        <div className="v2-exp-body">
          {banks.length === 0 ? (
            <p className="v2-exp-hint">
              还没有导入音色包。不导入也能用——钢琴和内置真采样（手风琴、口琴、小提琴、中音萨克斯、次中音萨克斯、长笛）始终可用。
            </p>
          ) : (
            banks.map((b) => (
              <div className="v2-bank-row" key={b.name}>
                <div className="v2-bank-row-main">
                  <strong>{b.name}</strong>
                  <span className="v2-bank-row-meta">
                    {(b.size / 1048576).toFixed(1)}MB · GM {b.patches.join('、')}
                  </span>
                </div>
                {confirming === b.name ? (
                  <span className="v2-bank-row-actions">
                    <span>连包文件一起删，音色回落内置</span>
                    <button className="v2-btn is-danger" onClick={() => void handleRemove(b.name)}>确认移除</button>
                    <button className="v2-btn" onClick={() => setConfirming(null)}>取消</button>
                  </span>
                ) : (
                  <button className="v2-btn" title="移除这个音色包：包文件一并删除，音色立刻回落内置" onClick={() => setConfirming(b.name)}>移除</button>
                )}
              </div>
            ))
          )}
        </div>
        <div className="v2-part-dialog-footer">
          <input ref={fileRef} type="file" accept=".wsbank" multiple hidden onChange={(e) => {
            void handleImport(e.target.files);
            e.target.value = '';
          }} />
          <button className="v2-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '导入中…' : '导入音色包…'}
          </button>
        </div>
      </div>
    </div>
  );
}
