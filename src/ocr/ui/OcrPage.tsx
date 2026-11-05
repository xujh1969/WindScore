// 按简谱识别（ScoreOCR 集成，2026-11-02；两段式改版 2026-11-03）：
// 第一段「识别启动页」：全屏主题底图（bg-ocr-light/dark.png，跟随 ws-theme），
//   只有「上传图片 / PDF」和「简谱识别」两个按钮（后者上传前禁用）；
//   上传后图片按最长边适配显示在屏幕中央供确认，多页 PDF 可逐页翻看；
//   点识别后进度条显示在启动页，全部完成才进入第二段。
// 第二段「对比修改页」：现有双栏工作台去掉标题/状态/按钮，直接展示识别结果
//   （左=原图+识别框，PDF 按单页翻看；右=完整简谱编辑器）。
// 多页 PDF：识别内部把全部页竖拼成一张长图（复用预览像素）；
//   预览与对比页只显示单页（长图在预览区会被压缩到看不清），
//   识别框坐标按「拼接缩放比 × 页高」折算回当前页显示。
// 引擎代码（dolce/ convert/ adapter/）vendored 自独立项目 ScoreOCR；
// 模型资产在 public/redist/（运行时 fetch，不进 bundle）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorApp, type DiagnosticsSnapshot } from '../../v2/ui/EditorApp';
import { ThemeToggle } from '../../v2/ui/ThemeToggle';
import type { Binary, RecognizedScore } from '../adapter/installOcr';
import { decodePdfPageBins, joinPdfPageBins } from '../adapter/pdfPages';
import { correctParenSlurs } from '../adapter/parenSlurs';
import { recognizeWithProgress, STAGE_LABEL, STAGE_ORDER } from '../adapter/recognizeProgress';
import { recognizedToJps } from '../convert/recognizedToJps';
import { BinPreview, ImagePane } from './ImagePane';
import './ocr.css';

/** 载入待识别的文件（已解码出预览，尚未识别）。 */
interface Pending {
  bytes: Uint8Array;
  mime?: string;
  name: string;
  /** 图片：彩色预览 URL。 */
  url?: string;
  /** PDF：逐页二值预览（按页序；识别复用预览像素后整册拼接）。 */
  pages?: Binary[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  suspect?: boolean;
}

/** 右栏显示层字号（px）：只影响画布排版不写进谱面属性，比编辑器默认（24）小，一屏看更多内容 */
const VIEW_FONT_SIZE = 14;

export function OcrPage() {
  // 主题键与其他页统一（ws-theme：'dark'/'light'），旧键 ws-dark 只作迁移兜底
  const [dark, setDark] = useState(() => {
    const t = localStorage.getItem('ws-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return localStorage.getItem('ws-dark') === '1' || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  });
  const [phase, setPhase] = useState<'start' | 'compare'>('start');
  const [pending, setPending] = useState<Pending | null>(null);
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const [viewPage, setViewPage] = useState(0); // PDF 当前预览页
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [stageIdx, setStageIdx] = useState(-1);
  const [elapsed, setElapsed] = useState(0);
  const [ocrItem, setOcrItem] = useState<{ name: string; text: string } | null>(null);
  /** 识别备注（DSL 未承载的信息：齐唱段写进各声部、杂行丢弃等），对比页顶栏展开查看 */
  const [notes, setNotes] = useState<string[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [leftW, setLeftW] = useState(25); // 对比页左栏宽度（占 .ocr-page 的百分比）
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  /** 识别用的拼接长图宽度：把识别框坐标从长图口径折算回单页口径要用 */
  const [recBinW, setRecBinW] = useState(0);
  /** 右栏编辑器上报的谱面校验快照（顶栏显示，与简谱编辑区同款） */
  const [diag, setDiag] = useState<DiagnosticsSnapshot | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  // 引用必须稳定，否则 EditorApp 里上报用的 useEffect 每次渲染都会重跑
  const onDiagnostics = useCallback((d: DiagnosticsSnapshot) => setDiag(d), []);

  const toggleDark = (d: boolean): void => {
    setDark(d);
    try {
      localStorage.setItem('ws-theme', d ? 'dark' : 'light');
    } catch {
      /* 隐私模式写不进就算了 */
    }
  };

  const pdfPages = pending?.pages;

  // 计时器：识别期间每 0.1s 刷新已用时间
  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const iv = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => clearInterval(iv);
  }, [busy]);

  // 拖拽手柄：按住后跟随指针改左栏宽度（14%–60%），松开结束
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = pageRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftW(Math.min(60, Math.max(14, pct)));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  /** 打开文件：只解码预览，不识别。 */
  async function onFile(f: File) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const isImage = f.type.startsWith('image/');
    setBoxes([]);
    setOcrItem(null);
    setNotes([]);
    setNotesOpen(false);
    setStageIdx(-1);
    setViewPage(0);
    setPhase('start');
    setPending(null);
    setImg(null);
    if (isImage) {
      const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
      const probe = new Image();
      probe.onload = () => {
        setImg({ url, w: probe.naturalWidth, h: probe.naturalHeight });
        setPending({ bytes, mime: f.type, name: f.name, url });
      };
      probe.src = url;
      setStatus(`已载入 ${f.name}`);
    } else {
      // PDF：逐页二值化做预览（识别时复用这些像素整册拼接）
      setStatus(`正在载入 ${f.name}…`);
      try {
        const pages = await decodePdfPageBins(bytes);
        setImg(null);
        setPending({ bytes, mime: f.type, name: f.name, pages });
        setStatus(pages.length > 1 ? `已载入 ${f.name}（共 ${pages.length} 页，可翻页确认）` : `已载入 ${f.name}`);
      } catch (e) {
        setStatus(`载入失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 开始识别：带阶段进度；完成后转 jps，全部完成才切入对比页。 */
  async function startRecognize() {
    if (!pending || busy) return;
    setBusy(true);
    setElapsed(0);
    try {
      const detail = await recognizeWithProgress(pending.bytes, pending.mime, (stage) => {
        setStageIdx(STAGE_ORDER.indexOf(stage));
      }, pending.pages ? joinPdfPageBins(pending.pages) : undefined);
      setRecBinW(detail.bin.w);
      const rec: RecognizedScore = detail.score;
      // 前奏括号校正：把被误读成 0/1 的窄弧括弧改写成挂在相邻音符上的连线 ( )
      const parenPairs = correctParenSlurs(rec, detail.bin);
      const convert = recognizedToJps(rec);
      setBoxes(
        (rec.rows ?? []).flatMap((r) => r.nums).map((n) => ({
          ...n.bbox,
          suspect: (n.doubt?.length ?? 0) > 0 || (n.lyricDoubt?.length ?? 0) > 0,
        })),
      );
      // 识别备注（DSL 未承载的信息：齐唱段写进各声部、杂行丢弃等）**不进谱面文本**——
      // 解析成功后源码视图显示的是序列化文本，文本里的注释会被规范化丢掉（0.4.52 实测）；
      // 改存独立状态，对比页顶栏「备注」展开查看（E1 人工核对用）
      setNotes(convert.comments);
      setOcrItem({ name: rec.title?.trim() || '识别谱面', text: convert.text });
      const voiceCount =
        new Set((rec.rows ?? []).map((r) => r.voice).filter((v) => v !== undefined)).size;
      setStatus(
        `识别完成 ✓ ${rec.rows?.length ?? 0} 个谱行` +
          (voiceCount > 1 ? `，${voiceCount} 个声部` : '') +
          (parenPairs > 0 ? `，已识别 ${parenPairs} 对前奏括号（ （ ）记号，非连线）` : ''),
      );
      setViewPage(0);
      setPhase('compare');
    } catch (e) {
      setStatus(`识别失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
    } finally {
      setBusy(false);
      setStageIdx(-1);
    }
  }

  /** 识别框按当前 PDF 页拆分：识别坐标在「整册拼接长图」上，
   *  长图 = 各页原始尺寸竖拼后按 s = 长图宽 / 最宽页 等比缩放，
   *  所以第 i 页在长图里的纵向区间是 [s×Σ_{j<i}h_j, s×Σ_{j≤i}h_j)。 */
  const pageBoxes = useMemo<Box[]>(() => {
    if (!pdfPages || pdfPages.length === 0 || boxes.length === 0 || !recBinW) return [];
    const maxW = Math.max(...pdfPages.map((p) => p.w));
    const s = recBinW / maxW;
    let y0 = 0;
    for (let i = 0; i < viewPage; i++) y0 += pdfPages[i]!.h;
    y0 *= s;
    const y1 = y0 + pdfPages[viewPage]!.h * s;
    return boxes
      .filter((b) => {
        const cy = b.y + b.h / 2;
        return cy >= y0 && cy < y1;
      })
      // 折算回当前页的**原始尺寸**口径（预览二值图就是原始尺寸）：长图坐标 ÷ s，
      // 只减 y0 不除 s 的话，s≠1（长图被 fitWidth 压过）时框会整体放大错位。
      .map((b) => ({ ...b, x: b.x / s, y: (b.y - y0) / s, w: b.w / s, h: b.h / s }));
  }, [pdfPages, boxes, viewPage, recBinW]);

  const progress =
    busy && stageIdx >= 0
      ? { label: STAGE_LABEL[STAGE_ORDER[stageIdx]!]!, pct: Math.round(((stageIdx + 1) / STAGE_ORDER.length) * 100) }
      : null;

  const pager =
    pdfPages && pdfPages.length > 1
      ? {
          page: viewPage,
          total: pdfPages.length,
          onPrev: () => setViewPage((v) => Math.max(0, v - 1)),
          onNext: () => setViewPage((v) => Math.min(pdfPages.length - 1, v + 1)),
        }
      : undefined;

  // ── 第一段：识别启动页 ──
  if (phase === 'start') {
    const showPreview = img?.url || (pdfPages && pdfPages.length > 0);
    return (
      <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry="ocr">
        <div className="ocr-start-bg" aria-hidden="true" />
        <header className="v2-head ocr-start-head">
          <a className="v2-home-btn" href="./index.html" title="回到首页">
            ← 返回首页
          </a>
          <div style={{ flex: 1 }} />
          <ThemeToggle dark={dark} onChange={toggleDark} />
        </header>
        <main className="ocr-start">
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
          {showPreview ? (
            <div className="ocr-start-preview-wrap">
              {img?.url ? (
                <img className="ocr-start-preview" src={img.url} alt="待识别简谱" />
              ) : pdfPages && pdfPages.length > 0 ? (
                <BinPreview bin={pdfPages[Math.min(viewPage, pdfPages.length - 1)]!} />
              ) : null}
              {pager ? (
                <span className="ocr-pager ocr-start-pager">
                  <button className="ocr-pager-btn" onClick={pager.onPrev} disabled={pager.page <= 0} aria-label="上一页">
                    ‹
                  </button>
                  <span>
                    {pager.page + 1} / {pager.total}
                  </span>
                  <button className="ocr-pager-btn" onClick={pager.onNext} disabled={pager.page >= pager.total - 1} aria-label="下一页">
                    ›
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
          {/* 操作面板：固定在画面左上（用户指定的绿框位置），确认图仍居中 */}
          <div className="ocr-start-panel">
            <div className="ocr-start-actions">
              <button className="ocr-start-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                上传图片 / PDF…
              </button>
              <button
                className="ocr-start-btn is-primary"
                onClick={() => void startRecognize()}
                disabled={!pending || busy}
                title={pending ? '首次识别需加载 OCR 模型（约 25MB），会多等几秒' : '先上传一张简谱图片或 PDF'}
              >
                简谱识别
              </button>
            </div>
            {busy && progress ? (
              <div className="ocr-start-progress" data-testid="progress">
                <div className="ocr-start-progress-text">
                  {progress.label}… {elapsed.toFixed(1)}s
                </div>
                <div className="ocr-progress-bar-track">
                  <div className="ocr-progress-bar" style={{ width: `${progress.pct}%` }} />
                </div>
              </div>
            ) : (
              <div className="ocr-start-status">{status || '上传一张简谱图片或 PDF，确认无误后开始识别'}</div>
            )}
          </div>
        </main>
        {/* 来源声明（dolce 为 MIT 许可，署名必须保留）：右下角小字、低调不抢眼 */}
        <footer className="ocr-start-foot">
          OCR 技术基于{' '}
          <a href="https://github.com/lodebar2026/dolce" target="_blank" rel="noreferrer">
            dolce 悦谱开源项目优化
          </a>
        </footer>
      </div>
    );
  }

  // ── 第二段：对比修改页（直接展示识别结果）──
  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry="ocr">
      <header className="v2-head ocr-cmp-head">
        <a className="v2-home-btn" href="./index.html" title="回到首页">
          ← 返回首页
        </a>
        <span className="v2-brand-name">
          按简谱识别 <span className="v2-brand-tag">测试功能</span>
        </span>
        {/* 谱面校验：与简谱编辑区工具栏同款，显示右栏谱面的语法解析/排版诊断 */}
        <div className="v2-head-check">
          <button
            className={!diag || (diag.issues.length === 0 && diag.draftErrors.length === 0) ? 'v2-check is-ok' : 'v2-check is-bad'}
            onClick={() => setCheckOpen((v) => !v)}
            title={
              diag?.draftErrors.length ? '请到右栏源码视图按错误提示修复' : !diag || diag.issues.length === 0
                ? '每小节拍数、拍内组、连线、反复结构都没问题'
                : '点开看具体问题'
            }
          >
            {!diag
              ? '谱面校验…'
              : diag.draftErrors.length
                ? `源码校验：${diag.draftErrors.length} 处问题`
                : diag.issues.length === 0
                  ? '谱面校验通过'
                  : `谱面校验：${diag.issues.length} 处问题`}
          </button>
          {checkOpen && diag && diag.issues.length > 0 ? (
            <ul className="v2-diag v2-check-list">
              {diag.issues.map((v, i) => (
                <li key={i} className={v.warn ? 'is-warn' : 'is-error'}>
                  <b>{v.label}</b> {v.message}
                </li>
              ))}
            </ul>
          ) : null}
          {/* 识别备注：DSL 未承载的信息（齐唱段写进各声部、杂行丢弃、括号改写等），人工核对用 */}
          {notes.length > 0 ? (
            <>
              <button
                className={notesOpen ? 'v2-check is-ok' : 'v2-check'}
                onClick={() => setNotesOpen((v) => !v)}
                title="识别层想说明、但谱面 DSL 里没写的信息"
              >
                {notesOpen ? '收起备注' : `识别备注 ${notes.length - 1}`}
              </button>
              {notesOpen ? (
                <ul className="v2-diag v2-check-list">
                  {notes.map((n, i) => (
                    <li key={i}>{n.startsWith('//') ? n.slice(2).trim() : n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
        <div style={{ flex: 1 }} />
        <ThemeToggle dark={dark} onChange={toggleDark} />
      </header>
      <main
        className="ocr-page"
        ref={pageRef}
        data-dragging={dragging || undefined}
        style={{ gridTemplateColumns: `minmax(240px, ${leftW}%) 5px minmax(0, 1fr)` }}
      >
        <section className="ocr-left">
          <ImagePane
            img={img}
            rec={null}
            locator={[]}
            activeBox={null}
            bin={pdfPages?.[Math.min(viewPage, (pdfPages?.length ?? 1) - 1)]}
            overlayBoxes={pdfPages ? pageBoxes : boxes}
            pager={pager}
          />
        </section>
        <div
          className="ocr-divider"
          title="拖动调整左右宽度"
          onPointerDown={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
        />
        <section className="ocr-right">
          <EditorApp
            entry="ocr"
            ocrItem={ocrItem ?? undefined}
            viewFontSize={VIEW_FONT_SIZE}
            onDiagnostics={onDiagnostics}
            theme={dark ? 'dark' : 'light'}
            fitRows
          />
        </section>
      </main>
    </div>
  );
}
