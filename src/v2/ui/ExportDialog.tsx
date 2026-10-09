/**
 * 导出弹窗：PDF（A4 分页 + 页脚页码）与视频（手机 / Pad 横竖屏比例）。
 *
 * 两种导出都**只用当前显示的那份谱**：播放界面开着「展开反复」时，
 * 导出的就是拉平后的线性谱——所见即所得。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Score } from '../types';
import { layoutScore, type LayoutOptions, type LayoutResult } from '../layout';
import { exportTheme, footerText, paintExportPage, type PageGeometry } from '../export/render';
import type { AudioStem } from '../audio';
import type { TempoMap } from '../tempo';
import type { TimelineEntry } from '../timeline';
import {
  a4Geometry,
  exportScorePdfToFile,
  planExport,
} from '../export/tasks';
import { exportScoreVideoToFile } from '../export/videoExport';
import { exportScoreImageToFile } from '../export/image';
import { VIDEO_RATIOS, recordSeconds, videoGeometry, type VideoRatio } from '../export/video';
import { ensembleIssues, partScore, scoreParts } from '../parts';

export interface ExportDialogProps {
  songName: string;
  /** 要导出的谱面（= 当前显示的那份） */
  score: Score;
  visibleLayout?: LayoutResult;
  visibleOptions?: LayoutOptions;
  initialPartId?: string;
  /** 是否允许导出视频（曲库播放 / 动态谱播放 = true；简谱编辑 = false，视频只在演奏页有意义） */
  allowVideo?: boolean;
  /** 视频配色跟随界面 */
  dark: boolean;
  onClose: () => void;
  /** 开始导出前先停掉正在进行的播放（录视频时播放器由录制器接管） */
  onBegin?: () => void;
  video: {
    timeline: TimelineEntry[];
    /** 画的是原谱时传映射回原谱 id 的那份时间线，指示才对得上谱面 */
    displayTimeline: TimelineEntry[];
    /** 播放指示样式（跟界面设置一致） */
    playStyle: 'head' | 'band';
    fromTick: number;
    bpm: number;
    tempo: TempoMap | null;
    stems: AudioStem[];
    /**
     * 演奏顺序里每一小节的起始 tick（`[小节1, 小节2, …]`）。
     * 段落选择：整首太长时只导一段。
     */
    measureTicks: number[];
  };
}

const DPIS = [150, 300] as const;
const SIDES = [720, 1080, 1440] as const;
const FPS = [25, 30, 60] as const;

/** 预览缩放：整套页面几何等比缩，页面比 / 页脚 / 边距保持一致 */
function zoomedGeo(geo: PageGeometry, z: number): PageGeometry {
  return {
    pageW: geo.pageW * z,
    pageH: geo.pageH * z,
    scale: geo.scale * z,
    marginX: geo.marginX * z,
    marginTop: geo.marginTop * z,
    marginBottom: geo.marginBottom * z,
  };
}

export function ExportDialog({ songName, score: fullScore, visibleLayout, visibleOptions, initialPartId = '', allowVideo = true, dark, onClose, onBegin, video: fullVideo }: ExportDialogProps) {
  const [partId, setPartId] = useState(initialPartId);
  const score = useMemo(() => partId ? partScore(fullScore, partId) : fullScore, [fullScore, partId]);
  const video = useMemo(() => partId ? { ...fullVideo, timeline: fullVideo.timeline.filter((e) => e.partId === partId), displayTimeline: fullVideo.displayTimeline.filter((e) => e.partId === partId) } : fullVideo, [fullVideo, partId]);
  const exportName = partId ? `${songName}-${score.part?.name ?? partId}` : songName;
  const [tab, setTab] = useState<'pdf' | 'video' | 'image'>('pdf');
  const [imageFormat, setImageFormat] = useState<'png' | 'svg'>('png');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const cancelRef = useRef(false);

  // PDF 选项
  const [landscape, setLandscape] = useState(false);
  const [dpi, setDpi] = useState<number>(150);
  const pdfLayout = useMemo(() => partId === initialPartId && visibleLayout ? visibleLayout : layoutScore(score, visibleOptions ?? { contentWidth: 900 }), [score, partId, initialPartId, visibleLayout, visibleOptions]);
  const [showTitle, setShowTitle] = useState(true);
  const [showBars, setShowBars] = useState(fullScore.meta.showMeasureNumbers !== false);
  const [pdfPage, setPdfPage] = useState(0);
  const pdfCanvas = useRef<HTMLCanvasElement>(null);

  // 视频选项
  const [ratio, setRatio] = useState<VideoRatio>('r9x16');
  const [shortSide, setShortSide] = useState<number>(1080);
  const [videoMode, setVideoMode] = useState<'page' | 'strip'>('page');
  const [fps, setFps] = useState<number>(30);
  // 声音：默认跟着伴奏（`auto` = 有伴奏就录伴奏，没有才退回合成音）。
  // 用户显式选「合成音」时才不听伴奏。
  const [audio, setAudio] = useState<'auto' | 'stems' | 'synth'>('auto');
  // 只导一段（0 = 到末尾）
  const [mFrom, setMFrom] = useState(1);
  const [mTo, setMTo] = useState(0);
  /** 视频外观：默认跟界面一致（界面临时换了深浅色，这里也重置过去） */
  const [videoDark, setVideoDark] = useState(dark);
  useEffect(() => {
    setVideoDark(dark);
  }, [dark]);

  // 没伴奏就别让用户选「伴奏」——导出来会是哑的
  const canRecord = video.stems.length > 0 && video.tempo !== null;
  const useAudio: 'stems' | 'synth' = canRecord && audio !== 'synth' ? 'stems' : 'synth';

  /** 页数 / 画面尺寸 / 时长都是纯计算，选项一动就能报出来（不用等真导出） */
  const preview = useMemo(() => {
    let pages = 0;
    let layoutError = '';
    let pdfPlan: ReturnType<typeof planExport> | null = null;
    try { pdfPlan = planExport(score, a4Geometry(landscape, dpi, 1), showTitle, pdfLayout); pages = pdfPlan.plans.length; }
    catch (e) { layoutError = e instanceof Error ? e.message : String(e); }
    const vg = videoGeometry(ratio, shortSide);
    const total = Math.max(1, video.measureTicks.length);
    const from = Math.min(Math.max(1, mFrom), total);
    const to = mTo > 0 ? Math.min(Math.max(from, mTo), total) : total;
    const fromTick = video.measureTicks[from - 1] ?? video.fromTick;
    const toTick = to >= total ? undefined : video.measureTicks[to];
    const seconds = recordSeconds({
      timeline: video.timeline,
      fromTick,
      ...(toTick !== undefined ? { toTick } : {}),
      bpm: video.bpm,
      tempo: video.tempo,
      stems: video.stems,
      audio: useAudio,
    });
    return { pages, pdfPlan, layoutError, canvasW: vg.canvasW, canvasH: vg.canvasH, seconds, from, to, total };
  }, [score, pdfLayout, landscape, dpi, showTitle, ratio, shortSide, useAudio, mFrom, mTo, video]);

  const pageIndex = Math.min(pdfPage, Math.max(0, preview.pages - 1));
  // PDF 预览缩放：null = 适应窗口（CSS 缩到面板内）；数字 = 相对页面原始像素的倍率。
  // 放大时按倍率重渲染画布（不是拉伸位图），细节才经得起看
  const [pdfZoom, setPdfZoom] = useState<number | null>(null);
  const pdfSheetRef = useRef<HTMLDivElement>(null);
  /**
   * 适应窗口的真实显示比例。**必须在适应模式下量画布元素本身**——
   * A4 是竖长条，适应受 50vh 高度约束而非宽度；只量宽度会高估一倍，
   * 第一步就跳到 68%。适应模式下量完缓存，供放大起点与缩小回退判断用
   * （放大后画布元素变成缩放后的尺寸，不能再量它）。
   */
  const fitScaleRef = useRef(0.25);
  useEffect(() => {
    if (pdfZoom !== null) return;
    const el = pdfCanvas.current;
    const pageW = preview.pdfPlan?.geo.pageW;
    if (el && pageW) fitScaleRef.current = Math.max(0.05, el.getBoundingClientRect().width / pageW);
  }, [pdfZoom, preview.pdfPlan]);
  /**
   * 步进缩放：从「适应窗口」出发每步 ×1.25 / ÷1.25，而不是一步跳到固定档位——
   * 适应比例随窗口宽窄变化，固定 125% 起步会猛跳。
   * 缩到接近适应比例时直接回「适应窗口」。
   */
  const zoomStep = (dir: 1 | -1): void =>
    setPdfZoom((z) => {
      if (z === null) return dir === 1 ? Math.min(3, Math.round(fitScaleRef.current * 1.25 * 100) / 100) : null;
      const next = Math.round(z * (dir === 1 ? 1.25 : 0.8) * 100) / 100;
      if (dir === -1 && next <= fitScaleRef.current * 1.02) return null;
      return Math.min(3, Math.max(0.2, next));
    });
  useEffect(() => {
    const canvas = pdfCanvas.current;
    const plan = preview.pdfPlan;
    if (tab !== 'pdf' || !canvas || !plan?.plans.length) return;
    const z = pdfZoom ?? 1;
    canvas.width = Math.round(plan.geo.pageW * z);
    canvas.height = Math.round(plan.geo.pageH * z);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // 缩放必须走 geo：paintExportPage 内部会 setTransform 重置矩阵，
      // 在外面 pre-scale 会被抹掉（放大后内容不变大的根源）。
      // 整套几何等比缩，页面比、页脚、页边距全部一致
      paintExportPage(ctx, plan.layout, exportTheme(false), plan.plans[pageIndex], zoomedGeo(plan.geo, z), { footer: footerText(exportName, pageIndex + 1, plan.plans.length), showMeasureNumbers: showBars });
    }
  }, [preview.pdfPlan, pageIndex, tab, exportName, showBars, pdfZoom]);

  const run = async (task: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setError('');
    setProgress(0);
    setNote('准备中…');
    cancelRef.current = false;
    try {
      onBegin?.();
      setNote(await task());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const doPdf = (): Promise<void> =>
    run(async () => {

      const res = await exportScorePdfToFile({
        score,
        name: exportName,
        landscape,
        dpi,
        layout: pdfLayout,
        showTitle,
        showMeasureNumbers: showBars,
        dark: false,
        onProgress: (r, n) => {
          setProgress(r);
          setNote(n);
        },
      });
      if (!res.ok) return '已取消保存';
      return `已导出 ${res.pageCount} 页 PDF，页脚格式 ${songName}-1/${res.pageCount}`;
    });

  const doImage = (): Promise<void> => run(async () => {
    const plan = preview.pdfPlan;
    if (!plan?.plans.length) throw new Error('谱面排版失败，无法导出图片');
    const res = await exportScoreImageToFile({
      name: exportName,
      format: imageFormat,
      dark: videoDark,
      showMeasureNumbers: showBars,
      layout: plan.layout,
      plans: plan.plans,
      geo: plan.geo,
    });
    return res.ok ? `已导出 ${imageFormat.toUpperCase()}（${plan.plans.length} 页，与 PDF 同版式）` : '已取消保存';
  });

  const doVideo = (): Promise<void> =>
    run(async () => {
      const mismatch = ensembleIssues(fullScore);
      if (mismatch.length) throw new Error(mismatch[0]);

      const res = await exportScoreVideoToFile({
        score,
        name: exportName,
        mode: videoMode,
        ...(videoMode === 'strip' ? { layout: pdfLayout } : {}),

        timeline: video.timeline,
        fromTick: video.measureTicks[preview.from - 1] ?? video.fromTick,
        ...(preview.to < preview.total
          ? { toTick: video.measureTicks[preview.to] }
          : {}),
        bpm: video.bpm,
        tempo: video.tempo,
        stems: video.stems,
        dark: videoDark,
        ratio,
        shortSide,
        fps,
        audio: useAudio,
        displayTimeline: video.displayTimeline,
        playStyle: video.playStyle,
        showMeasureNumbers: showBars,
        onProgress: setProgress,
        cancelled: () => cancelRef.current,
      });
      if (cancelRef.current || !res.ok) return '已取消';
      const mm = Math.floor(res.seconds / 60);
      const ss = Math.round(res.seconds % 60);
      return `已导出 ${res.ext.toUpperCase()}：${mm}:${String(ss).padStart(2, '0')} · ${preview.canvasW}×${preview.canvasH} · ${res.sizeMB} MB`;
    });

  return (
    <div
      className="v2-exp-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={`v2-exp${tab === 'pdf' ? ' v2-exp--pdf' : ''}`} role="dialog" aria-label="导出">
        <div className="v2-exp-head">
          <div className="v2-view-switch">
            <button
              className={tab === 'pdf' ? 'v2-seg is-on' : 'v2-seg'}
              onClick={() => setTab('pdf')}
              disabled={busy}
            >
              PDF
            </button>
            {allowVideo ? (
              <button
                className={tab === 'video' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => setTab('video')}
                disabled={busy}
              >
                视频
              </button>
            ) : null}
            <button className={tab === 'image' ? 'v2-seg is-on' : 'v2-seg'} onClick={() => setTab('image')} disabled={busy}>图片</button>
          </div>
          <span className="v2-exp-song" title={songName}>
            {songName}
          </span>
          <button className="v2-btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>

        {fullScore.part ? <label className="v2-exp-row v2-exp-part">
          <span>导出内容</span>
          <select aria-label="导出声部" value={partId} disabled={busy} onChange={(e) => setPartId(e.target.value)}>
            <option value="">全部声部 · 总谱</option>
            {scoreParts(fullScore).map((p) => <option key={p.id} value={p.id}>{p.name} · 分谱</option>)}
          </select>
        </label> : null}
        {tab === 'pdf' && preview.layoutError ? <p className="v2-exp-err" role="alert">{preview.layoutError}</p> : null}

        {tab === 'pdf' ? (
          <div className="v2-exp-pdf">
          <div className="v2-exp-body">
            <div className="v2-exp-row">
              <span>纸张</span>
              <div className="v2-view-switch">
                <button
                  className={!landscape ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setLandscape(false)}
                  disabled={busy}
                >
                  A4 纵向
                </button>
                <button
                  className={landscape ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setLandscape(true)}
                  disabled={busy}
                >
                  A4 横向
                </button>
              </div>
            </div>
            <div className="v2-exp-row">
              <span>清晰度</span>
              <div className="v2-view-switch">
                {DPIS.map((d) => (
                  <button
                    key={d}
                    className={dpi === d ? 'v2-seg is-on' : 'v2-seg'}
                    onClick={() => setDpi(d)}
                    disabled={busy}
                    title={d === 150 ? '够打印，文件小' : '更清晰，文件大约翻两倍'}
                  >
                    {d} dpi
                  </button>
                ))}
              </div>
            </div>
            <p className="v2-exp-hint">沿用当前谱面的字号、字间距、音符间距和每行小节布局，整行等比适配纸张。清晰度只影响图像质量。</p>
            <div className="v2-exp-row">
              <label className="v2-grace-check">
                <input
                  type="checkbox"
                  checked={showTitle}
                  disabled={busy}
                  onChange={(e) => setShowTitle(e.target.checked)}
                />
                首页包含标题
              </label>
              <label className="v2-grace-check">
                <input
                  type="checkbox"
                  checked={showBars}
                  disabled={busy}
                  onChange={(e) => setShowBars(e.target.checked)}
                />
                显示小节号
              </label>
            </div>
            <p className="v2-exp-hint">
              共 <b>{preview.pages}</b> 页。页脚每页都写「{songName}-页号/总页数」。
            </p>
          </div>
          <section className="v2-pdf-preview" aria-label="PDF 页面预览">
            <div className="v2-pdf-zoom" role="group" aria-label="预览缩放">
              <button className="v2-btn" disabled={busy || (pdfZoom ?? 1) <= 0.5} onClick={() => zoomStep(-1)} title="缩小">－</button>
              <span className="v2-pdf-zoom-label">{pdfZoom === null ? '适应窗口' : `${Math.round(pdfZoom * 100)}%`}</span>
              <button className="v2-btn" disabled={busy || (pdfZoom ?? 1) >= 3} onClick={() => zoomStep(1)} title="放大">＋</button>
              <button className="v2-btn" disabled={busy || pdfZoom === 1} onClick={() => setPdfZoom(1)}>100%</button>
              <button className="v2-btn" disabled={busy || pdfZoom === null} onClick={() => setPdfZoom(null)}>适应窗口</button>
            </div>
            <div className="v2-pdf-sheet" data-zoom={pdfZoom ? 'in' : 'fit'} ref={pdfSheetRef}>
              <canvas
                ref={pdfCanvas}
                aria-label={`PDF 第 ${pageIndex + 1} 页预览`}
                style={
                  pdfZoom && preview.pdfPlan
                    ? {
                        // 宽高都按同一倍率显式给定：宽高比只由页面几何决定，
                        // 不依赖 height:auto 的等比推断（flex + 滚动容器下会被压扁）
                        width: Math.round(preview.pdfPlan.geo.pageW * pdfZoom),
                        height: Math.round(preview.pdfPlan.geo.pageH * pdfZoom),
                      }
                    : undefined
                }
              />
            </div>
            <div className="v2-pdf-pages">
              <button className="v2-btn" disabled={busy || pageIndex === 0} onClick={() => setPdfPage(pageIndex - 1)}>上一页</button>
              <span>第 {preview.pages ? pageIndex + 1 : 0} / {preview.pages} 页</span>
              <button className="v2-btn" disabled={busy || pageIndex + 1 >= preview.pages} onClick={() => setPdfPage(pageIndex + 1)}>下一页</button>
            </div>
          </section>
          </div>
        ) : tab === 'image' ? (
          <div className="v2-exp-body">
            <label className="v2-exp-row"><span>格式</span><select value={imageFormat} disabled={busy} onChange={(e) => setImageFormat(e.target.value as 'png' | 'svg')}><option value="png">PNG · 多页拼接长图</option><option value="svg">SVG · 矢量图片</option></select></label>
            <div className="v2-exp-row"><span>纸向</span><div className="v2-view-switch"><button className={!landscape ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setLandscape(false)}>纵向</button><button className={landscape ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setLandscape(true)}>横向</button></div></div>
            <div className="v2-exp-row"><span>精度</span><div className="v2-view-switch">{[150, 300].map((d) => <button key={d} className={dpi === d ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setDpi(d)}>{d} dpi</button>)}</div></div>
            <div className="v2-exp-row"><span>外观</span><div className="v2-view-switch"><button className={!videoDark ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setVideoDark(false)}>浅色</button><button className={videoDark ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setVideoDark(true)}>深色</button></div></div>
            <div className="v2-exp-row"><label className="v2-grace-check"><input type="checkbox" checked={showTitle} disabled={busy} onChange={(e) => setShowTitle(e.target.checked)} />包含标题</label><label className="v2-grace-check"><input type="checkbox" checked={showBars} disabled={busy} onChange={(e) => setShowBars(e.target.checked)} />显示小节号</label></div>
            <p className="v2-exp-hint">与 PDF 完全同一套分页排版：每页和 PDF 预览逐像素一致（含页脚），多页纵向拼接成一张。SVG 放大不失真，文字显示使用打开设备上的字体。</p>
          </div>
        ) : (
          <div className="v2-exp-body">
            <div className="v2-exp-row">
              <span>模式</span>
              <div className="v2-view-switch">
                <button className={videoMode === 'page' ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setVideoMode('page')} title="整页纵向滚动，跟随换行换页">整页滚动</button>
                <button className={videoMode === 'strip' ? 'v2-seg is-on' : 'v2-seg'} disabled={busy} onClick={() => setVideoMode('strip')} title="拉平成横向长条从右向左移动；绿幕底色便于 OBS 抠像叠加">绿幕横条</button>
              </div>
            </div>
            {videoMode === 'page' ? (
            <div className="v2-exp-row">
              <span>画面比例</span>
              <div className="v2-exp-ratios">
                {VIDEO_RATIOS.map((r) => (
                  <button
                    key={r.id}
                    className={ratio === r.id ? 'v2-seg is-on' : 'v2-seg'}
                    onClick={() => setRatio(r.id)}
                    disabled={busy}
                    title={r.hint}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            ) : (
            <p className="v2-exp-hint">
              绿幕横条：忽略换行 / 分页，整份简谱拉成一条横带随音乐从右向左移动。
              宽度 = 下方数值；高度 = 一行谱（多声部为一组）。
              底色固定绿幕 #00B140，音符白色、播放指示红色，便于 OBS 抠像叠加到演奏画面。
            </p>
            )}
            <div className="v2-exp-row">
              <span>段落</span>
              <span className="v2-exp-mrange">
                第
                <input
                  type="number"
                  min={1}
                  max={preview.total}
                  value={preview.from}
                  disabled={busy}
                  onChange={(e) => setMFrom(Number(e.target.value) || 1)}
                />
                小节 到 第
                <input
                  type="number"
                  min={preview.from}
                  max={preview.total}
                  value={preview.to}
                  disabled={busy}
                  onChange={(e) => setMTo(Number(e.target.value) || 0)}
                />
                小节（共 {preview.total} 小节）
              </span>
              <button
                className="v2-btn"
                disabled={busy}
                onClick={() => {
                  setMFrom(1);
                  setMTo(0);
                }}
              >
                整首
              </button>
            </div>
            <div className="v2-exp-row">
              <span>分辨率</span>
              <div className="v2-view-switch">
                {SIDES.map((s) => (
                  <button
                    key={s}
                    className={shortSide === s ? 'v2-seg is-on' : 'v2-seg'}
                    onClick={() => setShortSide(s)}
                    disabled={busy}
                  >
                    {videoMode === 'strip' ? '宽' : '短边'} {s}
                  </button>
                ))}
              </div>
              <output className="v2-spacing-val">
                {preview.canvasW}×{preview.canvasH}
              </output>
            </div>
            {videoMode === 'page' ? (
            <div className="v2-exp-row">
              <span>外观</span>
              <div className="v2-view-switch">
                <button
                  className={!videoDark ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setVideoDark(false)}
                  disabled={busy}
                  title="白底黑字：适合发朋友圈、打印、投影"
                >
                  浅色
                </button>
                <button
                  className={videoDark ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setVideoDark(true)}
                  disabled={busy}
                  title="深底浅字：夜里看更舒服"
                >
                  深色
                </button>
              </div>
            </div>
            ) : null}
            <div className="v2-exp-row">
              <span>帧率</span>
              <div className="v2-view-switch">
                {FPS.map((f) => (
                  <button
                    key={f}
                    className={fps === f ? 'v2-seg is-on' : 'v2-seg'}
                    onClick={() => setFps(f)}
                    disabled={busy}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="v2-exp-row">
              <span>声音</span>
              <div className="v2-view-switch">
                <button
                  className={useAudio === 'stems' ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setAudio('stems')}
                  disabled={busy || !canRecord}
                  title={canRecord ? '录真实伴奏' : '这首还没有伴奏：先到对轨界面载入，或在曲库导入打包'}
                >
                  伴奏{canRecord ? '（默认）' : ''}
                </button>
                <button
                  className={useAudio === 'synth' ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setAudio('synth')}
                  disabled={busy}
                  title="用合成音按谱面奏（三角波，只有旋律没有伴奏）"
                >
                  合成音
                </button>
              </div>
            </div>
            <p className="v2-exp-hint">
              约 {Math.floor(preview.seconds / 60)}:{String(Math.round(preview.seconds % 60)).padStart(2, '0')} · 画面按播放位置滚动。离线渲染：不用守着页面，也不用听一遍。
            </p>
          </div>
        )}

        {/*
          底栏**常驻**：导出按钮不能只在「导出过一次」之后才出现
          （之前挂在 busy || note || error 里，首次打开时三者都空，按钮整个不渲染）。
          没在导出时这一行放一句说明，兼作按钮的占位，主按钮始终贴右。
        */}
        <div className="v2-exp-foot">
          {busy ? (
            <>
              <progress className="v2-exp-bar" max={1} value={progress} />
              <span className="v2-exp-note">{note}</span>
              <button
                className="v2-btn"
                onClick={() => {
                  cancelRef.current = true;
                  setNote('正在收尾…');
                }}
              >
                取消
              </button>
            </>
          ) : error ? (
            <span className="v2-exp-err">{error}</span>
          ) : (
            <span className="v2-exp-note">
              {note ||
                (tab === 'pdf'
                  ? `将导出 ${preview.pages} 页 A4，文件名取歌名`
                  : tab === 'image' ? `将按 PDF 版式导出 ${imageFormat.toUpperCase()}（多页纵向拼接）`
                  : `将录一段 ${preview.canvasW}×${preview.canvasH} 的${
                      videoDark ? '深色' : '浅色'
                    }视频，约 ${Math.floor(preview.seconds / 60)}:${String(
                      Math.round(preview.seconds % 60),
                    ).padStart(2, '0')}`)}
            </span>
          )}
          {tab === 'pdf' ? (
            <button className="v2-btn v2-btn--primary" onClick={doPdf} disabled={busy || !!preview.layoutError}>
              导出 PDF
            </button>
          ) : tab === 'image' ? (
            <button className="v2-btn v2-btn--primary" onClick={doImage} disabled={busy}>导出 {imageFormat.toUpperCase()}</button>
          ) : (
            <button className="v2-btn v2-btn--primary" onClick={doVideo} disabled={busy}>
              导出视频
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;

