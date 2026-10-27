/**
 * 播放界面的「合成音音色」弹窗（播放工具条「音色」按钮打开，仅合成音场景出现）：
 * **每声部一行**——音色下拉 + 右侧竖排的 +8 / -8 互斥扁按钮（音色八度，点亮的再点一下取消）。
 * 「跟随谱面」= 不覆盖，按声部在谱面里的设置发声。只影响本次合成音播放（按曲名记住），
 * 谱面文件不动。
 *
 * 弹窗规范（全站统一）：关闭按钮只有右上角 ×，遮罩点击 / ESC 同样关闭。
 */
import type { ReactNode } from 'react';
import { ExpClose } from './ExpClose';
import { scoreParts } from '../parts';
import { instrumentLabel, instrumentPatches, instrumentSource, shortInstrumentLabel } from '../instrumentSamples';
import type { PlayTimbre, PlayTimbrePart } from './playTimbre';
import type { Score } from '../types';

interface Props {
  score: Score;
  timbre: PlayTimbre | undefined;
  onChange: (timbre: PlayTimbre | null) => void;
  onClose: () => void;
}

/** 音色下拉的公共选项（「跟随谱面」由调用方给，默认值各声部不同）。括号备注只留在下拉里，谱面标注用简略名 */
function TimbreOptions(): ReactNode {
  const patches = instrumentPatches();
  return (
    <>
      {/* 0 号没被包覆盖时才是合成钢琴；覆盖了（如 GM 包的三角钢琴）就跟包走，不重复列 */}
      {patches.includes(0) ? null : <option value="0">钢琴（合成）</option>}
      {patches.map((p) => (
        <option key={p} value={p}>
          {instrumentLabel(p) ?? p}（真采样 · {instrumentSource(p)}）
        </option>
      ))}
    </>
  );
}

export function PlayTimbreDialog({ score, timbre, onChange, onClose }: Props) {
  const parts = scoreParts(score);
  const patchValue = (v: number | undefined): string => (v === undefined ? '' : String(v));

  const setPart = (id: string, field: 'patch' | 'octave', value: number | undefined): void => {
    const raw = timbre?.parts?.[id];
    const prev: PlayTimbrePart = raw ? { ...raw } : {};
    if (value === undefined) delete prev[field];
    else prev[field] = value;
    const nextParts = { ...timbre?.parts };
    if (prev.patch === undefined && prev.octave === undefined) delete nextParts[id];
    else nextParts[id] = prev;
    onChange(Object.keys(nextParts).length ? { parts: nextParts } : null);
  };

  return (
    <div className="v2-exp-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-exp v2-part-dialog" role="dialog" aria-modal="true" aria-label="合成音音色" onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab') {
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('select:not(:disabled), button:not(:disabled)'));
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="v2-exp-head"><strong>合成音音色</strong><ExpClose onClose={onClose} /></div>
        <div className="v2-exp-body v2-part-settings">
          {parts.map((p) => {
            const ov = timbre?.parts?.[p.id];
            const oct = ov?.octave ?? 0;
            return (
              <div className="v2-timbre-row" key={p.id}>
                <label className="v2-timbre-part">
                  声部「{p.name}」
                  <select value={patchValue(ov?.patch)} onChange={(e) => setPart(p.id, 'patch', e.target.value === '' ? undefined : Number(e.target.value))}>
                    <option value="">跟随谱面（{shortInstrumentLabel(p.patch ?? score.meta.patch) ?? `音色 ${p.patch ?? score.meta.patch}`}）</option>
                    <TimbreOptions />
                  </select>
                </label>
                <div className="v2-timbre-oct" role="group" aria-label={`声部「${p.name}」音色八度`}>
                  <button type="button" className={oct === 1 ? 'is-on' : ''} title="音色升八度（只挪发声不动记谱）；再点一下取消" onClick={() => setPart(p.id, 'octave', oct === 1 ? undefined : 1)}>+8</button>
                  <button type="button" className={oct === -1 ? 'is-on' : ''} title="音色降八度（只挪发声不动记谱）；再点一下取消" onClick={() => setPart(p.id, 'octave', oct === -1 ? undefined : -1)}>-8</button>
                </div>
              </div>
            );
          })}
          <p className="v2-exp-hint">
            每个声部单独选；「跟随谱面」按声部在谱面里的设置（声部配置 / 谱头 @patch）发声。+8 / -8 只挪发声不动记谱，两边互斥，点亮的再点一下取消。只影响**本播放界面**的合成音（编辑界面与导出始终按谱面发声），不改谱面文件，按这首曲子记住；播放中修改会先停，再从下一次播放用新音色。
          </p>
        </div>
      </div>
    </div>
  );
}
