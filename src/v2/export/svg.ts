/** 记录谱面绘制指令为矢量 SVG；字体测量仍使用浏览器画布。 */
const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export class SvgCanvas {
  fillStyle = '#000';
  strokeStyle = '#000';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  lineWidth = 1;
  lineCap = 'butt';
  private transform = '';
  private elements: string[] = [];
  private path: string[] = [];
  private point: [number, number] | null = null;
  private stack: Array<{ fillStyle: string; strokeStyle: string; font: string; textAlign: string; textBaseline: string; lineWidth: number; lineCap: string; transform: string }> = [];
  private measure = document.createElement('canvas').getContext('2d')!;

  save(): void {
    const { fillStyle, strokeStyle, font, textAlign, textBaseline, lineWidth, lineCap, transform } = this;
    this.stack.push({ fillStyle, strokeStyle, font, textAlign, textBaseline, lineWidth, lineCap, transform });
  }
  restore(): void { const state = this.stack.pop(); if (state) Object.assign(this, state); }
  translate(x: number, y: number): void { this.transform += ` translate(${x} ${y})`; }
  scale(x: number, y: number): void { this.transform += ` scale(${x} ${y})`; }
  /** 绝对矩阵（SVG matrix 与 canvas setTransform 同序）；paintExportPage 依赖它定位页面 */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
  }
  private emit(element: string): void {
    this.elements.push(this.transform ? `<g transform="${this.transform.trim()}">${element}</g>` : element);
  }
  measureText(text: string): TextMetrics { this.measure.font = this.font; return this.measure.measureText(text); }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.emit(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(this.fillStyle)}"/>`);
  }
  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start';
    const baseline = this.textBaseline === 'middle' ? 'central' : this.textBaseline === 'top' ? 'text-before-edge' : 'alphabetic';
    const fit = maxWidth !== undefined && this.measureText(text).width > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
    this.emit(`<text x="${x}" y="${y}" fill="${escapeXml(this.fillStyle)}" style="font:${escapeXml(this.font)}" text-anchor="${anchor}" dominant-baseline="${baseline}"${fit}>${escapeXml(text)}</text>`);
  }
  beginPath(): void { this.path = []; this.point = null; }
  moveTo(x: number, y: number): void { this.path.push(`M${x} ${y}`); this.point = [x, y]; }
  lineTo(x: number, y: number): void { if (!this.point) this.moveTo(x, y); else { this.path.push(`L${x} ${y}`); this.point = [x, y]; } }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void { this.path.push(`Q${cx} ${cy} ${x} ${y}`); this.point = [x, y]; }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.path.push(`C${a} ${b} ${c} ${d} ${x} ${y}`); this.point = [x, y]; }
  closePath(): void { this.path.push('Z'); }
  arc(x: number, y: number, r: number, start: number, end: number, anticlockwise = false): void { this.ellipse(x, y, r, r, 0, start, end, anticlockwise); }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, anticlockwise = false): void {
    const tau = Math.PI * 2;
    let delta = end - start;
    if (!anticlockwise) delta = delta >= tau ? tau : ((delta % tau) + tau) % tau;
    else delta = delta <= -tau ? -tau : -(((-delta % tau) + tau) % tau);
    const at = (angle: number): [number, number] => [x + rx * Math.cos(angle) * Math.cos(rotation) - ry * Math.sin(angle) * Math.sin(rotation), y + rx * Math.cos(angle) * Math.sin(rotation) + ry * Math.sin(angle) * Math.cos(rotation)];
    const first = at(start);
    this.lineTo(...first);
    const pieces = Math.abs(delta) >= tau - 1e-8 ? 2 : 1;
    for (let i = 1; i <= pieces; i++) {
      const point = at(start + delta * i / pieces);
      this.path.push(`A${rx} ${ry} ${rotation * 180 / Math.PI} ${Math.abs(delta / pieces) > Math.PI ? 1 : 0} ${anticlockwise ? 0 : 1} ${point[0]} ${point[1]}`);
      this.point = point;
    }
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (!this.point) { this.moveTo(x1, y1); return; }
    const [x0, y0] = this.point;
    const a = Math.hypot(x0 - x1, y0 - y1), b = Math.hypot(x2 - x1, y2 - y1);
    if (!a || !b || !r) { this.lineTo(x1, y1); return; }
    const ux = (x0 - x1) / a, uy = (y0 - y1) / a, vx = (x2 - x1) / b, vy = (y2 - y1) / b;
    const angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (angle < 1e-8 || Math.abs(angle - Math.PI) < 1e-8) { this.lineTo(x1, y1); return; }
    const distance = r / Math.tan(angle / 2);
    this.lineTo(x1 + ux * distance, y1 + uy * distance);
    const end: [number, number] = [x1 + vx * distance, y1 + vy * distance];
    this.path.push(`A${r} ${r} 0 0 ${ux * vy - uy * vx < 0 ? 1 : 0} ${end[0]} ${end[1]}`);
    this.point = end;
  }
  fill(): void { this.emit(`<path d="${this.path.join(' ')}" fill="${escapeXml(this.fillStyle)}"/>`); }
  stroke(): void { this.emit(`<path d="${this.path.join(' ')}" fill="none" stroke="${escapeXml(this.strokeStyle)}" stroke-width="${this.lineWidth}" stroke-linecap="${this.lineCap}"/>`); }
  toSvg(width: number, height: number, title: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml(title)}</title>${this.elements.join('')}</svg>`;
  }
}
