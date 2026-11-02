// [ScoreOCR] dolce i18n 的最小 shim。
// dolce 原版 i18n/index.ts 依赖 model/msg（不搬）。overlay.ts / beats.ts 只用到
// t(key, params) 与 MsgKey 类型——这里给中文文案表 + 占位符插值，未知 key 回退原文。
export type MsgKey = string;

const ZH: Record<string, string> = {
  'beat.measure': '第 {n} 小节拍数不符：{issue}',
  'omr.doubt.sep': '、',
  'omr.doubt.reasons': '{list}',
  'omr.doubt.lyric': '第 {n} 段歌词可疑',
};

export function t(key: MsgKey, params?: Record<string, unknown>): string {
  const tpl = ZH[key] ?? key;
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}
