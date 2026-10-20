/**
 * 运行环境标记：安卓 App 的 WebView 壳用 WebViewAssetLoader，
 * 页面固定跑在 `https://appassets.androidplatform.net` 这个域名下。
 * 以此区分「安卓 App 里的 WindScore」和「桌面 / 浏览器里的 WindScore」，
 * 用于隐藏安卓端不提供的入口（简谱编辑、对轨）。
 */
export const IS_ANDROID_APP =
  typeof location !== 'undefined' && location.hostname === 'appassets.androidplatform.net';
