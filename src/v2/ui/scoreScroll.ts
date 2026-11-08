/** 一次导航请求：edge = 滚到曲谱首尾；eventId = 滚到这个事件所在行。
 *  seq 变化才算新请求（连按同一个键也要重新滚）。 */
export type ScrollRequest = { seq: number; edge?: 'start' | 'end'; eventId?: string | null };

/** 跳曲谱首尾时视口该停在哪：滚到顶 / 滚到底（自己钳到可滚范围，
 *  不依赖浏览器把超出 scrollHeight 的赋值悄悄夹回去）。 */
export function edgeScrollTop(edge: 'start' | 'end', scrollHeight: number, clientHeight: number): number {
  return edge === 'start' ? 0 : Math.max(0, scrollHeight - clientHeight);
}

/** 跳小节时把目标行放到视口中部，并钳到可滚范围。 */
export function eventScrollTop(y: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(max, y - clientHeight / 2));
}
