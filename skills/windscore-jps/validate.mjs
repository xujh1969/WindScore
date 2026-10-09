// scripts/build-skill-validator.ts
import { readFileSync } from "node:fs";

// src/v2/ticks.ts
var TICKS_PER_BEAT = 48;
var DURATION_TICKS = {
  whole: 192,
  half: 96,
  quarter: 48,
  eighth: 24,
  sixteenth: 12,
  thirtySecond: 6,
  /** 1/3 拍，三连音成员 */
  tripletThird: 16,
  /** 1/6 拍，六连音成员 */
  sextupletSixth: 8
};
var DIVISION_TICKS = {
  1: 48,
  2: 24,
  3: 16,
  4: 12,
  6: 8,
  8: 6
};
var TICK_DIVISIONS = {
  48: 1,
  24: 2,
  16: 3,
  12: 4,
  8: 6,
  6: 8
};
var BASE_DURATIONS = [192, 96, 48, 24, 12, 6];
function withDots(base, dots) {
  if (dots === 0) return base;
  return Math.round(base * (dots === 1 ? 1.5 : 1.75));
}
var LEGAL_TICKS = (() => {
  const set = /* @__PURE__ */ new Set();
  for (const b of BASE_DURATIONS) {
    for (const d of [0, 1, 2]) set.add(withDots(b, d));
  }
  set.add(DURATION_TICKS.tripletThird);
  set.add(DURATION_TICKS.sextupletSixth);
  return [...set].sort((a, b) => a - b);
})();
var LEGAL_SET = new Set(LEGAL_TICKS);
function isLegalTick(t) {
  return LEGAL_SET.has(t);
}
function undotTicks(ticks, dot) {
  const factor = dot === 1 ? 1.5 : dot === 2 ? 1.75 : 1;
  return Math.round(ticks / factor);
}
function beamCount(ticks) {
  if (ticks <= 0 || ticks >= TICKS_PER_BEAT) return 0;
  const ratio = TICKS_PER_BEAT / ticks;
  if (!Number.isInteger(ratio)) return 0;
  const n = Math.log2(ratio);
  return Number.isInteger(n) ? n : 0;
}
function tupletBeamCount(totalTicks, n) {
  if (n <= 1 || totalTicks <= 0) return 0;
  const replaced = 2 ** Math.floor(Math.log2(n));
  return beamCount(Math.floor(totalTicks / replaced));
}

// src/v2/parts.ts
var DEFAULT_PART = { id: "1", name: "\u58F0\u90E8 1", gain: 1 };
function scoreParts(score2) {
  return [{ ...score2.part ?? DEFAULT_PART, events: score2.events, groups: score2.groups }, ...score2.parts ?? []];
}
function partScore(score2, id) {
  const part = scoreParts(score2).find((p) => p.id === id) ?? scoreParts(score2)[0];
  const { events, groups, ...info } = part;
  const { parts: _parts, part: _part, ...base } = score2;
  return { ...base, events, groups, ...score2.part ? { part: info } : {} };
}
function assembleParts(score2, parts) {
  const [first, ...rest] = parts;
  const { events, groups, ...part } = first;
  const assembled = { ...score2, format: 3, events, groups, part, parts: rest };
  return { ...assembled, parts: rest.map((p) => {
    const aligned = withConductor(assembled, p.id);
    return { ...p, events: aligned.events };
  }) };
}
function namespacePart(score2, info) {
  const ids = new Map(score2.events.map((e, i) => [e.id, `p${info.id}:e${i + 1}`]));
  const gids = new Map(score2.groups.map((g, i) => [g.id, `p${info.id}:g${i + 1}`]));
  return {
    ...info,
    events: score2.events.map((e) => ({
      ...e,
      id: ids.get(e.id),
      ..."groupId" in e && e.groupId ? { groupId: gids.get(e.groupId) } : {},
      ...e.kind === "note" && e.ties ? { ties: e.ties.map((t) => ({ ...t, to: ids.get(t.to) })) } : {},
      ...e.kind === "note" && e.hairpinTo ? { hairpinTo: ids.get(e.hairpinTo) } : {}
    })),
    groups: score2.groups.map((g) => ({ ...g, id: gids.get(g.id), memberIds: g.memberIds.map((id) => ids.get(id)) }))
  };
}
function partMeasures(events) {
  const out = [];
  let from = 0;
  let ticks = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === "note" || e.kind === "rest") ticks += e.ticks;
    if (e.kind === "barline" && ticks > 0) {
      out.push({ from, to: i + 1, ticks });
      from = i + 1;
      ticks = 0;
    }
  }
  if (ticks > 0) out.push({ from, to: events.length, ticks });
  return out;
}
function ensembleIssues(score2) {
  if (!score2.parts?.length) return [];
  const parts = scoreParts(score2);
  const measures2 = parts.map((p) => partMeasures(p.events));
  const out = [];
  parts.slice(1).forEach((p, pi) => {
    const current = measures2[pi + 1];
    if (current.length !== measures2[0].length) out.push(`${p.name}\u6709 ${current.length} \u5C0F\u8282\uFF0C${parts[0].name}\u6709 ${measures2[0].length} \u5C0F\u8282`);
    current.forEach((m, i) => {
      if (measures2[0][i] && m.ticks !== measures2[0][i].ticks) out.push(`${p.name}\u7B2C ${i + 1} \u5C0F\u8282\u4E3A ${m.ticks / TICKS_PER_BEAT} \u62CD\uFF0C\u4E0E${parts[0].name}\u4E0D\u4E00\u81F4`);
    });
  });
  return out;
}
function withConductor(score2, id) {
  const target = partScore(score2, id);
  if (!score2.part || id === score2.part.id) return target;
  const sourceMeasures = partMeasures(score2.events);
  const targetMeasures = partMeasures(target.events);
  const clean = target.events.filter((e) => e.kind !== "jump").map((e) => {
    if (e.kind !== "barline") return e;
    const { repeat: _r, times: _t, volta: _v, voltaOpen: _o, beatAfter: _b, breakAfter: _br, ...bar } = e;
    return bar;
  });
  const sourceStarts = [0, ...sourceMeasures.map((m) => m.to)];
  const targetStarts = [0, ...targetMeasures.map((m) => m.to)];
  const sourceHead = score2.events.slice(0, score2.events.findIndex((e) => "ticks" in e));
  const targetHead = target.events.slice(0, target.events.findIndex((e) => "ticks" in e));
  for (let boundary = sourceStarts.length - 1; boundary >= 0; boundary--) {
    const at = sourceStarts[boundary];
    const src = boundary === 0 ? sourceHead.find((e) => e.kind === "barline") : score2.events[at - 1];
    const dstOriginal = boundary === 0 ? targetHead.find((e) => e.kind === "barline") : target.events[(targetStarts[boundary] ?? 0) - 1];
    let index = dstOriginal ? clean.findIndex((e) => e.id === dstOriginal.id) : -1;
    if (src?.kind === "barline") {
      const attributes = { repeat: src.repeat, times: src.times, volta: src.volta, voltaOpen: src.voltaOpen, partial: src.partial, beatAfter: src.beatAfter, breakAfter: src.breakAfter };
      if (clean[index]?.kind === "barline") clean[index] = { ...clean[index], ...attributes };
      else if (boundary === 0) {
        clean.unshift({ id: `p${id}:conductor:start`, kind: "barline", style: "single", ...attributes });
        index = 0;
      }
    }
    const jumps = [];
    const following = boundary === 0 ? sourceHead : [];
    if (boundary > 0) for (let j = at; j < score2.events.length && !("ticks" in score2.events[j]) && score2.events[j].kind !== "barline"; j++) following.push(score2.events[j]);
    for (const e of following) {
      if (e.kind === "jump") jumps.push({ ...e, id: `p${id}:conductor:${e.id}` });
    }
    if (jumps.length) clean.splice(Math.max(0, index + 1), 0, ...jumps);
  }
  return { ...target, events: clean };
}

// src/v2/meter.ts
function validMeter(value) {
  const m = /^([1-9]\d*)\/(1|2|4|8|16|32)$/.exec(value);
  return !!m && Number(m[1]) <= 32;
}
function meterAt(score2, index) {
  let beat = score2.meta.beat;
  for (let i = 0; i < index; i++) {
    const e = score2.events[i];
    if (e.kind === "barline" && e.beatAfter) beat = e.beatAfter;
  }
  return beat;
}
function groupTicks(beat) {
  return /^(6|9|12)\/8$/.test(beat) ? 72 : 48;
}

// src/v2/timeline.ts
var GRACE_TICKS = TICKS_PER_BEAT / 4;
function normalizeKey(key) {
  const m = /^\s*1\s*=\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)\s*$/.exec(key);
  if (!m) return null;
  const char = m[1] || m[3];
  const acc = char === "#" || char === "\u266F" ? "#" : char === "b" || char === "\u266D" ? "b" : "";
  return `1=${acc}${m[2].toUpperCase()}`;
}

// src/v2/types.ts
var TICKS_PER_BEAT2 = 48;
function isTimed(e) {
  return e.kind === "note" || e.kind === "rest";
}

// src/v2/edit.ts
function maxSeq(ids, prefix) {
  let m = 0;
  for (const id of ids) {
    const local = id.split(":").pop();
    const n = Number(local.startsWith(prefix) ? local.slice(prefix.length) : NaN);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}
function autoGroupBeats(score2) {
  const noteIds = new Set(score2.events.filter((e) => e.kind === "note").map((e) => e.id));
  if (score2.events.some((e) => e.kind === "note" && e.hairpinTo && !noteIds.has(e.hairpinTo))) {
    score2 = { ...score2, events: score2.events.map((e) => {
      if (e.kind !== "note" || !e.hairpinTo || noteIds.has(e.hairpinTo)) return e;
      const { hairpinTo: _to, hairpin: _kind, ...rest } = e;
      return rest;
    }) };
  }
  if (score2.format === 3 && score2.groups.some((g) => g.auto)) {
    const keep = score2.groups.filter((g) => !g.auto);
    const keptIds = new Set(keep.map((g) => g.id));
    score2 = { ...score2, groups: keep, events: score2.events.map((e) => {
      if ("groupId" in e && e.groupId && !keptIds.has(e.groupId)) {
        const { groupId: _g, ...rest } = e;
        return rest;
      }
      return e;
    }) };
  }
  let beatTicks = score2.format === 3 ? groupTicks(score2.meta.beat) : TICKS_PER_BEAT;
  const grouped = /* @__PURE__ */ new Set();
  for (const g of score2.groups) for (const id of g.memberIds) grouped.add(id);
  const existing = new Set(score2.groups.map((g) => g.memberIds.join(",")));
  const added = [];
  let seq = maxSeq(score2.groups.map((g) => g.id), "g");
  let tick = 0;
  let run = [];
  let sum = 0;
  const flush = () => {
    const shortOnly = run.every((id) => {
      const e = score2.events.find((event) => event.id === id);
      return e && isTimed(e) && undotTicks(e.ticks, e.dot ?? 0) < TICKS_PER_BEAT;
    });
    if (run.length >= 2 && sum === beatTicks && shortOnly && !existing.has(run.join(","))) {
      seq += 1;
      added.push({ id: `${score2.part ? `p${score2.part.id}:` : ""}g${seq}`, totalTicks: beatTicks, memberIds: [...run], ...score2.format === 3 ? { auto: true } : {} });
    }
    run = [];
    sum = 0;
  };
  for (const ev of score2.events) {
    if (ev.kind === "barline") {
      flush();
      if (score2.format === 3) tick = 0;
      if (score2.format === 3 && ev.beatAfter) beatTicks = groupTicks(ev.beatAfter);
      continue;
    }
    if (ev.kind !== "note" && ev.kind !== "rest") continue;
    if (grouped.has(ev.id)) {
      flush();
      tick += ev.ticks;
      continue;
    }
    if (tick % beatTicks === 0) {
      run = [ev.id];
      sum = ev.ticks;
    } else if (run.length > 0) {
      run.push(ev.id);
      sum += ev.ticks;
    }
    tick += ev.ticks;
    if (sum >= beatTicks) flush();
  }
  flush();
  if (added.length === 0) return score2;
  const gidOf = /* @__PURE__ */ new Map();
  for (const g of added) for (const id of g.memberIds) gidOf.set(id, g.id);
  return {
    ...score2,
    groups: [...score2.groups, ...added],
    events: score2.events.map(
      (e) => gidOf.has(e.id) ? { ...e, groupId: gidOf.get(e.id) } : e
    )
  };
}

// src/v2/lyrics.ts
function lyricTrackNames(score2) {
  const count = Math.max(score2.part?.lyricNames?.length ?? 0, 0, ...score2.events.map((e) => e.kind === "note" ? e.lyrics?.length ?? 0 : 0));
  return Array.from({ length: count }, (_, i) => score2.part?.lyricNames?.[i] ?? `\u7B2C ${i + 1} \u6BB5\u6B4C\u8BCD`);
}
function lyricTokens(text2) {
  const tokens = text2.match(/"(?:[^"\\]|\\.)*"(?=\s|$)|[^\s]+/g) ?? [];
  return tokens.filter((t) => t !== "|").map((t) => t === "_" ? "" : t.startsWith('"') ? JSON.parse(t) : t);
}
function lyricRows(score2) {
  const notes = score2.events.filter((e) => e.kind === "note");
  const count = lyricTrackNames(score2).length;
  return Array.from({ length: count }, (_, i) => {
    const words = notes.map((n) => n.lyrics?.[i] ?? "");
    while (words.length && !words[words.length - 1]) words.pop();
    return words.map((w) => !w ? "_" : /\s|["\\]/.test(w) || w === "_" || w === "|" ? JSON.stringify(w) : w).join(" ");
  });
}
function applyLyrics(score2, rows) {
  const count = score2.events.filter((e) => e.kind === "note").length;
  const errors = [];
  if (rows.length > 6) errors.push("\u6700\u591A\u652F\u6301\u516D\u6BB5\u6B4C\u8BCD");
  const verses = rows.map((row, i) => {
    try {
      const words = lyricTokens(row);
      if (words.length > count) errors.push(`\u7B2C ${i + 1} \u6BB5\u6709 ${words.length} \u4E2A\u6B4C\u8BCD\u4F4D\u7F6E\uFF0C\u5F53\u524D\u58F0\u90E8\u53EA\u6709 ${count} \u4E2A\u97F3\u7B26`);
      return words;
    } catch {
      errors.push(`\u7B2C ${i + 1} \u6BB5\u6B4C\u8BCD\u7684\u53CC\u5F15\u53F7\u6216\u8F6C\u4E49\u4E0D\u6B63\u786E`);
      return [];
    }
  });
  if (errors.length) return { score: score2, errors };
  let index = 0;
  return { errors, score: { ...score2, format: 3, events: score2.events.map((e) => {
    if (e.kind !== "note") return e;
    const lyrics = verses.map((v) => v[index] ?? "");
    index++;
    while (lyrics.length && !lyrics[lyrics.length - 1]) lyrics.pop();
    const { lyrics: _lyrics, ...base } = e;
    return lyrics.length ? { ...base, lyrics } : base;
  }) } };
}

// src/v2/dsl.ts
var NOTE_RE = /^([v^#b♯♭♮]*)([0-7])([v^]*)(\.{0,2})(?:\/([1-8]))?(-*)(~?)([!=>@tkVfdmwsxqh]*)$/;
var TECHNIQUE_LETTER = {
  V: "breath",
  // 换气 V（大写，避开低八度点 v）
  r: "trill",
  // 颤音 tr
  f: "flutter",
  // 花舌 *
  d: "da",
  // 打音 ♮
  m: "mordentUp",
  // 上波音 ≈
  w: "mordentDown",
  // 下波音 ≈（上下翻转）
  s: "slideUp",
  // 上滑音 ↑
  x: "slideDown",
  // 下滑音 ↓
  q: "bendUp",
  // 前弯音 ↗
  h: "bendDown"
  // 后弯音 ↘
};
var TECHNIQUE_OF = Object.fromEntries(
  Object.entries(TECHNIQUE_LETTER).map(([letter, value]) => [value, letter])
);
var ACCIDENTALS = {
  "#": "#",
  "\u266F": "#",
  b: "b",
  "\u266D": "b",
  "\u266E": "\u266E"
};
var DYNAMIC_RE = /^(pp|mp|mf|ff|p|f|cresc|dim)$/;
var DEFAULT_META = {
  title: "\u672A\u547D\u540D\u66F2\u8C31",
  key: "1=C",
  beat: "4/4",
  bpm: 90,
  patch: 73
};
function parseGraceNotes(text2) {
  if (!text2) return null;
  const parts = text2.match(/[#b♯♭♮]*[1-7][v^]*/g);
  if (!parts || parts.join("") !== text2) return null;
  return parts.map((p) => {
    const m = /^([#b♯♭♮]*)([1-7])([v^]*)$/.exec(p);
    let octave = 0;
    for (const c of m[3]) octave += c === "^" ? 1 : -1;
    const g = { degree: Number(m[2]), octave };
    const acc = [...m[1]].find((c) => c in ACCIDENTALS);
    if (acc) g.accidental = ACCIDENTALS[acc];
    return g;
  });
}
function renderGraceNote(g) {
  const oct = g.octave > 0 ? "^".repeat(g.octave) : "v".repeat(-g.octave);
  return `${g.accidental ?? ""}${g.degree}${oct}`;
}
function parseDsl(text2) {
  const version = /^@format\s+(\S+)\s*$/mi.exec(text2)?.[1];
  if (version && version !== "3") return { score: null, errors: [`\u4E0D\u652F\u6301\u7684 JPS \u8BED\u6CD5\u7248\u672C\uFF1A${version}`] };
  const modern = version === "3";
  if (!modern && /^@part\b/mi.test(text2)) return { score: null, errors: ["\u591A\u58F0\u90E8\u6587\u4EF6\u9700\u8981\u5728\u8C31\u5934\u5199 @format 3"] };
  if (!modern) return parseSingle(text2);
  const header = [];
  const blocks = [];
  const errors = [];
  for (const raw of text2.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^@part\b/i.test(line)) {
      const match = /^@part\s+([1-9]\d*)\s+("(?:[^"\\]|\\.)*")\s*$/i.exec(line);
      if (!match) {
        errors.push('\u58F0\u90E8\u58F0\u660E\u5E94\u4E3A @part 1 "\u4E3B\u65CB\u5F8B"');
        continue;
      }
      if (blocks.some((b) => b.id === match[1])) {
        errors.push(`\u58F0\u90E8\u7F16\u53F7 ${match[1]} \u91CD\u590D`);
        continue;
      }
      try {
        blocks.push({ id: match[1], name: JSON.parse(match[2]), gain: 1, lines: [] });
      } catch {
        errors.push(`\u58F0\u90E8 ${match[1]} \u7684\u540D\u79F0\u5F15\u53F7\u6216\u8F6C\u4E49\u4E0D\u6B63\u786E`);
      }
    } else if (/^@mix\b/i.test(line)) {
      const m = /^@mix\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+(on|off)\s+(solo|all)\s*$/i.exec(line);
      const block = blocks[blocks.length - 1];
      if (!block || !m) errors.push("\u58F0\u90E8\u8BD5\u542C\u8BBE\u7F6E\u5E94\u4E3A @mix 0.8 on all\uFF0C\u5E76\u653E\u5728\u58F0\u90E8\u58F0\u660E\u4E4B\u540E");
      else {
        block.gain = Number(m[1]);
        block.muted = m[2].toLowerCase() === "off";
        block.solo = m[3].toLowerCase() === "solo";
      }
    } else if (/^@lyricnames\b/i.test(line)) {
      const block = blocks[blocks.length - 1];
      try {
        const names = JSON.parse(line.replace(/^@lyricnames\s*/i, ""));
        if (!block || !Array.isArray(names) || names.length > 6 || names.some((n) => typeof n !== "string" || !n.trim())) throw new Error();
        block.lyricNames = names;
      } catch {
        errors.push('\u6B4C\u8BCD\u884C\u540D\u79F0\u5E94\u4E3A @lyricNames ["\u7B2C\u4E00\u6BB5", "\u7B2C\u4E8C\u6BB5"]\uFF0C\u653E\u5728\u5173\u8054\u58F0\u90E8\u58F0\u660E\u4E4B\u540E\uFF0C\u6700\u591A\u516D\u6761');
      }
    } else if (line.startsWith("@")) header.push(raw);
    else if (blocks.length) blocks[blocks.length - 1].lines.push(raw);
    else if (line && !line.startsWith("//") && line !== "---") header.push(raw);
  }
  if (errors.length) return { score: null, errors };
  if (!blocks.length) {
    const result = parseSingle(normalizeModern(text2), true);
    return { ...result, score: result.score && !result.errors.length ? autoGroupBeats(result.score) : null };
  }
  if (header.some((l) => l.trim() && !l.trim().startsWith("@") && !l.trim().startsWith("//"))) return { score: null, errors: ["\u591A\u58F0\u90E8\u6587\u4EF6\u7684\u97F3\u7B26\u5FC5\u987B\u5199\u5728 @part \u58F0\u90E8\u58F0\u660E\u4E4B\u540E"] };
  const parsed = blocks.map((b) => ({ block: b, result: parseSingle(normalizeModern([...header, ...b.lines].join("\n")), true) }));
  for (const { block, result } of parsed) errors.push(...result.errors.map((e) => `${block.name}\uFF1A${e}`));
  if (errors.length || parsed.some((p) => !p.result.score)) return { score: null, errors };
  return { score: assembleParts(parsed[0].result.score, parsed.map(({ block, result }) => {
    const { lines: _lines, ...info } = block;
    return namespacePart(autoGroupBeats(result.score), {
      ...info,
      muted: info.muted ?? false,
      solo: info.solo ?? false
    });
  })), errors };
}
function normalizeModern(text2) {
  return text2.split(/(^\s*@[^\n]*$|^\s*\/\/[^\n]*$|^\s*歌词[1-6]:[^\n]*$)/m).map((segment) => {
    if (segment.trim().startsWith("@") || segment.trim().startsWith("//") || /^歌词[1-6]:/.test(segment.trim())) return segment;
    return segment.replace(/(^|\s|[<(}])([#b♯♭♮]?[v^]*[0-7][v^]*\.{0,2})(\/{1,3})(?![\d/])/g, (_, before, note, slashes) => `${before}${note}/${2 ** slashes.length}`).replace(/<3:\s*([^<>]+)>/g, (full, body) => {
      const tokens = body.trim().split(/\s+/);
      if (tokens.length !== 3 || !tokens.every((t) => /^[#b♯♭♮]?[0-7][v^]*[!=>@tkVrfdmwsxqh]*$/.test(t))) return full;
      return `<3: ${tokens.map((t) => t.replace(/^([#b♯♭♮]?[0-7][v^]*)/, "$1/3")).join(" ")}>`;
    });
  }).join("");
}
function parseSingle(text2, modern = false) {
  const errors = [];
  const meta = { ...DEFAULT_META };
  const body = [];
  const lyrics = [];
  const lyricNumbers = /* @__PURE__ */ new Set();
  for (const raw of text2.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("//")) continue;
    const lyric = /^歌词([1-6]):\s*(.*)$/.exec(line);
    if (lyric) {
      if (!modern) errors.push("\u6B4C\u8BCD\u9700\u8981 @format 3");
      const verse = Number(lyric[1]) - 1;
      if (lyricNumbers.has(verse)) errors.push(`\u6B4C\u8BCD ${verse + 1} \u91CD\u590D`);
      lyricNumbers.add(verse);
      lyrics[verse] = lyric[2];
      continue;
    }
    if (line.startsWith("@")) {
      const sp = line.indexOf(" ");
      const k = (sp > 0 ? line.slice(1, sp) : line.slice(1)).toLowerCase();
      const v = sp > 0 ? line.slice(sp + 1).trim() : "";
      switch (k) {
        case "title":
          meta.title = v;
          break;
        case "key":
          meta.key = v;
          break;
        case "beat":
          meta.beat = v;
          break;
        case "bpm": {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) meta.bpm = n;
          else errors.push(`BPM \u89E3\u6790\u5931\u8D25\uFF1A${v}`);
          break;
        }
        case "patch": {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0 && n <= 127) meta.patch = n;
          else errors.push(`patch \u89E3\u6790\u5931\u8D25\uFF1A${v}`);
          break;
        }
        case "patchname":
          meta.patchName = v;
          break;
        case "sub":
          meta.sub = v;
          break;
        case "note":
          meta.notes = [...meta.notes ?? [], v].slice(0, 4);
          break;
        case "size": {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 12 && n <= 56) meta.fontSize = n;
          else errors.push(`\u5B57\u53F7\u89E3\u6790\u5931\u8D25\uFF08\u5E94\u4E3A 12\u201356 \u7684\u6570\u5B57\uFF09\uFF1A${v}`);
          break;
        }
        case "space": {
          const n = Number(v);
          if (Number.isFinite(n) && n >= -4 && n <= 24) meta.letterSpacing = n;
          else errors.push(`\u5B57\u95F4\u8DDD\u89E3\u6790\u5931\u8D25\uFF08\u5E94\u4E3A -4\u201324 \u7684\u6570\u5B57\uFF09\uFF1A${v}`);
          break;
        }
        case "measureno": {
          if (/^(off|0|false|no)$/i.test(v)) meta.showMeasureNumbers = false;
          else if (/^(on|1|true|yes)$/i.test(v)) meta.showMeasureNumbers = true;
          else errors.push(`\u5C0F\u8282\u53F7\u5F00\u5173\u89E3\u6790\u5931\u8D25\uFF08\u5E94\u4E3A on / off\uFF09\uFF1A${v}`);
          break;
        }
        default:
          break;
      }
      continue;
    }
    body.push(line);
  }
  const events = [];
  const groups = [];
  const byId = /* @__PURE__ */ new Map();
  let seq = 0;
  let groupSeq = 0;
  const nextId = () => `e${++seq}`;
  let lastNoteId = null;
  let pendingTie = false;
  let pendingKey;
  let currentBeat = meta.beat;
  let hairpinStart = null;
  const slurStack = [];
  let currentGroup = null;
  const topGroup = () => currentGroup;
  const addTie = (fromId, toId, kind) => {
    const from = byId.get(fromId);
    if (!from || from.kind !== "note") return;
    from.ties = [...from.ties ?? [], { to: toId, kind }];
  };
  const pushTimed = (core, gBefore, gAfter, hiddenRest = false) => {
    const m = NOTE_RE.exec(core);
    if (!m) {
      errors.push(`\u65E0\u6CD5\u89E3\u6790\u7684\u8BB0\u53F7\uFF1A${core}`);
      return;
    }
    const [, pre, digit, post, dots, div, dashes, tieMark, artic] = m;
    let octave = 0;
    for (const c of pre + post) {
      if (c === "^") octave += 1;
      else if (c === "v") octave -= 1;
    }
    const accChar = [...pre].find((c) => c in ACCIDENTALS);
    const accidental = accChar ? ACCIDENTALS[accChar] : void 0;
    const divN = div ? Number(div) : 1;
    const base = DIVISION_TICKS[divN];
    if (base === void 0) {
      errors.push(`\u4E0D\u652F\u6301\u7684\u9664\u6CD5\u8BB0\u53F7 /${divN}`);
      return;
    }
    const dotCount = dots.length;
    const ticks = withDots(base, dotCount) + dashes.length * TICKS_PER_BEAT;
    const degree = Number(digit);
    const id = nextId();
    let ev;
    if (degree === 0) {
      if (gBefore || gAfter) errors.push("\u501A\u97F3\u53EA\u80FD\u52A0\u5728\u97F3\u7B26\u4E0A\uFF0C\u4E0D\u80FD\u52A0\u5728\u4F11\u6B62\u7B26\u4E0A");
      const rest = { id, kind: "rest", ticks };
      if (dotCount) rest.dot = dotCount;
      ev = rest;
      if (hiddenRest) rest.hidden = true;
    } else {
      const note = {
        id,
        kind: "note",
        degree,
        octave,
        ticks,
        dot: dotCount
      };
      if (accidental) note.accidental = accidental;
      if (pendingKey) {
        note.keyChange = pendingKey;
        pendingKey = void 0;
      }
      const arts = [];
      let fermata = false;
      let tongue;
      const techniques = [];
      for (const c of artic) {
        if (c === "!") arts.push("staccato");
        else if (c === "=") arts.push("tenuto");
        else if (c === ">") arts.push("accent");
        else if (c === "@") fermata = true;
        else if (c === "t") tongue = "T";
        else if (c === "k") tongue = "K";
        else if (c in TECHNIQUE_LETTER) techniques.push(TECHNIQUE_LETTER[c]);
      }
      if (arts.length) note.articulations = arts;
      if (fermata) note.fermata = true;
      if (tongue) note.tongue = tongue;
      if (techniques.length) note.techniques = techniques;
      if (gBefore?.length) note.graceBefore = gBefore;
      if (gAfter?.length) note.graceAfter = gAfter;
      ev = note;
    }
    if (currentGroup) {
      ev.groupId = currentGroup.id;
      currentGroup.memberIds.push(id);
    }
    if (pendingTie) {
      if (lastNoteId && ev.kind === "note") addTie(lastNoteId, id, "tie");
      else errors.push(`\u5EF6\u97F3\u7EBF\u5FC5\u987B\u8FDE\u63A5\u4E24\u4E2A\u97F3\u7B26\uFF1A${core}`);
    }
    pendingTie = tieMark === "~";
    events.push(ev);
    byId.set(id, ev);
    if (ev.kind === "note") {
      lastNoteId = id;
      const s = slurStack[slurStack.length - 1];
      if (s) {
        if (s.last && s.last !== id) addTie(s.last, id, "slur");
        s.last = id;
        s.notes += 1;
      }
    } else {
      lastNoteId = null;
    }
  };
  const openSlur = () => {
    slurStack.push({ last: null, notes: 0 });
  };
  const closeSlur = () => {
    const s = slurStack.pop();
    if (!s) {
      errors.push("\u591A\u4F59\u7684 )\uFF0C\u6CA1\u6709\u5BF9\u5E94\u7684 (");
      return;
    }
    if (s.notes < 2) errors.push("\u8FDE\u97F3\u7EBF\u81F3\u5C11\u8981\u62EC\u4F4F\u4E24\u4E2A\u97F3");
  };
  const openGroup = () => {
    if (currentGroup) errors.push("\u62CD\u5185\u7EC4\u4E0D\u80FD\u5D4C\u5957");
    const id = `g${++groupSeq}`;
    const g = { id, totalTicks: 0, memberIds: [] };
    groups.push(g);
    currentGroup = g;
  };
  const closeGroup = () => {
    if (!currentGroup) {
      errors.push("\u591A\u4F59\u7684 >\uFF0C\u6CA1\u6709\u5BF9\u5E94\u7684 <");
      return;
    }
    if (currentGroup.memberIds.length === 0) {
      errors.push("\u62CD\u5185\u7EC4\u4E3A\u7A7A\uFF0C< > \u4E4B\u95F4\u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u97F3");
    }
    let sum = 0;
    for (const id of currentGroup.memberIds) {
      const m = byId.get(id);
      if (m && (m.kind === "note" || m.kind === "rest")) sum += m.ticks;
    }
    currentGroup.totalTicks = sum;
    if (modern) {
      const maxTicks = !currentGroup.tuplet ? groupTicks(currentBeat) : TICKS_PER_BEAT;
      if (sum > maxTicks) errors.push(`\u62CD\u7EC4\u65F6\u503C\u8D85\u8FC7 ${maxTicks / TICKS_PER_BEAT} \u62CD\uFF1B\u4E09\u8FDE\u97F3\u7701\u5199\u5FC5\u987B\u662F <3: 1 2 3>\uFF0C\u5176\u4ED6\u60C5\u51B5\u8BF7\u660E\u786E\u6BCF\u97F3\u65F6\u503C`);
      if (currentGroup.tuplet && currentGroup.memberIds.length !== currentGroup.tuplet) errors.push(`${currentGroup.tuplet} \u8FDE\u97F3\u9700\u8981 ${currentGroup.tuplet} \u4E2A\u6210\u5458`);
    }
    currentGroup = null;
  };
  const pushBarline = (style, partial = false, hidden = false) => {
    if (currentGroup) {
      errors.push("\u62CD\u5185\u7EC4\u4E0D\u5F97\u8DE8\u5C0F\u8282\uFF0C\u8BF7\u5148\u7528 > \u6536\u5C3E");
      currentGroup = null;
    }
    const id = nextId();
    const ev = partial ? { id, kind: "barline", style, partial: true } : { id, kind: "barline", style };
    if (hidden) ev.hidden = true;
    events.push(ev);
    byId.set(id, ev);
    if (!pendingTie || style === "final") lastNoteId = null;
  };
  const barrier = () => {
    if (currentGroup) {
      errors.push("\u62CD\u5185\u7EC4\u4E0D\u5F97\u8DE8\u53CD\u590D\u8BB0\u53F7\uFF0C\u8BF7\u5148\u7528 > \u6536\u5C3E");
      currentGroup = null;
    }
    lastNoteId = null;
  };
  const pushSimple = (ev) => {
    events.push(ev);
    byId.set(ev.id, ev);
  };
  const pushRepeatBarline = (repeat, times) => {
    barrier();
    const ev = { id: nextId(), kind: "barline", style: "single", repeat };
    if (repeat === "end") ev.times = times ?? 2;
    pushSimple(ev);
  };
  const lastBarline = () => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.kind === "barline") return e;
    }
    return void 0;
  };
  const markVolta = (numbers, open) => {
    const bar = lastBarline();
    if (!bar) {
      errors.push(`\u623F\u5B50 [${numbers.join(",")}] \u524D\u9762\u6CA1\u6709\u5C0F\u8282\u7EBF\uFF08\u623F\u5B50\u8981\u5199\u5728\u5C0F\u8282\u7EBF\u540E\u9762\uFF0C\u5982 | [1] \u2026\uFF09`);
      return;
    }
    if (bar.volta) {
      errors.push(
        `\u7B2C ${bar.volta.join(",")} \u623F\u4E0E [${numbers.join(",")}] \u623F\u4E4B\u95F4\u7F3A\u5C11\u5C0F\u8282\u7EBF\uFF08\u4E24\u4E2A\u623F\u5B50\u5FC5\u987B\u5404\u81EA\u8D77\u5728\u4E00\u6839\u5C0F\u8282\u7EBF\u4E0A\uFF09`
      );
      return;
    }
    bar.volta = numbers;
    if (open) bar.voltaOpen = true;
  };
  for (const line of body) {
    const tokens = line.replace(/~/g, "~ ").split(/\s+/).filter(Boolean);
    for (let raw of tokens) {
      const deco = /^\(([^()]+)\)$/.exec(raw);
      if (deco && /[^\d\s/^~.vVtT<>|#\-]/.test(deco[1])) {
        const id = nextId();
        const ev = { id, kind: "directive", type: "text", value: deco[1] };
        events.push(ev);
        byId.set(id, ev);
        continue;
      }
      const opens = [];
      while (raw.startsWith("(") || raw.startsWith("<")) {
        opens.push(raw[0] === "(" ? "slur" : "group");
        raw = raw.slice(1);
      }
      for (const t of opens) {
        if (t === "slur") openSlur();
        else openGroup();
      }
      const closes = [];
      while (raw.endsWith(")") || raw.endsWith(">") && (topGroup() !== null || raw.length === 1)) {
        closes.push(raw[raw.length - 1] === ")" ? "slur" : "group");
        raw = raw.slice(0, -1);
      }
      closes.reverse();
      if (raw !== "" && /^\d+:$/.test(raw)) {
        const g = topGroup();
        if (g && g.memberIds.length === 0) {
          g.tuplet = Number(raw.slice(0, -1));
          raw = "";
        }
      }
      let graceBefore;
      let graceAfter;
      if (raw !== "|{partial}" && raw !== "") {
        if (raw.startsWith("{")) {
          const end = raw.indexOf("}");
          if (end < 0) {
            errors.push(`\u501A\u97F3\u7F3A\u5C11\u53F3\u82B1\u62EC\u53F7\uFF1A${raw}`);
          } else {
            graceBefore = parseGraceNotes(raw.slice(1, end)) ?? void 0;
            if (!graceBefore) errors.push(`\u501A\u97F3\u5199\u6CD5\u65E0\u6CD5\u8BC6\u522B\uFF08\u5E94\u4E3A {5} \u6216 {65}\uFF09\uFF1A${raw}`);
            raw = raw.slice(end + 1);
          }
        }
        if (raw.endsWith("}") && !raw.startsWith("|")) {
          const start = raw.lastIndexOf("{");
          if (start < 0) {
            errors.push(`\u501A\u97F3\u7F3A\u5C11\u5DE6\u82B1\u62EC\u53F7\uFF1A${raw}`);
          } else {
            graceAfter = parseGraceNotes(raw.slice(start + 1, -1)) ?? void 0;
            if (!graceAfter) errors.push(`\u501A\u97F3\u5199\u6CD5\u65E0\u6CD5\u8BC6\u522B\uFF08\u5E94\u4E3A {5} \u6216 {65}\uFF09\uFF1A${raw}`);
            raw = raw.slice(0, start);
          }
        }
      }
      if (raw !== "") {
        if (/^拍/.test(raw) || raw === "\u6362\u884C" || raw === "\u5206\u9875") {
          const bar = events[events.length - 1];
          if (!modern || bar?.kind !== "barline") errors.push(`${raw} \u9700\u8981 @format 3\uFF0C\u5E76\u7D27\u63A5\u5C0F\u8282\u7EBF\u4E66\u5199`);
          else if (raw.startsWith("\u62CD")) {
            const beat = raw.slice(1);
            if (!validMeter(beat)) errors.push(`\u62CD\u53F7\u4E0D\u5408\u6CD5\uFF1A${beat}`);
            else {
              bar.beatAfter = beat;
              currentBeat = beat;
            }
          } else bar.breakAfter = raw === "\u5206\u9875" ? "page" : "line";
        } else if (raw === "cresc[" || raw === "dim[") {
          if (!modern) errors.push("\u8DE8\u97F3\u529B\u5EA6\u8303\u56F4\u9700\u8981 @format 3");
          else if (hairpinStart) errors.push("\u6E10\u5F3A/\u6E10\u5F31\u8303\u56F4\u4E0D\u80FD\u5D4C\u5957");
          else hairpinStart = { kind: raw === "cresc[" ? "cresc" : "dim", from: events.length };
        } else if (raw === "]hairpin") {
          if (!hairpinStart) errors.push("\u529B\u5EA6\u8303\u56F4\u7F3A\u5C11 cresc[ \u6216 dim[");
          else {
            const notes = events.slice(hairpinStart.from).filter((e) => e.kind === "note");
            if (notes.length < 2) errors.push("\u8DE8\u97F3\u529B\u5EA6\u8303\u56F4\u81F3\u5C11\u9700\u8981\u4E24\u4E2A\u97F3\u7B26");
            else {
              notes[0].hairpin = hairpinStart.kind;
              notes[0].hairpinTo = notes[notes.length - 1].id;
            }
            hairpinStart = null;
          }
        } else if (raw === "|*") pushBarline("single", false, true);
        else if (raw === "|") pushBarline("single");
        else if (raw === "||") pushBarline("final");
        else if (raw === "|{partial}") pushBarline("single", true);
        else if (raw === "'") {
          errors.push("\u4E0D\u518D\u652F\u6301\u6362\u6C14\u8BB0\u53F7 '\uFF08\u8BF7\u6539\u7528\u97F3\u7B26\u540E\u7F00 V\uFF0C\u5982 5V\uFF09");
        } else if (/^转\s*(\S+)$/.test(raw)) {
          const mKey = /^转\s*(\S+)$/.exec(raw);
          const norm = normalizeKey(mKey[1]);
          if (norm) pendingKey = norm;
          else errors.push(`\u8F6C\u8C03\u8BB0\u53F7\u65E0\u6CD5\u8BC6\u522B\uFF08\u5E94\u4E3A 1=C \u5F62\u5F0F\uFF09\uFF1A${raw}`);
        } else if (DYNAMIC_RE.test(raw)) {
          const id = nextId();
          const ev = { id, kind: "directive", type: "dynamic", value: raw };
          events.push(ev);
          byId.set(id, ev);
        } else if (raw === "|:") {
          pushRepeatBarline("start");
        } else if (/^:\|\d*$/.test(raw)) {
          pushRepeatBarline("end", raw.length > 2 ? Number(raw.slice(2)) : 2);
        } else if (/^\[\d+(,\d+)*\]$/.test(raw)) {
          markVolta(raw.slice(1, -1).split(",").map(Number), false);
        } else if (/^\[\d+(,\d+)*$/.test(raw)) {
          markVolta(raw.slice(1).split(",").map(Number), true);
        } else if (/^\$(s|x|t|f|ds|dc)$/i.test(raw)) {
          const mark = { s: "segno", x: "coda", t: "tocoda", f: "fine", ds: "ds", dc: "dc" }[raw.slice(1).toLowerCase()];
          const id = nextId();
          const ev = { id, kind: "jump", mark };
          events.push(ev);
          byId.set(id, ev);
        } else if (raw.startsWith("$")) {
          errors.push(
            `\u8DF3\u8F6C\u8BB0\u53F7\u65E0\u6CD5\u8BC6\u522B\uFF1A${raw}\uFF08\u53EF\u7528 $s=\u{1D10B} \xB7 $x=\u2295 \xB7 $t=To\u2295 \xB7 $f=Fine \xB7 $ds=D.S. \xB7 $dc=D.C.\uFF09`
          );
        } else if (/[()\u4e00-\u9fff]/.test(raw)) {
          errors.push(
            `( ) \u9700\u8981\u6210\u5BF9\u5199\u5728\u540C\u4E00\u4E2A\u8BB0\u53F7\u91CC\uFF1A\u6807\u6CE8\u6BB5\u843D\u7528 (\u524D\u594F) \u8FD9\u79CD\u7EAF\u6587\u5B57\uFF1B\u8FDE\u97F3\u7EBF\u8981\u5305\u4F4F\u97F3\u7B26\uFF0C\u5982 (5 6 5)\u3002\u6536\u5230\u7684\u662F\uFF1A${raw}`
          );
        } else if (/^8(?:[.\-/]|$)/.test(raw)) {
          const at = events.length;
          pushTimed(`0${raw.slice(1)}`, graceBefore, graceAfter, true);
          const last = events[at];
          if (last?.kind !== "rest") errors.push(`\u9690\u85CF\u4F11\u6B62\u5199\u6CD5\u65E0\u6CD5\u8BC6\u522B\uFF1A${raw}`);
        } else {
          pushTimed(raw, graceBefore, graceAfter);
        }
      }
      for (const t of closes) {
        if (t === "slur") closeSlur();
        else closeGroup();
      }
    }
  }
  for (let i = slurStack.length - 1; i >= 0; i -= 1) {
    errors.push("\u8C31\u9762\u7ED3\u675F\u65F6 ( \u672A\u95ED\u5408");
    slurStack.pop();
  }
  if (currentGroup) {
    errors.push("\u8C31\u9762\u7ED3\u675F\u65F6 < \u672A\u95ED\u5408");
    closeGroup();
  }
  if (hairpinStart) errors.push("\u6E10\u5F3A/\u6E10\u5F31\u8303\u56F4\u7F3A\u5C11 ]hairpin \u6536\u5C3E");
  if (events.length === 0) errors.push("\u8C31\u9762\u4E3A\u7A7A");
  if (pendingKey) {
    errors.push(`\u8F6C\u8C03\u8BB0\u53F7 \u8F6C${pendingKey} \u540E\u9762\u6CA1\u6709\u97F3\u7B26\uFF0C\u65E0\u6CD5\u751F\u6548\uFF08\u8F6C\u8C03\u5FC5\u987B\u5199\u5728\u5B83\u751F\u6548\u7684\u7B2C\u4E00\u4E2A\u97F3\u524D\u9762\uFF09`);
    pendingKey = void 0;
  }
  {
    const kept = [];
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      const next = events[i + 1];
      if (e.kind === "directive" && e.type === "dynamic" && next && next.kind === "note") {
        if (e.value === "cresc" || e.value === "dim") {
          next.hairpin = e.value;
          continue;
        }
        if (!next.dynamic) {
          next.dynamic = e.value;
          continue;
        }
      }
      kept.push(e);
    }
    events.length = 0;
    events.push(...kept);
  }
  let score2 = events.length || modern ? { version: 2, meta, events, groups, ...modern ? { format: 3 } : {} } : null;
  if (score2 && lyricNumbers.size) {
    const applied = applyLyrics(score2, Array.from({ length: lyrics.length }, (_, i) => lyrics[i] ?? ""));
    score2 = applied.score;
    errors.push(...applied.errors);
  }
  return {
    score: score2,
    errors
  };
}
function renderDuration(ticks, dot) {
  const dots = dot ?? 0;
  const factor = dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75;
  const undotted = ticks / factor;
  if (!Number.isInteger(undotted)) {
    throw new Error(`tick ${ticks} \u4E0E\u9644\u70B9\u6570 ${dots} \u4E0D\u81EA\u6D3D\uFF0C\u65E0\u6CD5\u8FD8\u539F\u5199\u6CD5`);
  }
  let base = undotted;
  let dashes = 0;
  while (base > TICKS_PER_BEAT) {
    base -= TICKS_PER_BEAT;
    dashes += 1;
  }
  const div = TICK_DIVISIONS[base];
  if (div === void 0) {
    throw new Error(`tick ${ticks}\uFF08\u53BB\u9644\u70B9\u540E ${base}\uFF09\u6CA1\u6709\u5BF9\u5E94\u7684\u9664\u6CD5\u8BB0\u53F7\uFF0C\u65E0\u6CD5\u65E0\u635F\u8FD8\u539F`);
  }
  let s = dots === 1 ? "." : dots === 2 ? ".." : "";
  if (div !== 1) s += `/${div}`;
  return s + "-".repeat(dashes);
}
function renderTimed(ev, tieOut, modern = false, explicitDuration = false) {
  const duration = renderDuration(ev.ticks, ev.dot ?? 0) || (explicitDuration ? "/1" : "");
  const short = modern ? duration.replace(/\/(2|4|8)(?!\d)/g, (_, n2) => "/".repeat(Math.log2(Number(n2)))) : duration;
  if (ev.kind === "rest") return `${ev.hidden ? "8" : "0"}${short}`;
  const n = ev;
  const marks = n.octave > 0 ? "^".repeat(n.octave) : "v".repeat(-n.octave);
  const acc = n.accidental ?? "";
  const body = `${acc}${n.degree}${marks}${short}`;
  const arts = (n.articulations ?? []).map(
    (a) => a === "staccato" ? "!" : a === "tenuto" ? "=" : a === "accent" ? ">" : ""
  ).join("");
  const ferm = n.fermata ? "@" : "";
  const tong = n.tongue === "K" ? "k" : n.tongue === "T" ? "t" : "";
  const tech = (n.techniques ?? []).map((v) => TECHNIQUE_OF[v] ?? "").join("");
  const gb = n.graceBefore?.length ? `{${n.graceBefore.map(renderGraceNote).join("")}}` : "";
  const ga = n.graceAfter?.length ? `{${n.graceAfter.map(renderGraceNote).join("")}}` : "";
  return `${gb}${body}${tieOut ? "~" : ""}${arts}${ferm}${tong}${tech}${ga}`;
}
function serializeDsl(score2) {
  if (score2.part || score2.parts?.length) {
    const parts = scoreParts(score2);
    const header = serializeSingle(partScore(score2, parts[0].id)).split("\n\n")[0];
    return `${header}

${parts.map((part) => {
      const body = serializeSingle(partScore(score2, part.id)).split("\n\n").slice(1).join("\n\n");
      const names = part.lyricNames?.length ? `
@lyricNames ${JSON.stringify(part.lyricNames)}` : "";
      return `@part ${part.id} ${JSON.stringify(part.name)}
@mix ${part.gain} ${part.muted ? "off" : "on"} ${part.solo ? "solo" : "all"}${names}
${body}`;
    }).join("\n\n")}`;
  }
  return serializeSingle(score2);
}
function serializeSingle(score2) {
  const head = [
    `@title ${score2.meta.title}`,
    `@key ${score2.meta.key}`,
    `@beat ${score2.meta.beat}`,
    `@bpm ${score2.meta.bpm}`,
    `@patch ${score2.meta.patch}`
  ];
  if (score2.format === 3) head.unshift("@format 3");
  if (score2.meta.patchName) head.push(`@patchName ${score2.meta.patchName}`);
  if (score2.meta.sub) head.push(`@sub ${score2.meta.sub}`);
  for (const line of score2.meta.notes ?? []) {
    if (line) head.push(`@note ${line}`);
  }
  if (score2.meta.fontSize !== void 0) head.push(`@size ${score2.meta.fontSize}`);
  if (score2.meta.letterSpacing !== void 0) head.push(`@space ${score2.meta.letterSpacing}`);
  if (score2.meta.showMeasureNumbers === false) head.push("@measureNo off");
  const byId = new Map(score2.events.map((e) => [e.id, e]));
  const nextOf = /* @__PURE__ */ new Map();
  score2.events.forEach((e, i) => {
    let j = i + 1;
    while (score2.events[j]?.kind === "barline") {
      const bar = score2.events[j];
      if (bar.style === "final" || bar.repeat || bar.volta) break;
      j += 1;
    }
    if (j < score2.events.length) nextOf.set(e.id, score2.events[j]);
  });
  const tieOut = (from) => {
    if (from.kind !== "note") return false;
    const next = nextOf.get(from.id);
    if (!next) return false;
    return (from.ties ?? []).some((t) => t.to === next.id && t.kind === "tie");
  };
  const idxOf = new Map(score2.events.map((e, i) => [e.id, i]));
  const slurNext = /* @__PURE__ */ new Map();
  for (const e of score2.events) {
    if (e.kind !== "note") continue;
    for (const t of e.ties ?? []) if (t.kind === "slur") slurNext.set(e.id, t.to);
  }
  const slurSpan = /* @__PURE__ */ new Map();
  {
    const isTarget = new Set(slurNext.values());
    for (const e of score2.events) {
      if (e.kind !== "note" || !slurNext.has(e.id) || isTarget.has(e.id)) continue;
      const seen = /* @__PURE__ */ new Set();
      let cur = e.id;
      let hi = idxOf.get(e.id);
      while (cur !== void 0 && !seen.has(cur)) {
        seen.add(cur);
        hi = Math.max(hi, idxOf.get(cur) ?? hi);
        cur = slurNext.get(cur);
      }
      slurSpan.set(idxOf.get(e.id), hi);
    }
  }
  const slurEndsAt = /* @__PURE__ */ new Map();
  for (const [lo, hi] of slurSpan) {
    const arr = slurEndsAt.get(hi);
    if (arr) arr.push(lo);
    else slurEndsAt.set(hi, [lo]);
  }
  const out = [];
  const emitted = /* @__PURE__ */ new Set();
  const hairpinEnds = /* @__PURE__ */ new Map();
  for (const e of score2.events) if (e.kind === "note" && e.hairpinTo) hairpinEnds.set(e.hairpinTo, (hairpinEnds.get(e.hairpinTo) ?? 0) + 1);
  const rangeStart = (e) => e.kind === "note" && e.hairpin && e.hairpinTo ? `${e.hairpin}[ ` : "";
  const rangeEnd = (e) => " ]hairpin".repeat(hairpinEnds.get(e.id) ?? 0);
  for (const ev of score2.events) {
    if (emitted.has(ev.id)) continue;
    if ((ev.kind === "note" || ev.kind === "rest") && ev.groupId) {
      const g = score2.groups.find((x) => x.id === ev.groupId && !x.auto);
      if (g && g.memberIds[0] === ev.id) {
        const members = g.memberIds.map((id) => byId.get(id)).filter((m) => !!m && (m.kind === "note" || m.kind === "rest"));
        const inner = members.map((m) => {
          const mi = idxOf.get(m.id);
          const pre = slurSpan.has(mi) ? "(" : "";
          const post = (slurEndsAt.get(mi) ?? []).length > 0 ? ")" : "";
          const dyn = m.kind === "note" ? [m.dynamic, m.hairpinTo ? void 0 : m.hairpin].filter(Boolean).join(" ") : "";
          const kc = m.kind === "note" && m.keyChange ? `\u8F6C${m.keyChange} ` : "";
          return `${rangeStart(m)}${kc}${dyn ? `${dyn} ` : ""}${pre}${renderTimed(m, tieOut(m), score2.format === 3, score2.format === 3 && g.tuplet === 3)}${post}${rangeEnd(m)}`;
        }).join(" ");
        out.push(`<${g.tuplet ? `${g.tuplet}: ` : ""}${inner}>`);
        members.forEach((m) => emitted.add(m.id));
        continue;
      }
      if (g) continue;
    }
    switch (ev.kind) {
      case "note":
      case "rest": {
        const i = idxOf.get(ev.id);
        const pre = slurSpan.get(i) !== void 0 ? "(" : "";
        const post = (slurEndsAt.get(i) ?? []).length > 0 ? ")" : "";
        const dyn = ev.kind === "note" ? [ev.dynamic, ev.hairpinTo ? void 0 : ev.hairpin].filter(Boolean).join(" ") : "";
        const kc = ev.kind === "note" && ev.keyChange ? `\u8F6C${ev.keyChange} ` : "";
        out.push(`${rangeStart(ev)}${kc}${dyn ? `${dyn} ` : ""}${pre}${renderTimed(ev, tieOut(ev), score2.format === 3)}${post}${rangeEnd(ev)}`);
        emitted.add(ev.id);
        break;
      }
      case "barline": {
        let tok;
        if (ev.hidden && ev.style === "single" && !ev.repeat) tok = "|*";
        else if (ev.repeat === "start") tok = "|:";
        else if (ev.repeat === "end") tok = ev.times && ev.times > 2 ? `:|${ev.times}` : ":|";
        else if (ev.style === "final") tok = "||";
        else if (ev.partial) tok = "|{partial}";
        else tok = "|";
        out.push(tok);
        if (ev.beatAfter) out.push(`\u62CD${ev.beatAfter}`);
        if (ev.breakAfter) out.push(ev.breakAfter === "page" ? "\u5206\u9875" : "\u6362\u884C");
        if (ev.volta) out.push(ev.voltaOpen ? `[${ev.volta.join(",")}` : `[${ev.volta.join(",")}]`);
        emitted.add(ev.id);
        break;
      }
      case "jump": {
        const tok = { segno: "$s", coda: "$x", tocoda: "$t", fine: "$f", ds: "$ds", dc: "$dc" }[ev.mark];
        out.push(tok);
        emitted.add(ev.id);
        break;
      }
      case "directive":
        out.push(ev.type === "text" ? `(${ev.value})` : ev.value);
        emitted.add(ev.id);
        break;
      default:
        break;
    }
  }
  const rows = lyricRows(score2).map((row, i) => `\u6B4C\u8BCD${i + 1}: ${row}`);
  return `${head.join("\n")}

${out.join(" ")}
${rows.length ? `${rows.join("\n")}
` : ""}`;
}

// src/v2/ensembleLayout.ts
function layoutEnsemble(score2, opts, layoutSingle) {
  const parts = scoreParts(score2);
  const singles = parts.map((p) => partScore(score2, p.id));
  const measured = singles.map((s) => layoutSingle(s, { ...opts, contentWidth: 1e9, showTitle: false }));
  const k = measured[0].glyph.fontSize / 21;
  const rowH = opts.lineHeight ?? Math.max(...measured.map((s) => s.lineHeight));
  const left = (opts.padding ?? 40) + Math.min(112, Math.max(52, ...parts.map((p) => [...p.name].length * 12))) * k;
  const right = opts.contentWidth - (opts.padding ?? 40);
  const available = Math.max(160, right - left);
  const tables = singles.map((s) => partMeasures(s.events));
  const count = Math.max(1, ...tables.map((ms) => ms.length));
  const entries = measured.map((layout, pi) => {
    const byId = new Map(layout.lines.flatMap((line) => line.items).map((it) => [it.eventId, it]));
    return tables[pi].flatMap((m, mi) => {
      let tick = 0;
      return singles[pi].events.slice(m.from, m.to).flatMap((e) => {
        const item = byId.get(e.id);
        const at = tick;
        if ("ticks" in e) tick += e.ticks;
        return item ? [{ item, tick: at, measure: mi, lead: (item.accW ?? 0) + (item.graceInk ?? 0) }] : [];
      });
    });
  });
  const local = /* @__PURE__ */ new Map();
  const widths = [];
  for (let mi = 0; mi < count; mi++) {
    const current = entries.flat().filter((e) => e.measure === mi);
    const end = Math.max(0, ...tables.map((ms) => ms[mi]?.ticks ?? 0));
    const dashTicks = current.flatMap((e) => Array.from({ length: e.item.dashes ?? 0 }, (_, i) => e.tick + (i + 1) * TICKS_PER_BEAT));
    const ticks = [.../* @__PURE__ */ new Set([0, end, ...dashTicks, ...current.filter((e) => e.item.kind !== "barline").map((e) => e.tick)])].sort((a, b) => a - b);
    const onsets = /* @__PURE__ */ new Map();
    const leads = /* @__PURE__ */ new Map();
    let x = 0;
    for (let ti = 0; ti < ticks.length; ti++) {
      const tick = ticks[ti];
      const here = current.filter((e) => e.tick === tick && e.item.kind !== "barline");
      const pre = Math.max(0, ...parts.map((p, pi) => entries[pi].filter((e) => e.measure === mi && e.tick === tick && e.item.kind !== "note" && e.item.kind !== "rest" && e.item.kind !== "barline").reduce((sum, e) => sum + e.item.w, 0)));
      const opening = tick === 0 ? Math.max(0, ...current.filter((e) => e.tick === 0 && e.item.kind === "barline").map((e) => e.item.w)) : 0;
      const lead = Math.max(0, ...here.map((e) => e.lead));
      onsets.set(tick, x + pre + opening + lead);
      leads.set(tick, lead);
      const step = ticks[ti + 1] === void 0 ? 0 : ticks[ti + 1] - tick;
      const ink = Math.max(0, ...here.filter((e) => e.item.kind === "note" || e.item.kind === "rest").map((e) => 26 * k + e.lead + (e.item.graceAfter?.length ?? 0) * measured[0].glyph.graceW));
      x += pre + opening + Math.max(ink, step * (opts.unit ?? 1.3) + (step > 0 ? 8 * k : 0));
    }
    const barW = Math.max(20 * k, ...current.filter((e) => e.item.kind === "barline" && e.tick > 0).map((e) => e.item.w));
    const close = x;
    const preUsed = /* @__PURE__ */ new Map();
    for (const e of current) {
      const it = e.item;
      if (it.kind === "barline") local.set(it.eventId, { x: e.tick === 0 ? 0 : close, w: barW });
      else if (it.kind === "note" || it.kind === "rest") {
        const start = onsets.get(e.tick) - e.lead;
        const until = e.tick + (it.ticks ?? 0);
        const endX = onsets.get(until) ?? close;
        const dashXs = Array.from({ length: it.dashes ?? 0 }, (_, i) => onsets.get(e.tick + (i + 1) * TICKS_PER_BEAT) + measured[0].glyph.pad + measured[0].glyph.nominalWidth / 2);
        local.set(it.eventId, { x: start, w: Math.max(26 * k + e.lead, endX - start - 3 * k), ...dashXs.length ? { dashXs } : {} });
      } else {
        const pi = entries.findIndex((list) => list.includes(e));
        const key = `${pi}:${e.tick}`;
        const used2 = preUsed.get(key) ?? 0;
        const preWidth = entries[pi].filter((a) => a.measure === mi && a.tick === e.tick && a.item.kind !== "note" && a.item.kind !== "rest" && a.item.kind !== "barline").reduce((sum, a) => sum + a.item.w, 0);
        local.set(it.eventId, { x: onsets.get(e.tick) - (leads.get(e.tick) ?? 0) - preWidth + used2, w: it.w });
        preUsed.set(key, used2 + it.w);
      }
    }
    widths.push(Math.max(60 * k, close + barW));
  }
  const systemOf = [];
  const offsetOf = [];
  let system = 0;
  let used = 0;
  for (let mi = 0; mi < count; mi++) {
    const previous = mi > 0 ? singles[0].events[tables[0][mi - 1]?.to - 1] : void 0;
    if (used > 0 && (used + widths[mi] > available || previous?.kind === "barline" && previous.breakAfter)) {
      system++;
      used = 0;
    }
    systemOf.push(system);
    offsetOf.push(used);
    used += widths[mi];
  }
  const positions = /* @__PURE__ */ new Map();
  for (const list of entries) for (const e of list) {
    const p = local.get(e.item.eventId);
    const offset = left + offsetOf[e.measure];
    positions.set(e.item.eventId, { x: offset + p.x, w: p.w, line: systemOf[e.measure], ...p.dashXs ? { dashXs: p.dashXs.map((x) => offset + x) } : {} });
  }
  const placed = singles.map((s, pi) => layoutSingle(s, { ...opts, lineHeight: rowH, positions, showTitle: pi === 0 && opts.showTitle !== false }));
  const title = placed[0].title;
  const startY = 20 + (title?.height ?? 0);
  const systemH = parts.length * rowH + 24 * k;
  const lines = [];
  const hitIndex = [];
  const systems = [];
  for (let si = 0; si <= system; si++) {
    const from = lines.length;
    for (let pi = 0; pi < parts.length; pi++) {
      const source = placed[pi].lines.find((line2) => line2.items.some((it) => positions.get(it.eventId)?.line === si));
      const y = startY + si * systemH + pi * rowH + rowH / 2;
      const line = source ? { ...source, index: lines.length, y, partId: parts[pi].id, partName: parts[pi].name, system: si } : {
        index: lines.length,
        y,
        items: [],
        beams: [],
        arcs: [],
        badges: [],
        tuplets: [],
        voltas: [],
        partId: parts[pi].id,
        partName: parts[pi].name,
        system: si
      };
      lines.push(line);
      if (source) {
        const ids = new Set(source.items.map((it) => it.eventId));
        hitIndex.push(...placed[pi].hitIndex.filter((b) => ids.has(b.eventId)).map((b) => ({ ...b, y: b.y + y - source.y })));
      }
    }
    systems.push({ from, to: lines.length, top: lines[from].y - rowH / 2, bottom: lines[lines.length - 1].y + rowH / 2, bracketX: left - 14 * k });
  }
  return { ...placed[0], lines, hitIndex, systems, width: Math.max(opts.contentWidth, left + Math.max(...widths) + (opts.padding ?? 40)), height: startY + (system + 1) * systemH + 24 };
}

// src/v2/layout.ts
var PENCIL_SIZE = 18;
function estimateWidth(text2, fontPx) {
  let w = 0;
  for (const ch of text2) w += (ch.codePointAt(0) ?? 0) > 11904 ? fontPx : fontPx * 0.55;
  return w;
}
var GLYPH = {
  pad: 5,
  after: 5,
  nominalWidth: 13,
  dotR: 2.2,
  dotGap: 7,
  dashW: 10,
  dashGap: 15,
  graceW: 13,
  graceGap: 3,
  glyphRight: 22,
  accW: 9,
  octaveStep: 7,
  octaveBase: 17,
  octaveClear: 7,
  beamLine: 1.6,
  beamTop: 15,
  beamStep: 5.5,
  barHalf: 21,
  arcBase: 24,
  arcTieBase: 19,
  selHalfH: 14,
  caretHalf: 16,
  markTop: 44,
  tupletDrop: 27,
  markBottom: 34,
  lineHeight: 86,
  caretTail: 14,
  fontSize: 21
};
function deriveGlyph(fontSize) {
  const k = Math.min(56, Math.max(12, fontSize)) / 21;
  const s = (v) => v * k;
  return {
    pad: s(GLYPH.pad),
    after: s(GLYPH.after),
    nominalWidth: s(GLYPH.nominalWidth),
    dotR: s(GLYPH.dotR),
    dotGap: s(GLYPH.dotGap),
    dashW: s(GLYPH.dashW),
    dashGap: s(GLYPH.dashGap),
    graceW: s(GLYPH.graceW),
    graceGap: s(GLYPH.graceGap),
    glyphRight: s(GLYPH.glyphRight),
    accW: s(GLYPH.accW),
    octaveStep: s(GLYPH.octaveStep),
    octaveBase: s(GLYPH.octaveBase),
    octaveClear: s(GLYPH.octaveClear),
    beamLine: s(GLYPH.beamLine),
    beamTop: s(GLYPH.beamTop),
    beamStep: s(GLYPH.beamStep),
    barHalf: s(GLYPH.barHalf),
    arcBase: s(GLYPH.arcBase),
    arcTieBase: s(GLYPH.arcTieBase),
    selHalfH: s(GLYPH.selHalfH),
    caretHalf: s(GLYPH.caretHalf),
    markTop: s(GLYPH.markTop),
    tupletDrop: s(GLYPH.tupletDrop),
    markBottom: s(GLYPH.markBottom),
    lineHeight: s(GLYPH.lineHeight),
    caretTail: s(GLYPH.caretTail),
    fontSize
  };
}
function isBarrier(ev) {
  return ev.kind === "barline";
}
function beatsPerMeasureOf(beat) {
  const [n, d] = beat.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 4;
  return n * (4 / d);
}
function dashCountOf(ticks, dot) {
  const factor = dot === 0 ? 1 : dot === 1 ? 1.5 : 1.75;
  let base = ticks / factor;
  if (!Number.isInteger(base)) return 0;
  let dashes = 0;
  while (base > TICKS_PER_BEAT) {
    base -= TICKS_PER_BEAT;
    dashes += 1;
  }
  return dashes;
}
function layoutScore(score2, opts) {
  if (score2.parts?.length) return layoutEnsemble(score2, opts, layoutScore);
  const unit = opts.unit ?? 1.3;
  const fontSize = opts.fontSize ?? score2.meta.fontSize ?? 21;
  const glyph = deriveGlyph(fontSize);
  const k = glyph.fontSize / 21;
  const spacing = opts.letterSpacing ?? score2.meta.letterSpacing ?? 0;
  const verses = Math.max(score2.part?.lyricNames?.length ?? 0, 0, ...score2.events.map((e) => e.kind === "note" ? e.lyrics?.length ?? 0 : 0));
  const lyricBottom = (score2.events.some((e) => e.kind === "note" && e.hairpinTo) ? 64 : 44) + verses * 24;
  const lineHeight = opts.lineHeight ?? Math.max(glyph.lineHeight + (score2.events.some((e) => e.kind === "note" && e.hairpinTo) ? 24 * k : 0), verses ? (lyricBottom + 8) * 2 * k : 0);
  const padTop = 20;
  const padBottom = 24;
  const padding = opts.padding ?? 40;
  const maxX = Math.max(240, opts.contentWidth - padding * 2);
  const meta = score2.meta;
  const title = opts.showTitle === false ? null : (() => {
    const y = padTop + 16;
    const subY = y + 28;
    const colY = subY + 10;
    const rowH = 18;
    const tempoY = colY + 32;
    const rightLines = (meta.notes ?? []).slice(0, 4);
    return {
      title: meta.title,
      sub: meta.sub ?? "",
      key: meta.key,
      beat: meta.beat,
      tempo: `\u2669=${meta.bpm}`,
      rightLines,
      y,
      subY,
      colY,
      rowH,
      tempoY,
      // 左右两列对齐谱面音符的实际边缘：谱行从 padding 起画、
      // 行尾锚点在 contentWidth - padding（见下方 maxX / barX 的算法），
      // 谱头贴 0 / contentWidth 就会悬在音符外面
      leftX: padding,
      rightX: opts.contentWidth - padding,
      centerX: opts.contentWidth / 2,
      edit: {
        // 28 = 标题字号；+20 给图标留出与歌名的间距，别贴着字
        cx: opts.contentWidth / 2 + estimateWidth(meta.title, 28) / 2 + 20,
        cy: y,
        size: PENCIL_SIZE
      },
      // 谱头总高：两列谁伸得更低取谁，底边再留 20px 净空
      //（首行标记最高到中线上方 50px，别压住）
      height: Math.max(
        tempoY + 6,
        rightLines.length > 0 ? colY + 4 + (rightLines.length - 1) * rowH + 6 : 0
      ) + 20
    };
  })();
  const titleHeight = title ? title.height : 0;
  const byId = new Map(score2.events.map((e) => [e.id, e]));
  const groupById = new Map(score2.groups.map((g) => [g.id, g]));
  const groupOfEvent = /* @__PURE__ */ new Map();
  for (const g of score2.groups) {
    for (const id of g.memberIds) groupOfEvent.set(id, g.id);
  }
  const slurNext = /* @__PURE__ */ new Map();
  const slurCrossedBars = /* @__PURE__ */ new Set();
  {
    const idxOf = new Map(score2.events.map((e, i) => [e.id, i]));
    for (const ev of score2.events) {
      if (ev.kind !== "note") continue;
      for (const t of ev.ties ?? []) {
        if (t.kind !== "slur") continue;
        slurNext.set(ev.id, t.to);
        const a = idxOf.get(ev.id);
        const b = idxOf.get(t.to);
        if (a === void 0 || b === void 0) continue;
        for (let i = a + 1; i < b; i += 1) {
          if (score2.events[i].kind === "barline") slurCrossedBars.add(i);
        }
      }
    }
  }
  const slurChains = [];
  {
    const isTarget = new Set(slurNext.values());
    for (const head of slurNext.keys()) {
      if (isTarget.has(head)) continue;
      const chain = [];
      const seen = /* @__PURE__ */ new Set();
      let cur = head;
      while (cur !== void 0 && !seen.has(cur)) {
        chain.push(cur);
        seen.add(cur);
        cur = slurNext.get(cur);
      }
      if (chain.length >= 2) slurChains.push(chain);
    }
  }
  const accWidthOf = (ev) => ev.kind === "note" && ev.accidental ? glyph.accW : 0;
  const widths = score2.events.map((ev) => {
    let w = 0;
    if (ev.kind === "note" || ev.kind === "rest") {
      const graceCount = ev.kind === "note" ? (ev.graceBefore?.length ?? 0) + (ev.graceAfter?.length ?? 0) : 0;
      w = Math.max(26 * k, ev.ticks * unit + 10 * k) + accWidthOf(ev) + graceCount * glyph.graceW + spacing;
    } else if (isBarrier(ev)) {
      const bar = ev;
      const base = bar.style === "final" ? 26 : bar.repeat ? 24 : 20;
      w = (base + (bar.beatAfter ? 30 : 0)) * k + spacing;
    } else if (ev.kind === "directive" || ev.kind === "jump") w = 26 * k + spacing;
    return { ev, w: opts.positions?.get(ev.id)?.w ?? w };
  });
  let starts = [0];
  let x = 0;
  let lastBar = -1;
  let lastBarAny = -1;
  let lastGroupEnd = -1;
  let start = 0;
  for (let i = 0; i < widths.length; i += 1) {
    x += widths[i].w;
    if (x > maxX) {
      const cut = [lastBar, lastBarAny, lastGroupEnd].find((c) => c > start) ?? i + 1;
      starts.push(cut);
      start = cut;
      x = 0;
      for (let j = start; j <= i; j += 1) x += widths[j].w;
      lastBar = -1;
      lastBarAny = -1;
      lastGroupEnd = -1;
    }
    const ev = widths[i].ev;
    if (ev.kind === "barline" && ev.breakAfter && i + 1 < widths.length) {
      if (starts[starts.length - 1] !== i + 1) starts.push(i + 1);
      start = i + 1;
      x = 0;
      lastBar = lastBarAny = lastGroupEnd = -1;
      continue;
    }
    if (isBarrier(ev)) {
      const bar = ev;
      if (!bar.volta) {
        const isRepeatStart = bar.repeat === "start";
        lastBarAny = isRepeatStart ? i : i + 1;
        if (!slurCrossedBars.has(i)) lastBar = isRepeatStart ? i : i + 1;
      }
    }
    if (ev.kind === "note" || ev.kind === "rest") {
      const gid = groupOfEvent.get(ev.id);
      const g = gid ? groupById.get(gid) : void 0;
      if (g && g.memberIds[g.memberIds.length - 1] === ev.id) lastGroupEnd = i + 1;
    }
  }
  if (opts.positions) {
    starts = [0];
    for (let i = 1; i < widths.length; i++) {
      if (opts.positions.get(widths[i].ev.id)?.line !== opts.positions.get(widths[i - 1].ev.id)?.line) starts.push(i);
    }
  }
  const lines = [];
  const hitIndex = [];
  const voltaRunLast = /* @__PURE__ */ new Map();
  {
    let wall = -1;
    let nums = "";
    let last = -1;
    for (let i = 0; i < score2.events.length; i += 1) {
      const ev = score2.events[i];
      if (ev.kind !== "barline") continue;
      const n = ev.volta?.join(",") ?? "";
      if (n && n === nums) {
        last = i;
      } else {
        if (wall >= 0) voltaRunLast.set(wall, last);
        wall = n ? i : -1;
        nums = n;
        last = n ? i : -1;
      }
    }
    if (wall >= 0) voltaRunLast.set(wall, last);
  }
  const nextBarIdxOf = (i) => {
    for (let j = i + 1; j < score2.events.length; j += 1) {
      if (score2.events[j].kind === "barline") return j;
    }
    return -1;
  };
  const repeatPair = /* @__PURE__ */ new Map();
  {
    const stack = [];
    for (let i = 0; i < score2.events.length; i += 1) {
      const ev = score2.events[i];
      if (ev.kind !== "barline") continue;
      const r2 = ev.repeat;
      if (r2 === "start") stack.push(i);
      else if (r2 === "end") {
        const s = stack.pop();
        if (s !== void 0) repeatPair.set(s, i);
      }
    }
  }
  const houseJumps = (wallIdx, numbers) => {
    let seg;
    for (const [s, e] of repeatPair) {
      if (s <= wallIdx && wallIdx < e && (!seg || s > seg[0])) seg = [s, e];
    }
    if (!seg) return false;
    const times = score2.events[seg[1]].times ?? 2;
    return Math.min(...numbers) < times;
  };
  let anyTimed = false;
  for (let li = 0; li < starts.length; li += 1) {
    const from = starts[li];
    const to = li + 1 < starts.length ? starts[li + 1] : widths.length;
    const y = padTop + titleHeight + li * lineHeight + lineHeight / 2;
    const items = [];
    let cx = padding;
    let measureNo = 1;
    let seenTimed = false;
    for (let k2 = 0; k2 < from; k2 += 1) {
      const e = score2.events[k2];
      if (e.kind === "note" || e.kind === "rest") {
        seenTimed = true;
        continue;
      }
      if (e.kind === "barline" && seenTimed) measureNo += 1;
    }
    const line = widths.slice(from, to);
    const usedBars = line.reduce((a, x2) => a + (x2.ev.kind === "barline" ? x2.w : 0), 0);
    const usedRest = line.reduce((a, x2) => a + x2.w, 0) - usedBars;
    const isLast = li === starts.length - 1;
    const stretch = opts.positions || isLast || usedRest <= 0 ? 1 : Math.max(1, (maxX - usedBars) / usedRest);
    for (let i = from; i < to; i += 1) {
      const { ev, w } = widths[i];
      if (opts.positions) cx = opts.positions.get(ev.id)?.x ?? cx;
      if (ev.kind === "note" || ev.kind === "rest") {
        const item = {
          eventId: ev.id,
          kind: ev.kind,
          eventIndex: i,
          x: cx,
          w,
          ticks: ev.ticks,
          dashXs: opts.positions?.get(ev.id)?.dashXs
        };
        if (ev.kind === "rest" && ev.hidden) item.hidden = true;
        if (ev.kind === "note") {
          const n = ev;
          item.degree = n.degree;
          item.octave = n.octave;
          if (n.accidental) {
            item.accidental = n.accidental;
            item.accW = glyph.accW;
          }
          const gid = groupOfEvent.get(n.id);
          const g = gid ? groupById.get(gid) : void 0;
          item.beams = g?.tuplet ? tupletBeamCount(g.totalTicks, g.tuplet) : beamCount(undotTicks(n.ticks, n.dot ?? 0));
          item.dot = n.dot ?? 0;
          item.dashes = dashCountOf(n.ticks, item.dot);
          if (n.tongue) item.tongue = n.tongue;
          if (n.fermata) item.fermata = true;
          if (n.keyChange) item.keyChange = n.keyChange;
          if (n.graceBefore?.length) {
            item.graceBefore = n.graceBefore;
            item.graceInk = n.graceBefore.length * glyph.graceW + glyph.graceGap;
          }
          if (n.graceAfter?.length) item.graceAfter = n.graceAfter;
          if (n.articulations?.includes("staccato")) item.staccato = true;
          if (n.techniques?.length) item.techniques = n.techniques;
          if (n.dynamic) item.dynamic = n.dynamic;
          if (n.hairpin && !n.hairpinTo) item.hairpin = n.hairpin;
          if (n.lyrics?.length) item.lyrics = n.lyrics;
        } else {
          const gid = groupOfEvent.get(ev.id);
          const g = gid ? groupById.get(gid) : void 0;
          item.beams = g?.tuplet ? tupletBeamCount(g.totalTicks, g.tuplet) : beamCount(undotTicks(ev.ticks, ev.dot ?? 0));
          item.dot = ev.dot ?? 0;
          item.dashes = dashCountOf(ev.ticks, item.dot);
        }
        items.push(item);
        anyTimed = true;
      } else if (isBarrier(ev)) {
        const bar = ev;
        items.push({
          eventId: ev.id,
          kind: "barline",
          eventIndex: i,
          x: cx,
          w,
          final: bar.style === "final",
          // 小节号：这条线**结束**的是第几小节（与报错「第 N 小节」同口径）。
          // 谱面开头那根线是第 1 小节的左边界，不编号也不推进计数——否则所有
          // 小节号会偏一位（|: 开头的谱实测踩到）
          measure: anyTimed ? measureNo : void 0,
          ...bar.hidden ? { hidden: true } : {},
          ...bar.partial ? { partial: true } : {},
          ...bar.beatAfter ? { beatAfter: bar.beatAfter } : {},
          ...bar.breakAfter ? { breakAfter: bar.breakAfter } : {},
          ...bar.repeat ? { repeat: bar.repeat } : {},
          ...bar.repeat === "end" && bar.times ? { repeatTimes: bar.times } : {},
          ...bar.volta ? { volta: bar.volta, ...bar.voltaOpen ? { voltaOpen: true } : {} } : {}
        });
        if (anyTimed) measureNo += 1;
      } else if (ev.kind === "directive") {
        const value = ev.type === "text" ? `(${ev.value})` : ev.value;
        items.push({ eventId: ev.id, kind: "directive", eventIndex: i, x: cx, w, value });
      } else if (ev.kind === "jump") {
        items.push({ eventId: ev.id, kind: "jump", eventIndex: i, x: cx, w, mark: ev.mark });
      }
      cx += isBarrier(ev) ? w : w * stretch;
    }
    const badges = [];
    {
      let acc = 0;
      let open = false;
      let barX = padding;
      const startsNewMeasure = from === 0 || isBarrier(widths[from - 1].ev);
      let complete = startsNewMeasure;
      let measurePartial = false;
      let firstPartial = false;
      let seenFirst = false;
      let expected = Math.round(beatsPerMeasureOf(meterAt(score2, from)) * TICKS_PER_BEAT);
      for (const it of items) {
        if (it.kind === "note" || it.kind === "rest") {
          acc += it.ticks ?? 0;
          open = true;
        } else if (it.kind === "barline") {
          if (open && complete && !measurePartial) {
            const beats = acc / TICKS_PER_BEAT;
            const exp = expected / TICKS_PER_BEAT;
            if (acc > expected) {
              badges.push({
                x: barX,
                text: `${trimNum(beats)}/${trimNum(exp)} \u2717`,
                level: "error"
              });
            } else if (acc < expected && !(it.final && firstPartial)) {
              badges.push({
                x: barX,
                text: `${trimNum(beats)}/${trimNum(exp)} \u26A0`,
                level: "warn"
              });
            }
          }
          acc = 0;
          open = false;
          complete = true;
          measurePartial = !!it.partial;
          if (!seenFirst) {
            seenFirst = true;
            firstPartial = !!it.partial;
          }
          barX = it.x;
          if (it.beatAfter) expected = Math.round(beatsPerMeasureOf(it.beatAfter) * TICKS_PER_BEAT);
        }
      }
    }
    const beams = [];
    const tuplets = [];
    const itemById = new Map(items.map((it) => [it.eventId, it]));
    const seenGroups = /* @__PURE__ */ new Set();
    for (const it of items) {
      if (it.kind !== "note" && it.kind !== "rest") continue;
      const gid = groupOfEvent.get(it.eventId);
      const g = gid ? groupById.get(gid) : void 0;
      if (!g) {
        if ((it.beams ?? 0) >= 1) {
          const x12 = it.x + Math.min(it.w - 4 * k, glyph.glyphRight);
          beams.push({ x0: it.x + 2, x1: x12, level: 1 });
          if ((it.beams ?? 0) >= 2) beams.push({ x0: it.x + 2, x1: x12, level: 2 });
          if ((it.beams ?? 0) >= 3) beams.push({ x0: it.x + 2, x1: x12, level: 3 });
        }
        continue;
      }
      if (seenGroups.has(g.id)) continue;
      seenGroups.add(g.id);
      const members = g.memberIds.map((id) => itemById.get(id)).filter((m) => !!m);
      if (members.length === 0) continue;
      const first = members[0];
      const last = members[members.length - 1];
      const rightOf = (m) => m.x + Math.min(m.w - 4 * k, glyph.glyphRight);
      const x0 = first.x + 2;
      const x1 = rightOf(last);
      if (g.tuplet) {
        for (let level = 1; level <= Math.max(1, first.beams ?? 1); level++) beams.push({ x0, x1, level });
        tuplets.push({ x0, x1, text: String(g.tuplet) });
        continue;
      }
      if (members.every((m) => (m.beams ?? 0) < 1)) continue;
      beams.push({ x0, x1, level: 1 });
      for (let level = 2; level <= Math.max(...members.map((m) => m.beams ?? 0)); level++) {
        let s = 0;
        while (s < members.length) {
          if ((members[s].beams ?? 0) < level) {
            s++;
            continue;
          }
          let end = s;
          while (end < members.length && (members[end].beams ?? 0) >= level) end++;
          beams.push({ x0: members[s].x + 2, x1: rightOf(members[end - 1]), level });
          s = end;
        }
      }
    }
    const arcs = [];
    const rightEdge = items.length ? items[items.length - 1].x + items[items.length - 1].w : padding;
    const pushStub = (it, cutBefore, cutAfter) => {
      const cx2 = it.x + Math.min(it.w - 4 * k, glyph.glyphRight) / 2 + 2 * k;
      let x0;
      let x1;
      if (cutBefore && cutAfter) {
        x0 = cx2 - 26 * k;
        x1 = cx2 + 26 * k;
      } else if (cutAfter) {
        x0 = cx2;
        x1 = Math.min(rightEdge, cx2 + 48 * k);
      } else if (cutBefore) {
        x0 = Math.max(padding, cx2 - 48 * k);
        x1 = cx2;
      } else {
        return;
      }
      if (x1 - x0 < 10) return;
      arcs.push({ x0, x1, lift: 11, kind: "slur", octaveUp: it.octave ?? 0 });
    };
    const pushArc = (a, b, chain2, kind) => {
      const x0 = a.x + 5;
      const x1 = b.x + Math.min(b.w - 4 * k, glyph.glyphRight);
      const span = x1 - x0;
      if (span < 10) return;
      arcs.push({
        x0,
        x1,
        // 跨度越大弧越明显，但上限 16px，给上方的换气 / 吐音标记留位置
        lift: kind === "slur" ? Math.min(16, 10 + span * 0.05) : 11,
        kind,
        octaveUp: chain2.reduce((m, i) => Math.max(m, i.octave ?? 0), 0)
      });
    };
    for (const chain2 of slurChains) {
      const onLine = chain2.map((id) => itemById.get(id)).filter((m) => !!m);
      if (onLine.length === 0) continue;
      const cutBefore = chain2.indexOf(onLine[0].eventId) > 0;
      const cutAfter = chain2.lastIndexOf(onLine[onLine.length - 1].eventId) < chain2.length - 1;
      if (onLine.length >= 2) {
        pushArc(onLine[0], onLine[onLine.length - 1], onLine, "slur");
      } else {
        pushStub(onLine[0], cutBefore, cutAfter);
      }
    }
    for (const it of items) {
      const ev = byId.get(it.eventId);
      if (!ev || ev.kind !== "note") continue;
      for (const t of ev.ties ?? []) {
        if (t.kind !== "tie") continue;
        const target = itemById.get(t.to);
        if (!target) continue;
        pushArc(it, target, [it, target], "tie");
      }
    }
    const chain = [];
    const anchors = [];
    for (const it of items) {
      if (it.kind === "directive") continue;
      chain.push(it);
      anchors.push(
        it.kind === "barline" ? it.x + it.w / 2 : it.x + 10 + (it.graceInk ?? 0)
      );
    }
    for (let k2 = 0; k2 < chain.length; k2 += 1) {
      const prevDashes = chain[k2 - 1]?.dashXs;
      const dashes = chain[k2].dashXs;
      const left = k2 === 0 ? -1e4 : ((prevDashes?.length ? prevDashes[prevDashes.length - 1] : anchors[k2 - 1]) + anchors[k2]) / 2;
      const right = k2 === chain.length - 1 ? 1e4 : ((dashes?.length ? dashes[dashes.length - 1] : anchors[k2]) + anchors[k2 + 1]) / 2;
      hitIndex.push({
        eventId: chain[k2].eventId,
        x: left,
        y: y - lineHeight / 2,
        w: right - left,
        h: lineHeight
      });
    }
    for (const it of items) {
      if (it.kind !== "directive") continue;
      hitIndex.push({ eventId: it.eventId, x: it.x, y: y + 14, w: it.w, h: 30 });
    }
    const previous = score2.events[from - 1];
    lines.push({ index: li, y, items, beams, arcs, badges, tuplets, voltas: [], pageBreakBefore: previous?.kind === "barline" && previous.breakAfter === "page" });
  }
  const position = new Map(lines.flatMap((line, li) => line.items.map((it) => [it.eventId, { li, it }])));
  for (const e of score2.events) {
    if (e.kind !== "note" || !e.hairpin || !e.hairpinTo) continue;
    const a = position.get(e.id);
    const b = position.get(e.hairpinTo);
    if (!a || !b || b.li < a.li) continue;
    const segments = [];
    for (let li = a.li; li <= b.li; li++) {
      const line = lines[li];
      const x0 = li === a.li ? a.it.x + 10 * k + (a.it.graceInk ?? 0) : line.items[0]?.x ?? padding;
      const x1 = li === b.li ? b.it.x + 20 * k + (b.it.graceInk ?? 0) : Math.max(x0, ...line.items.map((it) => it.x + it.w));
      segments.push({ li, x0, x1 });
    }
    const length = segments.reduce((sum, s) => sum + Math.max(1, s.x1 - s.x0), 0);
    let done = 0;
    const opening = (fraction) => 4 * k * (e.hairpin === "cresc" ? fraction : 1 - fraction);
    for (const s of segments) {
      const span = Math.max(1, s.x1 - s.x0);
      (lines[s.li].hairpins ??= []).push({ x0: s.x0, x1: s.x1, kind: e.hairpin, startOpen: opening(done / length), endOpen: opening((done + span) / length) });
      done += span;
    }
  }
  {
    const barPos = /* @__PURE__ */ new Map();
    lines.forEach((ln, li) => {
      for (const it of ln.items) {
        if (it.kind === "barline") barPos.set(it.eventIndex, { li, x: it.x, w: it.w });
      }
    });
    const rightEdge = (li) => {
      let r2 = padding;
      for (const it of lines[li].items) r2 = Math.max(r2, it.x + it.w);
      return r2;
    };
    for (const [wall, last] of voltaRunLast) {
      const wallBar = score2.events[wall];
      const numbers = wallBar.volta ?? [];
      const manualOpen = wallBar.voltaOpen ?? false;
      const nb = nextBarIdxOf(last);
      const closes = nb >= 0 && score2.events[nb].repeat === "end" && !manualOpen;
      const endIdx = nb >= 0 ? nb : last;
      const wp = barPos.get(wall);
      if (!wp) continue;
      const ep = barPos.get(endIdx);
      const to = ep ? ep.li : wp.li;
      for (let li = wp.li; li <= to; li += 1) {
        const isWallSeg = li === wp.li;
        const isEndSeg = li === to;
        const open = !(closes && isEndSeg);
        const x0 = isWallSeg ? wp.x + wp.w / 2 : padding;
        const x1 = isEndSeg && ep ? ep.x + ep.w / 2 : rightEdge(li);
        if (x1 - x0 <= 10) continue;
        lines[li].voltas.push({
          x0,
          x1,
          numbers,
          ...open ? { open: true } : {},
          ...isWallSeg ? {} : { cont: true },
          // 开放段尾若是「非末遍房子」的跳回点（如 [1] 后面跟 [2]），标「↩跳回」；
          // 封闭在真正 :| 上的房子不用标——那根线本身就是跳回记号
          ...isEndSeg && open && houseJumps(wall, numbers) ? { jump: true } : {}
        });
      }
    }
  }
  return {
    lines,
    unit,
    lineHeight,
    glyph,
    hitIndex,
    title,
    width: opts.contentWidth,
    height: padTop + titleHeight + lines.length * lineHeight + padBottom
  };
}
function trimNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// src/v2/validate.ts
function validateGroups(score2) {
  if (score2.parts?.length) {
    return [{ ...score2, parts: void 0 }, ...score2.parts.map((p) => ({ ...score2, events: p.events, groups: p.groups, part: p, parts: void 0 }))].flatMap((s) => validateGroups(s).map((v) => ({ ...v, message: `${s.part?.name ?? "\u58F0\u90E8 1"}\uFF1A${v.message}` })));
  }
  const out = [];
  const index = /* @__PURE__ */ new Map();
  score2.events.forEach((e, i) => index.set(e.id, i));
  for (const [i, e] of score2.events.entries()) {
    if (e.kind === "barline" && e.beatAfter && !validMeter(e.beatAfter)) out.push({ code: "E2", message: `\u62CD\u53F7\u4E0D\u5408\u6CD5\uFF1A${e.beatAfter}` });
    if (e.kind === "note" && e.hairpinTo) {
      const target = index.get(e.hairpinTo) ?? -1;
      if (!e.hairpin || target <= i || score2.events[target]?.kind !== "note") out.push({ code: "I5", message: "\u6E10\u5F3A/\u6E10\u5F31\u7EC8\u70B9\u5FC5\u987B\u662F\u540C\u58F0\u90E8\u7684\u540E\u7EED\u97F3\u7B26" });
    }
  }
  for (const g of score2.groups) {
    if (g.id === "" || g === void 0) continue;
    const members = g.memberIds.map((id) => score2.events[index.get(id) ?? -1]);
    if (members.some((m) => m === void 0)) {
      out.push({ code: "E1", groupId: g.id, message: "\u6210\u5458 id \u4E0D\u5B58\u5728\u4E8E events" });
      continue;
    }
    if (members.some((m) => !isTimed(m))) {
      out.push({ code: "E2", groupId: g.id, message: "\u6210\u5458\u5FC5\u987B\u662F note / rest" });
      continue;
    }
    const sum = members.reduce((a, m) => a + m.ticks, 0);
    if (sum !== g.totalTicks) {
      out.push({
        code: "I1",
        groupId: g.id,
        message: `\u03A3 \u6210\u5458\u65F6\u503C ${sum} \u2260 \u7EC4\u603B\u65F6\u503C ${g.totalTicks}`
      });
    }
    const maxGroup = score2.format === 3 && !g.tuplet ? groupTicks(meterAt(score2, index.get(g.memberIds[0]) ?? 0)) : TICKS_PER_BEAT2;
    if (g.totalTicks > maxGroup) {
      out.push({
        code: "I2",
        groupId: g.id,
        message: `\u7EC4\u603B\u65F6\u503C ${g.totalTicks} \u8D85\u8FC7\u62CD\u7EC4\u4E0A\u9650\uFF08${maxGroup} tick\uFF09`
      });
    }
    const positions = g.memberIds.map((id) => index.get(id)).sort((a, b) => a - b);
    const lo = positions[0];
    const hi = positions[positions.length - 1];
    const inside = new Set(positions);
    const gaps = [];
    for (let i = lo; i <= hi; i++) {
      const ev = score2.events[i];
      if (!inside.has(i)) gaps.push(ev);
    }
    if (gaps.length > 0) {
      out.push({
        code: "I3",
        groupId: g.id,
        message: `\u6210\u5458\u4E0D\u8FDE\u7EED\uFF0C\u4E2D\u95F4\u5939\u4E86 ${gaps.length} \u4E2A\u522B\u7684\u4E8B\u4EF6\uFF08\u9996\u4E2A ${gaps[0].kind}\uFF09`
      });
    }
    if (!isLegalTick(g.totalTicks)) {
      out.push({
        code: "I4",
        groupId: g.id,
        message: `\u7EC4\u603B\u65F6\u503C ${g.totalTicks} \u4E0D\u662F\u5408\u6CD5 tick\uFF08\u5019\u9009 ${LEGAL_TICKS.join("/")}\uFF09`
      });
    }
    for (const m of members) {
      if (!isLegalTick(m.ticks)) {
        out.push({
          code: "I4",
          groupId: g.id,
          message: `\u6210\u5458 ${m.id} \u65F6\u503C ${m.ticks} \u4E0D\u662F\u5408\u6CD5 tick`
        });
      }
    }
  }
  {
    const outDeg = /* @__PURE__ */ new Map();
    const inDeg = /* @__PURE__ */ new Map();
    for (const e of score2.events) {
      if (e.kind !== "note") continue;
      for (const t of e.ties ?? []) {
        if (t.kind !== "slur") continue;
        outDeg.set(e.id, (outDeg.get(e.id) ?? 0) + 1);
        inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1);
      }
    }
    for (const [id, n] of outDeg) {
      if (n > 1) {
        out.push({
          code: "I5",
          message: `\u97F3\u5E8F ${(index.get(id) ?? 0) + 1} \u6709 ${n} \u6761\u5916\u5411\u8FDE\u7EBF\uFF1A\u8FDE\u7EBF\u4E0D\u80FD\u5206\u53C9`
        });
      }
    }
    for (const [id, n] of inDeg) {
      if (n > 1) {
        out.push({
          code: "I5",
          message: `\u97F3\u5E8F ${(index.get(id) ?? 0) + 1} \u6709 ${n} \u6761\u5185\u5411\u8FDE\u7EBF\uFF1A\u8FDE\u7EBF\u4E0D\u80FD\u5E76\u6D41`
        });
      }
    }
  }
  return out;
}

// scripts/build-skill-validator.ts
var file = process.argv[2];
if (!file) {
  console.error("\u7528\u6CD5: node validate.mjs <\u8C31\u9762.jps>");
  process.exit(2);
}
var text;
try {
  text = readFileSync(file, "utf-8");
} catch {
  console.error(`\u65E0\u6CD5\u8BFB\u53D6\u6587\u4EF6\uFF1A${file}`);
  process.exit(2);
}
var failed = false;
var r = parseDsl(text);
for (const e of r.errors) {
  failed = true;
  console.log(`[\u89E3\u6790\u9519\u8BEF] ${e}`);
}
if (!r.score) {
  console.log("FAIL");
  process.exit(1);
}
var score = r.score;
var L = layoutScore(score, { contentWidth: 1e5 });
var warns = 0;
for (const line of L.lines) {
  for (const b of line.badges) {
    if (b.level === "error") failed = true;
    else warns += 1;
    console.log(`[\u5C0F\u8282\u62CD\u6570${b.level === "error" ? "\u9519\u8BEF" : "\u8B66\u544A"}] ${b.text}`);
  }
}
for (const v of validateGroups(score)) {
  failed = true;
  console.log(`[${v.code}] ${v.message}`);
}
for (const issue of ensembleIssues(score)) {
  failed = true;
  console.log(`[\u58F0\u90E8\u5BF9\u9F50] ${issue}`);
}
function musicalContent(s) {
  return { meta: s.meta, parts: scoreParts(s).map((p) => {
    const eventIndex = new Map(p.events.map((e, i) => [e.id, i]));
    const groups = [...p.groups].sort((a, b) => (eventIndex.get(a.memberIds[0]) ?? 0) - (eventIndex.get(b.memberIds[0]) ?? 0));
    const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
    return {
      id: p.id,
      name: p.name,
      gain: p.gain,
      muted: !!p.muted,
      solo: !!p.solo,
      events: p.events.map((e) => {
        const { id: _id, originId: _origin, ...rest } = e;
        return {
          ...rest,
          ..."groupId" in e ? { groupId: e.groupId ? groupIndex.get(e.groupId) : void 0 } : {},
          ...e.kind === "note" && e.ties ? { ties: e.ties.map((t) => ({ ...t, to: eventIndex.get(t.to) })) } : {},
          ...e.kind === "note" && e.hairpinTo ? { hairpinTo: eventIndex.get(e.hairpinTo) } : {}
        };
      }),
      groups: groups.map(({ id: _id, auto: _auto, memberIds, ...g }) => ({ ...g, memberIds: memberIds.map((id) => eventIndex.get(id)) }))
    };
  }) };
}
var rt = parseDsl(serializeDsl(score));
var original = score.format === 3 ? musicalContent(score) : score;
var reopened = score.format === 3 && rt.score ? musicalContent(rt.score) : rt.score;
if (JSON.stringify(reopened) !== JSON.stringify(original) || rt.errors.length > 0) {
  failed = true;
  console.log("[round-trip] \u5E8F\u5217\u5316\u56DE\u8BFB\u4E0D\u4E00\u81F4\uFF0C\u6587\u4EF6\u4FDD\u5B58\u540E\u518D\u6253\u5F00\u4F1A\u53D8\u5F62");
}
var measures = score.events.filter((e) => e.kind === "barline").length;
var graces = score.events.reduce(
  (a, e) => a + (e.kind === "note" ? (e.graceBefore?.length ?? 0) + (e.graceAfter?.length ?? 0) : 0),
  0
);
console.log(
  `\u2014\u2014 ${score.meta.title}\uFF1A${measures} \u6761\u5C0F\u8282\u7EBF\uFF0C${score.events.filter((e) => e.kind === "note").length} \u97F3${graces ? `\uFF08\u542B ${graces} \u9897\u501A\u97F3\uFF09` : ""}\uFF0C${score.groups.length} \u4E2A\u62CD\u5185\u7EC4${warns ? `\uFF0C${warns} \u5904\u62CD\u6570\u8B66\u544A` : ""}`
);
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
