#!/usr/bin/env node
/**
 * json2jps —— 把分段识别的结构化 JSON 转成 .jps 文本。
 *
 * 为什么不让模型直接写 .jps：模型只负责「看」（识别音高 / 时值），
 * 语法正确性全部由本脚本保证——模型输出非法 token 是语法漂移，
 * 输出非法 JSON 会被这里明确拒绝，并指出是哪一小节哪个字段。
 *
 * 用法：
 *   node tools/json2jps.mjs 谱面.json 输出.jps   # 推荐带输出路径：直接以 UTF-8 落盘
 *   node tools/json2jps.mjs 谱面.json            # 不带输出路径则打印到 stdout
 *   （PowerShell 的 > 重定向会写成 UTF-16 导致乱码，所以一定要带输出路径）
 *
 * 退出码：0 = 小节拍数全部对上；1 = 有拍数 / 字段问题
 *（问题清单在 stderr，逐条注明「小节 N 差多少拍」——按提示回去重读对应小节即可）
 *
 * JSON schema（字段名尽量短，减少模型输出量；详见 tools/README.md）：
 * {
 *   "meta": { "title": "曲名", "key": "1=C", "beat": "4/4", "bpm": 90, "patch": 73 },
 *   "measures": [
 *     {
 *       "partial": false,       // 弱起小节（只允许第一个小节）
 *       "notes": [
 *         {
 *           "d": 5,             // 音级 1-7；0=休止；8=隐藏休止（占位不画）
 *           "dur": 1,           // 时值（拍）：1 / 2 / 3 / 4 / 1.5 / 1.75 / 0.5 / 0.25 / 0.125 / 1/3 / 1/6 / 0.75
 *           "oct": 0,           // 八度：正数=高音点个数，负数=低音点个数
 *           "acc": "",          // 变音记号："#" / "b" / "♮" / ""
 *           "tie": false,       // 延音线连到下一颗音（下一颗须同音高）
 *           "slur": "",         // 连音线："open"=弧线从这颗开始，"close"=在这颗结束
 *           "graceBefore": [],  // 前倚音：[{ "d": 6, "oct": 0, "acc": "" }, …]
 *           "graceAfter": [],   // 后倚音
 *           "text": "",         // 段落文字标注（如 "前奏"）→ (前奏)
 *           "parenOpen": false, // 左括号记号 → （
 *           "parenClose": false // 右括号记号 → ）
 *         }
 *       ],
 *       "meterAfter": "",       // 本小节结束后改拍号，如 "3/4"
 *       "breakAfter": ""        // "line"=换行，"page"=分页
 *     }
 *   ]
 * }
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TICKS = 48; // 每拍 tick 数（与程序一致；只用于时值对账，不进输出）
const issues = [];
const fail = (msg) => issues.push(msg);

/** 变音记号归一：♯♭ 字形转 # b */
const accMark = (a) => (a === '♯' ? '#' : a === '♭' ? 'b' : a);

/** 八度点标记：正数 ^、负数 v */
function octMarks(oct, where) {
  if (oct === undefined || oct === null) return '';
  if (!Number.isInteger(oct) || oct < -3 || oct > 3) {
    fail(`${where}：八度 oct 必须是 -3..3 的整数，得到 ${JSON.stringify(oct)}`);
    return '';
  }
  return oct > 0 ? '^'.repeat(oct) : 'v'.repeat(-oct);
}

/**
 * 时值（拍）→ token 后缀（附点 + 除法 + 增时线）。
 * 枚举全部合法组合找精确匹配，选记号最少的写法——
 * 模型只需要给出拍数，不用猜「1.5 拍该写成 5. 还是别的」。
 */
function durSuffix(beats, where) {
  const target = Math.round(Number(beats) * TICKS * 1000) / 1000;
  if (!Number.isFinite(target) || target <= 0) {
    fail(`${where}：时值 dur 必须是正数（拍），得到 ${JSON.stringify(beats)}`);
    return null;
  }
  let best = null;
  for (const div of [0, 2, 3, 4, 6, 8]) {
    const base = div === 0 ? TICKS : TICKS / div;
    for (let dots = 0; dots <= 2; dots += 1) {
      const withDots = base * (1 + 0.5 * dots);
      for (let dashes = 0; dashes <= 3; dashes += 1) {
        const t = withDots + dashes * TICKS;
        if (Math.abs(t - target) < 1e-6) {
          const cost = (div ? 1 : 0) + dots * 2 + dashes;
          if (!best || cost < best.cost) best = { div, dots, dashes, cost };
        }
      }
    }
  }
  if (!best) {
    fail(
      `${where}：时值 ${beats} 拍没有合法写法。可用值：1 / 2 / 3 / 4 / 1.5 / 1.75 / 0.5 / 0.25 / 0.125 / 1/3 / 1/6 / 0.75（拍）`,
    );
    return null;
  }
  return '.'.repeat(best.dots) + (best.div ? `/${best.div}` : '') + '-'.repeat(best.dashes);
}

/** 单颗音的 token；d=0/8（休止）不允许变音 / 八度 / 延音线 */
function noteToken(n, where) {
  const d = n.d;
  if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(d)) {
    fail(`${where}：音级 d 必须是 0-8（0=休止，8=隐藏休止），得到 ${JSON.stringify(d)}`);
    return null;
  }
  const isRest = d === 0 || d === 8;
  if (isRest && (n.acc || n.oct || n.tie)) {
    fail(`${where}：休止符（d=0/8）不能带变音记号、八度点或延音线`);
  }
  const suffix = durSuffix(n.dur, where);
  if (suffix === null) return null;
  const acc = isRest ? '' : accMark(n.acc ?? '');
  const oct = isRest ? '' : octMarks(n.oct, where);
  const tie = isRest ? '' : n.tie ? '~' : '';
  return `${acc}${d}${oct}${suffix}${tie}`;
}

/** 倚音数组 → {5} / {65}（连写不加空格） */
function graceToken(list, where) {
  if (!Array.isArray(list) || list.length === 0) return '';
  if (list.length > 3) fail(`${where}：倚音最多 3 颗`);
  const inner = list
    .map((g, i) => {
      if (!g || ![1, 2, 3, 4, 5, 6, 7].includes(g.d)) {
        fail(`${where}：倚音第 ${i + 1} 颗音级 d 必须是 1-7，得到 ${JSON.stringify(g?.d)}`);
        return '';
      }
      return `${accMark(g.acc ?? '')}${g.d}${octMarks(g.oct, where)}`;
    })
    .join('');
  return `{${inner}}`;
}

const slurWrap = (slur, body) =>
  slur === 'open' ? `(${body}` : slur === 'close' ? `${body})` : body;

// ── 读入 ──
const file = process.argv[2];
if (!file) {
  console.error('用法：node tools/json2jps.mjs 谱面.json');
  process.exit(2);
}
let data;
try {
  data = JSON.parse(readFileSync(file, 'utf-8'));
} catch (e) {
  console.error(`JSON 解析失败（模型输出的不是合法 JSON）：${e.message}`);
  process.exit(1);
}

const meta = data.meta ?? {};
const measures = data.measures ?? [];
if (!Array.isArray(measures) || measures.length === 0) {
  console.error('measures 为空：至少要有一个小节');
  process.exit(1);
}
if (meta.beat && !/^\d+\/\d+$/.test(meta.beat)) fail(`meta.beat 应为 N/M 形式，得到 ${JSON.stringify(meta.beat)}`);

// 每小节拍数（以四分音符为一拍）：4/4=4、3/4=3、6/8=3（与程序 meter/layout 同口径）
// 每小节拍数（以四分音符为一拍）：4/4=4、3/4=3、6/8=3（与程序 meter/layout 同口径）
const beatsPerMeasure = (m) => {
  const [n, d] = String(m).split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 4;
  return n * (4 / d);
};
let firstPartial = false;

// ── 逐小节转写 + 拍数对账 ──
const measureTexts = [];
let expected = meta.beat ? beatsPerMeasure(meta.beat) : 4;
let hasIssueBefore = false;

for (let i = 0; i < measures.length; i += 1) {
  const m = measures[i] ?? {};
  const toks = [];
  let sum = 0;
  (m.notes ?? []).forEach((n, j) => {
    const where = `小节 ${i + 1} 第 ${j + 1} 音`;
    if (n.text) toks.push(`(${String(n.text).replace(/[()（）]/g, '')})`);
    if (n.parenOpen) toks.push('（');
    const grace = graceToken(n.graceBefore, where);
    const body = noteToken(n, where);
    if (grace) toks.push(grace);
    if (body !== null) {
      toks.push(slurWrap(n.slur, body));
      sum += Number(n.dur) || 0;
    } else {
      hasIssueBefore = true;
    }
    if (graceToken(n.graceAfter, where)) toks.push(graceToken(n.graceAfter, where));
    if (n.parenClose) toks.push('）');
  });

  // 拍数对账：弱起小节（仅第一个）与弱起曲的最后一个小节（互补）豁免；
  // 不匹配的精确报「差多少」供回压
  const sumR = Math.round(sum * 1000) / 1000;
  const expR = Math.round(expected * 1000) / 1000;
  const isLast = i === measures.length - 1;
  const exempt = !!m.partial || (firstPartial && isLast);
  if (!m.partial && !exempt && Math.abs(sumR - expR) > 1e-6) {
    fail(`小节 ${i + 1}：合计 ${sumR} 拍 ≠ ${expected} 拍（差 ${sumR > expR ? '+' : ''}${Math.round((sumR - expR) * 1000) / 1000}）——只裁剪这一小节放大重读`);
  }
  if (m.partial && i === 0) firstPartial = true;

  measureTexts.push({ toks: toks.join(' '), meterAfter: m.meterAfter, breakAfter: m.breakAfter, partial: !!m.partial });

  if (m.meterAfter) {
    if (!/^\d+\/\d+$/.test(m.meterAfter)) fail(`小节 ${i + 1}：meterAfter 应为 N/M 形式，得到 ${JSON.stringify(m.meterAfter)}`);
    else expected = beatsPerMeasure(m.meterAfter);
  }
  if (m.partial && i !== 0) fail(`小节 ${i + 1}：partial 只允许出现在第一个小节`);
  if (m.breakAfter && !['line', 'page'].includes(m.breakAfter)) {
    fail(`小节 ${i + 1}：breakAfter 只能是 "line" / "page"`);
  }
}

// ── 拼装 .jps ──
const out = [];
const first = measures[0] ?? {};
if (first.partial) out.push('|{partial}');
measureTexts.forEach((m, i) => {
  if (i > 0) {
    out.push('|');
    const prev = measures[i - 1] ?? {};
    if (prev.meterAfter) out.push(`拍${prev.meterAfter}`);
    if (prev.breakAfter === 'line') out.push('换行');
    if (prev.breakAfter === 'page') out.push('分页');
  }
  if (m.toks) out.push(m.toks);
});
out.push('||');

const body = out.join(' ').replace(/\s+/g, ' ').trim();
const header = [
  '@format 3',
  `@title ${meta.title ?? '未命名曲谱'}`,
  `@key ${meta.key ?? '1=C'}`,
  `@beat ${meta.beat ?? '4/4'}`,
  `@bpm ${meta.bpm ?? 90}`,
  ...(meta.patch !== undefined ? [`@patch ${meta.patch}`] : []),
].join('\n');

const text = `${header}\n\n${body}`;
const outFile = process.argv[3];
if (outFile) {
  // 直接 UTF-8 落盘：shell 的 > 重定向在 PowerShell 下会写成 UTF-16 把文件写坏
  writeFileSync(outFile, text + '\n', 'utf-8');
  console.log(`已写出 ${outFile}`);
} else {
  console.log(text);
}

// ── 结果报告 ──
if (issues.length || hasIssueBefore) {
  console.error(`\n[json2jps] ${issues.length} 个问题（拍数不对的小节：只裁剪该小节放大重读，重跑本命令）：`);
  for (const s of issues) console.error(`  - ${s}`);
  process.exit(1);
}
