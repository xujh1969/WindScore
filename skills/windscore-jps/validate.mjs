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

// src/v2/timeline.ts
var GRACE_TICKS = TICKS_PER_BEAT / 4;
function normalizeKey(key) {
  const m = /^\s*1\s*=\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)\s*$/.exec(key);
  if (!m) return null;
  const char = m[1] || m[3];
  const acc = char === "#" || char === "\u266F" ? "#" : char === "b" || char === "\u266D" ? "b" : "";
  return `1=${acc}${m[2].toUpperCase()}`;
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
  const errors = [];
  const meta = { ...DEFAULT_META };
  const body = [];
  for (const raw of text2.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("//")) continue;
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
  const slurStack = [];
  let currentGroup = null;
  const topGroup = () => currentGroup;
  const addTie = (fromId, toId, kind) => {
    const from = byId.get(fromId);
    if (!from || from.kind !== "note") return;
    from.ties = [...from.ties ?? [], { to: toId, kind }];
  };
  const pushTimed = (core, gBefore, gAfter) => {
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
    currentGroup = null;
  };
  const pushBarline = (style, partial = false) => {
    if (currentGroup) {
      errors.push("\u62CD\u5185\u7EC4\u4E0D\u5F97\u8DE8\u5C0F\u8282\uFF0C\u8BF7\u5148\u7528 > \u6536\u5C3E");
      currentGroup = null;
    }
    const id = nextId();
    const ev = partial ? { id, kind: "barline", style, partial: true } : { id, kind: "barline", style };
    events.push(ev);
    byId.set(id, ev);
    lastNoteId = null;
  };
  for (const line of body) {
    const tokens = line.replace(/~/g, "~ ").split(/\s+/).filter(Boolean);
    for (let raw of tokens) {
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
        if (raw === "|") pushBarline("single");
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
        } else if (raw === "|:" || raw.startsWith(":|") || /^\[\d+\]$/.test(raw) || raw.startsWith("$")) {
          errors.push(`\u672C\u9636\u6BB5\u672A\u5B9E\u73B0\u7684\u8BB0\u53F7\uFF08M4\uFF09\uFF1A${raw}`);
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
  return {
    score: events.length ? { version: 2, meta, events, groups } : null,
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
function renderTimed(ev, tieOut) {
  if (ev.kind === "rest") return `0${renderDuration(ev.ticks, ev.dot ?? 0)}`;
  const n = ev;
  const marks = n.octave > 0 ? "^".repeat(n.octave) : "v".repeat(-n.octave);
  const acc = n.accidental ?? "";
  const body = `${acc}${n.degree}${marks}${renderDuration(n.ticks, n.dot ?? 0)}`;
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
  const head = [
    `@title ${score2.meta.title}`,
    `@key ${score2.meta.key}`,
    `@beat ${score2.meta.beat}`,
    `@bpm ${score2.meta.bpm}`,
    `@patch ${score2.meta.patch}`
  ];
  if (score2.meta.patchName) head.push(`@patchName ${score2.meta.patchName}`);
  if (score2.meta.fontSize !== void 0) head.push(`@size ${score2.meta.fontSize}`);
  if (score2.meta.letterSpacing !== void 0) head.push(`@space ${score2.meta.letterSpacing}`);
  const byId = new Map(score2.events.map((e) => [e.id, e]));
  const nextOf = /* @__PURE__ */ new Map();
  score2.events.forEach((e, i) => {
    if (i + 1 < score2.events.length) nextOf.set(e.id, score2.events[i + 1]);
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
  for (const ev of score2.events) {
    if (emitted.has(ev.id)) continue;
    if ((ev.kind === "note" || ev.kind === "rest") && ev.groupId) {
      const g = score2.groups.find((x) => x.id === ev.groupId);
      if (g && g.memberIds[0] === ev.id) {
        const members = g.memberIds.map((id) => byId.get(id)).filter((m) => !!m && (m.kind === "note" || m.kind === "rest"));
        const inner = members.map((m) => {
          const mi = idxOf.get(m.id);
          const pre = slurSpan.has(mi) ? "(" : "";
          const post = (slurEndsAt.get(mi) ?? []).length > 0 ? ")" : "";
          const dyn = m.kind === "note" ? [m.dynamic, m.hairpin].filter(Boolean).join(" ") : "";
          const kc = m.kind === "note" && m.keyChange ? `\u8F6C${m.keyChange} ` : "";
          return `${kc}${dyn ? `${dyn} ` : ""}${pre}${renderTimed(m, tieOut(m))}${post}`;
        }).join(" ");
        out.push(`<${g.tuplet ? `${g.tuplet}: ` : ""}${inner}>`);
        members.forEach((m) => emitted.add(m.id));
        continue;
      }
      continue;
    }
    switch (ev.kind) {
      case "note":
      case "rest": {
        const i = idxOf.get(ev.id);
        const pre = slurSpan.get(i) !== void 0 ? "(" : "";
        const post = (slurEndsAt.get(i) ?? []).length > 0 ? ")" : "";
        const dyn = ev.kind === "note" ? [ev.dynamic, ev.hairpin].filter(Boolean).join(" ") : "";
        const kc = ev.kind === "note" && ev.keyChange ? `\u8F6C${ev.keyChange} ` : "";
        out.push(`${kc}${dyn ? `${dyn} ` : ""}${pre}${renderTimed(ev, tieOut(ev))}${post}`);
        emitted.add(ev.id);
        break;
      }
      case "barline":
        out.push(ev.style === "final" ? "||" : ev.partial ? "|{partial}" : "|");
        emitted.add(ev.id);
        break;
      case "directive":
        out.push(ev.value);
        emitted.add(ev.id);
        break;
      default:
        break;
    }
  }
  return `${head.join("\n")}

${out.join(" ")}
`;
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
  const unit = opts.unit ?? 1.3;
  const fontSize = score2.meta.fontSize ?? 21;
  const glyph = deriveGlyph(fontSize);
  const k = glyph.fontSize / 21;
  const spacing = score2.meta.letterSpacing ?? 0;
  const lineHeight = opts.lineHeight ?? glyph.lineHeight;
  const padTop = 20;
  const padBottom = 24;
  const padding = opts.padding ?? 40;
  const maxX = Math.max(240, opts.contentWidth - padding * 2);
  const meta = score2.meta;
  const title = opts.showTitle === false ? null : {
    title: meta.title,
    subtitle: [meta.key, meta.beat, `\u2669=${meta.bpm}`, `\u97F3\u8272 ${meta.patch}`].join("   "),
    y: padTop + 16,
    subY: padTop + 44,
    centerX: opts.contentWidth / 2,
    edit: {
      // 28 = 标题字号；+20 给图标留出与歌名的间距，别贴着字
      cx: opts.contentWidth / 2 + estimateWidth(meta.title, 28) / 2 + 20,
      cy: padTop + 16,
      size: PENCIL_SIZE
    }
  };
  const titleHeight = title ? 96 : 0;
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
    } else if (ev.kind === "barline") w = (ev.style === "final" ? 26 : 20) * k + spacing;
    else if (ev.kind === "directive") w = 26 * k + spacing;
    return { ev, w };
  });
  const starts = [0];
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
    if (ev.kind === "barline") {
      lastBarAny = i + 1;
      if (!slurCrossedBars.has(i)) lastBar = i + 1;
    }
    if (ev.kind === "note" || ev.kind === "rest") {
      const gid = groupOfEvent.get(ev.id);
      const g = gid ? groupById.get(gid) : void 0;
      if (g && g.memberIds[g.memberIds.length - 1] === ev.id) lastGroupEnd = i + 1;
    }
  }
  const expected = Math.round(beatsPerMeasureOf(score2.meta.beat) * TICKS_PER_BEAT);
  const lines = [];
  const hitIndex = [];
  for (let li = 0; li < starts.length; li += 1) {
    const from = starts[li];
    const to = li + 1 < starts.length ? starts[li + 1] : widths.length;
    const y = padTop + titleHeight + li * lineHeight + lineHeight / 2;
    const items = [];
    let cx = padding;
    const line = widths.slice(from, to);
    const usedBars = line.reduce((a, x2) => a + (x2.ev.kind === "barline" ? x2.w : 0), 0);
    const usedRest = line.reduce((a, x2) => a + x2.w, 0) - usedBars;
    const isLast = li === starts.length - 1;
    const stretch = isLast || usedRest <= 0 ? 1 : Math.max(1, (maxX - usedBars) / usedRest);
    for (let i = from; i < to; i += 1) {
      const { ev, w } = widths[i];
      if (ev.kind === "note" || ev.kind === "rest") {
        const item = {
          eventId: ev.id,
          kind: ev.kind,
          eventIndex: i,
          x: cx,
          w,
          ticks: ev.ticks
        };
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
          item.beams = g?.tuplet ? tupletBeamCount(g.totalTicks, g.tuplet) : beamCount(n.ticks);
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
          if (n.hairpin) item.hairpin = n.hairpin;
        } else {
          const gid = groupOfEvent.get(ev.id);
          const g = gid ? groupById.get(gid) : void 0;
          item.beams = g?.tuplet ? tupletBeamCount(g.totalTicks, g.tuplet) : beamCount(ev.ticks);
          item.dot = ev.dot ?? 0;
          item.dashes = dashCountOf(ev.ticks, item.dot);
        }
        items.push(item);
      } else if (ev.kind === "barline") {
        items.push({
          eventId: ev.id,
          kind: "barline",
          eventIndex: i,
          x: cx,
          w,
          final: ev.style === "final",
          partial: ev.partial
        });
      } else if (ev.kind === "directive") {
        items.push({ eventId: ev.id, kind: "directive", eventIndex: i, x: cx, w, value: ev.value });
      }
      cx += ev.kind === "barline" ? w : w * stretch;
    }
    const badges = [];
    {
      let acc = 0;
      let open = false;
      let barX = padding;
      const startsNewMeasure = from === 0 || widths[from - 1].ev.kind === "barline";
      let complete = startsNewMeasure;
      let measurePartial = false;
      let firstPartial = false;
      let seenFirst = false;
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
        if ((it.beams ?? 0) >= 1 && it.kind === "note") {
          const x12 = it.x + Math.min(it.w - 4 * k, glyph.glyphRight);
          beams.push({ x0: it.x + 2, x1: x12, level: 1 });
          if ((it.beams ?? 0) >= 2) beams.push({ x0: it.x + 2, x1: x12, level: 2 });
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
        beams.push({ x0, x1, level: 1 });
        tuplets.push({ x0, x1, text: String(g.tuplet) });
        continue;
      }
      if (members.every((m) => (m.beams ?? 0) < 1)) continue;
      beams.push({ x0, x1, level: 1 });
      let s = 0;
      while (s < members.length) {
        if ((members[s].beams ?? 0) < 2) {
          s += 1;
          continue;
        }
        let e2 = s;
        while (e2 < members.length && (members[e2].beams ?? 0) >= 2) e2 += 1;
        const seg = members.slice(s, e2);
        beams.push({ x0: seg[0].x + 2, x1: rightOf(seg[seg.length - 1]), level: 2 });
        s = e2;
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
      const left = k2 === 0 ? -1e4 : (anchors[k2 - 1] + anchors[k2]) / 2;
      const right = k2 === chain.length - 1 ? 1e4 : (anchors[k2] + anchors[k2 + 1]) / 2;
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
    lines.push({ index: li, y, items, beams, arcs, badges, tuplets });
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

// src/v2/types.ts
var TICKS_PER_BEAT2 = 48;
function isTimed(e) {
  return e.kind === "note" || e.kind === "rest";
}

// src/v2/validate.ts
function validateGroups(score2) {
  const out = [];
  const index = /* @__PURE__ */ new Map();
  score2.events.forEach((e, i) => index.set(e.id, i));
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
    if (g.totalTicks > TICKS_PER_BEAT2) {
      out.push({
        code: "I2",
        groupId: g.id,
        message: `\u7EC4\u603B\u65F6\u503C ${g.totalTicks} \u8D85\u8FC7 1 \u62CD\uFF08${TICKS_PER_BEAT2} tick\uFF09`
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
var rt = parseDsl(serializeDsl(score));
if (JSON.stringify(rt.score) !== JSON.stringify(score) || rt.errors.length > 0) {
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
