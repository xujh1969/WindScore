import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AndroidDialog, AndroidIcon } from './AndroidComponents';
import { METRONOME_PATTERNS } from '../metronome';
import type { PlayStyle } from '../paint';
import type { StaffPitchMode } from '../pitch';

/**
 * 自绘下拉：原生 <select> 的弹出列表是系统控件，字体大小跟着系统字体缩放走，
 * 在设置弹窗里显得巨大突兀。这里改用贴着触发按钮弹出的选项卡：
 * 出现在按钮正下方（下方放不下则向上弹），点选项先收起再应用，点空白处收起。
 * 注意两点（0.2.96 实测「选完不关闭」的教训）：
 * ① 设置行绝不能用 <label> 包本组件——选项卡是 label 的子孙，点选项卡空白处会被
 *    label 转发给关联控件（触发按钮），刚收起又立刻弹开。设置行一律用 <div>。
 * ② 选项卡/选项的点击仍保留 preventDefault + stopPropagation 双保险，任何一层
 *    转发/冒泡机制都吃不到这次点击；选项缝隙的点击冒泡到选项卡统一收起。
 * 导出给同为安卓风格的弹窗复用（如合成音音色 AndroidTimbreDialog）。
 */
export function AndroidSelect({ value, options, onChange, disabled, label }: {
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openAt = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) { setPos(null); setOpen(true); return; }
    const width = Math.max(Math.round(r.width), 210);
    const maxH = Math.min(Math.round(window.innerHeight * 0.55), 380);
    const left = Math.min(Math.max(10, r.right - width), Math.max(10, window.innerWidth - width - 10));
    let top = r.bottom + 6;
    if (top + maxH > window.innerHeight - 12) top = Math.max(12, r.top - maxH - 6);
    setPos({ left, top, width, maxH });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    // 打开时把当前选中项滚进可视区
    listRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  return <>
    <button ref={btnRef} type="button" className="an-select" disabled={disabled} onClick={openAt}>{options.find(o => o.value === value)?.label ?? value}</button>
    {open && <div className="an-select-sheet" role="dialog" aria-label={label} onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}>
      <div ref={listRef} className="an-select-list"
        style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH } : undefined}>
        {options.map(o => (
          <button key={o.value} type="button" disabled={o.disabled}
            className={o.value === value ? 'an-select-option is-on' : 'an-select-option'}
            onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); onChange(o.value); }}>
            {o.label}{o.value === value ? '　✓' : ''}
          </button>
        ))}
      </div>
    </div>}
  </>;
}

interface Props {
  title: string; playing: boolean; busy: boolean; restoring: boolean; audioReady: boolean;
  duration: number; getSeconds: () => number; onSeek: (seconds: number) => void;
  onToggle: () => void; onReplay: () => void; onBack: () => void;
  renderScore: () => ReactNode;
  notation: 'jianpu' | 'staff'; onNotation: (staff: boolean) => void;
  /** 五线谱的调性视图：实音谱 / 乐器移调谱（仅记谱方式 = 五线谱时显示） */
  pitch: StaffPitchMode; onPitch: (value: StaffPitchMode) => void;
  parts: { id: string; name: string }[]; selectedPart: string; allowTotal: boolean; onPart: (id: string) => void;
  source: 'audio' | 'synth'; onSource: (value: 'audio' | 'synth') => void;
  font: number; onFont: (value: number) => void; onResetFont: () => void; gap: number; onGap: (value: number) => void;
  /** 行间距（行高增量 px）：与字间距同排的阅读偏好 */
  lineGap: number; onLineGap: (value: number) => void;
  style: PlayStyle; onStyle: (value: PlayStyle) => void;
  /** 伴奏分轨：勾哪条放哪条，播放中即时生效；vocal 用于「无人声」快捷 */
  stems: { name: string; on: boolean; vocal: boolean }[];
  onStem: (index: number) => void; onStemsAll: () => void; onStemsNoVocal: () => void;
  expanded: boolean; canExpand: boolean; onExpand: (value: boolean) => void;
  /** 升降调 ±5 半音、速度 0.60–1.40×：与 PC 端 MAX_SEMITONES / MIN_SPEED / MAX_SPEED 对齐，防 WSOLA 明显失真 */
  transpose: number; onTranspose: (value: number) => void; speed: number; onSpeed: (value: number) => void;
  /** 节拍器：跟随谱面打拍、拍内节奏型、音量（与 PC 端同一套状态） */
  metronomeFollow: boolean; onMetronomeFollow: (value: boolean) => void;
  metronomePattern: string; onMetronomePattern: (value: string) => void;
  metronomeVolume: number; onMetronomeVolume: (value: number) => void;
  /** 立刻打一声：确认声音通不通（浏览器要求先有一次点击才允许出声） */
  onMetronomeTest: () => void;
  /** 谱面拍号与速度（跟随模式下强弱与速度按它们来，节拍器不自己定） */
  scoreBeat: string;
  metronomeBpm: number;
  /** 合成音音色：行值文案与打开弹窗（仅合成音场景显示，undefined = 整个入口不出现） */
  timbreLabel: string; onOpenTimbre?: () => void;
  message?: string;
}
function time(value: number) { const seconds = Math.max(0, Math.floor(value)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
export function AndroidPlayer(p: Props) {
  const [visible, setVisible] = useState(true);
  const [settings, setSettings] = useState(false);
  const [activity, setActivity] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const revealOnly = useRef(false);
  const fontRef = useRef(p.font); fontRef.current = p.font;
  const setFontRef = useRef(p.onFont); setFontRef.current = p.onFont;
  const secondsRef = useRef(p.getSeconds); secondsRef.current = p.getSeconds;
  const wake = () => { setVisible(true); setActivity(n => n + 1); };
  useEffect(() => {
    setVisible(true);
    if (!p.playing || settings) return;
    const id = setTimeout(() => setVisible(false), 5000); return () => clearTimeout(id);
  }, [p.playing, activity, settings]);
  useEffect(() => {
    const update = () => setSeconds(secondsRef.current()); update();
    if (!p.playing) return;
    const id = setInterval(update, 100); return () => clearInterval(id);
  }, [p.playing, p.getSeconds]);
  useEffect(() => {
    if (!p.playing) return;
    const native = (window as unknown as { WindScoreAndroid?: { setPlaybackActive: (active: boolean) => void } }).WindScoreAndroid;
    native?.setPlaybackActive(true);
    let lock: WakeLockSentinel | null = null; let disposed = false;
    const release = () => { if (lock) void lock.release().catch(() => {}); lock = null; };
    const sync = async () => {
      release(); if (document.hidden || !navigator.wakeLock) return;
      try { const next = await navigator.wakeLock.request('screen'); if (disposed || document.hidden) await next.release(); else lock = next; } catch { /* 浏览器不允许时正常播放 */ }
    };
    void sync(); document.addEventListener('visibilitychange', sync);
    return () => { disposed = true; release(); native?.setPlaybackActive(false); document.removeEventListener('visibilitychange', sync); };
  }, [p.playing]);
  useEffect(() => {
    const node = stage.current; if (!node) return;
    let pinch: { distance: number; font: number } | null = null;
    let frame = 0; let nextFont = fontRef.current;
    const distance = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const start = (e: TouchEvent) => { if (e.touches.length === 2) { e.preventDefault(); pinch = { distance: Math.max(1, distance(e)), font: fontRef.current }; } };
    const move = (e: TouchEvent) => { if (pinch && e.touches.length === 2) {
      e.preventDefault(); nextFont = Math.round(Math.max(14, Math.min(42, pinch.font * distance(e) / pinch.distance)));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (nextFont !== fontRef.current) setFontRef.current(nextFont); });
    } };
    const end = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; setFontRef.current(nextFont); } pinch = null; };
    node.addEventListener('touchstart', start, { passive: false }); node.addEventListener('touchmove', move, { passive: false }); node.addEventListener('touchend', end); node.addEventListener('touchcancel', end);
    return () => { cancelAnimationFrame(frame); node.removeEventListener('touchstart', start); node.removeEventListener('touchmove', move); node.removeEventListener('touchend', end); node.removeEventListener('touchcancel', end); };
  }, []);
  return <div className={`an-player ${visible ? '' : 'an-controls-hidden'}`} onPointerDownCapture={e => {
    revealOnly.current = !visible;
    if (!visible) { e.preventDefault(); e.stopPropagation(); }
    wake();
  }} onMouseDownCapture={e => { if (revealOnly.current || !visible) { e.preventDefault(); e.stopPropagation(); wake(); } }} onClickCapture={e => { if (revealOnly.current) { e.preventDefault(); e.stopPropagation(); revealOnly.current = false; } }}>
    <header className="an-player-top" aria-hidden={!visible}><button className="an-icon-button" aria-label="返回曲库" onClick={p.onBack}><AndroidIcon name="back"/></button><div><h1>{p.title}</h1>{p.parts.length > 1 ? <span className="an-player-part" title="分谱选择只改变显示，声音仍播放全部声部。">{p.selectedPart === 'total' ? '当前显示：总谱（全部声部）' : `当前分谱：${p.parts.find(part => part.id === p.selectedPart)?.name ?? '未命名声部'}`}</span> : <span>{p.notation === 'staff' ? '五线谱' : '简谱'}{p.expanded && p.canExpand ? ' · 已展开反复' : ''}</span>}</div><span className="an-player-source">{p.restoring ? '载入中' : p.source === 'audio' ? '伴奏' : '合成音'}</span></header>
    <div ref={stage} className="an-player-stage" onDoubleClick={p.onResetFont}>{p.renderScore()}</div>
    <footer className="an-player-controls" aria-hidden={!visible}>
      <div className="an-progress"><input aria-label="播放进度" type="range" min="0" max={Math.max(0.01, p.duration)} step="0.1" value={Math.min(seconds, p.duration)} onChange={e => { const v = Number(e.target.value); setSeconds(v); p.onSeek(v); wake(); }}/><div><span>{time(seconds)}</span><span>{time(p.duration)}</span></div></div>
      <div className="an-transport"><button className="an-transport-side" onClick={p.onReplay} aria-label="从头重放" disabled={p.busy || p.restoring}><AndroidIcon name="replay"/><span>重放</span></button><button className="an-play-button" aria-label={p.playing ? '暂停' : '播放'} onClick={p.onToggle} disabled={p.busy || p.restoring || p.duration <= 0}><AndroidIcon name={p.playing ? 'pause' : 'play'} filled={!p.playing}/></button><button className="an-transport-side" onClick={() => setSettings(true)} aria-label="播放设置"><AndroidIcon name="settings"/><span>设置</span></button></div>
    </footer>
    {settings && <AndroidDialog title="播放设置" onClose={() => setSettings(false)} className="an-settings">
      <section className="an-settings-section"><h3>谱面与声音</h3>{p.parts.length > 1 && <div className="an-setting"><span>显示声部</span><AndroidSelect label="显示声部" value={p.selectedPart} onChange={p.onPart} options={[...(p.allowTotal ? [{ value: 'total', label: '总谱' }] : []), ...p.parts.map(part => ({ value: part.id, label: part.name }))]} /></div>}<div className="an-setting"><span>记谱方式</span><AndroidSelect label="记谱方式" value={p.notation} onChange={v => p.onNotation(v === 'staff')} options={[{ value: 'jianpu', label: '简谱' }, { value: 'staff', label: '五线谱' }]} /></div>{p.notation === 'staff' && <div className="an-setting"><span>五线谱调性</span><AndroidSelect label="五线谱调性" value={p.pitch} onChange={v => p.onPitch(v as StaffPitchMode)} options={[{ value: 'concert', label: '实音谱（按实际音高）' }, { value: 'transposed', label: '乐器移调谱' }]} /></div>}<div className="an-setting"><span>音源</span><AndroidSelect label="音源" value={p.source} onChange={v => p.onSource(v as 'audio' | 'synth')} options={[{ value: 'synth', label: '合成音' }, { value: 'audio', label: '伴奏', disabled: !p.audioReady }]} /></div><label className="an-setting"><span>展开重复</span><input type="checkbox" checked={p.expanded} disabled={!p.canExpand} onChange={e => p.onExpand(e.target.checked)}/></label></section>
      {p.stems.length > 0 && <section className="an-settings-section"><h3>伴奏分轨</h3>
        {p.stems.map((s, i) => <label className="an-setting" key={s.name + i} title={s.on ? '点击静音这条' : '点击放这条'}>
          <span>{s.name.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '')}{s.vocal ? ' · 人声' : ''}</span>
          <input type="checkbox" checked={s.on} onChange={() => p.onStem(i)}/>
        </label>)}
        <div className="an-setting-actions">
          <button className="an-secondary" onClick={p.onStemsAll} title="所有分轨都放">全放</button>
          <button className="an-secondary" onClick={p.onStemsNoVocal} disabled={!p.stems.some(s => s.vocal)} title="关掉人声分轨，只放伴奏（练习用）">无人声</button>
        </div>
        <p className="an-setting-hint">练习时关掉人声只留伴奏；切换即时生效，不用重播。</p>
      </section>}
      <section className="an-settings-section"><h3>阅读显示</h3><label className="an-setting an-range-setting"><span>字体大小 <output>{p.font}px</output></span><input aria-label="字体大小" type="range" min="14" max="42" value={p.font} onChange={e => p.onFont(Number(e.target.value))}/></label><label className="an-setting an-range-setting"><span>字间距 <output>{p.gap}px</output></span><input aria-label="字间距" type="range" min="-20" max="24" value={p.gap} onChange={e => p.onGap(Number(e.target.value))}/></label><label className="an-setting an-range-setting"><span>行间距 <output>{p.lineGap}px</output></span><input aria-label="行间距" type="range" min="0" max="48" value={p.lineGap} onChange={e => p.onLineGap(Number(e.target.value))}/></label><div className="an-setting"><span>光标类型</span><AndroidSelect label="光标类型" value={p.style} onChange={v => p.onStyle(v as PlayStyle)} options={[{ value: 'head', label: '光标' }, { value: 'band', label: '高亮条' }, { value: 'ball', label: '光球' }]} /></div><p className="an-setting-hint">双指调整字号，自动按屏宽排版；双击恢复原字号。行间距拉开谱行，长谱可少翻一些。</p></section>
      {p.source === 'synth' && p.onOpenTimbre ? <section className="an-settings-section"><h3>合成音音色</h3>
        <div className="an-setting"><span>每声部音色</span><button type="button" className="an-select" onClick={p.onOpenTimbre} title="打开音色选择弹窗">{p.timbreLabel} ›</button></div>
        <p className="an-setting-hint">按声部选合成音用哪种乐器（钢琴、音色包里的音色…），不改谱面，按这首曲子记住。</p>
      </section> : null}
      {p.source === 'synth' ? <section className="an-settings-section"><h3>节拍器</h3>
        <label className="an-setting"><span>跟着谱面打拍</span><input type="checkbox" checked={p.metronomeFollow} onChange={e => p.onMetronomeFollow(e.target.checked)}/></label>
        <div className="an-setting"><span>节奏型</span><AndroidSelect label="节奏型" value={p.metronomePattern} onChange={p.onMetronomePattern} options={METRONOME_PATTERNS.map(m => ({ value: m.id, label: m.label }))} /></div>
        <label className="an-setting an-range-setting"><span>节拍器音量 <output>{Math.round(p.metronomeVolume * 100)}%</output></span><input aria-label="节拍器音量" type="range" min="0" max="1" step="0.05" value={p.metronomeVolume} onChange={e => p.onMetronomeVolume(Number(e.target.value))}/></label>
        <div className="an-setting-actions"><button className="an-secondary" onClick={p.onMetronomeTest} title="立刻打一声，确认节拍器声音通不通">试一下</button></div>
        <p className="an-setting-hint">跟着谱面打：{p.metronomeBpm} BPM · {p.scoreBeat}，小节第一拍重音。只跟变速（倍速播放时一起变快），不跟移调。</p>
      </section> : null}
      <section className="an-settings-section"><h3>练习参数</h3><div className="an-setting"><span>升降调</span><AndroidSelect label="升降调" value={String(p.transpose)} disabled={p.busy} onChange={v => p.onTranspose(Number(v))} options={Array.from({ length: 11 }, (_, i) => i - 5).map(n => ({ value: String(n), label: n === 0 ? '原调' : `${n > 0 ? '+' : ''}${n} 半音` }))} /></div><label className="an-setting an-range-setting"><span>播放速度 <output>{p.speed.toFixed(2)}×</output></span><input aria-label="播放速度" type="range" min="0.6" max="1.4" step="0.05" disabled={p.busy} value={p.speed} onChange={e => p.onSpeed(Number(e.target.value))}/></label><p className="an-setting-hint">变调 ±5、变速 0.60–1.40×：与电脑版一致，超出这个范围伴奏会明显失真。</p></section>
    </AndroidDialog>}
    {(p.busy || p.restoring) && <div className="an-player-status" role="status">{p.busy ? '正在处理伴奏…' : '正在载入伴奏…'}</div>}
    {p.message && <p className="an-player-error" role="status">{p.message}</p>}
  </div>;
}
