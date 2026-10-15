import { legacyPitch, writtenPitch, type StaffClef, type StaffPitchMode } from './pitch';
import type { ScorePart } from './types';
import { TICKS_PER_BEAT } from './ticks';

/** 手动优先；默认高音，只有持续且明显的低音区才采用低音。 */
export function resolveStaffClef(part: ScorePart, initialKey: string, mode: StaffPitchMode): StaffClef {
  if (part.staffClef === 'treble' || part.staffClef === 'bass') return part.staffClef;
  return analyzeStaffClef(part, initialKey, mode).automatic;
}

/** 保守音区判断；不修改源谱、八度或播放音高。 */
export function suggestStaffClef(part: ScorePart, initialKey: string, mode: StaffPitchMode): StaffClef {
  return analyzeStaffClef(part, initialKey, mode).suggested;
}

function analyzeStaffClef(part: ScorePart, initialKey: string, mode: StaffPitchMode): { automatic: StaffClef; suggested: StaffClef } {
  // 这些预设的乐器移调分谱惯用高音谱号；实音视图仍按实际音区评估。
  if (mode === 'transposed' && part.staffInstrument && part.staffInstrument !== 'concert') return { automatic: 'treble', suggested: 'treble' };
  let key = initialKey, treble = 0, bass = 0, weightSum = 0, lowWeight = 0, veryLowWeight = 0;
  const seen = new Set<string>();
  const cost = (step: number): number => {
    const ledger = Math.min(5, Math.max(0, Math.floor(-step / 2), Math.floor((step - 8) / 2)));
    return ledger + .4 * ledger * ledger;
  };
  for (const event of part.events) {
    if (event.kind !== 'note') continue;
    key = event.keyChange ?? key;
    const identity = event.originId ?? event.id;
    if (seen.has(identity)) continue; // 展开反复的克隆不重复增加某段音区的权重。
    seen.add(identity);
    const pitch = writtenPitch(legacyPitch(event.degree, event.octave, key, event.accidental), mode, part.staffInstrument);
    const step = pitch.step + pitch.octave * 7 - 30;
    const weight = Math.min(4, Math.max(.25, event.ticks / TICKS_PER_BEAT));
    treble += cost(step) * weight;
    bass += cost(step + 12) * weight;
    weightSum += weight;
    if (step < -2) lowWeight += weight; // C4 以下；偶尔的下加线不构成低音声部。
    if (step <= -4) veryLowWeight += weight; // 高音谱号至少两根下加线，才计入明确低音。
  }
  // 持续低音（至少 80% 时长权重）、高音加线负担明显且低音收益至少一半才建议。
  const useful = weightSum > 0 && lowWeight >= .8 * weightSum && treble >= 2 * weightSum && bass < treble * .5;
  return { suggested: useful ? 'bass' : 'treble', automatic: useful && veryLowWeight >= .8 * weightSum ? 'bass' : 'treble' };
}
