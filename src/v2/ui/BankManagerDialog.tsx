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
import { listBanks, removeBank, saveBank, type BankImportStage, type BankInfo } from './instrumentBank';

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
  /** 导入进度：第几个 + 当前阶段（大包读文件/写存储都是秒级，得让用户看到卡在哪） */
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 结果写在弹窗自己的状态栏里；列表里看得见的变化不另外弹 toast */
  const [result, setResult] = useState<string | null>(null);

  const handleImport = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setBusy(true);
    setResult(null);
    let ok = 0;
    const bad: string[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      setProgress(list.length > 1 ? `导入 ${i + 1}/${list.length}「${f.name}」` : `导入「${f.name}」`);
      try {
        await saveBank(f, (stage: BankImportStage) => {
          setProgress(
            (list.length > 1 ? `导入 ${i + 1}/${list.length}：` : '') + `${f.name} · 正在${stage}…`,
          );
        });
        ok += 1;
      } catch (e) {
        bad.push(`${f.name}（${(e as Error).message}）`);
      }
    }
    onBanks(await listBanks());
    setBusy(false);
    setProgress(null);
    setResult(bad.length === 0 ? `已装入 ${ok} 个音色包` : `已装入 ${ok} 个；失败：${bad.join('、')}`);
    // 失败才需要打断用户，交给外层 toast
    if (bad.length > 0) onNotify(`音色包导入失败：${bad.join('、')}`);
  };

  const handleRemove = async (name: string): Promise<void> => {
    await removeBank(name);
    onBanks(await listBanks());
    setConfirming(null);
    setResult(`已移除音色包「${name}」：包文件已删除，音色回落内置`);
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
        <input ref={fileRef} type="file" accept=".wsbank" multiple hidden onChange={(e) => {
          void handleImport(e.target.files);
          e.target.value = '';
        }} />
        <div className="v2-bank-toolbar">
          <button className="v2-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '导入中…' : '导入音色包…'}
          </button>
          <span className="v2-bank-toolbar-info">
            {progress ?? result ?? (banks.length > 0
              ? `已装 ${banks.length} 个包 · 共 ${(banks.reduce((acc, b) => acc + b.size, 0) / 1048576).toFixed(1)}MB`
              : '支持 .wsbank 音色包')}
          </span>
        </div>
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
      </div>
    </div>
  );
}
