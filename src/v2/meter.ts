import type { Score } from './types';

export function validMeter(value: string): boolean {
  const m = /^([1-9]\d*)\/(1|2|4|8|16|32)$/.exec(value);
  return !!m && Number(m[1]) <= 32;
}

export function meterAt(score: Score, index: number): string {
  let beat = score.meta.beat;
  for (let i = 0; i < index; i++) {
    const e = score.events[i];
    if (e.kind === 'barline' && e.beatAfter) beat = e.beatAfter;
  }
  return beat;
}

export function groupTicks(beat: string): number {
  return /^(6|9|12)\/8$/.test(beat) ? 72 : 48;
}
