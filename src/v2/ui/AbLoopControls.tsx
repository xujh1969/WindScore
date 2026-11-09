/**
 * AB 循环控件：PC 播放工具条与安卓播放控件共用同一份交互与文案。
 * 两端只差 CSS 类名前缀（`v2-ab` / `an-ab`），行为完全一致。
 * 循环图标夹在 A、B 之间：点亮 = 开启 A→B 循环，灰暗 = 普通播放。
 */
export interface AbLoopControlsProps {
  variant: 'pc' | 'android';
  /** A / B 是否已设（按钮变色） */
  aSet: boolean;
  bSet: boolean;
  enabled: boolean;
  /** 谱面上是否已选中一个音符（没选中时 A / B 不可用） */
  hasSelection: boolean;
  /** A、B 都已设好 */
  ready: boolean;
  onSetA: () => void;
  onSetB: () => void;
  onToggle: (on: boolean) => void;
}

/** 用户给的循环箭头图标（viewBox 1024），颜色交给 currentColor 由高亮 / 灰暗态控制 */
function LoopIcon() {
  return <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M446.59712 319.5904l0.96256 0.84992 102.4 102.2976c1.67936 1.6896 2.6624 3.81952 2.92864 6.01088 0 0.08192 0 0.17408 0.02048 0.256a6.93248 6.93248 0 0 1 0.0512 0.74752v0.67584l-0.03072 0.32768L552.96 430.08c0 3.24608-1.50528 6.144-3.86048 8.01792l-101.53984 101.62176a10.24 10.24 0 0 1-15.33952-13.5168l0.86016-0.96256L517.90848 440.32H215.04v245.76h593.92V440.32H655.36a10.24 10.24 0 0 1-10.16832-9.04192L645.12 430.08a10.24 10.24 0 0 1 9.04192-10.16832L655.36 419.84h163.84a10.24 10.24 0 0 1 10.16832 9.04192L829.44 430.08v266.24a10.24 10.24 0 0 1-9.04192 10.16832L819.2 706.56H204.8a10.24 10.24 0 0 1-10.16832-9.04192L194.56 696.32V430.08a10.24 10.24 0 0 1 9.04192-10.16832L204.8 419.84h313.27232l-84.992-84.92032a10.24 10.24 0 0 1-0.86016-13.5168l0.86016-0.96256a10.24 10.24 0 0 1 13.5168-0.86016z" />
  </svg>;
}

export function AbLoopControls(p: AbLoopControlsProps) {
  const c = p.variant === 'pc' ? 'v2-ab' : 'an-ab';
  const pickHint = p.hasSelection ? '' : '请先在谱面中点选一个音符；';
  const loopHint = !p.ready
    ? '请先分别点 A、B 设好循环点，再点图标开启循环'
    : p.enabled ? '循环已开启：点一下图标关闭，回到普通播放'
      : '循环已关闭：点一下图标开启 A→B 往复播放（关闭时播放不受循环点影响）';
  return <div className={`${c}-group`} role="group" aria-label="AB 循环播放">
    <button type="button" className={`${c}-btn ${p.aSet ? 'is-on' : ''}`}
      disabled={!p.hasSelection} aria-pressed={p.aSet} onClick={p.onSetA}
      title={`${pickHint}把选中的音符设为循环起点 A（再点一次可重设到新音符）`}>A</button>
    <button type="button" className={`${c}-loop ${p.enabled ? 'is-on' : ''}`}
      aria-pressed={p.enabled} aria-label={p.enabled ? '关闭 AB 循环' : '开启 AB 循环'}
      onClick={() => p.onToggle(!p.enabled)}
      title={loopHint}><LoopIcon /></button>
    <button type="button" className={`${c}-btn ${p.bSet ? 'is-on' : ''}`}
      disabled={!p.hasSelection} aria-pressed={p.bSet} onClick={p.onSetB}
      title={`${pickHint}把选中的音符设为循环终点 B，播放到它的音值走完（再点一次可重设）`}>B</button>
  </div>;
}
