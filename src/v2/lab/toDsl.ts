/**
 * 网格音符 → 完整 .jps 文本。
 *
 * 专用人声模型输出单声部草稿，复用现有解析 / 排版 / 播放内核。
 */

import { measuresToLines, type GridNote } from './quantize';

export interface DslBuild {
  title: string;
  key: string;
  beat: string;
  bpm: number;
  /** 谱头右侧说明（如「AI 转录 · 人声主旋律」） */
  note?: string;
  notes: GridNote[];
  /** 每行排几个小节（默认 4） */
  measuresPerLine?: number;
}

export function buildDsl(b: DslBuild): string {
  const beats = Number(b.beat.split('/')[0]) || 4;
  // 全部时间线以内核四分拍为单位；6/8 的小节长为 3 个四分拍。
  const denominator = Number(b.beat.split('/')[1]) || 4;
  const lines = measuresToLines(b.notes, beats * 4 / denominator, b.key);
  const per = b.measuresPerLine ?? 4;
  const body: string[] = [];
  for (let i = 0; i < lines.length; i += per) {
    body.push(lines.slice(i, i + per).join(' | ') + ' |');
  }
  const head = [
    `@title ${b.title}`,
    `@key ${b.key}`,
    `@beat ${b.beat}`,
    `@bpm ${b.bpm}`,
    `@patch 73`,
    b.note ? `@note ${b.note}` : '',
    `@note 听音成谱草稿，请试听后确认`,
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${body.join('\n')}`;
}
