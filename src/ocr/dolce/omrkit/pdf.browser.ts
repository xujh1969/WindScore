// 浏览器与 WebView 共用官方兼容构建；主线程和 worker 必须成对使用。
import type { OpsEnum } from "./vector";

/**
 * 打开 PDF（`extra` 原样交给 `getDocument`：矢量路要 `disableFontFace: true`，位图路要关掉图像解码优化）。
 * pdf.js v6 的位图解码器（jbig2.wasm 兼管 CCITTFax G4、openjpeg 管 JPEG2000）要显式指明 wasm 目录，
 * 否则内嵌位图（扫描版乐谱的 1-bit ImageMask）会被静默丢弃。目录随 public/redist/ 一起部署，离线自包含。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openPdf(bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<{ pdf: any; OPS: OpsEnum }> {
  streamAsyncIterator();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdfBase = `${import.meta.env.BASE_URL}redist/pdfjs/`;
  // getDocument 会 detach 传入的 buffer，复制一份避免污染调用方字节。
  // standardFontDataUrl / cMapUrl 必须配：文字型 PDF（Word 导出）的文字渲染依赖标准字体
  // 数据与 CJK CMap，不配的话 pdfjs 只在 console 里 warn 然后静默跳过文字——整页近乎
  // 全白，预览空白、识别为空（北国之春.pdf 实测，渲染本身不报任何错）。
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    wasmUrl: pdfBase,
    standardFontDataUrl: `${pdfBase}standard_fonts/`,
    cMapUrl: `${pdfBase}cmaps/`,
    ...extra,
  }).promise;
  return { pdf, OPS: pdfjs.OPS as unknown as OpsEnum };
}

/**
 * pdf.js 的 `getTextContent()` 用 `for await` 遍历 `ReadableStream`；桌面版的 WKWebView 没有流的异步迭代器
 * （较新的 Safari / Playwright 的 WebKit 有，所以网页版、回归都测不出来），一取文字层就报
 * 「undefined is not a function (near '...i of e...')」——破碎干净版拼页眉时撞上。没有就按 `getReader` 补一个。
 */
function streamAsyncIterator(): void {
  const proto = globalThis.ReadableStream?.prototype as (ReadableStream & { [Symbol.asyncIterator]?: unknown }) | undefined;
  if (!proto || proto[Symbol.asyncIterator]) return;
  Object.defineProperty(proto, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}
