import assert from 'node:assert/strict';
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { lyricInputTokens, setLyricWord, writeLyricInput } from '../src/v2/lyrics';
import type { NoteEvent, Score } from '../src/v2/types';

const cases: [string, string[]][] = [
  ['你，我。', ['你，', '我。']],
  ['你,我.!?;:、；：！？……', ['你,', '我.!?;:、；：！？……']],
  ['“你好！”（朋友）', ['“你', '好！”', '（朋', '友）']],
  ['"你好"', ['"你', '好"']],
  ['你 我。', ['你', '', '我。']],
  ['你\t\t我', ['你', '', '', '我']],
  ['，。！？', ['，。！？']],
  ['“', ['“']],
  ["don't-stop,朋友。", ["don't-stop,", '朋', '友。']],
  ['It’s fine!', ['It’s', '', 'fine!']],
];
for (const [input, expected] of cases) assert.deepEqual(lyricInputTokens(input), expected, input);

const base = parseDsl('@format 3\n@beat 2/4\n\n1 2 |\n').score!;
const notes = (score: Score) => score.events.filter((event): event is NoteEvent => event.kind === 'note');
const first = notes(base)[0].id;
const written = writeLyricInput(base, first, 0, '你，我。');
assert.equal(written.error, undefined);
assert.equal(written.count, 2);
assert.deepEqual(notes(written.score).map(note => note.lyrics?.[0]), ['你，', '我。']);
const parsed = parseDsl(serializeDsl(written.score));
assert.deepEqual(parsed.errors, []);
assert.deepEqual(notes(parsed.score!).map(note => note.lyrics?.[0]), ['你，', '我。']);
const punctuation = writeLyricInput(base, first, 0, '，。');
assert.equal(notes(punctuation.score)[0].lyrics?.[0], '，。');
const edited = writeLyricInput(written.score, first, 0, '你，？！');
assert.equal(edited.error, undefined);
assert.deepEqual(notes(edited.score).map(note => note.lyrics?.[0]), ['你，？！', '我。']);
const tooLong = writeLyricInput(written.score, first, 0, '你，我，他。');
assert.ok(tooLong.error);
assert.equal(tooLong.score, written.score, 'capacity failure must retain the original lyrics');
const quoted = setLyricWord(base, first, 0, '"你好"');
assert.equal(notes(parseDsl(serializeDsl(quoted)).score!)[0].lyrics?.[0], '"你好"');
const withGap = parseDsl('@format 3\n@beat 3/4\n\n1 2 3 |\n').score!;
const gap = writeLyricInput(withGap, notes(withGap)[0].id, 0, '你 我。');
assert.equal(gap.error, undefined);
assert.deepEqual(notes(parseDsl(serializeDsl(gap.score)).score!).map(note => note.lyrics?.[0] ?? ''), ['你', '', '我。']);
console.log(`lyric punctuation: ${cases.length} tokenizer cases and write/DSL round trips passed`);
