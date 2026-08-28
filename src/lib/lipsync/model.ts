/**
 * The compiler's internal vocabulary.
 *
 * `types.ts` is the contract with the rest of the app and holds only what the
 * renderer reads. Everything below exists between `prepare()` and `sample()`
 * and never escapes the engine — except `Score`, which the dev harness inspects.
 */

import type { Lang, SpeechEvent, Tone } from "./types";

/** Always length 8, indexed by the channel constants in `types.ts`. */
export type Chan = Float32Array;

export type Cls =
  | "STOPU"
  | "STOPV"
  | "NAS"
  | "FRICS"
  | "FRICN"
  | "AFFR"
  | "LAT"
  | "RHO"
  | "TAP"
  | "GLIDE"
  | "GLOT"
  | "PHAR"
  | "VSCHWA"
  | "VSHORT"
  | "VLONG"
  | "VDIPH"
  | "SIL";

export type Place =
  | "vocalic"
  | "bilabial"
  | "labiodental"
  | "dental"
  | "alveolar"
  | "postalv"
  | "palatal"
  | "velar"
  | "uvular"
  | "pharyng"
  | "glottal"
  | "pause";

export type Phone = {
  /** "AA" | "P" | "A:" | "SH" … Emphatics carry a trailing `*`. */
  sym: string;
  cls: Cls;
  vowel: boolean;
  /** Shadda / doubled — a longer hold and, for a stop, a longer closure. */
  gem: boolean;
  /** Arabic emphatic consonant. */
  emph: boolean;
  /** 0..1 emphatic backing on a vowel, after spreading. */
  emphF: number;
  /** Glottal stop: hold the current shape, contribute nothing. */
  freeze: boolean;
  /** Long vowel or diphthong — decides syllable weight. */
  long: boolean;
  stress: 0 | 1 | 2;
  /** 0..1 schwa-ward lerp strength. English only; Egyptian does not reduce. */
  reduce: number;
  /** Analysis-string span that produced this phone. */
  a0: number;
  a1: number;
  word: number;
  syl: number;
};

export type Syl = {
  /** Half-open phone range within the word. */
  p0: number;
  p1: number;
  /** Index of the nucleus phone. */
  nuc: number;
  stress: 0 | 1 | 2;
  /** L = CV · H = CVC/CVː · S = superheavy. */
  weight: "L" | "H" | "S";
  emph: number;
  onset: number;
};

/** One word's compiled pronunciation. */
export type WordPlan = {
  phones: Phone[];
  syls: Syl[];
  func: boolean;
};

/**
 * A scheduled gesture. Targets, dominance and window widths are fully resolved
 * at build time so the per-frame blend is pure arithmetic.
 */
export type Seg = {
  sym: string;
  cls: Cls;
  /** Plateau interval, nominal seconds. */
  t0: number;
  t1: number;
  dur: number;
  target: Chan;
  alpha: Chan;
  /** Anticipatory / carryover 4 % widths, seconds. */
  wa: Chan;
  wc: Chan;
  /** 0 none | 1 bilabial | 2 labiodental. */
  closure: 0 | 1 | 2;
  cloT0: number;
  cloT1: number;
  /** Duty-cycle scale for this closure, ≤ 1. */
  duty: number;
  freeze: boolean;
  nucleus: boolean;
  stress: 0 | 1 | 2;
  emph: number;
  loud: number;
  voiced: 0 | 1;
  /** Cumulative pause seconds before this segment — the co-articulation gate. */
  pauseBefore: number;
  word: number;
  phrase: number;
};

export type Word = {
  /** Char span in TTS space, which is what `boundary.charIndex` indexes. */
  c0: number;
  c1: number;
  t0: number;
  t1: number;
  seg0: number;
  segN: number;
  syl: number;
  func: boolean;
  nuclear: boolean;
  emph: number;
  phrase: number;
};

export type Phrase = {
  w0: number;
  w1: number;
  t0: number;
  t1: number;
  tone: Tone;
  pauseAfter: number;
  turn: number;
  tilt: 1 | -1;
};

/** Impulse kinds. Velocity, not position — that is where the overshoot comes from. */
export const K_ANTIC = 0,
  K_HIT = 1,
  K_POP = 2,
  K_SPREAD = 3,
  K_PUCKER = 4,
  K_BROW = 5,
  K_NOD = 6,
  K_BREATH = 7;

export type Kick = { t: number; k: number; a: number };

export type Score = {
  lang: Lang;
  segs: Seg[];
  words: Word[];
  phrases: Phrase[];
  /** Sorted by `t`. */
  events: SpeechEvent[];
  kicks: Kick[];
  /** Nominal seconds. */
  total: number;
  nSyll: number;
  /** Every filter ω is multiplied by this. */
  speedFactor: number;
  /** What to hand `speechSynthesis` — Arabic has its tashkeel stripped. */
  ttsText: string;
  /** TTS index → original index. */
  charMap: Int32Array;
  /** True if the G2P degenerated and the babble oscillator stood in. */
  fallback: boolean;
};

export const emptyScore = (lang: Lang, ttsText: string): Score => ({
  lang,
  segs: [],
  words: [],
  phrases: [],
  events: [],
  kicks: [],
  total: 0,
  nSyll: 0,
  speedFactor: 1,
  ttsText,
  charMap: new Int32Array(0),
  fallback: true,
});
