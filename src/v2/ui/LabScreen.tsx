import { useRef, useState } from 'react';
import { importLibrary } from './libraryStore';
import { saveSession } from '../session';
import { saveTextAsFile } from '../io';
import { buildDsl } from '../lab/toDsl';
import { quantizeNotes, detectKey, type RawNote } from '../lab/quantize';
import { SAMPLE_RATE, toMono22050, transcribe } from '../lab/transcribe';

/** 识别后端：webgl 快（GPU），cpu 慢（部分机器的驱动编译不了着色器，自动降级） */
type Backend = 'webgl' | 'cpu' | 'unknown';

/**
 * 实验功能「听音成谱」：导入分离好的人声 / 伴奏音频，浏览器内识别音高，
 * 量化成简谱草稿。结果以两个独立谱（人声谱 / 伴奏谱）进曲库，并打开人声谱草稿
 * 进入正常编辑器修错——所有后续流程（对轨 / 播放 / 打包）与手工谱完全一致。
 */

type Track = 'vocal' | 'accomp';

interface Progress {
  phase: 'idle' | 'decoding' | 'transcribing' | 'done' | 'error';
  track?: Track;
  percent: number;
  message?: string;
}

interface Result {
  vocalDsl: string;
  accompDsl: string;
  vocalNotes: number;
  accompNotes: number;
  /** 音域跨度（半音）。> 24（两个八度）说明混入了和声 / 多乐器，可信度低 */
  vocalSpan: number;
  accompSpan: number;
  /** 自动检测的调号 */
  detectedKey: string;
}

export function LabScreen(): React.ReactElement {
  const [song, setSong] = useState('');
  const [key, setKey] = useState('1=C');
  const [bpm, setBpm] = useState('120');
  const [offset, setOffset] = useState('0');
  const [prog, setProg] = useState<Progress>({ phase: 'idle', percent: 0 });
  const [backend, setBackend] = useState<Backend>('unknown');
  const [result, setResult] = useState<Result | null>(null);
  const vocalRef = useRef<HTMLInputElement>(null);
  const accompRef = useRef<HTMLInputElement>(null);

  const busy = prog.phase === 'decoding' || prog.phase === 'transcribing';

  const decode = async (file: File): Promise<AudioBuffer> => {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      return await ctx.decodeAudioData(await file.arrayBuffer());
    } finally {
      void ctx.close();
    }
  };

  const run = async (): Promise<void> => {
    const vf = vocalRef.current?.files?.[0];
    const af = accompRef.current?.files?.[0];
    if (!vf && !af) {
      setProg({ phase: 'error', percent: 0, message: '至少导入一条音频（人声或伴奏）' });
      return;
    }
    const tempo = Number(bpm);
    if (!Number.isFinite(tempo) || tempo < 20 || tempo > 300) {
      setProg({ phase: 'error', percent: 0, message: 'BPM 应为 20-300 的数字' });
      return;
    }
    const off = Number(offset) || 0;
    const name = song.trim() || '听音成谱';
    setResult(null);
    const out: Partial<Result> = {};
    let detectedKey = key;
    try {
      for (const [track, file, label] of [
        ['vocal', vf, '人声'],
        ['accomp', af, '伴奏'],
      ] as const) {
        if (!file) continue;
        setProg({ phase: 'decoding', track, percent: 0, message: `解码${label}音频…` });
        const mono = await toMono22050(await decode(file));
        setProg({ phase: 'transcribing', track, percent: 0, message: `识别${label}旋律…（CPU 模式整曲约 5-15 分钟）` });
        const raw: RawNote[] = await transcribe(mono, {
          onProgress: (p) => setProg({ phase: 'transcribing', track, percent: p }),
          onBackend: setBackend,
        });
        // 第一条轨识别完自动检测调号（消除填错调号这个最大的错误源）
        const autoKey = detectKey(raw);
        if (out.vocalDsl === undefined && out.accompDsl === undefined) {
          detectedKey = autoKey;
          setKey(autoKey);
        }
        const grid = quantizeNotes(raw, tempo, off);
        const text = buildDsl({
          title: track === 'vocal' ? `${name}（人声）` : `${name}（伴奏）`,
          key: detectedKey,
          beat: '4/4',
          bpm: tempo,
          note: track === 'vocal' ? '人声主旋律（AI 转录）' : '伴奏主奏（AI 转录）',
          notes: grid,
        });
        const span =
          grid.length === 0 ? 0 : Math.max(...grid.map((g) => g.midi)) - Math.min(...grid.map((g) => g.midi));
        if (track === 'vocal') {
          out.vocalDsl = text;
          out.vocalNotes = grid.length;
          out.vocalSpan = span;
        } else {
          out.accompDsl = text;
          out.accompNotes = grid.length;
          out.accompSpan = span;
        }
      }
      setProg({ phase: 'done', percent: 1 });
      // 识别结果**自动存进曲库**（之前要点按钮才存，用户以为丢了）；
      // 面板里再给「打开修谱」和「导出 .jps」两个出口
      if (out.vocalDsl) importLibrary(`${name}（人声）`, out.vocalDsl);
      if (out.accompDsl) importLibrary(`${name}（伴奏）`, out.accompDsl);
      setResult({
        vocalDsl: out.vocalDsl ?? '',
        accompDsl: out.accompDsl ?? '',
        vocalNotes: out.vocalNotes ?? 0,
        accompNotes: out.accompNotes ?? 0,
        vocalSpan: out.vocalSpan ?? 0,
        accompSpan: out.accompSpan ?? 0,
        detectedKey,
      });
    } catch (e) {
      setProg({ phase: 'error', percent: 0, message: `识别失败：${(e as Error).message}` });
    }
  };

  const trackName = (which: 'vocal' | 'accomp'): string =>
    (song.trim() || '听音成谱') + (which === 'vocal' ? '（人声）' : '（伴奏）');

  /** 打开草稿（编辑器从 session 恢复；曲库在识别完成时已自动存过） */
  const open = (which: 'vocal' | 'accomp'): void => {
    if (!result) return;
    const text = which === 'vocal' ? result.vocalDsl : result.accompDsl;
    if (!text) return;
    saveSession({ text, name: trackName(which), path: null });
    location.href = 'index.html';
  };

  /** 手动导出 .jps 文件（Tauri 走存盘对话框，浏览器走下载） */
  const exportJps = async (which: 'vocal' | 'accomp'): Promise<void> => {
    if (!result) return;
    const text = which === 'vocal' ? result.vocalDsl : result.accompDsl;
    if (!text) return;
    await saveTextAsFile(text, `${trackName(which)}.jps`);
  };

  return (
    <div className="v2-lab">
      <header className="v2-lab-head">
        <a className="v2-btn" href="index.html">
          ← 返回
        </a>
        <h1 className="v2-lab-title">听音成谱（实验）</h1>
        <span className="v2-lab-badge">实验功能</span>
      </header>
      <p className="v2-lab-intro">
        导入分离好的音频（人声 / 伴奏都可，至少一条），在本机识别音高并量化成简谱草稿。
        两个声部各自生成一份谱：人声 = 主旋律，伴奏 = 主奏声部，都进曲库、都可编辑。
        转录用的是初稿 AI——错音、连音线、跨小节长音请打开后人工修正。
      </p>

      <div className="v2-lab-form">
        <label className="v2-lab-row">
          <span>歌名</span>
          <input value={song} onChange={(e) => setSong(e.target.value)} placeholder="如：晴天" />
        </label>
        <label className="v2-lab-row">
          <span>调号</span>
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {['1=C', '1=D', '1=E', '1=F', '1=G', '1=A', '1=B', '1=bB', '1=bE', '1=#F'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="v2-lab-row">
          <span>BPM</span>
          <input
            type="number"
            value={bpm}
            min={20}
            max={300}
            onChange={(e) => setBpm(e.target.value)}
            title="速度。建议先在主程序对轨界面标定，这里填同一个值"
          />
        </label>
        <label className="v2-lab-row">
          <span>首拍(秒)</span>
          <input
            type="number"
            step="0.01"
            value={offset}
            onChange={(e) => setOffset(e.target.value)}
            title="第一个正拍在音频里的位置（秒）。前奏长的曲子填前奏时长，对不齐整谱节奏都会歪"
          />
        </label>
        <label className="v2-lab-row">
          <span>人声轨</span>
          <input ref={vocalRef} type="file" accept="audio/*" title="主旋律来源——转录质量最好的一轨" />
        </label>
        <label className="v2-lab-row">
          <span>伴奏轨</span>
          <input
            ref={accompRef}
            type="file"
            accept="audio/*"
            title="伴奏通常含鼓 / 贝斯 / 和弦，是多轨混音——转录出来噪音很大，仅供辅助参考"
          />
        </label>
        <button className="v2-btn v2-btn--primary" disabled={busy} onClick={() => void run()}>
          {busy ? '识别中…' : '开始识别'}
        </button>
      </div>

      {prog.phase !== 'idle' && prog.phase !== 'done' ? (
        <div className="v2-lab-progress">
          <p>{prog.message}</p>
          {prog.phase === 'transcribing' ? (
            <>
              <progress value={prog.percent} max={1} />
              {backend === 'cpu' ? (
                <p className="v2-lab-hint">
                  这台机器的 GPU 跑不了识别，已自动切到 CPU 模式：整曲约 5-15 分钟，
                  页面保持响应但请别关闭，进度条会缓慢前进。
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {prog.phase === 'error' ? <p className="v2-lab-error">{prog.message}</p> : null}

      {result ? (
        <div className="v2-lab-result">
          <h2>识别完成——两份草稿已自动存入曲库</h2>
          <p className="v2-lab-hint">自动检测调号：{result.detectedKey}（已填入，可在上方改后重新识别）</p>
          {result.vocalDsl ? (
            <div className="v2-lab-result-row">
              <span>
                人声主旋律：{result.vocalNotes} 个音
                {result.vocalSpan > 24 ? <span className="v2-lab-warn">｜音域跨度 {result.vocalSpan} 半音，混入了和声或杂音，可信度低</span> : null}
              </span>
              <span className="v2-lab-result-actions">
                <button className="v2-btn" onClick={() => open('vocal')}>
                  打开修谱
                </button>
                <button className="v2-btn" onClick={() => void exportJps('vocal')}>
                  导出 .jps
                </button>
              </span>
            </div>
          ) : null}
          {result.accompDsl ? (
            <div className="v2-lab-result-row">
              <span>
                伴奏主奏：{result.accompNotes} 个音
                {result.accompSpan > 24 ? <span className="v2-lab-warn">｜音域跨度 {result.accompSpan} 半音，混入了和声或杂音，可信度低</span> : null}
              </span>
              <span className="v2-lab-result-actions">
                <button className="v2-btn" onClick={() => open('accomp')}>
                  打开修谱
                </button>
                <button className="v2-btn" onClick={() => void exportJps('accomp')}>
                  导出 .jps
                </button>
              </span>
            </div>
          ) : null}
          <p className="v2-lab-hint">
            想跟着伴奏对拍：把伴奏音频在主程序「对轨」界面载入（BPM 填同一个值），之后即可
            合成音 / 伴奏两种方式对比播放。
          </p>
        </div>
      ) : null}
    </div>
  );
}
