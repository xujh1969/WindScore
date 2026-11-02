// 按简谱识别（ScoreOCR 集成，2026-11-02）：
// 双栏工作台——左栏打开图片/PDF + 简谱识别（10 阶段进度，浏览器内 OMR，
// 首次识别需下载约 25MB OCR 模型）；右栏直接嵌完整简谱编辑器
// （EditorApp entry='ocr'：功能与编辑页一致，只是没有新建/打开）。
// 识别完成 → recognizedToJps → 通过 ocrItem 传给 EditorApp 载入。
// 引擎代码（dolce/ convert/ adapter/）vendored 自独立项目 ScoreOCR，
// 当时与 WindScore 0.4.38 同版；模型资产在 public/redist/（运行时 fetch，不进 bundle）。
import { useEffect, useRef, useState } from 'react';
import { EditorApp } from '../../v2/ui/EditorApp';
import { ThemeToggle } from '../../v2/ui/ThemeToggle';
import type { Binary, RecognizedScore } from '../adapter/installOcr';
import { recognizeWithProgress, STAGE_LABEL, STAGE_ORDER } from '../adapter/recognizeProgress';
import { recognizedToJps } from '../convert/recognizedToJps';
import { ImagePane } from './ImagePane';
import './ocr.css';

/** 载入待识别的文件（已解码出预览，尚未识别）。 */
interface Pending {
  bytes: Uint8Array;
  mime?: string;
  name: string;
  /** 图片类：彩色预览 URL；PDF：二值图预览。 */
  url?: string;
  bin?: Binary;
}

export function OcrPage() {
  const [dark, setDark] = useState(() => localStorage.getItem('ws-dark') === '1');
  const [pending, setPending] = useState<Pending | null>(null);
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const [boxes, setBoxes] = useState<{ x: number; y: number; w: number; h: number; suspect?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [stageIdx, setStageIdx] = useState(-1);
  const [elapsed, setElapsed] = useState(0);
  const [ocrItem, setOcrItem] = useState<{ name: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggleDark = (d: boolean): void => {
    setDark(d);
    try {
      localStorage.setItem('ws-dark', d ? '1' : '0');
    } catch {
      /* 隐私模式写不进就算了 */
    }
  };

  // 计时器：识别期间每 0.1s 刷新已用时间
  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const iv = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => clearInterval(iv);
  }, [busy]);

  /** 打开文件：只解码预览，不识别。 */
  async function onFile(f: File) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const isImage = f.type.startsWith('image/');
    setBoxes([]);
    setOcrItem(null);
    setStageIdx(-1);
    if (isImage) {
      const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
      const probe = new Image();
      probe.onload = () => {
        setImg({ url, w: probe.naturalWidth, h: probe.naturalHeight });
        setPending({ bytes, mime: f.type, name: f.name, url });
      };
      probe.src = url;
      setStatus(`已载入 ${f.name}，点击「简谱识别」`);
    } else {
      // PDF：栅格化出二值图做预览
      setStatus(`正在载入 ${f.name}…`);
      try {
        const { decodeToBinary } = await import('../dolce/omrkit/decode');
        const bin = await decodeToBinary(bytes, f.type);
        setImg({ url: '', w: bin.w, h: bin.h });
        setPending({ bytes, mime: f.type, name: f.name, bin });
        setStatus(`已载入 ${f.name}，点击「简谱识别」`);
      } catch (e) {
        setStatus(`载入失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 开始识别：带阶段进度；完成后转 jps 塞给右栏编辑器。 */
  async function startRecognize() {
    if (!pending || busy) return;
    setBusy(true);
    setElapsed(0);
    try {
      const detail = await recognizeWithProgress(pending.bytes, pending.mime, (stage) => {
        setStageIdx(STAGE_ORDER.indexOf(stage));
      });
      if (pending.bin) {
        setImg({ url: '', w: detail.bin.w, h: detail.bin.h });
        setPending({ ...pending, bin: detail.bin });
      }
      const rec: RecognizedScore = detail.score;
      const convert = recognizedToJps(rec);
      setBoxes(
        (rec.rows ?? []).flatMap((r) => r.nums).map((n) => ({
          ...n.bbox,
          suspect: (n.doubt?.length ?? 0) > 0 || (n.lyricDoubt?.length ?? 0) > 0,
        })),
      );
      setOcrItem({ name: rec.title?.trim() || '识别谱面', text: convert.text });
      setStatus(`识别完成 ✓ ${rec.rows?.length ?? 0} 个谱行，已载入右侧编辑器`);
    } catch (e) {
      setStatus(`识别失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
    } finally {
      setBusy(false);
      setStageIdx(-1);
    }
  }

  const progress =
    busy && stageIdx >= 0
      ? { label: STAGE_LABEL[STAGE_ORDER[stageIdx]!]!, pct: Math.round(((stageIdx + 1) / STAGE_ORDER.length) * 100) }
      : null;

  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry="ocr">
      <header className="v2-head">
        <a className="v2-home-btn" href="./index.html" title="回到首页">
          ← 返回首页
        </a>
        <span className="v2-brand-name">
          按简谱识别 <span className="v2-brand-tag">测试功能</span>
        </span>
        <div style={{ flex: 1 }} />
        <ThemeToggle dark={dark} onChange={toggleDark} />
      </header>
      <main className="ocr-page">
        <section className="ocr-left">
          <div className="ocr-head">
            <div className="ocr-title">简谱图片识别</div>
            <div className="ocr-status" data-busy={busy || undefined}>
              {busy && progress
                ? `${progress.label}… ${elapsed.toFixed(1)}s`
                : status || '打开一张简谱图片或 PDF 开始'}
            </div>
            {busy && (
              <div className="ocr-progress" data-testid="progress">
                <div className="ocr-progress-bar" style={{ width: `${progress!.pct}%` }} />
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <div className="ocr-head-actions">
              <button className="ocr-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                打开图片 / PDF…
              </button>
              <button
                className="ocr-btn"
                data-primary
                onClick={() => void startRecognize()}
                disabled={!pending || busy}
                title="首次识别需加载 OCR 模型（约 25MB），会多等几秒"
              >
                简谱识别
              </button>
            </div>
          </div>
          <ImagePane img={img} rec={null} locator={[]} activeBox={null} bin={pending?.bin} overlayBoxes={boxes} />
        </section>
        <section className="ocr-right">
          <EditorApp entry="ocr" ocrItem={ocrItem ?? undefined} />
        </section>
      </main>
    </div>
  );
}
