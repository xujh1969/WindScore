/** Offline print faces derived from Arimo / Roboto / Noto Sans SC; see public/fonts/README.md. */
export const NOTATION_DIGIT_FAMILY = '"WindScore Notation Digits", Arial, sans-serif';
/** 谱面所有中文文字（标题、说明行、歌词）共用这一族，只靠字号分层，不单独打包标题字体。 */
export const NOTATION_TEXT_FAMILY = '"Microsoft YaHei", "WindScore Notation Text", sans-serif';

/** All ten tabular digits have advance 1139 in the bundled face's 2048-unit em. */
export function notationDigitWidth(fontSize = 21): number {
  return fontSize * 1139 / 2048;
}

/** Zero's exact ink extent is -20..1430 font units; the narrow one uses the same extent. */
export function notationDigitInkHeight(fontSize = 21): number {
  return fontSize * 1450 / 2048;
}

/** Noto Sans SC's mean 祈/福/那/是 ink ratio; replaced by actual runtime font metrics. */
let cachedTextInkRatio = 0.88875;

export function notationLyricFontSize(noteSize = 21): number {
  return notationDigitInkHeight(noteSize) * 1.024 / cachedTextInkRatio;
}

/**
 * 谱头说明文字（@sub 居中行、右列说明、速度、声部名）的字号。
 * 它们不是谱面主体，不跟着 @size 无限放大：大字谱下原本会顶破右列行距而叠字，
 * 视觉上也盖过标题。排版与绘制共用这套上限（见 notationHeaderRowHeight）。
 */
export function notationHeaderSubSize(noteSize = 21): number {
  return Math.min(notationLyricFontSize(noteSize) * 0.78, 15);
}

export function notationHeaderInfoSize(noteSize = 21): number {
  return Math.min(notationLyricFontSize(noteSize) * 0.7, 13);
}

/** 右列说明的行距：始终不小于该列字高的 1.35 倍，多行说明不会叠在一起。 */
export function notationHeaderRowHeight(noteSize = 21): number {
  return Math.max(18, Math.ceil(notationHeaderInfoSize(noteSize) * 1.35));
}

let ready: Promise<void> | undefined;

/** Resolve before the first canvas layout/paint so fallback metrics never become cached. */
export function ensureNotationFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return ready ??= Promise.all([
    document.fonts.load('700 21px "WindScore Notation Digits"', '0123456789'),
    document.fonts.load('400 16px "WindScore Notation Text"', '简谱歌词'),
  ]).then(faces => {
    if (faces.some(loaded => loaded.length === 0)) throw new Error('谱面字体未注册，请检查离线字体资源');
    // Measure the chosen face rather than guessing the operating system. Tests without
    // a real canvas keep the bundled face's measured ratio.
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      ctx.font = `400 100px ${NOTATION_TEXT_FAMILY}`;
      ctx.textBaseline = 'alphabetic';
      const ratio = Array.from('祈福那是').reduce((sum, ch) => {
        const metrics = ctx.measureText(ch);
        return sum + metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      }, 0) / 400;
      if (Number.isFinite(ratio) && ratio > 0) cachedTextInkRatio = ratio;
    } catch { /* Node/jsdom without Canvas retains the bundled-font ratio. */ }
  });
}

let embeddedCss: Promise<string> | undefined;

/** Fetch only when exporting SVG; font bytes stay outside the application JavaScript. */
export function embeddedNotationFontCss(): Promise<string> {
  return embeddedCss ??= Promise.all([
    ['WindScore Notation Digits', 'notation-digits.woff2', 700],
    ['WindScore Notation Text', 'notation-text.woff2', 400],
  ].map(async ([family, file, weight]) => {
    const response = await fetch(`${import.meta.env?.BASE_URL ?? './'}fonts/${file}`);
    if (!response.ok) throw new Error(`谱面字体读取失败：${file} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    const data = btoa(chunks.join(''));
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');}`;
  })).then(rules => rules.join('\n'));
}
