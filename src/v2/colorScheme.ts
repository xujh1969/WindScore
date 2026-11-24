/**
 * 主题同步：把 React 里的深浅状态反映到 <meta name="color-scheme">，
 * 让浏览器原生 UI（滚动条 / 表单 / 默认画布底色）也跟着主题走。
 * 页面 head 里已有首帧前的内联脚本设置初始 meta（防闪白），这里是运行期切换的补写。
 * 无 document 的环境（Node 测试 / 导出脚本）静默跳过。
 */
export function syncColorSchemeMeta(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
}
