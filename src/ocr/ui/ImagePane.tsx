// 中栏：原图/PDF 预览 + 识别框叠加层 + 双向联动（点图定位 jps；jps 光标高亮音框）。
import { forwardRef, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type Ref } from 'react'
import type { RecognizedScore } from '../adapter/installOcr'
import type { LocatorEntry } from '../convert/recognizedToJps'
import { boxAtPoint } from '../convert/locator'
import type { WorkbenchImage } from './ImagePaneTypes'
import type { Binary } from '../dolce/omrkit/types'

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
}

/** 二值图 → canvas（PDF 预览用）。ref 转发给叠加层测量实际渲染矩形。 */
const BinPreview = forwardRef<HTMLCanvasElement, { bin: Binary }>(function BinPreview({ bin }, ref) {
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

export function ImagePane({ img, locator = [], overlayBoxes, onPickBox, activeBox, bin }: ImagePaneProps) {
  const boxes = overlayBoxes ?? locator.map((e) => ({ ...e.bbox, suspect: e.suspect }))

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

  const onClick = (ev: ReactMouseEvent<SVGSVGElement>) => {
    if (!onPickBox || !img || locator.length === 0) return
    const rect = ev.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const x = ((ev.clientX - rect.left) / rect.width) * img.w
    const y = ((ev.clientY - rect.top) / rect.height) * img.h
    const hit = boxAtPoint(locator, x, y)
    if (hit) onPickBox(hit)
  }

  return (
    <section className="ocr-pane" data-pane="image">
      <div className="ocr-pane-head">原图</div>
      {img ? (
        <div className="ocr-pane-body">
          <div className="ocr-img-wrap">
            {bin ? (
              <BinPreview ref={mediaRef as Ref<HTMLCanvasElement>} bin={bin} />
            ) : (
              <img ref={mediaRef as Ref<HTMLImageElement>} src={img.url} alt="原始简谱" data-testid="src-image" />
            )}
            {(boxes.length > 0 || activeBox) && (
              <svg
                className="ocr-overlay"
                width={img.w}
                height={img.h}
                viewBox={`0 0 ${img.w} ${img.h}`}
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
