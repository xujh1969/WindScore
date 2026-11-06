// 按简谱识别（ScoreOCR 集成，2026-11-02；两段式改版 2026-11-03）：
// 第一段「识别启动页」：全屏主题底图（bg-ocr-light/dark.png，跟随 ws-theme），
//   只有「上传照片 / PDF」和「简谱识别」两个按钮（后者上传前禁用）；
//   单图按最长边适配显示；多张照片按文件名自然排序叠成一摞纸，两侧箭头循环翻页；
//   多页 PDF 可逐页翻看；点识别后进度条显示在启动页，全部完成才进入第二段。
// 第二段「对比修改页」：现有双栏工作台去掉标题/状态/按钮，直接展示识别结果
//   （左=原图+识别框，多图时左栏就是识别用的那张拼合长图；PDF 按单页翻看；右=完整简谱编辑器）。
// 多图：识别前把各照片统一宽度竖拼成一张 PNG 长图，识别与左栏共用同一份像素，
//   识别框坐标天然对齐；PDF 仍复用预览像素做二值竖拼，单页显示并按缩放比折算识别框。
// 引擎代码（dolce/ convert/ adapter/）vendored 自独立项目 ScoreOCR；
// 模型资产在 public/redist/（运行时 fetch，不进 bundle）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorApp, type DiagnosticsSnapshot } from '../../v2/ui/EditorApp';
import { ThemeToggle } from '../../v2/ui/ThemeToggle';
import type { Binary, RecognizedScore } from '../adapter/installOcr';
import { joinPhotos, loadPhotoSource, sortByName, type PhotoSource } from '../adapter/joinPhotos';
import { decodePdfPageBins, joinPdfPageBins } from '../adapter/pdfPages';
import { recognizeWithFeedback, FEEDBACK_ROUNDS, type RecognizeProgress } from '../adapter/recognizeProgress';
import { BinPreview, ImagePane } from './ImagePane';
import { PhotoStack } from './PhotoStack';
import './ocr.css';

/** 载入待识别的文件（已解码出预览，尚未识别）；多张照片时这里放排序后的第一张作代表。 */
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

/** 右栏显示层字号（px）：只影响画布排版不写进谱面属性，比编辑器默认（24）小。
 *  这是「字号上限」——行放不下时 ScoreCanvas 的两段收缩会先压拍距、再从 16 往下
 *  找放得下的最大字号（下限 10），右栏缩窄后画布更宽，16px 大部分情况能站住。 */
const VIEW_FONT_SIZE = 16;

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
  /** 多张照片（已按文件名自然排序）：启动页叠成一摞纸，识别前竖拼成一张长图 */
  const [photos, setPhotos] = useState<PhotoSource[]>([]);
  const [activePhoto, setActivePhoto] = useState(0);
  /** 识别进度（细分动作 / 轮次 / 校验问题数），由适配层逐步回传 */
  const [progressState, setProgressState] = useState<RecognizeProgress | null>(null);
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const [viewPage, setViewPage] = useState(0); // PDF 当前预览页
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [ocrItem, setOcrItem] = useState<{ name: string; text: string } | null>(null);
  /** 识别备注（DSL 未承载的信息：齐唱段写进各声部、杂行丢弃等），对比页顶栏展开查看 */
  const [notes, setNotes] = useState<string[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [leftW, setLeftW] = useState(25); // 对比页左栏宽度（占 .ocr-page 的百分比）
  const [dragging, setDragging] = useState(false);
  /** 曲谱类型：歌曲（带歌词，默认）/ 器乐（无词——跳过歌词识别，0 一律按休止）。
   *  用户选择会记住，下次打开还是上次的选择。 */
  const [pieceKind, setPieceKind] = useState<'song' | 'instrumental'>(() =>
    localStorage.getItem('ws-ocr-piece-kind') === 'instrumental' ? 'instrumental' : 'song');
  const changePieceKind = (k: 'song' | 'instrumental') => {
    setPieceKind(k);
    try { localStorage.setItem('ws-ocr-piece-kind', k); } catch { /* 隐私模式等存不了就算了 */ }
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  /** 所有 createObjectURL 产物（每张照片 + 拼出的长图），换文件/卸载时统一释放 */
  const urlsRef = useRef<string[]>([]);
  /** 最近一次拼出的长图：重试识别时先单独释放，避免几十 MB 的长图堆积 */
  const joinedUrlRef = useRef<string | null>(null);
  const trackUrl = (url: string): string => {
    urlsRef.current.push(url);
    return url;
  };
  const clearUrls = (): void => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = [];
    joinedUrlRef.current = null;
  };
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

  // 卸载时释放所有预览/长图 URL（拼出的长图可能几十 MB）
  useEffect(() => () => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = [];
  }, []);

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

  /** 载入新文件：先清掉上一批状态与 objectURL，避免旧长图/预览残留。 */
  function resetPending() {
    clearUrls();
    setBoxes([]);
    setOcrItem(null);
    setNotes([]);
    setNotesOpen(false);
    setProgressState(null);
    setViewPage(0);
    setRecBinW(0);
    setPhase('start');
    setPending(null);
    setImg(null);
    setPhotos([]);
    setActivePhoto(0);
  }

  /** 单 PDF：逐页二值化做预览（识别时复用这些像素整册拼接）。 */
  async function onPdf(f: File) {
    resetPending();
    setStatus(`正在载入 ${f.name}…`);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const pages = await decodePdfPageBins(bytes);
      setPending({ bytes, mime: f.type || 'application/pdf', name: f.name, pages });
      setStatus(pages.length > 1 ? `已载入 ${f.name}（共 ${pages.length} 页，可翻页确认）` : `已载入 ${f.name}`);
    } catch (e) {
      setStatus(`载入失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 一次可载入多张照片：按文件名自然排序（序号小的在前），叠成一摞纸预览。 */
  async function onFiles(list: File[]) {
    if (!list.length) return;
    const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (list.length === 1 && isPdf(list[0]!)) {
      await onPdf(list[0]!);
      return;
    }
    if (list.some(isPdf)) {
      setStatus('PDF 请单独上传；一次拼接多张时请只选择照片');
      return;
    }
    resetPending();
    const sorted = sortByName(list);
    setStatus(`正在载入 ${sorted.length} 张照片…`);
    try {
      const loaded: PhotoSource[] = [];
      for (const f of sorted) {
        const photo = await loadPhotoSource(f);
        trackUrl(photo.url);
        loaded.push(photo);
      }
      const first = loaded[0]!;
      setPhotos(loaded);
      setPending({ bytes: first.bytes, mime: first.mime, name: first.name, url: first.url });
      // 单张沿用原来的预览；多张交给 PhotoStack，识别成功后再把 img 换成拼合长图
      if (loaded.length === 1) setImg({ url: first.url, w: first.w, h: first.h });
      setStatus(
        loaded.length > 1
          ? `已载入 ${loaded.length} 张照片（按文件名排序）；点两侧箭头翻看，识别时按此顺序拼成长图`
          : `已载入 ${first.name}`,
      );
    } catch (e) {
      clearUrls();
      setPhotos([]);
      setPending(null);
      setStatus(`载入失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 开始识别：细分进度 + 自动校验反馈（问题多时最多重识别三轮）；完成后才切入对比页。 */
  async function startRecognize() {
    if (!pending || busy) return;
    setBusy(true);
    setElapsed(0);
    const rounds = pending.pages ? 1 : FEEDBACK_ROUNDS;
    setProgressState({ label: '准备识别', pct: 1, round: 1, rounds, attempt: '准备' });
    try {
      const onProgress = (p: RecognizeProgress) => setProgressState(p);
      if (photos.length > 1) {
        setProgressState({ label: `正在把 ${photos.length} 张照片拼成长图`, pct: 3, round: 1, rounds, attempt: '拼图' });
      }
      // 多图：识别前统一宽度竖拼；单图/PDF 保持原来的输入路径不变
      const joined = photos.length > 1 ? await joinPhotos(photos) : null;
      if (joined) {
        if (joinedUrlRef.current) {
          URL.revokeObjectURL(joinedUrlRef.current);
          urlsRef.current = urlsRef.current.filter((u) => u !== joinedUrlRef.current);
        }
        joinedUrlRef.current = joined.url;
        trackUrl(joined.url);
        // 识别与左栏共用同一份像素：长图宽 ≤2200，decodeToBinary 不会再缩放，识别框坐标 1:1
        setImg({ url: joined.url, w: joined.w, h: joined.h });
      }
      const result = joined
        ? await recognizeWithFeedback(joined.bytes, 'image/png', onProgress, undefined, { instrumental: pieceKind === 'instrumental' })
        : await recognizeWithFeedback(pending.bytes, pending.mime, onProgress,
            pending.pages ? joinPdfPageBins(pending.pages) : undefined, { instrumental: pieceKind === 'instrumental' });
      setRecBinW(result.bin.w);
      const rec: RecognizedScore = result.score;
      setBoxes(
        (rec.rows ?? []).flatMap((r) => r.nums).map((n) => ({
          ...n.bbox,
          suspect: (n.doubt?.length ?? 0) > 0 || (n.lyricDoubt?.length ?? 0) > 0,
        })),
      );
      // 识别备注不进谱面文本（解析成功后源码视图显示序列化文本，注释会被规范化丢掉）
      setNotes(result.comments);
      setOcrItem({ name: rec.title?.trim() || '识别谱面', text: result.text });
      const voiceCount =
        new Set((rec.rows ?? []).map((r) => r.voice).filter((v) => v !== undefined)).size;
      setStatus(
        `识别完成 ✓ ${rec.rows?.length ?? 0} 个谱行` +
          (voiceCount > 1 ? `，${voiceCount} 个声部` : '') +
          (result.parenPairs > 0 ? `，已识别 ${result.parenPairs} 对前奏括号（ （ ）记号，非连线）` : '') +
          `，自动校验 ${result.diagnostic.issues} 处问题` +
          (result.rounds > 1 ? `（共 ${result.rounds} 轮，采用「${result.attempt}」）` : '') +
          (pieceKind === 'instrumental' ? '，器乐模式（未识别歌词）' : ''),
      );
      setViewPage(0);
      setPhase('compare');
    } catch (e) {
      setStatus(`识别失败 ✗ ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
    } finally {
      setBusy(false);
      setProgressState(null);
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
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = ''; // 允许再次选择同一批文件
              if (list.length) void onFiles(list);
            }}
          />
          {photos.length > 1 ? (
            <PhotoStack
              photos={photos}
              active={activePhoto}
              disabled={busy}
              onTurn={(d) => setActivePhoto((v) => (v + d + photos.length) % photos.length)}
            />
          ) : showPreview ? (
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
                上传照片（可多选）/ PDF…
              </button>
              <button
                className="ocr-start-btn is-primary"
                onClick={() => void startRecognize()}
                disabled={!pending || busy}
                title={
                  !pending
                    ? '先上传简谱照片或 PDF'
                    : photos.length > 1
                      ? `将按文件名顺序把 ${photos.length} 张照片拼成一幅长图再识别`
                      : '首次识别需加载 OCR 模型（约 25MB），会多等几秒'
                }
              >
                简谱识别
              </button>
            </div>
            {/* 曲谱类型：决定引擎怎么对待页面上的文字——歌曲逐字对位，器乐一律不挂词 */}
            <div className="ocr-piece-kind" role="group" aria-label="曲谱类型">
              <span className="ocr-piece-kind-label">曲谱类型</span>
              <button type="button" className={pieceKind === 'song' ? 'is-on' : ''} disabled={busy}
                onClick={() => changePieceKind('song')}>
                歌曲（带歌词）
              </button>
              <button type="button" className={pieceKind === 'instrumental' ? 'is-on' : ''} disabled={busy}
                title="器乐曲：跳过歌词识别，更快也更准——谱面上的 0 一律按休止处理，页脚文字不会被当成歌词"
                onClick={() => changePieceKind('instrumental')}>
                器乐（无歌词）
              </button>
            </div>
            {/* 实验性提示：简谱样式千奇百怪、错误与不规范常见，识别结果可能不理想（用户 2026-11-06 定） */}
            <div className="ocr-experimental" role="note">
              <div className="ocr-experimental-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 2v6.3L4.4 18a2 2 0 0 0 1.7 3h11.8a2 2 0 0 0 1.7-3L14 8.3V2" />
                  <path d="M8.5 2h7" />
                  <path d="M6.8 14.5h10.4" />
                </svg>
                <b>实验性功能</b>
              </div>
              <p>
                简谱的排版五花八门、千奇百怪，不少谱面本身还存在错误或不规范之处，
                因此 OCR 识别目前仍是<b>实验性功能</b>——最终的识别效果可能无法让您满意。
                识别完成后，请务必在右侧对照原图<b>逐行校对、修正</b>后再使用。
              </p>
            </div>
            {busy && progressState ? (
              <div className="ocr-start-progress" data-testid="progress">
                <div className="ocr-start-progress-text">
                  {progressState.label}… {elapsed.toFixed(1)}s
                </div>
                <div className="ocr-progress-detail" data-testid="progress-detail">
                  {progressState.rounds > 1
                    ? `第 ${progressState.round}/${progressState.rounds} 轮 · ${progressState.attempt}`
                    : '单轮识别'}
                  {progressState.issues !== undefined ? ` · 校验 ${progressState.issues} 处问题` : ''}
                  {progressState.note ? ` · ${progressState.note}` : ''}
                </div>
                <div className="ocr-progress-bar-track">
                  <div className="ocr-progress-bar" style={{ width: `${progressState.pct}%` }} />
                </div>
              </div>
            ) : (
              <div className="ocr-start-status">
                {status || '上传一张或多张简谱照片（一次可多选），或单独上传 PDF，确认无误后开始识别'}
              </div>
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
          {/* 多图：img 就是识别用的那张拼合长图，boxes 是长图像素坐标，天然对齐；
              PDF：逐页预览，识别框从整册长图折算回当前页尺寸。 */}
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
