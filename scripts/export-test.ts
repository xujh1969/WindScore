/** 导出相关测试（纯计算部分，不需要 canvas） */
import { planPages, buildPdf, pdfTextString, A4_PT } from '../src/v2/export/pdf';
import { a4Geometry, planExport, safeFileName } from '../src/v2/export/tasks';
import { videoGeometry, VIDEO_RATIOS as RATIOS, videoCanvasSize as canvasSize } from '../src/v2/export/video';
import { estimateBitrate, planCodecs } from '../src/v2/export/encode';
import { mixStems, peakOf, synthNotes, type PcmSource } from '../src/v2/export/mix';


import { parseDsl } from '../src/v2/dsl';
import { buildTimeline, timelineTicks } from '../src/v2/timeline';
import { constantTempo } from '../src/v2/tempo';
import type { LayoutResult } from '../src/v2/layout';
import { lineTickRanges, recordSeconds, scrollTargetY, type VideoRatio } from '../src/v2/export/video';
import { buildStrip, scrollTargetX, stripTickRanges } from '../src/v2/export/strip';
import { layoutScore } from '../src/v2/layout';
import { TICKS_PER_BEAT } from '../src/v2/types';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/** PDF 里混着 JPEG 二进制，按 latin1 逐字节转字符串才能用正则找结构 */
const latin1 = (u: Uint8Array): string => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return s;
};

console.log('[导出 · 分页]');
{
  // 30 行、行高 86、每页能放 7 行（带高 700）
  const ys = Array.from({ length: 30 }, (_, i) => 50 + i * 86);
  const band = { top: 0, bottom: 700 };
  const pages = planPages(ys, 86, band, band);
  const flat = pages.flatMap((p) => ys.slice(p.from, p.to));
  check('分页后总行数不变', flat.length === ys.length, `${flat.length} / ${ys.length}`);
  check('分页不重不漏且顺序正确', flat.every((y, i) => y === ys[i]));
  check('首页确实装不下 30 行', pages.length > 1, `${pages.length} 页`);
  check(
    '换页后首行上沿精确落在带顶',
    pages
      .slice(1)
      .every((p) => Math.abs(ys[p.from]! - p.offset - 86 / 2 - 6 - band.top) < 0.001),
    JSON.stringify(pages.slice(1, 3)),
  );
  check(
    '每页末行都在带底之上',
    pages.every((p) => ys[p.to - 1]! - p.offset + 86 / 2 + 6 <= band.bottom + 0.001),
    JSON.stringify(pages.map((p) => [ys[p.from], ys[p.to - 1], p.offset])),
  );
  check(
    '每页首行不会伸到页边之上',
    pages.slice(1).every((p) => ys[p.from]! - p.offset - 86 / 2 - 6 >= band.top - 0.001),
  );

  // 单行就高过整页：不能开空白页，也不能死循环
  const tall = planPages([40, 3000], 86, band, band);
  check('单行高过整页时不产生空白页', tall.every((p) => p.to > p.from), JSON.stringify(tall));
  check('高行也被收了进去', tall.reduce((n, p) => n + (p.to - p.from), 0) === 2);
  check('空谱面不产生页', planPages([], 86, band, band).length === 0);
}

console.log('[导出 · PDF 字节]');
{
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  const pdf = buildPdf(
    [
      { jpeg, width: 1240, height: 1754 },
      { jpeg, width: 1240, height: 1754 },
      { jpeg, width: 1240, height: 1754 },
    ],
    A4_PT.w,
    A4_PT.h,
    { title: '灰姑娘' },
  );
  const text = latin1(pdf);
  check('文件头是 %PDF-1.4', text.startsWith('%PDF-1.4'));
  check('结尾有 %%EOF', text.trimEnd().endsWith('%%EOF'));

  // 页树必须指向 **Page** 对象。踩过的坑：Kids 里塞的是位图 XObject，
  // 全文没有一个 /Type /Page —— 查看器按规范找不到页，打开就是一片空白。
  check('三页三个 /Type /Page 对象', (text.match(/\/Type \/Page[^s]/g) ?? []).length === 3);
  const kids = /\/Type \/Pages \/Kids \[([^\]]*)\]/.exec(text)?.[1] ?? '';
  const kidNums = kids.trim().split(/\s+(?=\d+ 0 R)/).map((s) => Number(/^(\d+)/.exec(s)?.[1]));
  check('Kids 恰好三个条目', kidNums.length === 3, kids);
  check(
    'Kids 指向的都是 /Type /Page 对象',
    kidNums.every((n) => new RegExp(`\\n${n} 0 obj\\n<< /Type /Page `).test(text)),
    kids,
  );
  check(
    '每个 Page 有 MediaBox / Resources / Contents',
    kidNums.every((n) => {
      const body = new RegExp(`\\n${n} 0 obj\\n(.*?)\\nendobj`, 's').exec(text)?.[1] ?? '';
      return (
        /\/MediaBox \[0 0 [\d.]+ [\d.]+\]/.test(body) &&
        /\/Resources << \/XObject << \/Im0 \d+ 0 R >> >>/.test(body) &&
        /\/Contents \d+ 0 R/.test(body) &&
        /\/Parent 2 0 R/.test(body)
      );
    }),
    kidNums.join(','),
  );
  check('三页三个位图对象', (text.match(/\/Subtype \/Image/g) ?? []).length === 3);
  check('JPEG 直接内嵌（DCTDecode）', text.includes('/Filter /DCTDecode'));
  // 中文歌名按 UTF-16BE + BOM 的十六进制写进 /Title
  check('中文标题进了文档信息', text.includes(`/Title ${pdfTextString('灰姑娘')}`), pdfTextString('灰姑娘'));
  // 𝄋 是代理对：D834 DD0B，两个 UTF-16 码元共 8 个十六进制字符
  check('代理对也正确展开（𝄋 之类）', pdfTextString('𝄋') === '<FEFFD834DD0B>', pdfTextString('𝄋'));
  check('位图按页宽铺满', text.includes(`q ${A4_PT.w} 0 0 ${A4_PT.h} 0 0 cm /Im0 Do Q`));
  check('内嵌字节长度与实际一致', text.includes(`/Length ${jpeg.length} >>\nstream\n`));

  // xref 的每个偏移都要真的指着「N 0 obj」——最容易写错、也最致命的地方
  const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1] ?? -1);
  check('startxref 指向 xref 表', startxref > 0 && text.slice(startxref, startxref + 4) === 'xref');
  const table = text.slice(startxref).split('\n');
  const size = Number(/\/Size (\d+)/.exec(text)?.[1] ?? 0);
  check('xref 条目数 = /Size', table.filter((l) => / \d{5} n $/.test(l)).length === size - 1);
  let xrefOk = true;
  let bad = '';
  for (let n = 1; n < size; n += 1) {
    const off = Number(table[2 + n]?.slice(0, 10) ?? NaN);
    if (!text.slice(off).startsWith(`${n} 0 obj`)) {
      xrefOk = false;
      bad = `#${n} → ${JSON.stringify(text.slice(off, off + 12))}`;
      break;
    }
  }
  check('xref 每条偏移都指到对应对象', xrefOk, bad);

  // 查看器真正会做的事：把全文的 `N 0 R` 引用逐个解析到已定义的对象。
  // 页树指错对象（Kids 塞图片而不是 Page）就是靠这条抓到的。
  const defined = new Set<number>();
  for (let n = 1; n < size; n += 1) {
    const off = Number(table[2 + n]?.slice(0, 10) ?? NaN);
    if (text.slice(off).startsWith(`${n} 0 obj`)) defined.add(n);
  }
  const refs = [...text.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const dangling = [...new Set(refs.filter((r) => !defined.has(r)))];
  check('所有间接引用都能解析（无悬空引用）', dangling.length === 0, dangling.join(','));
}

console.log('[导出 · 谱面切页]');
{
  const score = parseDsl('@beat 4/4\n\n1 2 3 4 | 5 6 5 6 | 1 2 3 4 | 5 6 5 6 ||\n').score!;
  const geo = a4Geometry(false, 150, 1.55);
  check('A4 纵向比例正确', Math.abs(geo.pageW / geo.pageH - A4_PT.w / A4_PT.h) < 0.01);
  check('A4 横向宽高互换', a4Geometry(true, 150, 1.55).pageW === geo.pageH);
  const { layout, plans } = planExport(score, geo, true);
  check('排出多行', layout.lines.length > 1, `${layout.lines.length} 行`);
  const covered = plans.flatMap((p) => Array.from({ length: p.to - p.from }, (_, i) => p.from + i));
  check(
    '切页覆盖每一行且不重复',
    covered.length === layout.lines.length && covered.every((v, i) => v === i),
    `${covered.length} / ${layout.lines.length}`,
  );
  check('首页偏移非负（标题不会被推到页外）', plans.length > 0 && plans[0]!.offset >= 0);
  // 字号缩放越大，每页行数越少 → 页数变多
  const small = planExport(score, a4Geometry(false, 150, 1.2), true).plans.length;
  const big = planExport(score, a4Geometry(false, 150, 2.2), true).plans.length;
  check('字号越大页数越多', big >= small, `${small} → ${big}`);
}

console.log('[导出 · 视频比例]');
{
  // 九档比例：竖屏短边=宽，横屏短边=高，方形两边相等（短边 1080）
  const cases: [VideoRatio, number, number][] = [
    ['r9x16', 1080, 1080, 1920],
    ['r16x9', 1080, 1920, 1080],
    ['r16x10', 1080, 1728, 1080],
    ['r10x16', 1080, 1080, 1728],
    ['r4x3', 1080, 1440, 1080],
    ['r3x4', 1080, 1080, 1440],
    ['r3x2', 1080, 1620, 1080],
    ['r2x3', 1080, 1080, 1620],
    ['r1x1', 1080, 1080, 1080],
  ];
  check(
    '九档比例的画布尺寸都对',
    cases.every(([r, side, w, h]) => {
      const s = canvasSize(r, side);
      return s.w === w && s.h === h;
    }),
    JSON.stringify(cases.map(([r, s]) => [r, canvasSize(r, s)])),
  );
  check(
    '宽高都是偶数（H.264 要求）',
    RATIOS.every((r) =>
      [720, 1080, 1440].every((s) => {
        const c = canvasSize(r.id, s);
        return c.w % 2 === 0 && c.h % 2 === 0;
      }),
    ),
  );

  // 编码协商：mp4 优先，声音必须跟容器配套（mp4+AAC / webm+Opus）
  const all = { avc: true, aac: true, vp9: true, vp8: true, opus: true };
  check('全都有 → mp4 + avc + aac', JSON.stringify(planCodecs(all, true)) === JSON.stringify({ container: 'mp4', video: 'avc', audio: 'aac' }), JSON.stringify(planCodecs(all, true)));
  check('无声时也要 mp4（avc + 无音轨）', planCodecs(all, false)?.audio === null);
  check('没有 aac → 退 webm + opus', JSON.stringify(planCodecs({ ...all, aac: false }, true)) === JSON.stringify({ container: 'webm', video: 'vp9', audio: 'opus' }));
  check('只有 vp8 → webm 仍可用', planCodecs({ avc: false, aac: false, vp9: false, vp8: true, opus: true }, true)?.video === 'vp8');
  check('无声 + 只有 vp8 → webm 无音轨', planCodecs({ avc: false, aac: false, vp9: false, vp8: true, opus: false }, false)?.container === 'webm');
  check('要声音但只剩「有画面没声音」的组合 → 明确失败', planCodecs({ avc: true, aac: false, vp9: true, vp8: true, opus: false }, true) === null);
  check('什么都没有 → null', planCodecs({ avc: false, aac: false, vp9: false, vp8: false, opus: false }, false) === null);
  check('码率随分辨率上升', estimateBitrate(1920, 1080, 30) > estimateBitrate(640, 360, 30));
  check('码率有上下限', estimateBitrate(320, 240, 15) >= 1.5e6 && estimateBitrate(7680, 4320, 60) <= 16e6);

  const vg = videoGeometry('r9x16', 1080);
  check('视频版面按画布尺寸给', vg.geo.pageW === 1080 && vg.geo.pageH === 1920);
  check('视频字号随短边放大', vg.geo.scale > 1.4 && vg.geo.scale < 1.9, String(vg.geo.scale));
  check('文件名去掉非法字符', safeFileName('灰姑娘/复:印') === '灰姑娘_复_印', safeFileName('灰姑娘/复:印'));
}

console.log('[导出 · 滚动跟随]');
{
  // 假版面：3 行，行距 86
  const layout = {
    lines: [
      { y: 50, items: [{ eventId: 'a' }] },
      { y: 136, items: [{ eventId: 'b' }] },
      { y: 222, items: [{ eventId: 'c' }] },
    ],
  } as unknown as LayoutResult;
  const timeline = [
    { eventId: 'a', startTick: 0, endTick: 100, midi: 60 },
    { eventId: 'b', startTick: 100, endTick: 200, midi: 62 },
    { eventId: 'c', startTick: 200, endTick: 300, midi: 64 },
  ] as never;
  const ranges = lineTickRanges(layout, timeline);
  check('三行都映射到时间区间', ranges.length === 3, JSON.stringify(ranges));
  check('区间首尾相接不留缝', ranges[0]!.from === 0 && ranges[1]!.from === 100 && ranges[2]!.to === 300);

  const h = 200;
  check('开头不滚（内容还没超过屏高）', scrollTargetY(ranges, 0, 1, h, 86) === 0);
  check('第二行滚到屏上 38% 处', Math.abs(scrollTargetY(ranges, 100, 1, h, 86) - 60) < 0.01);
  // 行内插值：走到本行一半时应当比行首低一点点，滚动看起来才连续
  const mid = scrollTargetY(ranges, 150, 1, h, 86);
  check('行内按进度插值', mid > 60 && mid < 90, String(mid));
  check('缩放越大滚得越远', scrollTargetY(ranges, 200, 2, h, 86) > scrollTargetY(ranges, 200, 1, h, 86));
  check('没有版面就不滚', scrollTargetY([], 100, 1, h, 86) === 0);
}

console.log('[导出 · 时长]');
{
  const score = parseDsl('@beat 4/4\n@tmp 120\n1 2 3 4 | 1 2 3 4 ||\n').score!;
  const timeline = buildTimeline(score);
  const synth = recordSeconds({
    timeline,
    fromTick: 0,
    bpm: 120,
    tempo: null,
    stems: [],
    audio: 'synth',
  });
  // 120 BPM 两小节 = 4 秒，再加 0.4 秒尾巴
  check('合成音时长 = 谱长 + 尾巴', Math.abs(synth - 4.4) < 0.01, String(synth));
  check(
    '静音时长同合成音',
    recordSeconds({ timeline, fromTick: 0, bpm: 120, tempo: null, stems: [], audio: 'none' }) ===
      synth,
  );
  // 音频模式以音频放完为准：给一条 10 秒的 stem，就是 10 秒而不是谱长
  const stemSec = recordSeconds({
    timeline,
    fromTick: 0,
    bpm: 120,
    tempo: constantTempo(120, 0, 0),
    stems: [{ buffer: { duration: 10 } as never, gain: 1 }],
    audio: 'stems',
  });
  check('音频模式以音频长度为准', Math.abs(stemSec - 10.4) < 0.01, String(stemSec));
  check(
    '没 tempo 就退回谱长（不会崩）',
    recordSeconds({
      timeline,
      fromTick: 0,
      bpm: 120,
      tempo: null,
      stems: [{ buffer: { duration: 10 } as never, gain: 1 }],
      audio: 'stems',
    }) === synth,
  );

  // 只录一段：录制是 1× 实时的，段落选择是唯一能立刻少等几倍的办法
  // TICKS_PER_BEAT=48、4/4 → 一小节 192 tick；120 BPM → 96 tick/秒 → 192 tick = 2 秒
  const tp = constantTempo(120, 0, 0);
  const whole = timelineTicks(timeline);
  check(
    '指定 toTick：只算那一段（第二小节 = 2 秒）',
    Math.abs(
      recordSeconds({
        timeline,
        fromTick: whole / 2,
        toTick: whole,
        bpm: 120,
        tempo: tp,
        stems: [],
        audio: 'synth',
      }) - 2.4,
    ) < 0.01,
    String(
      recordSeconds({
        timeline,
        fromTick: whole / 2,
        toTick: whole,
        bpm: 120,
        tempo: tp,
        stems: [],
        audio: 'synth',
      }),
    ),
  );
  check(
    '选了段落就以 tick 为界（不再被谱长/音频长度截断）',
    Math.abs(
      recordSeconds({
        timeline,
        fromTick: 0,
        toTick: whole / 2, // 2 秒
        bpm: 120,
        tempo: tp,
        stems: [{ buffer: { duration: 10 } as never, gain: 1 }],
        audio: 'stems',
      }) - 2.4,
    ) < 0.01,
    String(
      recordSeconds({
        timeline,
        fromTick: 0,
        toTick: whole / 2,
        bpm: 120,
        tempo: tp,
        stems: [{ buffer: { duration: 10 } as never, gain: 1 }],
        audio: 'stems',
      }),
    ),
  );
  check(
    'toTick 早于 fromTick 也不会崩（钳到 0.1 秒）',
    recordSeconds({
      timeline,
      fromTick: whole,
      toTick: whole / 2,
      bpm: 120,
      tempo: tp,
      stems: [],
      audio: 'synth',
    }) === 0.5,
  );
}

console.log('[导出 · 离线混音]');
{
  // 假 AudioBuffer：全 1 的直流信号，方便验增益与偏移
  const dc = (n: number): PcmSource => ({
    numberOfChannels: 1,
    length: n,
    sampleRate: 1000,
    getChannelData: () => new Float32Array(n).fill(1),
  });

  const m = mixStems({ stems: [{ buffer: dc(1000), gain: 0.5 }], durationSec: 1, sampleRate: 1000 });
  check('混音长度 = 时长 × 采样率', m.length === 1000 && m.channels.length === 2, String(m.length));
  check('单声道 stem 复制到两声道', m.channels[0]![10] === 0.5 && m.channels[1]![10] === 0.5, String(m.channels[0]![10]));

  // 只录第 40 小节起：伴奏要从 startSec 处开始（前面几十秒要剪掉）
  const off = mixStems({
    stems: [{ buffer: dc(1000), gain: 1 }],
    durationSec: 0.5,
    sampleRate: 1000,
    offsetSec: 0.25,
  });
  check('offsetSec 之前是静音（伴奏前段被剪掉）', off.channels[0]![0] === 0 && off.channels[0]![200] === 0);
  check('offsetSec 之后才有声音', off.channels[0]![300] === 1, String(off.channels[0]![300]));

  const mute = mixStems({ stems: [{ buffer: dc(100), gain: 0 }], durationSec: 0.1, sampleRate: 1000 });
  check('gain 0 的 stem 被跳过（静音轨不进混音）', peakOf(mute) === 0, String(peakOf(mute)));

  const over = mixStems({ stems: [{ buffer: dc(1000), gain: 1 }], durationSec: 0.2, sampleRate: 1000 });
  check('伴奏比目标长时截断，不越界', over.length === 200 && over.channels[0]![199] === 1);

  // 合成音：三角波 + 包络
  const s = synthNotes({ notes: [{ startSec: 0.5, endSec: 1, midi: 69 }], durationSec: 2, sampleRate: 8000 });
  check('合成音：起点之前静音', s.channels[0]![100] === 0);
  check('合成音：音内非零', peakOf(s) > 0.05, String(peakOf(s)));
  check('合成音：包络渐入（前 1ms 明显小于中段）', s.channels[0]![4000]! < Math.abs(s.channels[0]![6000]!));
  check('合成音：音结束后静音', s.channels[0]![8100] === 0);
  const short = synthNotes({ notes: [{ startSec: 0, endSec: 0.001, midi: 60 }], durationSec: 0.5, sampleRate: 8000 });
  check('极短的音也有 60ms 尾巴（不会被吃掉）', peakOf(short) > 0, String(peakOf(short)));
  const over2 = synthNotes({ notes: [{ startSec: 5, endSec: 6, midi: 60 }], durationSec: 1, sampleRate: 8000 });
  check('超出时长的音被丢掉（不会越界写）', peakOf(over2) === 0, String(peakOf(over2)));
  const two = synthNotes({
    notes: [
      { startSec: 0, endSec: 1, midi: 60 },
      { startSec: 0, endSec: 1, midi: 67 },
    ],
    durationSec: 1,
    sampleRate: 8000,
  });
  check('同刻两个音叠加（和声不会被覆盖）', peakOf(two) > 0.15, String(peakOf(two)));
}

console.log('\n[视频 · 横向长条（strip）]');
{
  const { score } = parseDsl('@title 条\n@key 1=C\n@beat 4/4\n@bpm 96\n\n1 2 3 4 | 5 6 7 1^ | 2 3 4 5 | 6 6 5 4 ||');
  const layout = layoutScore(score, { contentWidth: 600 });
  const strip = buildStrip(layout);
  check('单声部长条行数不变（每行横向接续）', strip.layout.lines.length === layout.lines.length);
  check('长条宽 = 各行拼接（≥ 原行宽）', strip.width >= layout.width, `${strip.width} vs ${layout.width}`);
  check('长条高约等于一行高', Math.abs(strip.height - layout.lineHeight * 2) < layout.lineHeight, `${strip.height} vs ${layout.lineHeight}`);
  check('title 清空（不重复画标题）', strip.layout.title === null);
  // 多声部：构造 systems 把两行并成一个系统
  const ensLayout: LayoutResult = {
    ...layout,
    lines: [layout.lines[0], { ...layout.lines[1], y: layout.lines[0].y + layout.lineHeight }],
    systems: [{ from: 0, to: 2, top: 0, bottom: 0, bracketX: 0 }],
  };
  const ens = buildStrip(ensLayout);
  check('两行同系统 → 拼成一组', ens.layout.lines.length === 2);
  check(
    '组内上下相对位置保留',
    Math.abs((ens.layout.lines[1].y - ens.layout.lines[0].y) - layout.lineHeight) < 1,
  );
  // tick → x 映射与滚动
  const tl = buildTimeline(score, constantTempo(96, 0, 0));
  const ranges = stripTickRanges(strip.layout, tl);
  check('时间线条目都能映射到长条 x', ranges.length >= 8, String(ranges.length));
  check('x 随音乐单调不减', ranges.every((r, i) => i === 0 || r.x >= ranges[i - 1].x));
  // 等宽拼接：相邻两行首项 x 的差恒定（= layout.width + 间隔）
  const starts = strip.layout.lines.map((ln) => ln.items[0]?.x ?? 0);
  const deltas = starts.slice(1).map((x, i) => x - starts[i]);
  check(
    '系统间隔严格恒定',
    deltas.every((d) => Math.abs(d - deltas[0]) < 0.5),
    deltas.map((d) => Math.round(d)).join(','),
  );
  const x0 = scrollTargetX(ranges, 0, 2, 800, strip.width);
  const xEnd = scrollTargetX(ranges, timelineTicks(tl), 2, 800, strip.width);
  check('起点滚动为 0', x0 === 0, String(x0));
  check('终点钳到长条末端', xEnd <= strip.width * 2 - 800 + 1, `${xEnd} vs max ${strip.width * 2 - 800}`);
  const xMid = scrollTargetX(ranges, timelineTicks(tl) / 2, 2, 800, strip.width);
  check('中段滚动位置在起点与终点之间', xMid >= x0 && xMid <= xEnd, String(xMid));
}

console.log(failed === 0 ? '\n导出测试全部通过' : `\n导出测试失败 ${failed} 项`);
if (failed > 0) process.exit(1);
