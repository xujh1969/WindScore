/**
 * 网格音符 → 完整 .jps 文本。
 *
 * v1 产出两个独立谱（人声主旋律谱 / 伴奏主奏谱）：各自是标准单声部谱，
 * 解析 / 排版 / 播放 / 打包全部走现有引擎，可独立编辑修错、进曲库、打包分享。
 * 同小节上下对齐的双声部排版是下一步的引擎升级（需要排版与播放支持声部维度）。
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
  const lines = measuresToLines(b.notes, beats, b.key);
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
    `@note AI 听音成谱草稿——错音 / 连音线请人工修正`,
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${body.join('\n')}`;
}
