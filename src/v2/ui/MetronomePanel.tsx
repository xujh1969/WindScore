import { useEffect } from 'react';
import { METRONOME_PATTERNS } from '../metronome';
import { ExpClose } from './ExpClose';

export interface MetronomePanelProps {
  /** 开关在播放条上（节拍器|⌄），这里只读它显示运行状态 */
  follow: boolean;
  /** 谱面的速度（拍/分）：只读显示，节拍器不自己定速度 */
  bpm: number;
  /** 谱面的拍号：只读显示 */
  scoreMeter: string;
  patternId: string;
  onPattern: (v: string) => void;
  volume: number;
  onVolume: (v: number) => void;
  /** 复拍子次强拍（GB/T 46845—2025 §6.3.13）：6/8、9/8、12/8 后续大拍打次强 */
  compoundMedium: boolean;
  onCompoundMedium: (v: boolean) => void;
  /** 音乐是否正在放（跟随模式只有放歌时才有拍） */
  playing: boolean;
  onClose: () => void;
}

/**
 * 节拍器面板：**只跟着谱面**，开关在播放条上，这里只管配置。
 *
 * 速度与拍号都取自谱面（这里只读显示），用户不能另设一个速度——
 * 否则节拍器和谱子对不上，跟着打就没意义了。
 * 面板里只留真正能调的：拍内节奏型（每拍怎么分）与音量。
 */
export function MetronomePanel(props: MetronomePanelProps) {
  const { follow, bpm, scoreMeter, patternId, onPattern, volume, onVolume, compoundMedium, onCompoundMedium, playing, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const statusText = follow && playing
    ? `跟着谱面打拍中 · ${bpm} BPM · ${scoreMeter}`
    : follow
      ? `已开启 · 放歌时开始打拍（${bpm} BPM · ${scoreMeter}）`
      : '已关闭';

  return (
    <div className="v2-exp-mask" onClick={onClose}>
      <div
        className="v2-exp v2-metronome-panel"
        role="dialog"
        aria-label="节拍器"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-exp-head">
          <span>节拍器</span>
          <ExpClose onClose={onClose} />
        </div>

        <div className="v2-field">
          <span className="v2-field-label">节奏型（每拍怎么分）</span>
          <div className="v2-grid v2-grid-2">
            {METRONOME_PATTERNS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === patternId ? 'v2-btn is-on' : 'v2-btn'}
                onClick={() => onPattern(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="v2-field">
          <span className="v2-field-label">音量</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </div>

        <div className="v2-field">
          <label className="v2-grace-check" title="复拍子（6/8、9/8、12/8）的后续大拍打次强拍——比强拍轻、比弱拍重（GB/T 46845—2025 §6.3.13）。普通拍子（2/4、3/4、4/4）没有次强拍，此开关不起作用">
            <input
              type="checkbox"
              checked={compoundMedium}
              onChange={(e) => onCompoundMedium(e.target.checked)}
            />
            复拍子次强拍
          </label>
        </div>

        {/* 运行状态：开没开、打没打，一眼可见（改节奏型/音量时不用猜） */}
        <div className="v2-field">
          <div className={`v2-metronome-state${follow && playing ? ' is-on' : ''}`} role="status">
            <span className="v2-metronome-dot" aria-hidden />
            {statusText}
          </div>
        </div>
      </div>
    </div>
  );
}
