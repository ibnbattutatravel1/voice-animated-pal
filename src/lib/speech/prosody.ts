/**
 * The score generator.
 *
 * `speechSynthesis` exposes three per-utterance scalars — pitch, rate, volume —
 * and **none of them can vary inside one utterance**. That single fact decides
 * the architecture: if the contour cannot live inside an utterance then *the
 * contour must be the segmentation*. A reply is compiled into a Score of N
 * segments, each its own utterance with its own three scalars and a scheduled
 * silence after it.
 *
 * Two forces multiply. Ours are the scalars. The engine's own prosody model is
 * switched on entirely by the **terminal punctuation of the text we hand it** —
 * "…, " gets a continuation plateau, "…?" gets a genuine engine-generated rise,
 * "…!" gets a punch. So every segment has its own trailing punctuation stripped
 * and the glyph its role demands appended. That costs nothing, works on eSpeak,
 * and composes with the scalars.
 *
 * Everything here is pure and deterministic — same text, same delivery, forever.
 * It runs in Node, which is the only practical way to find a prosody bug without
 * six devices and a good ear.
 */

import { isArabicText } from "../lipsync/types";
import { countWords, stripTerminal, weightedChars, WORD_RE } from "./text";
import {
  clamp,
  GAP_MAX_MS,
  hash01,
  hash11,
  hashString,
  MAX_EMPH_PER_REPLY,
  MAX_SEG_SEC_HARD,
  MAX_SEGMENTS,
  quantise,
  stToRatio,
  type SpeechLang,
} from "./units";

export type EmotionName =
  "warm" | "cheerful" | "excited" | "curious" | "thinking" | "gentle" | "playful";

export type Role =
  | "interject"
  | "head"
  | "body"
  | "colon"
  | "aside"
  | "prefocus"
  | "emph"
  | "postfocus"
  | "qhead"
  | "qtail"
  | "final"
  | "trail";

export type InterjectKind = "hmm" | "ooh" | "haha" | "mhm";

/** Author-side markup. A hint beats the classifier every time, and costs one property. */
export type DeliveryHint = {
  emotion?: EmotionName | undefined;
  emphasis?: readonly string[] | undefined;
  interject?: InterjectKind | undefined;
  /** Hand-written Latin twin, for Arabic with no Arabic voice installed. */
  latin?: string | undefined;
};

/** Everything the planner needs to know about the voice it is writing for. */
export type PlanEnv = {
  readonly lang: SpeechLang;
  /** Weighted chars per second at rate 1 — measured, not assumed. */
  readonly cps: number;
  readonly pitchBiasSt: number;
  readonly pitchStMin: number;
  readonly pitchStMax: number;
  readonly rateMin: number;
  readonly rateMax: number;
  readonly rateGain: number;
  /** Measured join latency. This is what sizes the segments. */
  readonly joinMs: number;
  readonly pitchResponse: number;
  readonly elongate: boolean;
  /** E — scales deviations only, never the character's own base pitch. */
  readonly expressiveness: number;
  readonly characterSt: number;
  readonly recentEmotions: readonly EmotionName[];
  /** So the same opener never lands twice running. */
  readonly lastInterject: string;
};

export type Segment = {
  /** Exactly what goes to the engine. */
  readonly text: string;
  readonly role: Role;
  /** Span in the planned string — add `srcStart` to a boundary's charIndex. */
  readonly srcStart: number;
  readonly srcEnd: number;
  readonly pitch: number;
  readonly rate: number;
  readonly volume: number;
  /** INTENDED semitones relative to character neutral. This goes to the rig. */
  readonly st: number;
  readonly emphasis: number;
  readonly jawGain: number;
  readonly pauseAfterMs: number;
  readonly wchars: number;
  readonly estMs: number;
  readonly sentence: number;
  /** 0..1 position within its sentence, by time. */
  readonly u: number;
  readonly breathBefore: boolean;
  readonly isFinal: boolean;
};

export type Score = {
  readonly id: string;
  readonly lang: SpeechLang;
  readonly emotion: EmotionName;
  readonly segments: readonly Segment[];
  readonly estTotalMs: number;
};

// ───────────────────────────────────────────────────────────── emotion presets

export type Preset = {
  baseSt: number;
  r0: number;
  Dst: number;
  Ast: number;
  Ar: number;
  pauseScale: number;
  V0: number;
  Ff: number;
  Fi: number;
  minRangeSt: number;
  interjectP: number;
  browBias: number;
  bounce: number;
  leanBias: number;
  elongate: boolean;
};

/**
 * `excited` has the *smallest* declination — excitement refuses to come down;
 * `thinking` the largest, because thought trails off. `thinking.pauseScale` is
 * the whole preset: thinking is not a pitch, it is a pause. `curious.Ff` is the
 * only one above 1 — the rise has to be long enough to hear. `playful` has the
 * widest `minRangeSt` because playful *is* unpredictability of range.
 */
// prettier-ignore
export const PRESETS: Readonly<Record<EmotionName, Preset>> = {
  //                base    r0   Dst  Ast    Ar  pause    V0    Ff    Fi  range  intP   long   brow bounce   lean
  warm:     mkPreset( 2.5, 1.00, 2.0, 0.9, 0.04, 1.00, 0.95, 0.90, 1.00,  3.0, 0.00, false,  0.00, 0.30,  0.00),
  cheerful: mkPreset( 4.0, 1.06, 2.2, 1.1, 0.05, 0.96, 0.98, 0.90, 1.02,  3.6, 0.35, false,  0.10, 0.55,  0.06),
  excited:  mkPreset( 6.0, 1.18, 1.0, 2.0, 0.09, 0.78, 1.00, 0.94, 1.08,  4.6, 0.50,  true,  0.30, 1.00,  0.12),
  curious:  mkPreset( 3.2, 0.98, 1.2, 1.4, 0.05, 1.12, 0.94, 1.02, 0.98,  3.8, 0.30, false,  0.22, 0.25,  0.14),
  thinking: mkPreset( 1.0, 0.86, 2.8, 0.7, 0.07, 1.55, 0.86, 0.86, 0.94,  3.0, 0.70, false, -0.18, 0.10, -0.10),
  gentle:   mkPreset( 2.0, 0.92, 2.6, 0.6, 0.03, 1.25, 0.88, 0.84, 0.96,  2.6, 0.25, false,  0.05, 0.15,  0.04),
  playful:  mkPreset( 5.0, 1.10, 1.4, 2.4, 0.12, 0.90, 0.98, 0.92, 1.05,  5.0, 0.50,  true,  0.18, 0.85,  0.16),
};

function mkPreset(
  baseSt: number,
  r0: number,
  Dst: number,
  Ast: number,
  Ar: number,
  pauseScale: number,
  V0: number,
  Ff: number,
  Fi: number,
  minRangeSt: number,
  interjectP: number,
  elongate: boolean,
  browBias: number,
  bounce: number,
  leanBias: number,
): Preset {
  return {
    baseSt,
    r0,
    Dst,
    Ast,
    Ar,
    pauseScale,
    V0,
    Ff,
    Fi,
    minRangeSt,
    interjectP,
    browBias,
    bounce,
    leanBias,
    elongate,
  };
}

export const EMOTION_ORDER: readonly EmotionName[] = [
  "warm",
  "cheerful",
  "excited",
  "curious",
  "thinking",
  "gentle",
  "playful",
];

export const EMOTION_INDEX: Readonly<Record<EmotionName, number>> = {
  warm: 0,
  cheerful: 1,
  excited: 2,
  curious: 3,
  thinking: 4,
  gentle: 5,
  playful: 6,
};

const NUMERIC_KEYS = [
  "baseSt",
  "r0",
  "Dst",
  "Ast",
  "Ar",
  "pauseScale",
  "V0",
  "Ff",
  "Fi",
  "minRangeSt",
  "interjectP",
  "browBias",
  "bounce",
  "leanBias",
] as const;

/**
 * Blend one preset toward another. This is what gives "Ready?" a genuinely
 * different colour from the declarative sentence before it, inside one reply.
 */
function blendPreset(a: Preset, b: Preset, w: number): Preset {
  const out: Preset = { ...a };
  for (const k of NUMERIC_KEYS) out[k] = a[k] + (b[k] - a[k]) * w;
  return out;
}

// ────────────────────────────────────────────────────────────── stage A: split

type SentKind = "statement" | "exclaim" | "question" | "trail";

type Bnd =
  | "conj"
  | "clause"
  | "comma"
  | "semi"
  | "colon"
  | "period"
  | "bang"
  | "quest"
  | "ellipsis"
  | "para"
  | "none";

const PAUSE_BASE: Readonly<Record<Bnd, number>> = {
  conj: 110,
  clause: 130,
  comma: 150,
  semi: 200,
  colon: 230,
  period: 380,
  bang: 300,
  quest: 400,
  ellipsis: 620,
  para: 700,
  none: 130,
};

type Sentence = {
  start: number;
  end: number;
  kind: SentKind;
  riseTail: boolean;
  declScale: number;
  bnd: Bnd;
  wh: boolean;
};

const TERM = /[.!?…؟۔\n]/;
const ABBREV = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "approx",
  "fig",
  "inc",
  "ltd",
  "jr",
  "sr",
]);
/** English wh-questions FALL. Polar questions rise. */
const WH_EN = /^(what|why|how|where|who|when|which|whose)\b/i;

function periodBreaks(text: string, i: number): boolean {
  const prev = text.charAt(i - 1);
  const next = text.charAt(i + 1);
  if (/\d/.test(prev) && /\d/.test(next)) return false; // 3.5
  if (/\p{L}/u.test(next)) return false; // e.g / i.e mid-token
  const token = (/([\p{L}.]+)$/u.exec(text.slice(0, i))?.[1] ?? "").toLowerCase();
  // "No." is the ordinal abbreviation only in front of a number. Everywhere
  // else it is the ordinary word, and the sentence really does end there.
  if (token === "no") return !/^\s*\d/.test(text.slice(i + 1));
  return !ABBREV.has(token);
}

function splitSentences(text: string, lang: SpeechLang): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (!TERM.test(ch)) {
      i++;
      continue;
    }
    if (ch === "." && !periodBreaks(text, i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && TERM.test(text.charAt(j))) j++;
    const after = text.charAt(j);
    // A terminator run only ends a sentence if something breaks after it.
    if (after !== "" && !/[\s"'»”)\]]/u.test(after)) {
      i = j;
      continue;
    }
    const s = mkSentence(text, start, i, text.slice(i, j), lang);
    if (s) out.push(s);
    start = j;
    i = j;
  }
  const tail = mkSentence(text, start, text.length, "", lang);
  if (tail) out.push(tail);
  return out;
}

function mkSentence(
  text: string,
  rawStart: number,
  rawEnd: number,
  run: string,
  lang: SpeechLang,
): Sentence | null {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  if (end <= start) return null;
  const body = text.slice(start, end);
  const wh = lang === "en-US" && WH_EN.test(body);

  let kind: SentKind = "statement";
  let bnd: Bnd = "period";
  let riseTail = false;
  let declScale = 1;
  if (run.includes("…")) {
    kind = "trail";
    bnd = "ellipsis";
    declScale = 1.25;
  } else if (run.includes("!")) {
    kind = "exclaim";
    bnd = "bang";
    declScale = 0.55;
    riseTail = run.includes("?") || run.includes("؟");
  } else if (run.includes("?") || run.includes("؟")) {
    kind = "question";
    bnd = "quest";
    declScale = 0.55;
    // No Arabic wh-exception: Egyptian wh-words are sentence-FINAL (رايح فين؟),
    // so the terminal rise always applies. That one line is the difference
    // between an Arabic question sounding like a question and like a statement.
    riseTail = !wh;
  } else if (run.includes("\n")) {
    bnd = "para";
  }
  return { start, end, kind, riseTail, declScale, bnd, wh };
}

// ─────────────────────────────────────────────────── stage B: phrases by time

type Piece = {
  start: number;
  end: number;
  sent: number;
  role: Role;
  bnd: Bnd;
  emphW: number;
  aside: boolean;
  /** Set only by cartoon elongation, which mutates the spoken text. */
  override: string | null;
  /** Set when a carve leaves a role whose glyph is not the one the reader needs. */
  glyphOverride: string | null;
};

const HARD = /[,;:،؛]/;
const SOFT_EN = /\b(and|but|so|or|then|because|while|when|if|though|although|after|before)\b/gi;
const SOFT_AR = /(?:^|\s)(لكن|بس|علشان|عشان|لما|لو|إن|يعني|كمان|بعدين|وبعدين)(?=\s)/g;

/** The shortest a stress word may be and still earn its own utterance. */
const EMPH_MIN_SEC = 0.28;

type SizeRules = {
  target: number;
  soft: number;
  max: number;
  minSec: number;
  minChars: number;
  maxChars: number;
  maxWords: number;
  maxSegments: number;
};

/**
 * The load-bearing adaptation. On a local voice (joinMs ≈ 40) every pause under
 * 80 ms is absorbed and everything else is timed exactly — crisp cartoon
 * phrasing. On a Chrome remote voice (joinMs ≈ 280) the planner *responds* with
 * longer segments and skipped emphasis carves, so the delivery becomes more
 * measured instead of a stuttering slideshow. Same generator, two
 * engine-appropriate results.
 */
function sizeRules(env: PlanEnv, ar: boolean): SizeRules {
  const j = env.joinMs / 1000;
  let target = clamp(1.6 + j * 3.0, 1.6, 3.6);
  // Density boost only when the contour is dead AND joins are cheap.
  if (env.pitchResponse < 0.4 && env.joinMs < 120) target *= 0.85;
  return {
    target,
    soft: target * 1.2,
    max: Math.min(target * 1.75, MAX_SEG_SEC_HARD),
    minSec: clamp(0.55 + j * 1.5, 0.55, 1.1),
    minChars: ar ? 8 : 10,
    maxChars: ar ? 120 : 140,
    maxWords: ar ? 7 : 9,
    maxSegments: env.joinMs > 260 ? 8 : MAX_SEGMENTS,
  };
}

/**
 * Roles are assigned after the merge pass, so a phrase that got absorbed into
 * its neighbour cannot leave a stale landing behind.
 */
function assignRoles(pieces: readonly Piece[], sents: readonly Sentence[]) {
  for (let si = 0; si < sents.length; si++) {
    const s = sents[si];
    if (!s) continue;
    const own = pieces.filter((p) => p.sent === si);
    for (let i = 0; i < own.length; i++) {
      const p = own[i];
      if (!p || p.aside) continue;
      if (i === own.length - 1) p.role = s.kind === "trail" ? "trail" : "final";
      else if (p.bnd === "colon") p.role = "colon";
      else if (i === 0) p.role = "head";
      else p.role = "body";
    }
  }
}

const EDGE = /[\s.,;:!?…،؛؟]/u;

function mkPiece(text: string, start: number, end: number, sent: number, bnd: Bnd): Piece | null {
  let s = start;
  let e = end;
  // Leading punctuation is the *previous* phrase's tail: a carve at "Anytime,"
  // would otherwise hand the engine an utterance that opens with a comma.
  while (s < e && EDGE.test(text.charAt(s))) s++;
  while (e > s && /\s/.test(text.charAt(e - 1))) e--;
  if (e <= s) return null;
  return {
    start: s,
    end: e,
    sent,
    role: "body",
    bnd,
    emphW: 0,
    aside: false,
    override: null,
    glyphOverride: null,
  };
}

const bodyOf = (text: string, p: Piece) => p.override ?? text.slice(p.start, p.end);
const pieceSec = (text: string, p: Piece, cps: number, r0: number) =>
  weightedChars(bodyOf(text, p)) / Math.max(1, cps * r0);

/** Parenthetical spans become their own quieter, faster segment. */
function splitParens(text: string, s: Sentence, si: number): Piece[] {
  const out: Piece[] = [];
  let cursor = s.start;
  for (let i = s.start; i < s.end; i++) {
    const ch = text.charAt(i);
    if (ch !== "(" && ch !== "[") continue;
    const close = text.indexOf(ch === "(" ? ")" : "]", i + 1);
    if (close < 0 || close >= s.end) continue;
    const before = mkPiece(text, cursor, i, si, "none");
    if (before) out.push(before);
    const inner = mkPiece(text, i + 1, close, si, "none");
    if (inner) {
      inner.aside = true;
      inner.role = "aside";
      out.push(inner);
    }
    cursor = close + 1;
    i = close;
  }
  const rest = mkPiece(text, cursor, s.end, si, s.bnd);
  if (rest) out.push(rest);
  else if (out.length > 0) {
    const last = out[out.length - 1];
    if (last) last.bnd = s.bnd;
  }
  return out;
}

function splitHard(text: string, p: Piece): Piece[] {
  const out: Piece[] = [];
  let cursor = p.start;
  for (let i = p.start; i < p.end - 1; i++) {
    const ch = text.charAt(i);
    if (!HARD.test(ch)) continue;
    // The mark stays with the left piece; it is what the engine reads.
    const piece = mkPiece(text, cursor, i + 1, p.sent, markBnd(ch));
    if (piece) {
      piece.aside = p.aside;
      out.push(piece);
    }
    cursor = i + 1;
  }
  const rest = mkPiece(text, cursor, p.end, p.sent, p.bnd);
  if (rest) {
    rest.aside = p.aside;
    out.push(rest);
  }
  return out.length ? out : [p];
}

function markBnd(ch: string): Bnd {
  if (ch === ";" || ch === "؛") return "semi";
  if (ch === ":") return "colon";
  return "comma";
}

/** Split before the conjunction nearest the midpoint, both sides ≥ 3 words. */
function softPoint(body: string, lang: SpeechLang): number {
  const re = lang === "ar-EG" ? SOFT_AR : SOFT_EN;
  re.lastIndex = 0;
  const mid = body.length / 2;
  let best = -1;
  let bestD = Infinity;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const at = m.index + (m[0].length - (m[1] ?? m[0]).length);
    if (at <= 0) continue;
    if (countWords(body.slice(0, at)) < 3 || countWords(body.slice(at)) < 3) continue;
    const d = Math.abs(at - mid);
    if (d < bestD) {
      bestD = d;
      best = at;
    }
  }
  return best;
}

/** Split at the space nearest the midpoint, never inside a number. */
function spacePoint(body: string): number {
  const mid = body.length / 2;
  let best = -1;
  let bestD = Infinity;
  for (let i = 1; i < body.length - 1; i++) {
    if (body.charAt(i) !== " ") continue;
    if (/\d$/.test(body.slice(0, i)) && /^\d/.test(body.slice(i + 1))) continue;
    if (countWords(body.slice(0, i)) < 2 || countWords(body.slice(i)) < 2) continue;
    const d = Math.abs(i - mid);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function splitByTime(text: string, pieces: Piece[], env: PlanEnv, R: SizeRules, r0: number) {
  const cut = (idx: number, at: number, bnd: Bnd) => {
    const p = pieces[idx];
    if (!p) return false;
    const left = mkPiece(text, p.start, p.start + at, p.sent, bnd);
    const right = mkPiece(text, p.start + at, p.end, p.sent, p.bnd);
    if (!left || !right) return false;
    left.aside = p.aside;
    right.aside = p.aside;
    right.role = p.role;
    pieces.splice(idx, 1, left, right);
    return true;
  };

  for (let pass = 0; pass < 2; pass++) {
    const limit = pass === 0 ? R.soft : R.max;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!p || p.override) continue;
      const body = bodyOf(text, p);
      const long =
        pieceSec(text, p, env.cps, r0) > limit ||
        (pass === 1 && (body.length > R.maxChars || countWords(body) > R.maxWords));
      if (!long) continue;
      const at = pass === 0 ? softPoint(body, env.lang) : spacePoint(body);
      if (at <= 0) continue;
      if (cut(i, at, pass === 0 ? "conj" : "clause")) i--;
    }
  }
}

function mergePass(text: string, pieces: Piece[], env: PlanEnv, R: SizeRules, r0: number) {
  const combined = (a: Piece, b: Piece) =>
    weightedChars(text.slice(a.start, b.end)) / Math.max(1, env.cps * r0);
  const canMerge = (a: Piece | undefined, b: Piece | undefined) =>
    Boolean(
      a &&
      b &&
      a.sent === b.sent &&
      a.aside === b.aside &&
      !a.override &&
      !b.override &&
      combined(a, b) <= R.max,
    );

  const merge = (i: number) => {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (!a || !b) return;
    a.end = b.end;
    a.bnd = b.bnd;
    pieces.splice(i + 1, 1);
  };

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (!p) continue;
    const body = bodyOf(text, p);
    if (weightedChars(body) >= R.minChars && countWords(body) >= 2) continue;
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    const okPrev = canMerge(prev, p);
    const okNext = canMerge(p, next);
    if (!okPrev && !okNext) continue;
    const dPrev = okPrev && prev ? combined(prev, p) : Infinity;
    const dNext = okNext && next ? combined(p, next) : Infinity;
    if (dPrev <= dNext) {
      merge(i - 1);
      i -= 2;
    } else {
      merge(i);
      i--;
    }
  }

  while (pieces.length > R.maxSegments) {
    let at = -1;
    let best = Infinity;
    for (let i = 0; i < pieces.length - 1; i++) {
      const a = pieces[i];
      const b = pieces[i + 1];
      if (!canMerge(a, b) || !a || !b) continue;
      const d = combined(a, b);
      if (d < best) {
        best = d;
        at = i;
      }
    }
    if (at < 0) break;
    merge(at);
  }
}

// ───────────────────────────────────────────────── stage C: emphasis carving

const POWER_EN = new Set(
  (
    "never always now yes no really very so much only just first best love perfect ready done " +
    "wow great huge tiny every all"
  )
    .split(" ")
    .filter(Boolean),
);
const POWER_AR = new Set(
  "خالص أوي قوي دلوقتي آه لأ يلا جدا جداً أكيد طبعا خلاص فعلا أبدا دايما بس كله لسه أهو"
    .split(" ")
    .filter(Boolean),
);
const STOP_EN = new Set(
  (
    "a an the of to in on at for with and or but is are was were be been am i you he she it we " +
    "they my your his her its our their this that these those as by from not do does did have " +
    "has had will would can could should there here than too about into over under out up down " +
    "off again some any each other own same me him us them what when where who why how which " +
    "whose don doesn didn isn aren wasn weren won couldn shouldn wouldn let"
  )
    .split(" ")
    .filter(Boolean),
);

/**
 * A contraction is one word to the tokeniser and two to the stop list: without
 * this, `what's` looks like a six-letter content word and gets stressed.
 */
const stem = (w: string) => w.replace(/'(s|t|re|ll|ve|d|m)$/, "");
const STOP_AR = new Set(
  "في من على إلى عن مع هو هي هم انا أنا انت أنت ده دي دا اللي ان أن كان يكون ما مش و يا ال لل عند"
    .split(" ")
    .filter(Boolean),
);
const UNIT_EN = new Set(
  "minute minutes second seconds hour hours day days week weeks month months year years percent times break"
    .split(" ")
    .filter(Boolean),
);
const UNIT_AR = new Set(
  "دقيقة دقايق دقائق ساعة ساعات ثانية ثواني يوم أيام أسبوع شهر سنة مرة مرات"
    .split(" ")
    .filter(Boolean),
);

type Token = { text: string; start: number; end: number; w: number };

function tokensOf(text: string, from: number, to: number): Token[] {
  const slice = text.slice(from, to);
  const out: Token[] = [];
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(slice); m; m = WORD_RE.exec(slice)) {
    out.push({ text: m[0], start: from + m.index, end: from + m.index + m[0].length, w: 0 });
  }
  return out;
}

function scoreTokens(
  toks: Token[],
  sent: Sentence,
  ar: boolean,
  spans: readonly (readonly [number, number])[],
  forced: readonly string[],
) {
  const power = ar ? POWER_AR : POWER_EN;
  const stop = ar ? STOP_AR : STOP_EN;
  const unit = ar ? UNIT_AR : UNIT_EN;
  const forcedSet = new Set(forced.map((f) => f.toLowerCase()));

  let longest: Token | null = null;
  for (const t of toks) {
    const low = stem(t.text.toLowerCase());
    if (!stop.has(low) && low.length >= 6 && (!longest || t.text.length > longest.text.length))
      longest = t;
  }
  const lastContent =
    [...toks].reverse().find((t) => !stop.has(stem(t.text.toLowerCase()))) ?? null;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const low = stem(t.text.toLowerCase());
    let w = 0;
    if (spans.some((s) => t.start >= s[0] && t.end <= s[1]) || forcedSet.has(low)) w = 1.0;
    else if (stop.has(low)) w = -1;
    else if (/^[A-Z]{2,}$/.test(t.text)) w = 0.9;
    else if (sent.kind === "exclaim" && t === lastContent) w = 0.8;
    else if (power.has(low)) w = 0.7;
    else if (/^\d+$/.test(t.text) && unit.has((toks[i + 1]?.text ?? "").toLowerCase())) w = 0.6;
    else if (sent.wh && i === 0) w = 0.55;
    else if (t === longest) w = 0.45;
    t.w = w;
  }

  // `**focus block**` is one stress unit, not two: widen the first token to the
  // whole span and silence the rest of it.
  for (const s of spans) {
    const inside = toks.filter((t) => t.start >= s[0] && t.end <= s[1]);
    const first = inside[0];
    const last = inside[inside.length - 1];
    if (!first || !last) continue;
    first.end = last.end;
    first.w = 1;
    for (let k = 1; k < inside.length; k++) {
      const t = inside[k];
      if (t) t.w = -1;
    }
  }
}

/**
 * `prefocus → emph → postfocus` is lower and slower, then high and slow with air
 * around it, then a drop: anticipation → extreme → settle. The silence around
 * the stress word does more work than the pitch on it.
 */
function carveEmphasis(
  text: string,
  pieces: Piece[],
  sents: readonly Sentence[],
  env: PlanEnv,
  hint: DeliveryHint | undefined,
  spans: readonly (readonly [number, number])[],
  R: SizeRules,
  r0: number,
) {
  const ar = env.lang === "ar-EG";
  const network = env.joinMs > 260;
  const secOf = (a: number, b: number) =>
    weightedChars(text.slice(a, b)) / Math.max(1, env.cps * r0);
  const forced = hint?.emphasis ?? [];
  let budget = MAX_EMPH_PER_REPLY;

  for (let si = 0; si < sents.length; si++) {
    const sent = sents[si];
    if (!sent) continue;
    const own = pieces.filter((p) => p.sent === si && p.role !== "qtail" && !p.aside);
    if (!own.length) continue;
    const words = countWords(text.slice(sent.start, sent.end));
    let perSentence = Math.min(3, Math.ceil(words / 9));

    const cands: { piece: Piece; tok: Token }[] = [];
    for (const p of own) {
      if (p.override) continue;
      const toks = tokensOf(text, p.start, p.end);
      scoreTokens(toks, sent, ar, spans, forced);
      const landing = p.role === "final" || p.role === "trail";
      for (const t of toks) {
        // Stressing a statement's very last word fights its own landing.
        if (landing && sent.kind !== "exclaim" && t.end >= p.end) continue;
        if (t.w > 0) cands.push({ piece: p, tok: t });
      }
    }
    cands.sort((a, b) => b.tok.w - a.tok.w);

    const taken: Token[] = [];
    for (const c of cands) {
      if (perSentence <= 0 || budget <= 0) break;
      // On a network voice, carving a word out costs ~600 ms of dead air on both
      // sides; only an author-marked word is worth that.
      if (network && c.tok.w < 0.9) continue;
      if (taken.some((t) => adjacent(text, t, c.tok))) continue;
      if (!pieces.includes(c.piece)) continue;
      if (carveOne(text, pieces, c.piece, c.tok, sent, ar, secOf, R)) {
        taken.push(c.tok);
        perSentence--;
        budget--;
      }
    }
  }
}

/** Two stresses in a row is a drum, not a performance. */
function adjacent(text: string, a: Token, b: Token): boolean {
  const [l, r] = a.start <= b.start ? [a, b] : [b, a];
  return r.start <= l.end || /^[\s,،]*$/u.test(text.slice(l.end, r.start));
}

function carveOne(
  text: string,
  pieces: Piece[],
  p: Piece,
  tok: Token,
  sent: Sentence,
  ar: boolean,
  secOf: (a: number, b: number) => number,
  R: SizeRules,
): boolean {
  const i = pieces.indexOf(p);
  if (i < 0) return false;
  const pre = mkPiece(text, p.start, tok.start, p.sent, "none");
  const post = mkPiece(text, tok.end, p.end, p.sent, p.bnd);
  // Floors, because three 0.2 s utterances in a row is exactly what
  // over-segmentation sounds like. The settle gets a lower one than an ordinary
  // phrase — dropping away quickly after the stress is the point of it — and the
  // stress word is measured at its own slower rate, which is most of its length.
  if (post && secOf(post.start, post.end) < Math.max(EMPH_MIN_SEC, R.minSec * 0.6)) return false;
  if (secOf(tok.start, tok.end) / (1 - 0.2 * tok.w) < EMPH_MIN_SEC) return false;

  // A one-beat wind-up stutters too; fold it into the stress word and keep the
  // pitch bump. If that leaves nothing to settle into, there was no carve here.
  const foldPre = !pre || secOf(pre.start, pre.end) < R.minSec;
  if (foldPre && !post) return false;
  const emph = mkPiece(text, foldPre ? p.start : tok.start, tok.end, p.sent, "none");
  if (!emph) return false;
  emph.role = "emph";
  emph.emphW = tok.w;
  emph.aside = p.aside;

  const out: Piece[] = [];
  if (!foldPre && pre) {
    pre.role = "prefocus";
    pre.aside = p.aside;
    out.push(pre);
  }
  out.push(emph);
  if (post) {
    // A sentence-final phrase keeps its landing role; the glyph depends on it.
    post.role =
      p.role === "final" || p.role === "trail" || p.role === "qhead" || p.role === "colon"
        ? p.role
        : "postfocus";
    post.aside = p.aside;
    out.push(post);
  } else {
    // The stress word ended the phrase: it inherits the boundary, and the glyph
    // the reader expects there rather than the one `emph` would have picked.
    emph.bnd = p.bnd;
    emph.glyphOverride = glyphFor(p.role, tok.w, sent.kind, ar);
  }
  pieces.splice(i, 1, ...out);
  return true;
}

// ───────────────────────────────────────────── stage D: the question staircase

/**
 * A rise cannot exist inside one utterance, so synthesise it as a staircase of
 * two: the last few words become their own segment sitting +3.4 st with a `?`
 * on the end, which makes the engine add its own rise on top of ours.
 */
function carveQuestion(text: string, pieces: Piece[], sents: readonly Sentence[]) {
  for (let si = 0; si < sents.length; si++) {
    const sent = sents[si];
    if (!sent || sent.kind !== "question" || !sent.riseTail) continue;
    const own = pieces.filter((p) => p.sent === si);
    const last = own[own.length - 1];
    if (!last) continue;
    const body = text.slice(last.start, last.end);
    if (weightedChars(text.slice(sent.start, sent.end)) < 22) {
      // Too short to split: one segment, a smaller lift, and the glyph.
      last.role = "qtail";
      last.emphW = 0.5;
      continue;
    }
    const toks = tokensOf(text, last.start, last.end);
    let cutAt = -1;
    for (let k = Math.max(0, toks.length - 3); k < toks.length; k++) {
      const t = toks[k];
      if (!t) continue;
      if (last.end - t.start <= 18 && k > 0) {
        cutAt = t.start;
        break;
      }
    }
    if (cutAt < 0 || countWords(body) < 3) {
      last.role = "qtail";
      continue;
    }
    const head = mkPiece(text, last.start, cutAt, si, "none");
    const tail = mkPiece(text, cutAt, last.end, si, last.bnd);
    if (!head || !tail) {
      last.role = "qtail";
      continue;
    }
    head.role = "qhead";
    tail.role = "qtail";
    pieces.splice(pieces.indexOf(last), 1, head, tail);
  }
}

// ──────────────────────────────────────────────────────── cartoon elongation

const ELONGATE_EN: Readonly<Record<string, string>> = {
  so: "sooo",
  very: "verrry",
  really: "reeeally",
  big: "biiig",
  love: "looove",
  yes: "yesss",
  no: "nooo",
  wow: "woow",
  huge: "huuuge",
  please: "pleeease",
};
const ELONGATE_AR: Readonly<Record<string, string>> = {
  أوي: "أوووي",
  جدا: "جداااا",
  كتير: "كتييير",
  آه: "آاااه",
};

function elongate(text: string, pieces: Piece[], ar: boolean) {
  let best: Piece | null = null;
  for (const p of pieces) if (p.role === "emph" && (!best || p.emphW > best.emphW)) best = p;
  if (!best) return;
  const body = text.slice(best.start, best.end);
  const word = /[\p{L}]+/u.exec(body)?.[0] ?? "";
  const table = ar ? ELONGATE_AR : ELONGATE_EN;
  const stretched = table[word.toLowerCase()];
  if (!stretched || stretched.length - word.length > 3) return;
  best.override = body.replace(word, stretched);
}

// ────────────────────────────────────────────────────────── role cue tables

type Cue = { st: number; rate: number; vol: number; accent: number; glyph: string };

/**
 * Rule T. Arabic segments get `،` and `؟` so script-sensitive engines pick the
 * right prosody model. `?` is never appended mid-sentence.
 */
function glyphFor(role: Role, w: number, kind: SentKind, ar: boolean): string {
  const comma = ar ? "،" : ",";
  const quest = ar ? "؟" : "?";
  switch (role) {
    case "interject":
      return "!";
    case "colon":
      return ":";
    case "emph":
      return w >= 0.8 ? "!" : comma;
    case "qtail":
      return quest;
    case "trail":
      return "…";
    case "final":
      return kind === "exclaim" ? "!" : kind === "question" ? quest : kind === "trail" ? "…" : ".";
    default:
      return comma;
  }
}

function cueFor(role: Role, w: number, kind: SentKind, wh: boolean, P: Preset, ar: boolean): Cue {
  const comma = ar ? "،" : ",";
  const quest = ar ? "؟" : "?";
  switch (role) {
    case "interject":
      return { st: 1.6, rate: 0.95, vol: 1, accent: 0.6, glyph: "!" };
    case "head":
      return { st: 0.5, rate: P.Fi, vol: 1, accent: 0.2, glyph: comma };
    case "colon":
      return { st: 0.6, rate: 0.98, vol: 1, accent: 0.3, glyph: ":" };
    case "aside":
      return { st: -1.6, rate: 1.12, vol: 0.74, accent: -0.35, glyph: comma };
    case "prefocus":
      return { st: -0.6, rate: 0.96, vol: 1, accent: -0.15, glyph: comma };
    case "emph":
      // cueVol is written absolutely in the table, so divide the base back out.
      return {
        st: 1.6 * w,
        rate: 1 - 0.2 * w,
        vol: Math.min(1, P.V0 + 0.1 * w) / P.V0,
        accent: 1,
        glyph: w >= 0.8 ? "!" : comma,
      };
    case "postfocus":
      return { st: -0.8, rate: 1, vol: 0.94, accent: -0.2, glyph: comma };
    case "qhead":
      return { st: 0.6, rate: 1, vol: 1, accent: 0.1, glyph: comma };
    case "qtail":
      return { st: 3.4, rate: 0.94, vol: 1, accent: 0.6, glyph: quest };
    case "trail":
      return { st: -2, rate: 0.86, vol: 0.72, accent: -0.5, glyph: "…" };
    case "final":
      if (kind === "exclaim")
        return { st: 0.8, rate: P.Ff * 1.04, vol: 1, accent: 0.5, glyph: "!" };
      if (kind === "question")
        return { st: wh ? -1.4 : 1.2, rate: P.Ff * 1.02, vol: 0.96, accent: -0.2, glyph: quest };
      if (kind === "trail") return { st: -2, rate: 0.86, vol: 0.72, accent: -0.5, glyph: "…" };
      return { st: -1.2, rate: P.Ff, vol: 0.96, accent: -0.3, glyph: "." };
    case "body":
    default:
      return { st: 0, rate: 1, vol: 1, accent: 0, glyph: comma };
  }
}

// ──────────────────────────────────────────────────────────────── interjection

const INTERJECTIONS: Readonly<
  Record<EmotionName, { en: readonly string[]; ar: readonly string[] }>
> = {
  warm: { en: [], ar: [] },
  cheerful: { en: ["Oh!", "Hey!", "Alright,", "Okay!"], ar: ["آه!", "طب!", "تمام!"] },
  excited: { en: ["Ooh!", "Yes!", "Ha!", "Whoa!"], ar: ["يااه!", "أيوة!", "يلا!"] },
  playful: { en: ["Heh,", "Ooh,", "Hmm!"], ar: ["أهااا!", "طب طب!"] },
  curious: { en: ["Hm?", "Oh?"], ar: ["أمم؟", "أيوة؟"] },
  thinking: { en: ["Hmm…", "Let's see…"], ar: ["أمممم…", "خليني أشوف…"] },
  gentle: { en: ["Ah.", "Okay."], ar: ["آه.", "تمام."] },
};

const OPENERS =
  /^(oh|hey|ok|okay|alright|hmm+|ooh|yes|whoa|ha|heh|hm|آه|طب|تمام|يلا|أمم+|أيوة|أهاا+)\b/iu;

function pickInterject(
  emotion: EmotionName,
  ar: boolean,
  seed: number,
  hint: DeliveryHint | undefined,
  env: PlanEnv,
  body: string,
): string | null {
  if (hint?.interject) return interjectText(hint.interject, ar);
  const P = PRESETS[emotion];
  if (OPENERS.test(body.trim())) return null;
  if (hash01(seed, 0x1111) >= P.interjectP * env.expressiveness) return null;
  const list = ar ? INTERJECTIONS[emotion].ar : INTERJECTIONS[emotion].en;
  // `lastInterject` is stored stripped of its glyph, so compare it that way.
  const usable = list.filter((s) => stripTerminal(s) !== env.lastInterject);
  if (!usable.length) return null;
  return usable[Math.floor(hash01(seed, 0x2222) * usable.length) % usable.length] ?? null;
}

export function interjectText(kind: InterjectKind, ar: boolean): string {
  switch (kind) {
    case "hmm":
      return ar ? "أمم…" : "Hmm…";
    case "ooh":
      return ar ? "أُه!" : "Ooh!";
    case "haha":
      return ar ? "هههه!" : "Ha ha!";
    case "mhm":
      return ar ? "أيوة." : "Mm-hm.";
  }
}

// ────────────────────────────────────────────────────────── emotion selection

export function chooseEmotion(t: string, prev: readonly EmotionName[]): EmotionName {
  const low = t.toLowerCase();
  const bangs = (t.match(/!/g) ?? []).length;
  let e: EmotionName;
  if (
    /\b(hmm+|let me think|i wonder|not sure|maybe)\b/.test(low) ||
    /خليني أفكر|أمم+|يمكن|مش متأكد/.test(t)
  )
    e = "thinking";
  else if (/[?؟]\s*["'»”]?$/.test(t.trim()) && t.length < 100) e = "curious";
  else if (
    bangs >= 2 ||
    /\b[A-Z]{3,}\b/.test(t) ||
    /[🎉✨🔥😄😆🥳🚀]/u.test(t) ||
    /\b(yay|awesome|amazing|wow|let'?s go|yes+|brilliant)\b/.test(low) ||
    /يلا+|رهيب|جامد|تحفة|هايل|مبروك/.test(t)
  )
    e = "excited";
  else if (
    /\b(haha|hehe|lol|silly|joke|cheeky)\b/.test(low) ||
    /[😜😝😏🙃]/u.test(t) ||
    /هههه+|بتهزر|بهزر/.test(t)
  )
    e = "playful";
  else if (
    /\b(sorry|calm|breathe|rest|gently|take your time|no rush)\b/.test(low) ||
    /[💜❤🥺🫶🤗]/u.test(t) ||
    /براحتك|متقلقش|خد وقتك|آسف|معلش|شكرا/.test(t)
  )
    e = "gentle";
  else if (
    bangs === 1 ||
    /^(hey|hi|hello)\b/.test(low) ||
    /\b(great|nice|ready|sure|anytime|of course)\b/.test(low) ||
    /^(أهلا|مرحب|سلام)/.test(t) ||
    /تمام|جاهز|أكيد|طبعا/.test(t)
  )
    e = "cheerful";
  else e = "cheerful"; // the resting personality

  // Sustained excitement exhausts a listener; long replies get calmer, not louder.
  if (t.length > 220) e = CALM_DOWN[e] ?? e;
  // Variety guard: never the same preset three times running.
  if (prev[0] === e && prev[1] === e) e = VARY[e];
  return e;
}

const CALM_DOWN: Partial<Record<EmotionName, EmotionName>> = {
  excited: "cheerful",
  playful: "cheerful",
  cheerful: "warm",
};
const VARY: Record<EmotionName, EmotionName> = {
  cheerful: "playful",
  playful: "cheerful",
  warm: "gentle",
  gentle: "warm",
  curious: "cheerful",
  excited: "playful",
  thinking: "curious",
};

const SENTENCE_BLEND: Record<SentKind, { to: EmotionName; w: number } | null> = {
  question: { to: "curious", w: 0.7 },
  exclaim: { to: "excited", w: 0.6 },
  trail: { to: "thinking", w: 0.5 },
  statement: null,
};

// ───────────────────────────────────────────────────────── contrast enforcement

/**
 * A cartoon voice is not uniformly high, it is *wide*. Semitones are already log
 * space, so widening the realised range is a plain affine expansion about the
 * mean and nothing can invert.
 */
function enforceContrast(sts: number[], minRangeSt: number) {
  if (sts.length < 3) return;
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (const s of sts) {
    if (s < lo) lo = s;
    if (s > hi) hi = s;
    sum += s;
  }
  const range = hi - lo;
  if (range >= minRangeSt || range < 0.05) return;
  const mean = sum / sts.length;
  const g = Math.min(minRangeSt / range, 2.2);
  for (let i = 0; i < sts.length; i++) sts[i] = mean + ((sts[i] ?? mean) - mean) * g;
}

// ──────────────────────────────────────────────────────────────────── planReply

export function planReply(text: string, env: PlanEnv, hint?: DeliveryHint): Score {
  const ar = env.lang === "ar-EG";
  const seed = hashString(text);
  const emotion = hint?.emotion ?? chooseEmotion(text, env.recentEmotions);
  const base = PRESETS[emotion];
  const E = clamp(env.expressiveness, 0, 2);
  const R = sizeRules(env, ar);

  const sents = splitSentences(text, env.lang);
  const pieces: Piece[] = [];
  for (let si = 0; si < sents.length; si++) {
    const s = sents[si];
    if (!s) continue;
    const runs = splitParens(text, s, si);
    const own: Piece[] = [];
    for (const r of runs) own.push(...(r.aside ? [r] : splitHard(text, r)));
    splitByTime(text, own, env, R, base.r0);
    pieces.push(...own);
  }
  mergePass(text, pieces, env, R, base.r0);
  assignRoles(pieces, sents);
  // D before C: the tail is carved out of an intact sentence-final phrase, and
  // the carver then treats qhead as an ordinary candidate but never qtail.
  carveQuestion(text, pieces, sents);
  carveEmphasis(text, pieces, sents, env, hint, spansIn(hint, text), R, base.r0);
  if (base.elongate && env.elongate) elongate(text, pieces, ar);

  const opener = pickInterject(emotion, ar, seed, hint, env, text);
  if (opener) {
    const p: Piece = {
      // No span: the opener is chosen after the text was handed to the lip-sync
      // engine, so it exists in the audio and nowhere in that timeline.
      start: -1,
      end: -1,
      sent: -1,
      role: "interject",
      bnd: "none",
      emphW: 0,
      aside: false,
      override: opener,
      glyphOverride: null,
    };
    pieces.unshift(p);
  }

  // Drop anything that would be an empty utterance — some engines never fire
  // `end` for one, which wedges the queue.
  const kept = pieces.filter((p) => weightedChars(bodyOf(text, p)) >= 1);
  if (!kept.length) {
    return { id: String(seed), lang: env.lang, emotion, segments: [], estTotalMs: 0 };
  }

  // ── stage E: the maths
  const nSent = sents.length;
  const T: number[] = kept.map((p) => pieceSec(text, p, env.cps, base.r0));
  const sentTotal = new Map<number, number>();
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (!p) continue;
    sentTotal.set(p.sent, (sentTotal.get(p.sent) ?? 0) + (T[i] ?? 0));
  }
  const acc = new Map<number, number>();

  const sts: number[] = [];
  const us: number[] = [];
  const rates: number[] = [];
  const vols: number[] = [];
  const presets: Preset[] = [];

  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (!p) continue;
    const sent = sents[p.sent];
    const kind: SentKind = sent?.kind ?? "statement";
    const declScale = sent?.declScale ?? 1;
    const blend = SENTENCE_BLEND[kind];
    const P = blend ? blendPreset(base, PRESETS[blend.to], blend.w) : base;
    presets.push(P);

    const total = sentTotal.get(p.sent) ?? T[i] ?? 1;
    const before = acc.get(p.sent) ?? 0;
    // An interjection is a reaction, not the top of a declining phrase.
    const u = p.role === "interject" ? 0 : total > 0 ? (before + (T[i] ?? 0) / 2) / total : 0.5;
    acc.set(p.sent, before + (T[i] ?? 0));
    us.push(u);

    const cue = cueFor(p.role, p.emphW, kind, sent?.wh ?? false, P, ar);
    const a = 0.6 * hash11(seed, i) + 0.4 * cue.accent;
    const g = hash11(seed, i + 0x51ed);

    let st =
      P.baseSt +
      env.pitchBiasSt +
      env.characterSt +
      E * (-P.Dst * declScale * u + P.Ast * a + cue.st);
    if (i === 0) st += 0.4; // the reply opens a little above its own line
    sts.push(st);

    const rate = clamp(
      (1 + E * (P.r0 - 1) * env.rateGain) *
        (1 + 0.06 * E * Math.sin(Math.PI * u)) *
        cue.rate *
        (1 + E * P.Ar * g),
      env.rateMin,
      env.rateMax,
    );
    rates.push(rate);
    vols.push(clamp(P.V0 * cue.vol * (1 - 0.12 * E * u), 0.05, 1));
  }

  // E scales deviations, and the minimum range is a deviation: without this the
  // contrast pass would re-widen exactly what reduced motion just calmed.
  enforceContrast(sts, base.minRangeSt * E);

  // ── pauses
  const pauses: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    const next = kept[i + 1];
    if (!p) continue;
    let ms = PAUSE_BASE[p.bnd];
    if (p.aside) ms += 100;
    if (next?.aside) ms += 60;
    if (p.role === "emph") ms += 50 + 60 * p.emphW;
    if (p.role === "interject") ms += 160;
    if (next?.role === "emph") ms += 70 + 60 * next.emphW;
    // The punchline needs air before it, not after.
    if (
      next &&
      next.sent !== p.sent &&
      sents[next.sent]?.kind === "exclaim" &&
      next.sent === nSent - 1
    )
      ms += 180;
    const P = presets[i] ?? base;
    ms *= 1 + (P.pauseScale - 1) * E;
    ms *= clamp(1 / (rates[i] ?? 1), 0.7, 1.4);
    pauses.push(clamp(quantise(ms), 0, GAP_MAX_MS));
  }

  // ── pitch-deaf engines: trade the inaudible contour for the audible channels
  if (env.pitchResponse < 0.4) {
    for (let i = 0; i < kept.length; i++) {
      const dev = (sts[i] ?? 0) - (base.baseSt + env.pitchBiasSt + env.characterSt);
      rates[i] = clamp((rates[i] ?? 1) * (1 + 0.035 * dev), env.rateMin, env.rateMax);
      vols[i] = clamp((vols[i] ?? 1) + 0.03 * dev, 0.05, 1);
      pauses[i] = clamp(
        quantise((pauses[i] ?? 0) * clamp(1 - 0.04 * dev, 0.7, 1.4)),
        0,
        GAP_MAX_MS,
      );
      if (kept[i]?.role === "emph")
        rates[i] = clamp((rates[i] ?? 1) * 0.92, env.rateMin, env.rateMax);
    }
  }

  // ── emit
  const segments: Segment[] = [];
  let estTotal = 0;
  let sinceBreath = Infinity;
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    if (!p) continue;
    const sent = sents[p.sent];
    const kind: SentKind = sent?.kind ?? "statement";
    const glyph = p.glyphOverride ?? glyphFor(p.role, p.emphW, kind, ar);
    const isFinal = i === kept.length - 1;
    const body = stripTerminal(bodyOf(text, p));
    if (!body) continue;
    const st = sts[i] ?? 0;
    const rate = rates[i] ?? 1;
    const volume = vols[i] ?? 1;
    const wchars = weightedChars(body);
    const estMs = (wchars / Math.max(1, env.cps * rate)) * 1000;
    const pauseAfterMs = isFinal ? 0 : (pauses[i] ?? 0);
    const prevPause = i > 0 ? (pauses[i - 1] ?? 0) : 0;
    const wantBreath = i === 0 || prevPause >= 380;
    const breathBefore = wantBreath && sinceBreath >= 2500;
    if (breathBefore) sinceBreath = 0;
    sinceBreath += estMs + pauseAfterMs;

    const emphasis = p.role === "emph" ? p.emphW : p.role === "qtail" ? 0.4 : 0;
    segments.push({
      text: body + glyph,
      role: p.role,
      srcStart: p.start,
      srcEnd: p.end,
      pitch: stToRatio(clamp(st, env.pitchStMin, env.pitchStMax)),
      rate,
      volume,
      st,
      emphasis,
      jawGain: clamp(0.82 + 0.55 * (st / 6) + 0.45 * (volume - 0.92) + 0.3 * emphasis, 0.7, 1.55),
      pauseAfterMs,
      wchars,
      estMs,
      sentence: p.sent,
      u: us[i] ?? 0.5,
      breathBefore,
      isFinal,
    });
    estTotal += estMs + pauseAfterMs;
  }

  return { id: String(seed), lang: env.lang, emotion, segments, estTotalMs: estTotal };
}

/** Author-marked spans survive normalisation; re-derive them from the hint too. */
function spansIn(
  hint: DeliveryHint | undefined,
  text: string,
): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  for (const w of hint?.emphasis ?? []) {
    const at = text.toLowerCase().indexOf(w.toLowerCase());
    if (at >= 0) out.push([at, at + w.length]);
  }
  return out;
}

/** Convenience for callers that have raw display text and no environment yet. */
export const detectLang = (t: string): SpeechLang => (isArabicText(t) ? "ar-EG" : "en-US");
