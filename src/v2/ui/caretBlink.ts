/** 插入点 I 形光标的闪烁周期（毫秒）：亮 / 灭各一段，与常见文本编辑器同节奏。 */
export const CARET_BLINK_MS = 530;

/**
 * 是否让插入点闪烁。播放中、歌词编辑、页面隐藏、系统要求减少动效、或调用方
 * 明确收起插入符时都退回常亮——前者不跟播放跟随抢重绘，后者不把动画强加给
 * 需要静态界面的用户。返回 false 时插入符仍在，只是不闪。
 */
export function caretBlinkActive(
  showCaret: boolean | undefined,
  playing: boolean,
  editingLyrics: boolean,
  reducedMotion: boolean,
  hidden: boolean,
): boolean {
  return showCaret !== false && !playing && !editingLyrics && !reducedMotion && !hidden;
}
