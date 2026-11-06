// 识别启动页的「一摞纸」预览：顶层按原来的预览位置显示照片，后面的页只露白色纸边，
// 略为旋转错开；两侧箭头循环翻页（后面的页跑到最前），靠各层 transform 过渡完成。
// 不做横扫高光或半透明滑入：那会像从画面外掠过的影子，也会让两层照片深浅不一、
// 看起来像两张图拼在一起。
import type { CSSProperties } from 'react';
import type { PhotoSource } from '../adapter/joinPhotos';

export type StackPhoto = Pick<PhotoSource, 'name' | 'url' | 'w' | 'h'>;

interface Props {
  /** 已按文件名自然排序 */
  photos: ReadonlyArray<StackPhoto>;
  active: number;
  disabled?: boolean;
  onTurn: (delta: number) => void;
}

/** 各层错开的倾角：越靠后越随意，像随手放下的一叠谱纸 */
const TILTS = [0, -2.6, 2.4, -1.5, 1.7];

export function PhotoStack({ photos, active, disabled, onTurn }: Props) {
  const n = photos.length;
  // 尺寸锚固定用第一张：翻页只换顶层内容，整摞纸的位置与大小不跳动
  const anchor = photos[0]!;
  const go = (delta: number) => {
    if (disabled || n < 2) return;
    onTurn(delta);
  };
  return (
    <div className="ocr-stack">
      <div className="ocr-stack-sheets">
        {/* 流内占位：沿用单张预览的「最长边 contain」尺寸；视觉由下面绝对定位的纸页绘制 */}
        <img className="ocr-stack-anchor" src={anchor.url} alt="" aria-hidden="true" />
        {photos.map((p, i) => {
          const rawDepth = (i - active + n) % n;
          const depth = Math.min(rawDepth, 4);
          const top = rawDepth === 0;
          return (
            <div
              key={p.name}
              className={`ocr-sheet${top ? ' is-top' : ''}`}
              data-depth={depth}
              aria-hidden={!top || undefined}
              style={
                {
                  '--dx': `${depth * 11}px`,
                  '--dy': `${depth * 7}px`,
                  '--dz': `${-depth * 34}px`,
                  '--rot': `${TILTS[depth] ?? 0}deg`,
                  '--sc': 1 - depth * 0.012,
                  zIndex: n - rawDepth,
                } as CSSProperties
              }
            >
              {/* 只有顶层显示照片；后面的层就是纯白纸面，不叠第二张图 */}
              {top ? <img src={p.url} alt={`第 ${i + 1} 张：${p.name}`} draggable={false} /> : null}
              <span className="ocr-sheet-no">{i + 1}</span>
            </div>
          );
        })}
        {n > 1 ? (
          <>
            <button
              type="button"
              className="ocr-stack-arrow is-prev"
              onClick={() => go(-1)}
              disabled={disabled}
              aria-label="上一张照片"
              title="上一张（把最后一张翻到最前）"
            >
              ‹
            </button>
            <button
              type="button"
              className="ocr-stack-arrow is-next"
              onClick={() => go(1)}
              disabled={disabled}
              aria-label="下一张照片"
              title="下一张（把后面一张翻到最前）"
            >
              ›
            </button>
          </>
        ) : null}
      </div>
      <div className="ocr-stack-caption">
        <b>
          {active + 1} / {n}
        </b>
        <span>{photos[active]?.name}</span>
        <small>按文件名排序，识别顺序不变</small>
      </div>
    </div>
  );
}
