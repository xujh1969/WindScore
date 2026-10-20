import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AndroidDialog, AndroidIcon } from './AndroidComponents';
import type { PlayStyle } from '../paint';

interface Props {
  title: string; playing: boolean; busy: boolean; restoring: boolean; audioReady: boolean;
  duration: number; getSeconds: () => number; onSeek: (seconds: number) => void;
  onToggle: () => void; onReplay: () => void; onBack: () => void;
  renderScore: () => ReactNode;
  notation: 'jianpu' | 'staff'; onNotation: (staff: boolean) => void;
  parts: { id: string; name: string }[]; selectedPart: string; allowTotal: boolean; onPart: (id: string) => void;
  source: 'audio' | 'synth'; onSource: (value: 'audio' | 'synth') => void;
  font: number; onFont: (value: number) => void; onResetFont: () => void; gap: number; onGap: (value: number) => void;
  style: PlayStyle; onStyle: (value: PlayStyle) => void;
  /** 伴奏分轨：勾哪条放哪条，播放中即时生效；vocal 用于「无人声」快捷 */
  stems: { name: string; on: boolean; vocal: boolean }[];
  onStem: (index: number) => void; onStemsAll: () => void; onStemsNoVocal: () => void;
  expanded: boolean; canExpand: boolean; onExpand: (value: boolean) => void;
  transpose: number; onTranspose: (value: number) => void; speed: number; onSpeed: (value: number) => void;
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
      <section className="an-settings-section"><h3>谱面与声音</h3>{p.parts.length > 1 && <label className="an-setting"><span>显示声部</span><select value={p.selectedPart} onChange={e => p.onPart(e.target.value)}>{p.allowTotal && <option value="total">总谱</option>}{p.parts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label>}<label className="an-setting"><span>记谱方式</span><select value={p.notation} onChange={e => p.onNotation(e.target.value === 'staff')}><option value="jianpu">简谱</option><option value="staff">五线谱</option></select></label><label className="an-setting"><span>音源</span><select value={p.source} onChange={e => p.onSource(e.target.value as 'audio' | 'synth')}><option value="synth">合成音</option><option value="audio" disabled={!p.audioReady}>伴奏{!p.audioReady ? '（未载入）' : ''}</option></select></label><label className="an-setting"><span>展开重复</span><input type="checkbox" checked={p.expanded} disabled={!p.canExpand} onChange={e => p.onExpand(e.target.checked)}/></label></section>
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
      <section className="an-settings-section"><h3>阅读显示</h3><label className="an-setting an-range-setting"><span>字体大小 <output>{p.font}px</output></span><input aria-label="字体大小" type="range" min="14" max="42" value={p.font} onChange={e => p.onFont(Number(e.target.value))}/></label><label className="an-setting an-range-setting"><span>字间距 <output>{p.gap}px</output></span><input aria-label="字间距" type="range" min="-20" max="24" value={p.gap} onChange={e => p.onGap(Number(e.target.value))}/></label><label className="an-setting"><span>光标类型</span><select value={p.style} onChange={e => p.onStyle(e.target.value as PlayStyle)}><option value="head">光标</option><option value="band">高亮条</option><option value="ball">光球</option></select></label><p className="an-setting-hint">双指调整字号，自动按屏宽排版；双击恢复原字号。</p></section>
      <section className="an-settings-section"><h3>练习参数</h3><label className="an-setting"><span>升降调</span><select value={p.transpose} disabled={p.busy} onChange={e => p.onTranspose(Number(e.target.value))}>{Array.from({ length: 25 }, (_, i) => i - 12).map(n => <option key={n} value={n}>{n === 0 ? '原调' : `${n > 0 ? '+' : ''}${n} 半音`}</option>)}</select></label><label className="an-setting an-range-setting"><span>播放速度 <output>{p.speed.toFixed(2)}×</output></span><input aria-label="播放速度" type="range" min="0.5" max="2" step="0.05" disabled={p.busy} value={p.speed} onChange={e => p.onSpeed(Number(e.target.value))}/></label></section>
    </AndroidDialog>}
    {(p.busy || p.restoring) && <div className="an-player-status" role="status">{p.busy ? '正在处理伴奏…' : '正在载入伴奏…'}</div>}
    {p.message && <p className="an-player-error" role="status">{p.message}</p>}
  </div>;
}
