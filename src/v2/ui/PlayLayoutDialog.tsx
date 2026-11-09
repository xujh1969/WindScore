import { ExpClose, useEscapeClose } from './ExpClose';
import type { MeasureNumberMode } from '../types';

export interface PlayLayoutDialogProps {
  /** 当前生效值：观看偏好优先，没设过就取自谱面 */
  font: number;
  gap: number;
  lineGap: number;
  measureNumbers: MeasureNumberMode;
  /** 哪一项已被观看偏好覆盖（决定显不显示 ⟲） */
  overridden: { font: boolean; gap: boolean; lineGap: boolean; measureNumbers: boolean };
  onFont: (v: number | null) => void;
  onGap: (v: number | null) => void;
  onLineGap: (v: number | null) => void;
  onMeasureNumbers: (v: MeasureNumberMode | null) => void;
  onClose: () => void;
}

/**
 * 播放页「版式设置」弹窗：字号 / 字间距 / 行距 / 小节号四项的观看偏好。
 *
 * 这四项以前直接铺在顶部工具条里，把工具条挤得全是滑杆（用户 2026-11-09 定：
 * 收进弹窗，工具条只留一个「版式设置」入口）。值不写进 JPS 文件，
 * ⟲ 把某一项交还给谱面自身的设置；动态谱演奏与曲库播放共用同一份偏好。
 */
export function PlayLayoutDialog(p: PlayLayoutDialogProps) {
  useEscapeClose(p.onClose);
  return (
    <div className="v2-exp-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div
        className="v2-exp v2-play-layout-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="版式设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-exp-head"><strong>版式设置</strong><ExpClose onClose={p.onClose} /></div>
        <div className="v2-exp-body">
          <div className="v2-exp-row v2-play-layout-row" title="字号（只影响播放界面，谱面本身不变）">
            <span>字号</span>
            <input
              type="range"
              min={14}
              max={42}
              step={1}
              value={p.font}
              onChange={(e) => p.onFont(Number(e.target.value))}
            />
            <output>{p.font}px</output>
            {p.overridden.font ? (
              <button type="button" className="v2-play-reset" onClick={() => p.onFont(null)} title="恢复跟随谱面设置">⟲</button>
            ) : null}
          </div>
          <div className="v2-exp-row v2-play-layout-row" title="字间距（观看偏好）">
            <span>字间距</span>
            <input
              type="range"
              min={-20}
              max={24}
              step={1}
              value={p.gap}
              onChange={(e) => p.onGap(Number(e.target.value))}
            />
            <output>{p.gap}px</output>
            {p.overridden.gap ? (
              <button type="button" className="v2-play-reset" onClick={() => p.onGap(null)} title="恢复跟随谱面设置">⟲</button>
            ) : null}
          </div>
          <div className="v2-exp-row v2-play-layout-row" title="行间距（观看偏好，不改谱面）">
            <span>行距</span>
            <input
              type="range"
              min={-24}
              max={48}
              step={1}
              value={p.lineGap}
              onChange={(e) => p.onLineGap(Number(e.target.value))}
            />
            <output>{p.lineGap}px</output>
            {p.overridden.lineGap ? (
              <button type="button" className="v2-play-reset" onClick={() => p.onLineGap(null)} title="恢复跟随谱面设置">⟲</button>
            ) : null}
          </div>
          <div className="v2-exp-row v2-play-layout-row" title="小节号显示（观看偏好，不改谱面）">
            <span>小节号</span>
            <select value={p.measureNumbers} onChange={(e) => p.onMeasureNumbers(e.target.value as MeasureNumberMode)}>
              <option value="all">全部显示</option>
              <option value="line-ends">行首行尾</option>
              <option value="none">全部隐藏</option>
            </select>
            {p.overridden.measureNumbers ? (
              <button type="button" className="v2-play-reset" onClick={() => p.onMeasureNumbers(null)} title="恢复跟随谱面设置">⟲</button>
            ) : null}
          </div>
        </div>
        <p className="v2-exp-hint">
          这些是播放观看偏好，只改变显示、不会写进 JPS 文件。⟲ 让该项恢复跟随谱面设置；动态谱演奏与曲库播放共用，设置会记住（安卓按曲目单独记）。
        </p>
      </div>
    </div>
  );
}
