import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player } from '../audio';
import { BeatClock } from '../clock';
import { parseDsl } from '../dsl';
import { saveTextAsFile } from '../io';
import { buildDsl } from '../lab/toDsl';
import { collectGraceNotes, detectKey, quantizeNotes, type RawNote } from '../lab/quantize';
import { analyzeRhythm, rhythmSource, TRACKS, type Track } from '../lab/rhythm';
import { checkService, decodeAudio, toMono22050, transcribe, type ServiceState } from '../lab/transcribe';
import { saveSession } from '../session';
import { activeAt, buildTimeline, tickAtEvent, type TimelineEntry } from '../timeline';
import { validateGroups } from '../validate';
import type { TempoEstimate } from '../beat';
import { TICKS_PER_BEAT, type Score } from '../types';
import { importLibrary } from './libraryStore';
import { initStore } from './storeInit';
import { ScoreCanvas } from './ScoreCanvas';
import { HelpDialog } from './HelpCenter';
import './lab.css';

const KEYS = ['C', '#C', 'D', 'bE', 'E', 'F', '#F', 'G', 'bA', 'A', 'bB', 'B'];
type Phase = 'idle' | 'rhythm' | 'decode' | 'recognize';

function TrackRow({ track, file, disabled, onChange }: {
  track: typeof TRACKS[number]; file?: File; disabled: boolean; onChange: (file?: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!file) { setUrl(''); return; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <div className={`ws-lab-track ${file ? 'has-file' : ''} ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled && e.dataTransfer.files[0]) onChange(e.dataTransfer.files[0]); }}>
      <div className="ws-lab-track-info">
        <strong>{track.label}<span>{track.id === 'vocal' ? '旋律' : '可选'}</span></strong>
        <p title={file?.name}>{file ? file.name : track.role}</p>
      </div>
      <input hidden ref={input} type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg"
        disabled={disabled}
        onChange={(e) => { onChange(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="ws-lab-button" aria-label={`${file ? '替换' : '选择'}${track.label}音频`} disabled={disabled} onClick={() => input.current?.click()}>{file ? '替换' : '选择音频'}</button>
      {file ? <button className="ws-lab-remove" aria-label={`移除${track.label}`} disabled={disabled} onClick={() => onChange()}>移除</button> : null}
      {url ? <audio className="ws-lab-source" controls preload="none" src={url} aria-label={`试听${track.label}`} /> : null}
    </div>
  );
}

function DraftPreview({ score, dark, onEditTitle, onCorrect }: {
  score: Score; dark: boolean; onEditTitle: () => void;
  onCorrect: (index: number, grace: boolean, semitones: number) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [correctGrace, setCorrectGrace] = useState(false);
  const clock = useRef(new BeatClock(score.meta.bpm));
  const player = useRef(new Player());
  const timeline = useMemo(() => buildTimeline(score), [score]);
  // 声音合并延音，画面逐颗跟随记谱音符（包括长音的后续分片）。
  const displayTimeline = useMemo(() => {
    let tick = 0;
    const entries: TimelineEntry[] = [];
    for (const ev of score.events) {
      if (ev.kind !== 'note' && ev.kind !== 'rest') continue;
      entries.push({ eventId: ev.id, startTick: tick, endTick: tick + ev.ticks,
        degree: ev.kind === 'note' ? ev.degree : 0, octave: ev.kind === 'note' ? ev.octave : 0, midi: null });
      tick += ev.ticks;
    }
    return entries;
  }, [score]);
  const selectedEvent = selected === null ? undefined : score.events[selected];
  const selectedIds = useMemo(() => new Set(selectedEvent ? [selectedEvent.id] : []), [selectedEvent]);
  const current = displayTimeline.findIndex((e) => e.eventId === currentId);
  const selectedPosition = displayTimeline.findIndex((e) => e.eventId === selectedEvent?.id);
  const stop = useCallback((): void => { player.current.stop(); clock.current.stop(); setPlaying(false); setCurrentId(null); }, []);
  useEffect(() => {
    player.current.stop(); clock.current.stop(); clock.current.setBpm(score.meta.bpm); setPlaying(false);
    setCurrentId(null); setCorrectGrace(false);
    setSelected((prev) => prev !== null && prev < score.events.length ? prev : null);
    return () => { player.current.stop(); clock.current.stop(); };
  }, [score]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const update = (): void => {
      const act = activeAt(displayTimeline, clock.current.currentBeat * TICKS_PER_BEAT);
      setCurrentId(act?.entry.eventId ?? null);
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [playing, displayTimeline]);
  const playFrom = (index: number): void => {
    player.current.stop(); clock.current.stop();
    const tick = tickAtEvent(score, index);
    clock.current.seek(tick / TICKS_PER_BEAT);
    const delay = player.current.start(timeline, score.meta.bpm, tick);
    clock.current.playAfter(delay);
    setPlaying(true);
  };
  return <>
    <div className="ws-lab-preview-toolbar"><span role="status">{playing && current >= 0
      ? `正在播放：第 ${current + 1} 个音符 · ${displayTimeline[current].degree || '休止'}`
      : selectedEvent ? `已选中：第 ${selectedPosition + 1} 个音符 · ${selectedEvent.kind === 'note' ? selectedEvent.degree : '休止'}` : '点击音符选择试听起点'}</span>
      <div><button className="ws-lab-text-button" onClick={() => { setSelected(null); playFrom(0); }}>从头试听</button>
        <button className="ws-lab-button" onClick={() => playing ? stop() : playFrom(selected ?? 0)}>{playing ? '停止试听' : selectedEvent ? '从选中音符试听' : '试听简谱'}</button></div>
    </div>
    {selectedEvent?.kind === 'note' ? <div className="ws-lab-correction">
      <span>选中音符校音</span>
      {selectedEvent.graceBefore?.length ? <select aria-label="校音对象" value={correctGrace ? 'grace' : 'main'} onChange={(e) => setCorrectGrace(e.target.value === 'grace')}><option value="main">主音</option><option value="grace">前倚音</option></select> : null}
      <button className="ws-lab-button" onClick={() => onCorrect(selected!, correctGrace, -1)}>降低半音</button>
      <button className="ws-lab-button" onClick={() => onCorrect(selected!, correctGrace, 1)}>升高半音</button>
    </div> : null}
    <div className="ws-lab-score"><ScoreCanvas score={score} dark={dark} selectedIds={selectedIds}
      cursor={selected ?? 0} timeline={displayTimeline} playing={playing} clock={clock.current} showCaret={false}
      onPick={(a, b) => {
        if (b !== null) return;
        const ev = score.events[a.index];
        if (ev?.kind !== 'note' && ev?.kind !== 'rest') return;
        setSelected(a.index); setCorrectGrace(false);
        if (playing) playFrom(a.index);
      }} onEnded={stop} onEditTitle={onEditTitle} /></div>
  </>;
}

export function LabScreen(): React.ReactElement {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [helpOpen, setHelpOpen] = useState(false);
  const [files, setFiles] = useState<Partial<Record<Track, File>>>({});
  const [song, setSong] = useState('');
  const [language, setLanguage] = useState('zh');
  const [key, setKey] = useState('auto');
  const [beat, setBeat] = useState('4/4');
  const [bpm, setBpm] = useState('120');
  const [offset, setOffset] = useState('0');
  const [octave, setOctave] = useState(0);
  const [graces, setGraces] = useState(false);
  const [pitchCorrections, setPitchCorrections] = useState<Record<number, number>>({});
  const [autoTempo, setAutoTempo] = useState(true);
  const [service, setService] = useState<ServiceState | null>(null);
  const [checking, setChecking] = useState(false);
  const [serviceError, setServiceError] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [raw, setRaw] = useState<RawNote[] | null>(null);
  const [estimate, setEstimate] = useState<TempoEstimate | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const songInput = useRef<HTMLInputElement>(null);
  const busy = phase !== 'idle';
  const reference = rhythmSource(files);
  const referenceLabel = TRACKS.find((t) => t.id === reference)?.label ?? '未选择';

  const refreshService = async (): Promise<void> => {
    setChecking(true); setServiceError('');
    try { setService(await checkService()); }
    catch (e) { setService(null); setServiceError((e as Error).message); }
    finally { setChecking(false); }
  };
  useEffect(() => { void refreshService(); return () => controller.current?.abort(); }, []);

  const draft = useMemo(() => {
    if (!raw?.length) return null;
    try {
      const tempo = Number(bpm);
      const origin = Number(offset);
      if (!bpm.trim() || !offset.trim() || origin < 0) throw new Error('请填写有效的速度与非负小节起点');
      const actualKey = key === 'auto' ? detectKey(raw) : key;
      const indexed = raw.map((n, sourceIndex) => ({ ...n, sourceIndex }));
      const prepared = graces ? collectGraceNotes(indexed, tempo) : indexed;
      // 先判定装饰音，再校音，避免一次半音修正使倚音忽然恢复成主音。
      const adjusted = prepared.map((n) => ({ ...n,
        midi: n.midi + octave * 12 + (pitchCorrections[n.sourceIndex!] ?? 0),
        ...(n.graceBefore ? { graceBefore: n.graceBefore.map((midi, i) =>
          midi + octave * 12 + (pitchCorrections[n.graceSourceIndices![i]] ?? 0)) } : {}) }));
      if (adjusted.some((n) => [n.midi, ...(n.graceBefore ?? [])].some((midi) => midi < 0 || midi > 127))) throw new Error('调整后的音高超出 MIDI 范围，请降低调整幅度');
      const grid = quantizeNotes(adjusted, tempo, origin);
      if (!grid.length) throw new Error('小节起点位于所有音符之后，请调整起点');
      const name = song.trim() || files.vocal?.name.replace(/\.[^.]+$/, '') || '听音成谱';
      const text = buildDsl({ title: name, key: actualKey, beat, bpm: tempo, notes: grid, note: '人声主旋律 · GAME' });
      const parsed = parseDsl(text);
      if (!parsed.score || parsed.errors.length) throw new Error(parsed.errors.join('；') || '成谱失败');
      const violations = validateGroups(parsed.score);
      if (violations.length) throw new Error(violations.map((v) => v.message).join('；'));
      return { score: parsed.score, text, name, key: actualKey, count: grid.length, grid, error: '' };
    } catch (e) { return { score: null, text: '', name: '', key: '', count: 0, grid: [], error: (e as Error).message }; }
  }, [raw, key, bpm, offset, beat, song, files.vocal, octave, graces, pitchCorrections]);
  useEffect(() => setSaved(''), [draft?.text]);
  const correctPitch = (index: number, grace: boolean, semitones: number): void => {
    if (!draft?.score) return;
    const tick = tickAtEvent(draft.score, index);
    const note = draft.grid.find((n) => n.startTick <= tick && tick < n.startTick + n.durTicks);
    const source = grace ? note?.graceSourceIndices?.[0] : note?.sourceIndex;
    if (source === undefined) return;
    setPitchCorrections((prev) => ({ ...prev, [source]: (prev[source] ?? 0) + semitones }));
  };

  const changeFile = (track: Track, file?: File): void => {
    if (file && file.size > 200 * 1024 * 1024) { setError('单条音频请控制在 200MB 以内'); return; }
    setFiles((prev) => ({ ...prev, [track]: file }));
    setRaw(null); setEstimate(null); setWarnings([]); setError(''); setMessage(''); setSaved('');
    setPitchCorrections({});
  };
  const rhythm = async (signal: AbortSignal): Promise<void> => {
    if (!reference || !files[reference]) throw new Error('请先选择至少一条音频');
    setPhase('rhythm'); setMessage(`正在从${referenceLabel}分析节奏`);
    const buffer = await decodeAudio(files[reference]!);
    signal.throwIfAborted();
    if (buffer.duration > 1200) throw new Error('请使用 20 分钟以内的音频');
    const result = await analyzeRhythm(buffer, signal);
    signal.throwIfAborted();
    setEstimate(result);
    if (result && result.confidence >= 0.2 && result.peakCount >= 8) {
      setBpm(String(Math.round(result.bpm * 100) / 100));
      const cautions = ['节拍位置不能确定小节第一拍，请核对小节起点。'];
      if (reference === 'vocal') cautions.push('节奏来自人声，长音和自由节奏可能影响估计。');
      if (result.isConstant === false) cautions.push('检测到速度可能变化，当前草稿使用平均速度，请在对轨中进一步标定。');
      setWarnings(cautions);
    } else {
      setWarnings(['节奏参考较弱，保留当前 BPM，请手动确认速度。']);
    }
  };
  const start = async (onlyRhythm = false): Promise<void> => {
    if (controller.current) return;
    const ctl = new AbortController(); controller.current = ctl;
    setError(''); setMessage(''); setWarnings([]);
    try {
      if (onlyRhythm) { await rhythm(ctl.signal); setMessage('节奏分析完成，请核对速度与小节起点'); return; }
      if (!files.vocal) throw new Error('歌唱主旋律需要人声音频；其他分轨用于节奏参考');
      const connected = await checkService(ctl.signal); setService(connected);
      if (!connected.ready) throw new Error('模型尚未安装，请展开识别服务说明');
      if (autoTempo) await rhythm(ctl.signal);
      setPhase('decode'); setMessage('正在解码人声');
      const buffer = await decodeAudio(files.vocal);
      ctl.signal.throwIfAborted();
      if (buffer.duration > 1200) throw new Error('请使用 20 分钟以内的人声片段');
      const audio = await toMono22050(buffer);
      ctl.signal.throwIfAborted();
      setPhase('recognize'); setMessage('正在加载人声识别模型');
      const notes = await transcribe(audio, { language, signal: ctl.signal, onMessage: setMessage });
      ctl.signal.throwIfAborted();
      if (!notes.length) throw new Error('没有识别出歌唱音符，请检查人声轨或使用更清晰的片段');
      setRaw(notes); setPitchCorrections({}); setMessage(`已识别 ${notes.length} 个音符，调整参数可立即重新成谱`);
    } catch (e) {
      if (ctl.signal.aborted) setMessage('已取消识别');
      else setError((e as Error).message);
    } finally { controller.current = null; setPhase('idle'); }
  };
  const save = async (): Promise<void> => {
    if (!draft?.score || saving) return;
    setSaving(true); setError('');
    try {
      await initStore();
      const item = importLibrary(draft.name, draft.text);
      if (!item) throw new Error('曲库存储不可用，可先导出 .jps');
      setSaved(item.name);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const open = (): void => {
    if (!draft?.score) return;
    saveSession({ text: draft.text, name: saved || draft.name, path: null });
    location.href = 'editor.html';
  };
  const exportDraft = async (): Promise<void> => {
    if (!draft?.score) return;
    try { await saveTextAsFile(draft.text, `${draft.name.replace(/[\\/:*?"<>|]/g, '_')}.jps`); }
    catch (e) { setError((e as Error).message); }
  };

  return <main className="v2-app ws-lab" data-theme={dark ? 'dark' : 'light'}>
    {helpOpen ? <HelpDialog dark={dark} initialTopic="faq" onClose={() => setHelpOpen(false)} /> : null}
    <header className="ws-lab-header">
      <a href="index.html" className="ws-lab-brand">WindScore</a>
      <span className="ws-lab-header-divider" />
      <span>听音成谱 <small>实验</small></span>
      <nav><a href="index.html">返回首页</a><button className="ws-lab-button" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>帮助</button><button className="ws-lab-button" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</button></nav>
    </header>
    <div className="ws-lab-body">
      <div className="ws-lab-heading"><h1>把歌声，写成简谱。</h1><p>人声识别旋律，分轨辅助节奏。先试听，再收进曲库。</p></div>
      <div className="ws-lab-workspace">
        <section className="ws-lab-inputs" aria-label="音频与成谱设置">
          <div className="ws-lab-section-title"><h2>音频来源</h2><span>同一首歌 · 保留相同起点</span></div>
          <div className="ws-lab-target"><strong>歌唱主旋律</strong><p>需要人声轨。前奏、间奏的乐器主奏暂不识别。</p></div>
          <div className="ws-lab-tracks">{TRACKS.map((track) => <TrackRow key={track.id} track={track} file={files[track.id]} disabled={busy} onChange={(file) => changeFile(track.id, file)} />)}</div>
          <div className="ws-lab-reference"><span>节奏参考</span><strong>{referenceLabel}</strong><button className="ws-lab-text-button" disabled={busy || !reference} onClick={() => void start(true)}>分析节奏</button></div>
          <div className="ws-lab-settings">
            <div className="ws-lab-section-title"><h2>成谱设置</h2><span>识别后仍可调整</span></div>
            <div className="ws-lab-fields">
              <label className="ws-lab-name">曲名<input ref={songInput} value={song} disabled={busy} placeholder="默认使用人声文件名" onChange={(e) => setSong(e.target.value)} /></label>
              <label>歌唱语言<select value={language} disabled={busy} onChange={(e) => { setLanguage(e.target.value); setRaw(null); }}><option value="zh">普通话</option><option value="yue">粤语</option><option value="en">英语</option><option value="ja">日语</option></select></label>
              <label>调号<select value={key} disabled={busy} onChange={(e) => setKey(e.target.value)}><option value="auto">自动建议</option>{KEYS.map((k) => <option key={k} value={`1=${k}`}>1={k}</option>)}</select></label>
              <label>拍号<select value={beat} disabled={busy} onChange={(e) => setBeat(e.target.value)}>{['4/4', '3/4', '2/4', '6/8'].map((b) => <option key={b}>{b}</option>)}</select></label>
              <label>速度 BPM<input type="number" min="20" max="300" value={bpm} disabled={busy} onChange={(e) => { setBpm(e.target.value); setAutoTempo(false); }} /></label>
              <label>整体八度<select value={octave} disabled={busy} onChange={(e) => setOctave(Number(e.target.value))}><option value="0">原音高</option><option value="1">升高八度（+12）</option><option value="-1">降低八度（−12）</option></select></label>
              <label className="ws-lab-name">小节起点（秒）<input type="number" min="0" step="0.01" value={offset} disabled={busy} onChange={(e) => setOffset(e.target.value)} /><span>谱面第一个小节在音频中的位置，默认保留前奏空拍。</span></label>
            </div>
            <label className="ws-lab-checkbox"><input type="checkbox" checked={autoTempo} disabled={busy} onChange={(e) => setAutoTempo(e.target.checked)} />识别前自动估计速度</label>
            <label className="ws-lab-checkbox"><input type="checkbox" checked={graces} disabled={busy} onChange={(e) => setGraces(e.target.checked)} />整理短倚音（实验）</label>
            <p className="ws-lab-estimate">倚音整理保留原音高。误识别的半音可点击谱面单独校正。</p>
            {estimate ? <p className="ws-lab-estimate">节奏建议 {estimate.bpm.toFixed(1)} BPM · 拍点相位 {estimate.phaseSec.toFixed(2)} 秒，非小节起点</p> : null}
          </div>
          <div className="ws-lab-run">
            <button className="ws-lab-primary" disabled={busy || !files.vocal || !service?.ready} onClick={() => void start()}>{busy ? phase === 'rhythm' ? '分析节奏中' : '正在识别' : raw ? '重新识别' : '开始识别'}</button>
            {busy ? <button className="ws-lab-button" onClick={() => controller.current?.abort()}>取消</button> : <span>{!files.vocal ? '先选择人声轨' : !service?.ready ? '请先连接识别服务' : '音频仅在本机处理'}</span>}
          </div>
        </section>
        <section className="ws-lab-output" aria-label="简谱预览">
          <div className="ws-lab-section-title"><h2>简谱预览</h2><span>{draft?.score ? `${draft.key} · ${beat} · ${draft.count} 个音符` : '等待识别'}</span></div>
          <div className="ws-lab-status" role="status" aria-live="polite">
            <span className={`ws-lab-status-dot ${service?.ready ? 'is-ready' : ''}`} />
            <strong>{checking ? '连接识别服务' : service?.ready ? '本机识别服务已就绪' : service ? '识别模型未安装' : '本机识别服务未连接'}</strong>
            <button className="ws-lab-text-button" disabled={checking || busy} onClick={() => void refreshService()}>重新检测</button>
          </div>
          {!service?.ready ? <details className="ws-lab-service"><summary>如何启用识别服务</summary><p>{serviceError || '首次使用需安装专用人声模型。'}</p><p>在 WindScore 项目目录打开终端，首次运行：</p><code>npm run lab:setup</code><p>安装完成后启动服务，并保持终端运行：</p><code>npm run lab:serve</code><p>回到此页点击「重新检测」。首次下载需要联网，识别时音频留在本机。</p></details> : null}
          {busy ? <div className="ws-lab-processing"><progress aria-label="正在处理音频" /><strong>{message}</strong><p>{phase === 'recognize' ? '模型正在本机运行，完成后会在这里显示谱面。' : '正在本机处理音频，请稍候。'}</p></div> : null}
          {error || draft?.error ? <div className="ws-lab-error" role="alert">{error || draft?.error}</div> : null}
          {warnings.length ? <div className="ws-lab-notice">{warnings.map((w) => <p key={w}>{w}</p>)}</div> : null}
          {draft?.score ? <DraftPreview score={draft.score} dark={dark} onEditTitle={() => songInput.current?.focus()} onCorrect={correctPitch} /> : !busy ? <div className="ws-lab-empty"><span className="ws-lab-empty-number">1 2 3</span><h3>从一段清晰的人声开始</h3><p>选择人声后开始识别。只有人声也可以；增加鼓或完整伴奏，可辅助确定速度。</p><div>识别旋律 <span>→</span> 调整节奏 <span>→</span> 试听修谱</div></div> : null}
          {draft?.score ? <div className="ws-lab-result-actions"><p>{saved ? `已入库：${saved}` : '草稿尚未入库，确认后再保存。'}</p><div><button className="ws-lab-primary" disabled={busy || saving || !!saved} onClick={() => void save()}>{saving ? '保存中' : saved ? '已存入曲库' : '存入曲库'}</button><button className="ws-lab-button" disabled={busy} onClick={open}>打开修谱</button><button className="ws-lab-button" disabled={busy} onClick={() => void exportDraft()}>导出 .jps</button></div></div> : null}
          {!busy && message ? <p className="ws-lab-message" role="status">{message}</p> : null}
        </section>
      </div>
      <footer className="ws-lab-footer"><span>支持两分轨与四分轨 · 单次最长 20 分钟</span><span>歌声转谱仍需试听确认</span></footer>
    </div>
  </main>;
}
