import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { parseDsl } from '../../src/v2/dsl';
import { layoutScore } from '../../src/v2/layout';
import { DARK_THEME, LIGHT_THEME, paintLayout } from '../../src/v2/paint';

GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'Microsoft YaHei');
const output = 'artifacts/video-layout-samples';
mkdirSync(output, { recursive: true });
const parsed = parseDsl(readFileSync('music/青花瓷/青花瓷.jps', 'utf8'));
if (!parsed.score) throw new Error('青花瓷曲谱无法解析');
const score = parsed.score;
const ratios = [
  { id: '9x16', w: 1080, h: 1920, device: '手机竖屏' },
  { id: '16x9', w: 1920, h: 1080, device: '手机横屏' },
  { id: '4x3', w: 1440, h: 1080, device: '平板横屏' },
  { id: '3x4', w: 1080, h: 1440, device: '平板竖屏' },
  { id: '16x10', w: 1728, h: 1080, device: '安卓平板横屏' },
  { id: '1x1', w: 1080, h: 1080, device: '方形画面' },
];
const configs = [
  { id: 'A', label: '紧凑', fontPx: 32, unit: 0.28, gap: -4 },
  { id: 'B', label: '均衡', fontPx: 38, unit: 0.35, gap: -6 },
  { id: 'C', label: '大字紧排', fontPx: 44, unit: 0.42, gap: -8 },
];
const results: any[] = [];
const boards: string[] = [];
for (const ratio of ratios) {
  const rendered: any[] = [];
  for (const config of configs) {
    const scale = config.fontPx / 21;
    const margin = 36;
    const header = 124;
    const layout = layoutScore(score, {
      contentWidth: (ratio.w - margin * 2) / scale,
      fontSize: 21, unit: config.unit, letterSpacing: config.gap,
      showTitle: false, padding: 0,
    });
    const visibleLines = layout.lines.filter(line => header + (line.y + layout.lineHeight / 2) * scale <= ratio.h - 32);
    const bars = visibleLines.map(line => line.items.filter(it => it.kind === 'barline').length);
    for (const light of config.id === 'B' ? [false, true] : [false]) {
      const theme = light ? LIGHT_THEME : DARK_THEME;
      const canvas = createCanvas(ratio.w, ratio.h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, ratio.w, ratio.h);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, header, ratio.w, ratio.h - header - 32); ctx.clip();
      ctx.translate(margin, header); ctx.scale(scale, scale);
      paintLayout(ctx as any, layout, theme, { height: ratio.h / scale, showMeasureNumbers: true, showTitleEdit: false });
      ctx.restore();
      ctx.fillStyle = theme.ink;
      ctx.font = 'bold 32px "Microsoft YaHei"';
      ctx.fillText(`${ratio.id} · ${config.id} ${config.label} · 青花瓷`, margin, 44);
      ctx.font = '23px "Microsoft YaHei"';
      ctx.fillStyle = theme.muted;
      ctx.fillText(`数字字号 ${config.fontPx}px / ${ratio.w}px宽 · ${ratio.device}`, margin, 79);
      ctx.fillText(`完整行小节数：${bars.slice(0, 6).join(' / ')} · 请全屏查看`, margin, 109);
      const name = `${ratio.id}-${config.id}${light ? '-light' : ''}.png`;
      writeFileSync(join(output, name), canvas.toBuffer('image/png'));
      results.push({ file: name, ratio: ratio.id, device: ratio.device, width: ratio.w, height: ratio.h, ...config, light, scale, visibleBars: bars });
      if (!light) rendered.push(canvas);
    }
  }
  const boardW = 1260;
  const thumbW = 404;
  const thumbH = Math.round(thumbW * ratio.h / ratio.w);
  const board = createCanvas(boardW, thumbH + 70);
  const ctx = board.getContext('2d');
  ctx.fillStyle = '#25262a'; ctx.fillRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#f5f5f5'; ctx.font = '28px "Microsoft YaHei"';
  ctx.fillText(`${ratio.device} ${ratio.id}：A 紧凑 / B 均衡 / C 大字紧排（请原图核验）`, 12, 42);
  rendered.forEach((canvas, i) => ctx.drawImage(canvas, 12 + i * 416, 62, thumbW, thumbH));
  const name = `${ratio.id}-compare.png`;
  writeFileSync(join(output, name), board.toBuffer('image/png'));
  boards.push(name);
}
writeFileSync(join(output, 'configurations.json'), JSON.stringify(results, null, 2));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>简谱视频设备样张</title><style>body{background:#17181b;color:#eee;font:16px system-ui;margin:24px;max-width:1100px}a{color:#e6c05e}img{max-width:100%;height:auto}section{margin:40px 0}p{line-height:1.7}</style><h1>简谱视频设备样张</h1><p>以《青花瓷》的真实简谱绘制。每种比例有 A 紧凑、B 均衡、C 大字；B 另有浅色版。样张只用于选择，不修改软件的默认配置。</p><p>请将单张 PNG 原图保存到手机或平板，横竖方向与文件对应，隐藏查看器工具条，先适应屏幕查看，不要放大。比较图只便于初选，三栏缩略图不能判断真实字号。数字字号是成品像素值，不是设备上的毫米大小。</p>${ratios.map(r => `<section><h2>${r.device} ${r.id}</h2><img src="${r.id}-compare.png"><p>${results.filter(x => x.ratio === r.id).map(x => `<a href="${x.file}" download>${x.id}${x.light ? ' 浅色' : ''} 原图</a>`).join(' · ')}</p></section>`).join('')}<h2>反馈方式</h2><p>请记录设备型号、屏幕尺寸、查看方向、配置编号，例如：手机竖屏 9x16-B，平板横屏 4x3-C。再说明音符、八度点、减时线、倚音是否清楚，间距是否拥挤，每行信息量是否足够。密集乐句可能自然只有一个小节；不应为了固定小节数把字号压得无法阅读。最终可按设备选择配置，而非强制所有比例共用一个布局。</p></html>`;
writeFileSync(join(output, 'index.html'), html);
console.log(JSON.stringify(results.filter(x => !x.light).map(x => ({file:x.file, font:x.fontPx, bars:x.visibleBars})), null, 2));
