/**
 * 安卓播放页的「合成音音色」弹窗（播放设置 → 合成音音色行打开，仅合成音场景出现）：
 * **每声部两行**——音色下拉 + 八度下拉（不移 / 升八度 / 降八度）。
 * 「跟随谱面」= 不覆盖，按声部在谱面里的设置发声。只影响本播放界面的合成音
 * （按曲名记住，编辑界面与导出始终按谱面发声），谱面文件不动。
 *
 * 与 PC 版 PlayTimbreDialog 共用 playTimbre.ts 的数据与持久化，两端互通；
 * 交互上沿用安卓自己的 AndroidDialog / AndroidSelect（0.2.97 教训：包下拉的
 * 设置行必须用 <div>，不能是 <label>，否则点选项卡空白会立刻重弹）。
 */
import { AndroidDialog } from './AndroidComponents';
import { AndroidSelect } from './AndroidPlayer';
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

/** 音色下拉的公共选项（「跟随谱面」由每行单独给，默认值各声部不同）。括号备注只留在下拉里，谱面标注用简略名 */
function TimbreOptions() {
  const patches = instrumentPatches();
  return [
    ...(patches.includes(0) ? [] : [{ value: '0', label: '钢琴（合成）' }]),
    ...patches.map((p) => ({ value: String(p), label: `${instrumentLabel(p) ?? p}（真采样 · ${instrumentSource(p)}）` })),
  ];
}

export function AndroidTimbreDialog({ score, timbre, onChange, onClose }: Props) {
  const parts = scoreParts(score);
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
  return <AndroidDialog title="合成音音色" onClose={onClose} className="an-settings">
    <section className="an-settings-section">
      {parts.map((p) => {
        const ov = timbre?.parts?.[p.id];
        return <div key={p.id} className="an-timbre-group">
          <div className="an-setting"><span>「{p.name}」音色</span><AndroidSelect
            label={`声部「${p.name}」音色`}
            value={ov?.patch === undefined ? '' : String(ov.patch)}
            onChange={(v) => setPart(p.id, 'patch', v === '' ? undefined : Number(v))}
            options={[{ value: '', label: `跟随谱面（${shortInstrumentLabel(p.patch ?? score.meta.patch) ?? `音色 ${p.patch ?? score.meta.patch}`}）` }, ...TimbreOptions()]} /></div>
          <div className="an-setting"><span>「{p.name}」八度</span><AndroidSelect
            label={`声部「${p.name}」音色八度`}
            value={String(ov?.octave ?? 0)}
            onChange={(v) => setPart(p.id, 'octave', v === '0' ? undefined : Number(v))}
            options={[{ value: '0', label: '不移' }, { value: '1', label: '升八度（+8）' }, { value: '-1', label: '降八度（−8）' }]} /></div>
        </div>;
      })}
      <p className="an-setting-hint">每个声部单独选：「跟随谱面」按声部在谱面里的设置发声；升/降八度只挪发声不动记谱。只影响本播放界面的合成音，按这首曲子记住；播放中修改会先停，再从下一次播放用新音色。</p>
    </section>
  </AndroidDialog>;
}
