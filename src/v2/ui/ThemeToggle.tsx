/**
 * 深浅主题开关：一枚图标，跟着当前主题换。
 *
 * **深色 = 太阳，浅色 = 月亮**（图标表示「点一下会变成什么」）：
 * 深色界面里挂个太阳，一眼就知道现在点它能回到白天。
 * 所有网页端页面共用（记谱 / 对轨 / 播放 / 曲库 / 动态谱首页 / 帮助），
 * Android 有自己的主题入口，不走这里。
 */
export function ThemeToggle({ dark, onChange }: { dark: boolean; onChange: (dark: boolean) => void }) {
  return (
    <button
      type="button"
      className={`v2-theme-toggle ${dark ? 'is-dark' : ''}`}
      onClick={() => onChange(!dark)}
      aria-pressed={dark}
      aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
      title={dark ? '当前深色，点击切回浅色' : '当前浅色，点击进入深色'}
    >
      {dark ? (
        /* 太阳：实心圆心 + 八道光芒 */
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
        </svg>
      ) : (
        /* 月亮：弯钩 */
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
        </svg>
      )}
    </button>
  );
}
