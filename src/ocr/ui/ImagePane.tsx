// 中栏：原图/PDF 预览 + 识别框叠加层 + 双向联动（点图定位 jps；jps 光标高亮音框）。
import { forwardRef, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type Ref } from 'react'
import type { RecognizedScore } from '../adapter/installOcr'
import type { LocatorEntry } from '../convert/recognizedToJps'
import { boxAtPoint } from '../convert/locator'
import type { WorkbenchImage } from './ImagePaneTypes'
import type { Binary } from '../dolce/omrkit/types'

/** 平移量钳在 [min,max] 内：图片放得下时范围是 [0,0]（禁拖），
 *  溢出时是 [−overflow, 0]——顶/左对齐布局，往负向拖看被裁的那一边。 */
const clampPan = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

interface ImagePaneProps {
  img: WorkbenchImage | null
  rec?: RecognizedScore | null
  locator?: LocatorEntry[]
  /** 直接供给的叠加框（WindScore 集成：识别完成后标注音符框，无文字栏联动）。 */
  overlayBoxes?: { x: number; y: number; w: number; h: number; suspect?: boolean }[]
  /** 图→文：点图上的音符框。 */
  onPickBox?: (e: LocatorEntry) => void
  /** 文→图：当前 jps 光标对应的音框（高亮）。 */
  activeBox?: { x: number; y: number; w: number; h: number } | null
  /** PDF 预览：二值图（无彩色原图）。 */
  bin?: Binary | null
  /** 多页 PDF 翻页器：显示在栏头（页码 + 前后翻页）。 */
  pager?: { page: number; total: number; onPrev(): void; onNext(): void }
}

/** 二值图 → canvas（PDF 预览用）。ref 转发给叠加层测量实际渲染矩形。 */
export const BinPreview = forwardRef<HTMLCanvasElement, { bin: Binary }>(function BinPreview({ bin }, ref) {
  const inner = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = inner.current
    if (!canvas) return
    canvas.width = bin.w
    canvas.height = bin.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(bin.w, bin.h)
    for (let i = 0; i < bin.w * bin.h; i++) {
      const v = bin.data[i] ? 0 : 255 // 1=墨
      img.data[i * 4] = v
      img.data[i * 4 + 1] = v
      img.data[i * 4 + 2] = v
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [bin])
  return (
    <canvas
      ref={(el) => {
        inner.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      data-testid="bin-preview"
      style={{ display: 'block', width: '100%', height: 'auto' }}
    />
  )
})

export function ImagePane({ img, locator = [], overlayBoxes, onPickBox, activeBox, bin, pager }: ImagePaneProps) {
  const boxes = overlayBoxes ?? locator.map((e) => ({ ...e.bbox, suspect: e.suspect }))
  // 叠加层的原生尺寸：图片文件用原图，PDF 预览用当前页二值图（overlayBoxes 同口径）。
  // 之前整块渲染以 img 为条件，PDF 载入时 img=null → 对比页左栏只剩「原图显示在此处」
  // 空态，启动页能看到的预览进编辑界面就没了（用户实测）。
  const dims = img ?? (bin ? { w: bin.w, h: bin.h } : null)

  // 叠加层贴住图片的**实际渲染矩形**（图片被 contain 缩放后 wrap 可能比图大）。
  // ResizeObserver 跟随图片尺寸变化（拖栏宽/窗口缩放/加载完成都会触发）。
  const mediaRef = useRef<HTMLImageElement | HTMLCanvasElement | null>(null)
  const [rendered, setRendered] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  useEffect(() => {
    const el = mediaRef.current
    if (!el) {
      setRendered(null)
      return
    }
    const measure = () =>
      setRendered({ left: el.offsetLeft, top: el.offsetTop, w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [img, bin])

  // ── 查看器：滚轮缩放 + 拖拽平移 ──
  // scale=1 是「刚好撑满可视区」的初始态（contain），也是缩小的下限；
  // 平移量 (x,y) 是相对初始位置的偏移，**缩小时按比例向初始位置收敛**——
  // 缩到下限时恰好归位，不会因为拖拽跑偏而回不来。放大以鼠标点为锚。
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; xMin: number; xMax: number; yMin: number; yMax: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 当前缩放下的平移范围。布局是「放得下居中、溢出顶/左对齐」（.ocr-img-wrap 的 margin:auto），
   *  所以溢出方向的可拖范围就是 [−overflow, 0]：长图从顶拖到底一截不缺。
   *  之前钳制按「居中各溢一半」算（maxY=(图高−栏高)/2），而外框的 max-height 又把溢出
   *  全堆在下方——拼合长图只能拖到一半，第二张照片的下半永远显示不出来（用户实测）。
   *  单图放得下时范围是 [0,0]，保持禁拖。 */
  const panLimits = (scale: number) => {
    const body = bodyRef.current
    const overflowX = Math.max(0, (rendered?.w ?? 0) * scale - (body?.clientWidth ?? 0))
    const overflowY = Math.max(0, (rendered?.h ?? 0) * scale - (body?.clientHeight ?? 0))
    return { xMin: -overflowX, xMax: 0, yMin: -overflowY, yMax: 0 }
  }

  // 换图/翻页时回到初始态
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 })
  }, [img, bin])

  // 滚轮缩放要 preventDefault，React 的 onWheel 是 passive 的，挂原生监听
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = ev.clientX - rect.left - rect.width / 2
      const my = ev.clientY - rect.top - rect.height / 2
      setView((v) => {
        const factor = ev.deltaY < 0 ? 1.25 : 1 / 1.25
        const scale = Math.min(8, Math.max(1, v.scale * factor))
        if (scale === v.scale) return v
        if (scale > v.scale) {
          // 放大：以鼠标点为锚
          const k = scale / v.scale
          const lim = panLimits(scale)
          return {
            scale,
            x: clampPan(mx * (1 - k) + v.x * k, lim.xMin, lim.xMax),
            y: clampPan(my * (1 - k) + v.y * k, lim.yMin, lim.yMax),
          }
        }
        // 缩小：平移量按「超出初始态的放大程度」等比收敛——缩到下限 scale=1 时
        // 恰好回到初始位置（x=y=0），不会因为拖拽跑偏而停在旁边
        const k = (scale - 1) / (v.scale - 1)
        return { scale, x: v.x * k, y: v.y * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [img, bin, rendered])

  // 拖拽平移（放大后才有意义）；拖过就算移动，松手后的 click 不再当点选
  useEffect(() => {
    const move = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.sx
      const dy = ev.clientY - d.sy
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      setView((v) => ({ ...v, x: clampPan(d.ox + dx, d.xMin, d.xMax), y: clampPan(d.oy + dy, d.yMin, d.yMax) }))
    }
    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      setDragging(false)
      if (d?.moved) suppressClickRef.current = true
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  const onMouseDown = (ev: ReactMouseEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return
    // 不再是「必须放大才能拖」：只要图片在任一方向超出可视区（拼合长图在 scale=1 就高度溢出）就能拖；
    // 单图完整放得下时两个溢出量都为 0，仍禁止拖拽。
    const lim = panLimits(view.scale)
    if (lim.xMin >= lim.xMax && lim.yMin >= lim.yMax) return
    ev.preventDefault()
    dragRef.current = {
      sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y,
      xMin: lim.xMin, xMax: lim.xMax, yMin: lim.yMin, yMax: lim.yMax, moved: false,
    }
    setDragging(true)
  }

  const onClick = (ev: ReactMouseEvent<SVGSVGElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (!onPickBox || !img || locator.length === 0) return
    const rect = ev.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const x = ((ev.clientX - rect.left) / rect.width) * img.w
    const y = ((ev.clientY - rect.top) / rect.height) * img.h
    const hit = boxAtPoint(locator, x, y)
    if (hit) onPickBox(hit)
  }

  const pan = panLimits(view.scale)
  const canPan = pan.xMin < -0.5 || pan.yMin < -0.5

  return (
    <section className="ocr-pane" data-pane="image">
      <div className="ocr-pane-head">
        原图
        {canPan && view.scale === 1 ? <span className="ocr-pane-hint">长图 · 可拖拽查看</span> : null}
        {pager ? (
          <span className="ocr-pager">
            <button
              className="ocr-pager-btn"
              onClick={pager.onPrev}
              disabled={pager.page <= 0}
              aria-label="上一页"
              title="上一页"
            >
              ‹
            </button>
            <span>
              {pager.page + 1} / {pager.total}
            </span>
            <button
              className="ocr-pager-btn"
              onClick={pager.onNext}
              disabled={pager.page >= pager.total - 1}
              aria-label="下一页"
              title="下一页"
            >
              ›
            </button>
          </span>
        ) : null}
      </div>
      {img || bin ? (
        <div className="ocr-pane-body" ref={bodyRef}>
          <div
            className="ocr-img-wrap"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              cursor: dragging ? 'grabbing' : canPan ? 'grab' : undefined,
            }}
            onMouseDown={onMouseDown}
          >
            {bin ? (
              <BinPreview ref={mediaRef as Ref<HTMLCanvasElement>} bin={bin} />
            ) : img ? (
              <img ref={mediaRef as Ref<HTMLImageElement>} src={img.url} alt="原始简谱" data-testid="src-image" draggable={false} />
            ) : null}
            {(boxes.length > 0 || activeBox) && dims && (
              <svg
                className="ocr-overlay"
                width={dims.w}
                height={dims.h}
                viewBox={`0 0 ${dims.w} ${dims.h}`}
                data-testid="overlay"
                onClick={onClick}
                style={
                  rendered
                    ? { left: rendered.left, top: rendered.top, width: rendered.w, height: rendered.h, ...(onPickBox ? { pointerEvents: 'auto', cursor: 'pointer' } : {}) }
                    : onPickBox ? { pointerEvents: 'auto', cursor: 'pointer' } : undefined
                }
              >
                {activeBox && (
                  <rect
                    x={activeBox.x - 3}
                    y={activeBox.y - 3}
                    width={activeBox.w + 6}
                    height={activeBox.h + 6}
                    fill="var(--accent-soft)"
                    data-testid="active-box"
                  />
                )}
                {boxes.map((b, i) => (
                  <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} data-suspect={b.suspect || undefined} />
                ))}
              </svg>
            )}
          </div>
        </div>
      ) : (
        <div className="ocr-empty">原图显示在此处</div>
      )}
    </section>
  )
}
