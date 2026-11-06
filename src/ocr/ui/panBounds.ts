/**
 * 原图查看器的可平移范围（纯几何，可单测）。
 *
 * transform: translate(x,y) scale(s) 配 CSS 默认的 transform-origin: 50% 50%，
 * wrap 布局盒里的一点 (u,v) 会落在容器坐标
 *   (cx + s·(u − w/2) + x, cy + s·(v − h/2) + y)，cx/cy 是 wrap 的布局中心。
 * 令左上角能被拖到 (0,0) 得 xMax/yMax，令右下角能被拖到 (bodyW,bodyH) 得
 * xMin/yMin。scale=1 时居中短图的两个界反过来，收成 [0,0] 禁拖；顶对齐长图
 * 则自然得到 [−overflowY, 0]。放大后 xMax/yMax 变正，左缘被推出去也能拖回来。
 *
 * 参数都是**布局盒**（offsetLeft/Top/Width/Height），不含 transform。
 */
export function panBounds(
  scale: number,
  bodyW: number,
  bodyH: number,
  wl: number,
  wt: number,
  w: number,
  h: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const cx = wl + w / 2;
  const cy = wt + h / 2;
  let xMax = scale * w / 2 - cx;
  let xMin = bodyW - cx - scale * w / 2;
  let yMax = scale * h / 2 - cy;
  let yMin = bodyH - cy - scale * h / 2;
  if (xMin > xMax) { xMin = 0; xMax = 0; }
  if (yMin > yMax) { yMin = 0; yMax = 0; }
  return { xMin, xMax, yMin, yMax };
}
