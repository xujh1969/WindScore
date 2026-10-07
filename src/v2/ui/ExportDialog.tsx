/**
 * 导出弹窗：PDF（A4 分页 + 页脚页码）与视频（手机 / Pad 横竖屏比例）。
 *
 * 两种导出都**只用当前显示的那份谱**：播放界面开着「展开反复」时，
 * 导出的就是拉平后的线性谱——所见即所得。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Score } from '../types';
import type { AudioStem } from '../audio';
import type { TempoMap } from '../tempo';
import type { TimelineEntry } from '../timeline';
import {
  a4Geometry,
  exportScorePdfToFile,
  planExport,
} from '../export/tasks';
import { exportScoreVideoToFile } from '../export/videoExport';
import { VIDEO_RATIOS, recordSeconds, videoGeometry, type VideoRatio } from '../export/video';

export interface ExportDialogProps {
  songName: string;
  /** 要导出的谱面（= 当前显示的那份） */
  score: Score;
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

export function ExportDialog({ songName, score, dark, onClose, video }: ExportDialogProps) {
  const [tab, setTab] = useState<'pdf' | 'video'>('pdf');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const cancelRef = useRef(false);

  // PDF 选项
  const [landscape, setLandscape] = useState(false);
  const [dpi, setDpi] = useState<number>(150);
  const [scale, setScale] = useState(1.55);
  const [showTitle, setShowTitle] = useState(true);
  const [showBars, setShowBars] = useState(true);

  // 视频选项
  const [ratio, setRatio] = useState<VideoRatio>('r9x16');
  const [shortSide, setShortSide] = useState<number>(1080);
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
    const pages = planExport(score, a4Geometry(landscape, dpi, scale), showTitle).plans.length;
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
    return { pages, canvasW: vg.canvasW, canvasH: vg.canvasH, seconds, from, to, total };
  }, [score, landscape, dpi, scale, showTitle, ratio, shortSide, useAudio, mFrom, mTo, video]);

  const run = async (task: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setError('');
    setProgress(0);
    setNote('准备中…');
    cancelRef.current = false;
    try {
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
        name: songName,
        landscape,
        dpi,
        scale,
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

  const doVideo = (): Promise<void> =>
    run(async () => {

      const res = await exportScoreVideoToFile({
        score,
        name: songName,

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
      <div className="v2-exp" role="dialog" aria-label="导出">
        <div className="v2-exp-head">
          <div className="v2-view-switch">
            <button
              className={tab === 'pdf' ? 'v2-seg is-on' : 'v2-seg'}
              onClick={() => setTab('pdf')}
              disabled={busy}
            >
              PDF
            </button>
            <button
              className={tab === 'video' ? 'v2-seg is-on' : 'v2-seg'}
              onClick={() => setTab('video')}
              disabled={busy}
            >
              视频
            </button>
          </div>
          <span className="v2-exp-song" title={songName}>
            {songName}
          </span>
          <button className="v2-btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>

        {tab === 'pdf' ? (
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
            <label className="v2-exp-row">
              <span>字号</span>
              <input
                type="range"
                min={1.1}
                max={2.4}
                step={0.05}
                value={scale}
                disabled={busy}
                onChange={(e) => setScale(Number(e.target.value))}
              />
              <output className="v2-spacing-val">{scale.toFixed(2)}×</output>
            </label>
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
        ) : (
          <div className="v2-exp-body">
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
                    短边 {s}
                  </button>
                ))}
              </div>
              <output className="v2-spacing-val">
                {preview.canvasW}×{preview.canvasH}
              </output>
            </div>
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
                  : `将录一段 ${preview.canvasW}×${preview.canvasH} 的${
                      videoDark ? '深色' : '浅色'
                    }视频，约 ${Math.floor(preview.seconds / 60)}:${String(
                      Math.round(preview.seconds % 60),
                    ).padStart(2, '0')}`)}
            </span>
          )}
          {tab === 'pdf' ? (
            <button className="v2-btn v2-btn--primary" onClick={doPdf} disabled={busy}>
              导出 PDF
            </button>
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

