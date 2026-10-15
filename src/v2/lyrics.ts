import type { LyricLink, NoteEvent, Score } from './types';
import { assembleParts, scoreParts } from './parts';

export function lyricTrackNames(score: Pick<Score, 'events' | 'part'>): string[] {
  const count = Math.max(score.part?.lyricNames?.length ?? 0, 0, ...score.events.map((e) => e.kind === 'note' ? Math.max(e.lyrics?.length ?? 0, e.lyricLinks?.length ?? 0) : 0));
  return Array.from({ length: count }, (_, i) => score.part?.lyricNames?.[i] ?? `第 ${i + 1} 段歌词`);
}

export function addLyricTrack(score: Score, partId: string, name: string): Score {
  return assembleParts(score, scoreParts(score).map((p) => p.id === partId
    ? { ...p, lyricNames: [...lyricTrackNames({ events: p.events, part: p }), name] } : p));
}

export function removeLyricTrack(score: Score, partId: string, verse: number): Score {
  return assembleParts(score, scoreParts(score).map((p) => p.id === partId ? {
    ...p,
    lyricNames: lyricTrackNames({ events: p.events, part: p }).filter((_, i) => i !== verse),
    events: p.events.map((e) => {
      if (e.kind !== 'note') return e;
      const lyrics = (e.lyrics ?? []).filter((_, i) => i !== verse);
      const lyricLinks = (e.lyricLinks ?? []).filter((_, i) => i !== verse);
      const { lyrics: _old, lyricLinks: _links, ...base } = e;
      return { ...base, ...(lyrics.some(Boolean) ? { lyrics } : {}), ...(lyricLinks.some(Boolean) ? { lyricLinks } : {}) };
    }),
  } : p));
}

/** 更换关联声部时按主音顺序对应；不足以容纳现有文字时保留原谱并提示。 */
export function configureLyricTrack(score: Score, partId: string, verse: number, name: string, targetId: string): { score: Score; verse: number; error?: string } {
  const parts = scoreParts(score);
  const source = parts.find((p) => p.id === partId)!;
  if (partId === targetId) return { verse, score: assembleParts(score, parts.map((p) => {
    if (p.id !== partId) return p;
    const names = lyricTrackNames({ events: p.events, part: p });
    names[verse] = name;
    return { ...p, lyricNames: names };
  })) };
  const target = parts.find((p) => p.id === targetId)!;
  const names = lyricTrackNames({ events: target.events, part: target });
  if (names.length >= 6) return { score, verse, error: '关联声部最多支持六条歌词行' };
  const words = source.events.filter((e): e is NoteEvent => e.kind === 'note').map((e) => e.lyrics?.[verse] ?? '');
  const links = source.events.filter((e): e is NoteEvent => e.kind === 'note').map((e) => e.lyricLinks?.[verse] ?? null);
  const capacity = target.events.filter((e) => e.kind === 'note').length;
  if (words.slice(capacity).some(Boolean) || links.slice(capacity).some(Boolean)) return { score, verse, error: '关联声部的音符不足以容纳这些歌词，请先调整歌词或补充音符' };
  const next = removeLyricTrack(score, partId, verse);
  return { verse: names.length, score: assembleParts(next, scoreParts(next).map((p) => {
    if (p.id !== targetId) return p;
    let index = 0;
    return { ...p, lyricNames: [...names, name], events: p.events.map((e) => {
      if (e.kind !== 'note') return e;
      const lyrics = [...(e.lyrics ?? [])];
      while (lyrics.length < names.length) lyrics.push('');
      lyrics[names.length] = words[index] ?? '';
      const lyricLinks = [...(e.lyricLinks ?? [])];
      while (lyricLinks.length < names.length) lyricLinks.push(null);
      lyricLinks[names.length] = links[index++] ?? null;
      return { ...e, lyrics, ...(lyricLinks.some(Boolean) ? { lyricLinks } : {}) };
    }) };
  })) };
}

export function setLyricWord(score: Score, eventId: string, verse: number, word: string): Score {
  return { ...score, format: 3, events: score.events.map((e) => {
    if (e.kind !== 'note' || e.id !== eventId) return e;
    const lyrics = [...(e.lyrics ?? [])];
    while (lyrics.length <= verse) lyrics.push('');
    lyrics[verse] = word;
    while (lyrics.length && !lyrics[lyrics.length - 1]) lyrics.pop();
    const { lyrics: _old, ...base } = e;
    const lyricLinks = [...(e.lyricLinks ?? [])];
    if (word && lyricLinks[verse] === 'extend') lyricLinks[verse] = null;
    if (!word && lyricLinks[verse] === 'hyphen') lyricLinks[verse] = null;
    while (lyricLinks.length && !lyricLinks[lyricLinks.length - 1]) lyricLinks.pop();
    const { lyricLinks: _links, ...clean } = base;
    return { ...clean, ...(lyrics.length ? { lyrics } : {}), ...(lyricLinks.length ? { lyricLinks } : {}) };
  }) };
}

/** 中文逐字，其他连续文字作为一个词；粘贴的空格占一个歌词位置。 */
export function lyricInputTokens(text: string): string[] {
  return (text.match(/\p{Script=Han}|[^\p{Script=Han}\s，。！？、；：]+|[ \t]/gu) ?? []).map((word) => /^[ \t]$/.test(word) ? '' : word);
}

interface LyricSlot { word: string; link: LyricLink | null; }
function lyricSlots(score: Score, verse: number): LyricSlot[] {
  return score.events.filter((e): e is NoteEvent => e.kind === 'note').map(e => ({ word: e.lyrics?.[verse] ?? '', link: e.lyricLinks?.[verse] ?? null }));
}
const occupied = (slot: LyricSlot): boolean => !!(slot.word || slot.link);

function replaceLyricRow(score: Score, verse: number, words: LyricSlot[]): Score {
  let index = 0;
  return { ...score, format: 3, events: score.events.map((e) => {
    if (e.kind !== 'note') return e;
    const lyrics = [...(e.lyrics ?? [])];
    while (lyrics.length <= verse) lyrics.push('');
    const slot = words[index++] ?? { word: '', link: null };
    lyrics[verse] = slot.word;
    const lyricLinks = [...(e.lyricLinks ?? [])];
    while (lyricLinks.length <= verse) lyricLinks.push(null);
    lyricLinks[verse] = slot.link;
    while (lyricLinks.length && !lyricLinks[lyricLinks.length - 1]) lyricLinks.pop();
    while (lyrics.length && !lyrics[lyrics.length - 1]) lyrics.pop();
    const { lyrics: _old, lyricLinks: _links, ...base } = e;
    return { ...base, ...(lyrics.length ? { lyrics } : {}), ...(lyricLinks.length ? { lyricLinks } : {}) };
  }) };
}

export function writeLyricInput(score: Score, eventId: string, verse: number, text: string): { score: Score; count: number; error?: string } {
  const tokens = lyricInputTokens(text);
  if (tokens.length <= 1) return { score: setLyricWord(score, eventId, verse, tokens[0] ?? ''), count: 1 };
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  const start = notes.findIndex((e) => e.id === eventId);
  const words = lyricSlots(score, verse);
  // 多出的字插入新位置，保留后续已有歌词；不覆盖或截断已有文字。
  words.splice(start, 1, ...tokens.map(word => ({ word, link: null })));
  if (tokens.length > notes.length - start || words.slice(notes.length).some(occupied)) {
    return { score, count: 0, error: '音符位置不足，未写入这段歌词。请补充音符或整理后续歌词后重试。' };
  }
  return { score: replaceLyricRow(score, verse, words.slice(0, notes.length)), count: tokens.length };
}

export function insertLyricGap(score: Score, eventId: string, verse: number): { score: Score; error?: string } {
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  const start = notes.findIndex((e) => e.id === eventId);
  const words = lyricSlots(score, verse);
  words.splice(start, 0, { word: '', link: null });
  if (words.slice(notes.length).some(occupied)) return { score, error: '末尾没有空位可顺延，未插入空位。请先补充音符或整理末尾歌词。' };
  return { score: replaceLyricRow(score, verse, words.slice(0, notes.length)) };
}

/** 空格分词；带空格的英文词组可用 JSON 双引号包住，_ 为占位。 */
export function lyricTokens(text: string): string[] {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"(?=\s|$)|[^\s]+/g) ?? [];
  return tokens.filter((t) => t !== '|').map((t) => t === '_' ? '' : t.startsWith('"') ? JSON.parse(t) as string : t);
}

/** 删除一个歌词位置（包括空位），后续文字向前补齐。 */
export function deleteLyricPosition(score: Score, eventId: string, verse: number, offset: number): Score {
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  const index = notes.findIndex((e) => e.id === eventId) + offset;
  if (index < 0) return score;
  const words = lyricSlots(score, verse);
  words.splice(index, 1);
  return replaceLyricRow(score, verse, words);
}

export function lyricRows(score: Score): string[] {
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  const count = lyricTrackNames(score).length;
  return Array.from({ length: count }, (_, i) => {
    const words = notes.map((n) => n.lyrics?.[i] ?? '');
    while (words.length && !words[words.length - 1]) words.pop();
    return words.map((w) => !w ? '_' : /\s|["\\]/.test(w) || w === '_' || w === '|' ? JSON.stringify(w) : w).join(' ');
  });
}

export function applyLyrics(score: Score, rows: string[]): { score: Score; errors: string[] } {
  const count = score.events.filter((e) => e.kind === 'note').length;
  const errors: string[] = [];
  if (rows.length > 6) errors.push('最多支持六段歌词');
  const verses = rows.map((row, i) => {
    try {
      const words = lyricTokens(row);
      if (words.length > count) errors.push(`第 ${i + 1} 段有 ${words.length} 个歌词位置，当前声部只有 ${count} 个音符`);
      return words;
    } catch { errors.push(`第 ${i + 1} 段歌词的双引号或转义不正确`); return []; }
  });
  if (errors.length) return { score, errors };
  let index = 0;
  return { errors, score: { ...score, format: 3, events: score.events.map((e) => {
    if (e.kind !== 'note') return e;
    const lyrics = verses.map((v) => v[index] ?? '');
    index++;
    while (lyrics.length && !lyrics[lyrics.length - 1]) lyrics.pop();
    const { lyrics: _lyrics, ...base } = e;
    return lyrics.length ? { ...base, lyrics } : base;
  }) } };
}

export function setLyricLink(score: Score, eventId: string, verse: number, link: LyricLink | null): { score: Score; error?: string } {
  const index = score.events.findIndex(e => e.id === eventId && e.kind === 'note');
  const note = score.events[index];
  if (!note || note.kind !== 'note') return { score };
  if (link === 'extend') {
    let continues = false;
    for (const event of score.events.slice(0, index)) {
      if (event.kind === 'rest') continues = false;
      if (event.kind === 'note') continues = !!event.lyrics?.[verse] || continues && event.lyricLinks?.[verse] === 'extend';
    }
    if (note.lyrics?.[verse]) return { score, error: '延唱请标在后续空歌词格；有字的格子不会被覆盖。' };
    if (!continues) return { score, error: '延唱前需要有歌词或连续延唱格，不能跨过休止或普通空位。' };
  }
  if (link === 'hyphen' && !note.lyrics?.[verse]) return { score, error: '连字请标在前一个有字的音节上。' };
  return { score: { ...score, format: 3, events: score.events.map(e => {
    if (e.kind !== 'note' || e.id !== eventId) return e;
    const lyricLinks = [...(e.lyricLinks ?? [])];
    while (lyricLinks.length <= verse) lyricLinks.push(null);
    lyricLinks[verse] = link;
    while (lyricLinks.length && !lyricLinks[lyricLinks.length - 1]) lyricLinks.pop();
    const { lyricLinks: _links, ...base } = e;
    return lyricLinks.length ? { ...base, lyricLinks } : base;
  }) } };
}

export function lyricLinkRows(score: Score): string[] {
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  return Array.from({ length: lyricTrackNames(score).length }, (_, verse) => notes.flatMap((n, i) => {
    const link = n.lyricLinks?.[verse];
    return link ? [`${i + 1}${link === 'extend' ? '~' : '-'}`] : [];
  }).join(' '));
}

/** 单独保存连接元数据，不重新解释任何旧歌词文字。 */
export function applyLyricLinks(score: Score, rows: string[]): { score: Score; errors: string[] } {
  const notes = score.events.filter((e): e is NoteEvent => e.kind === 'note');
  const links = new Map<string, (LyricLink | null)[]>();
  const errors: string[] = [];
  rows.forEach((row, verse) => {
    const used = new Set<number>();
    for (const token of row.trim().split(/\s+/).filter(Boolean)) {
      const match = /^([1-9]\d*)([~-])$/.exec(token);
      const index = match ? Number(match[1]) - 1 : -1;
      if (!match || !notes[index] || used.has(index)) { errors.push(`歌词线 ${verse + 1} 的位置无效或重复：${token}`); continue; }
      used.add(index);
      const value = links.get(notes[index].id) ?? [];
      while (value.length <= verse) value.push(null);
      value[verse] = match[2] === '~' ? 'extend' : 'hyphen';
      links.set(notes[index].id, value);
    }
  });
  if (errors.length) return { score, errors };
  return { errors, score: { ...score, format: 3, events: score.events.map(e => {
    if (e.kind !== 'note') return e;
    const { lyricLinks: _old, ...base } = e;
    const lyricLinks = links.get(e.id);
    return lyricLinks ? { ...base, lyricLinks } : base;
  }) } };
}
