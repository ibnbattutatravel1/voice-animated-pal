/**
 * The phone table: what each sound looks like, who owns which articulator, and
 * how long it lasts.
 *
 * We need *viseme* accuracy, not phoneme accuracy. /s z θ ð ʃ/ differ audibly
 * and barely visually, /t d n/ likewise — so voicing and coronal place are
 * allowed to be wrong for free, while rounding, bilabial closure, labiodental
 * contact, jaw magnitude and spread are the five things sized precisely.
 */

import { CORNER, JAW, NCH, PRESS, PROT, ROUND, TONGUE, TUCK, WIDE } from "./types";
import type { Chan, Cls, Place } from "./model";

/** `[jaw, wide, round, press, protrude, tuck, tongue, corner]`, corner is −1..1. */
const T: Record<string, readonly number[]> = {
  // ── English vowels ─────── jaw  wide  rnd   prs   pro   tuck  tng   cor
  IY: [0.18, 0.95, 0.0, 0.0, 0.0, 0.06, 0.12, 0.4],
  IH: [0.34, 0.55, 0.0, 0.0, 0.0, 0.04, 0.08, 0.22],
  EH: [0.52, 0.5, 0.0, 0.0, 0.0, 0.04, 0.06, 0.2],
  AE: [0.8, 0.58, 0.0, 0.0, 0.0, 0.06, 0.04, 0.28],
  AA: [0.95, 0.1, 0.02, 0.0, 0.0, 0.02, 0.04, 0.02],
  AO: [0.74, 0.0, 0.48, 0.0, 0.3, 0.02, 0.03, -0.1],
  AH: [0.56, 0.18, 0.02, 0.0, 0.02, 0.02, 0.04, 0.04],
  AX: [0.3, 0.14, 0.04, 0.0, 0.02, 0.02, 0.04, 0.04],
  UH: [0.3, 0.0, 0.6, 0.0, 0.44, 0.0, 0.04, -0.2],
  UW: [0.18, 0.0, 1.0, 0.0, 0.9, 0.0, 0.02, -0.4],
  ER: [0.38, 0.08, 0.38, 0.0, 0.32, 0.02, 0.28, 0.0],
  /** The /o/ onset of OW — never emitted on its own. */
  AOo: [0.62, 0.0, 0.56, 0.0, 0.44, 0.02, 0.03, -0.08],
  // ── English consonants ───────────────────────────────────────────────────
  P: [0.04, 0.06, 0.04, 1.0, 0.02, 0.08, 0.0, 0.0],
  B: [0.06, 0.06, 0.04, 1.0, 0.02, 0.08, 0.0, 0.0],
  M: [0.08, 0.08, 0.04, 0.96, 0.02, 0.06, 0.0, 0.02],
  F: [0.12, 0.3, 0.0, 0.3, 0.0, 0.92, 0.0, 0.06],
  V: [0.13, 0.28, 0.0, 0.28, 0.0, 0.88, 0.0, 0.06],
  TH: [0.22, 0.36, 0.0, 0.05, 0.0, 0.14, 0.88, 0.06],
  DH: [0.22, 0.34, 0.0, 0.05, 0.0, 0.12, 0.84, 0.06],
  T: [0.16, 0.3, 0.0, 0.06, 0.0, 0.08, 0.4, 0.06],
  D: [0.17, 0.28, 0.0, 0.06, 0.0, 0.06, 0.4, 0.06],
  N: [0.16, 0.26, 0.0, 0.1, 0.0, 0.06, 0.36, 0.04],
  S: [0.1, 0.62, 0.0, 0.22, 0.0, 0.18, 0.18, 0.16],
  Z: [0.11, 0.6, 0.0, 0.2, 0.0, 0.16, 0.18, 0.16],
  SH: [0.22, 0.02, 0.52, 0.1, 0.74, 0.08, 0.12, -0.1],
  ZH: [0.22, 0.02, 0.5, 0.1, 0.72, 0.08, 0.12, -0.1],
  CH: [0.2, 0.02, 0.54, 0.14, 0.76, 0.08, 0.16, -0.1],
  JH: [0.21, 0.02, 0.52, 0.14, 0.74, 0.08, 0.16, -0.1],
  K: [0.3, 0.18, 0.02, 0.02, 0.0, 0.02, 0.08, 0.02],
  G: [0.31, 0.18, 0.02, 0.02, 0.0, 0.02, 0.08, 0.02],
  NG: [0.26, 0.2, 0.02, 0.04, 0.0, 0.02, 0.1, 0.02],
  L: [0.34, 0.28, 0.0, 0.02, 0.0, 0.04, 0.62, 0.06],
  /** Dark / coda l. */
  LL: [0.3, 0.06, 0.26, 0.02, 0.2, 0.02, 0.55, 0.0],
  R: [0.3, 0.02, 0.38, 0.0, 0.32, 0.02, 0.26, 0.0],
  W: [0.18, 0.0, 0.98, 0.02, 0.92, 0.0, 0.02, -0.36],
  Y: [0.22, 0.8, 0.0, 0.0, 0.0, 0.04, 0.16, 0.3],
  HH: [0.36, 0.18, 0.04, 0.0, 0.02, 0.02, 0.02, 0.02],
  /** Glottal stop — freeze, so this target is only a fallback. */
  Q: [0.26, 0.14, 0.03, 0.0, 0.02, 0.02, 0.02, 0.0],
  // ── Arabic ───────────────────────────────────────────────────────────────
  a: [0.72, 0.24, 0.0, 0.0, 0.0, 0.04, 0.05, 0.14],
  "A:": [0.92, 0.18, 0.0, 0.0, 0.0, 0.02, 0.04, 0.08],
  i: [0.32, 0.58, 0.0, 0.0, 0.0, 0.04, 0.08, 0.2],
  "I:": [0.22, 0.92, 0.0, 0.0, 0.0, 0.06, 0.1, 0.36],
  u: [0.28, 0.0, 0.64, 0.0, 0.46, 0.02, 0.03, -0.14],
  "U:": [0.18, 0.0, 0.96, 0.0, 0.86, 0.0, 0.02, -0.38],
  "E:": [0.44, 0.74, 0.0, 0.0, 0.0, 0.05, 0.08, 0.3],
  "O:": [0.48, 0.0, 0.72, 0.0, 0.58, 0.02, 0.03, -0.18],
  AIN: [0.54, 0.04, 0.0, 0.0, 0.0, 0.02, 0.04, -0.02],
  HAA: [0.46, 0.06, 0.0, 0.0, 0.0, 0.02, 0.03, 0.0],
  KHA: [0.3, 0.14, 0.06, 0.0, 0.06, 0.02, 0.04, 0.0],
  GHA: [0.31, 0.14, 0.08, 0.0, 0.08, 0.02, 0.04, 0.0],
  QAF: [0.34, 0.1, 0.08, 0.0, 0.06, 0.02, 0.04, 0.0],
  /** Arabic tap — a flick, not the English rhotic. */
  RT: [0.24, 0.2, 0.04, 0.0, 0.02, 0.02, 0.42, 0.02],
  SIL: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
};

export const TARGET: Record<string, Chan> = {};
for (const k of Object.keys(T)) TARGET[k] = Float32Array.from(T[k]!);

/**
 * Dominance answers "which articulator *owns* this channel during this phone",
 * and it is a function of place, not manner.
 */
const PLACE_DOM: Record<Place, readonly number[]> = {
  //            jaw   wide  rnd   prs   pro   tuck  tng   cor
  vocalic: [1.0, 0.92, 0.95, 0.04, 0.92, 0.06, 0.12, 0.85],
  bilabial: [0.15, 0.18, 0.2, 1.2, 0.2, 0.18, 0.04, 0.12],
  labiodental: [0.32, 0.45, 0.2, 0.55, 0.2, 1.05, 0.06, 0.18],
  dental: [0.3, 0.4, 0.15, 0.06, 0.15, 0.16, 0.95, 0.15],
  alveolar: [0.34, 0.3, 0.14, 0.1, 0.14, 0.12, 0.75, 0.16],
  postalv: [0.5, 0.62, 0.9, 0.12, 0.95, 0.12, 0.5, 0.35],
  palatal: [0.4, 0.85, 0.2, 0.04, 0.2, 0.08, 0.45, 0.35],
  velar: [0.26, 0.14, 0.1, 0.03, 0.1, 0.04, 0.1, 0.1],
  uvular: [0.32, 0.12, 0.12, 0.03, 0.12, 0.04, 0.08, 0.1],
  pharyng: [0.7, 0.12, 0.08, 0.03, 0.08, 0.04, 0.06, 0.1],
  glottal: [0.14, 0.07, 0.05, 0.02, 0.05, 0.03, 0.04, 0.06],
  pause: [0.55, 0.45, 0.45, 0.2, 0.45, 0.3, 0.35, 0.45],
};

export const PLACE_ALPHA: Record<Place, Chan> = {} as Record<Place, Chan>;
for (const k of Object.keys(PLACE_DOM) as Place[]) PLACE_ALPHA[k] = Float32Array.from(PLACE_DOM[k]);

/**
 * Per-phone corrections to the place default. Three of these carry most of the
 * improvement over a keyframe engine:
 *
 * `velar.jaw = 0.26` and `HH.jaw = 0.18` let the surrounding vowel show straight
 * through /k g h/ — which is what the mouth actually does — instead of yanking
 * the jaw to a meaningless mid value on every "hello" and every Egyptian ق.
 * And `M`'s target keeps `jaw = 0.08` while `bilabial.jaw = 0.15`, so in "mama"
 * the lips shut while the jaw stays open behind them: the vowel's jaw dominance
 * (1.00) beats the nasal's (0.15).
 */
const DOM_OVERRIDE: Record<string, Partial<Record<number, number>>> = {
  W: { [ROUND]: 1.15, [PROT]: 1.15, [JAW]: 0.3 },
  UW: { [ROUND]: 1.15, [PROT]: 1.15 },
  "U:": { [ROUND]: 1.15, [PROT]: 1.15 },
  "O:": { [ROUND]: 1.05, [PROT]: 1.0 },
  S: { [JAW]: 0.6, [WIDE]: 0.85 },
  Z: { [JAW]: 0.58, [WIDE]: 0.82 },
  IY: { [WIDE]: 1.05 },
  "I:": { [WIDE]: 1.05 },
  F: { [TUCK]: 1.1 },
  V: { [TUCK]: 1.05 },
  AIN: { [JAW]: 0.8 },
  HAA: { [JAW]: 0.78 },
  HH: { [JAW]: 0.18, [WIDE]: 0.06, [ROUND]: 0.05, [CORNER]: 0.06 },
  RT: { [TONGUE]: 0.55, [JAW]: 0.3 },
  // English /r/ is visibly rounded; plain alveolar dominance (round 0.14) hides it.
  R: { [ROUND]: 0.55, [PROT]: 0.55 },
  LL: { [ROUND]: 0.4, [PROT]: 0.35 },
};

/** Backing: an Arabic emphatic darkens, lowers and rounds the vowels around it. */
export function emphShift(t: Chan, f: number) {
  t[JAW] = t[JAW]! + 0.12 * f;
  t[WIDE] = t[WIDE]! * (1 - 0.28 * f);
  t[ROUND] = t[ROUND]! + 0.1 * f;
  t[PROT] = t[PROT]! + 0.1 * f;
}

export type PhInfo = {
  cls: Cls;
  place: Place;
  /** Klatt inherent and minimum durations, ms at the reference rate. */
  di: number;
  dm: number;
  /** Closure share of the segment. */
  clo: number;
};

const V = (cls: Cls, di: number, dm: number): PhInfo => ({ cls, place: "vocalic", di, dm, clo: 0 });
const C = (cls: Cls, place: Place, di: number, dm: number, clo = 0): PhInfo => ({
  cls,
  place,
  di,
  dm,
  clo,
});

export const PH: Record<string, PhInfo> = {
  IY: V("VLONG", 120, 60),
  IH: V("VSHORT", 92, 48),
  EH: V("VSHORT", 92, 48),
  AE: V("VSHORT", 92, 48),
  AA: V("VLONG", 130, 64),
  AO: V("VLONG", 130, 64),
  AH: V("VSHORT", 92, 48),
  AX: V("VSCHWA", 68, 38),
  UH: V("VSHORT", 92, 48),
  UW: V("VLONG", 120, 60),
  ER: V("VLONG", 130, 64),
  AOo: V("VLONG", 130, 64),
  EY: V("VDIPH", 235, 135),
  AY: V("VDIPH", 235, 135),
  OY: V("VDIPH", 235, 135),
  AW: V("VDIPH", 235, 135),
  OW: V("VDIPH", 235, 135),

  P: C("STOPU", "bilabial", 80, 46, 0.72),
  B: C("STOPV", "bilabial", 68, 40, 0.66),
  T: C("STOPU", "alveolar", 80, 46, 0.72),
  D: C("STOPV", "alveolar", 68, 40, 0.66),
  K: C("STOPU", "velar", 80, 46, 0.72),
  G: C("STOPV", "velar", 68, 40, 0.66),
  M: C("NAS", "bilabial", 76, 44, 0.85),
  N: C("NAS", "alveolar", 74, 42),
  NG: C("NAS", "velar", 74, 42),
  F: C("FRICN", "labiodental", 92, 52),
  V: C("FRICN", "labiodental", 92, 52),
  TH: C("FRICN", "dental", 96, 54),
  DH: C("FRICN", "dental", 96, 54),
  S: C("FRICS", "alveolar", 120, 68),
  Z: C("FRICS", "alveolar", 120, 68),
  SH: C("FRICS", "postalv", 126, 72),
  ZH: C("FRICS", "postalv", 126, 72),
  CH: C("AFFR", "postalv", 105, 62, 0.34),
  JH: C("AFFR", "postalv", 105, 62, 0.34),
  L: C("LAT", "alveolar", 70, 40),
  LL: C("LAT", "alveolar", 88, 52),
  R: C("RHO", "alveolar", 82, 46),
  W: C("GLIDE", "vocalic", 62, 36),
  Y: C("GLIDE", "palatal", 62, 36),
  HH: C("FRICN", "glottal", 60, 34),
  Q: C("GLOT", "glottal", 55, 30, 0.55),

  a: V("VSHORT", 92, 48),
  i: V("VSHORT", 92, 48),
  u: V("VSHORT", 92, 48),
  "A:": V("VLONG", 175, 95),
  "I:": V("VLONG", 175, 95),
  "U:": V("VLONG", 175, 95),
  "E:": V("VLONG", 175, 95),
  "O:": V("VLONG", 175, 95),
  AIN: C("PHAR", "pharyng", 100, 56),
  HAA: C("PHAR", "pharyng", 100, 56),
  KHA: C("FRICN", "uvular", 92, 52),
  GHA: C("FRICN", "uvular", 92, 52),
  QAF: C("STOPU", "uvular", 88, 50, 0.7),
  RT: C("TAP", "alveolar", 34, 22),

  SIL: C("SIL", "pause", 50, 22),
};

/** Emphatics are not separate rows — they are their plain base plus `EMPH_SHIFT`. */
export const baseSym = (sym: string) => (sym.endsWith("*") ? sym.slice(0, -1) : sym);

export const infoOf = (sym: string): PhInfo => PH[baseSym(sym)] ?? PH["AX"]!;

export const targetOf = (sym: string): Chan => TARGET[baseSym(sym)] ?? TARGET["AX"]!;

export const isVowelSym = (sym: string) => infoOf(sym).cls.startsWith("V");

/**
 * How much each phone is worth *to the eye*. The animator's pass (§ score.ts)
 * keeps the highest-scoring shape in each 55–110 ms bucket and lets the rest
 * smear through, which is the whole difference between a phonetic simulation
 * and cartoon lip sync.
 */
export const SALIENCE: Record<string, number> = {
  P: 1.0,
  B: 1.0,
  M: 1.0,
  W: 0.95,
  UW: 0.95,
  "U:": 0.95,
  F: 0.9,
  V: 0.88,
  SH: 0.85,
  CH: 0.85,
  ZH: 0.83,
  JH: 0.83,
  "A:": 0.85,
  AA: 0.82,
  AE: 0.78,
  IY: 0.75,
  "I:": 0.75,
  "O:": 0.74,
  AOo: 0.72,
  AO: 0.72,
  "E:": 0.7,
  EH: 0.66,
  TH: 0.62,
  DH: 0.6,
  S: 0.58,
  Z: 0.56,
  AIN: 0.55,
  IH: 0.52,
  ER: 0.5,
  R: 0.46,
  Y: 0.45,
  UH: 0.45,
  AH: 0.44,
  a: 0.72,
  i: 0.5,
  u: 0.62,
  L: 0.4,
  LL: 0.42,
  T: 0.34,
  D: 0.34,
  N: 0.32,
  RT: 0.3,
  K: 0.22,
  G: 0.22,
  NG: 0.22,
  HAA: 0.22,
  KHA: 0.22,
  GHA: 0.22,
  QAF: 0.24,
  HH: 0.14,
  AX: 0.18,
  Q: 0.0,
  SIL: 0.9,
};

/**
 * Co-articulation windows, as the 4 % width in seconds. Parameterising by a
 * legible width rather than a rate constant is what makes these tunable by hand.
 *
 * Rounding and protrusion reach much further than everything else — that is the
 * /stru/ effect, where the lips purse during the /s/ — and press and tuck are
 * deliberately narrow and near-Gaussian so closures stay crisp.
 */
export const W_ANT = Float32Array.from([0.15, 0.125, 0.24, 0.072, 0.25, 0.08, 0.1, 0.19]);
export const W_CAR = Float32Array.from([0.13, 0.105, 0.165, 0.062, 0.17, 0.068, 0.085, 0.175]);
export const GAMMA = Float32Array.from([1.6, 1.6, 1.3, 2.2, 1.3, 2.2, 1.8, 1.5]);

/**
 * The constant rest gesture. It guarantees a non-zero denominator, relaxes the
 * mouth wherever gesture density is low, and removes any need for a "not
 * speaking" branch in the blend.
 */
export const A_REST = Float32Array.from([0.1, 0.1, 0.1, 0.06, 0.1, 0.06, 0.1, 0.1]);

/** Per-phone window stretch. Anticipatory rounding needs more reach than the default. */
const WIDTH_MUL: Record<string, Partial<Record<number, number>>> = {
  W: { [ROUND]: 1.35, [PROT]: 1.35 },
  UW: { [ROUND]: 1.35, [PROT]: 1.35 },
  "U:": { [ROUND]: 1.35, [PROT]: 1.35 },
  "O:": { [ROUND]: 1.2, [PROT]: 1.2 },
  SH: { [PROT]: 1.15 },
  ZH: { [PROT]: 1.15 },
  CH: { [PROT]: 1.15 },
  JH: { [PROT]: 1.15 },
};

/** `f↑, f↓, ζ↑, ζ↓, v_max` per channel. All frequencies scale with `speedFactor`. */
export const FILT: readonly (readonly [number, number, number, number, number])[] = [
  [6.0, 5.0, 0.55, 0.82, 12], // jaw — under-damped on purpose: it resonates at the syllable rate
  [9.0, 7.5, 0.75, 0.9, 16], // wide
  [6.6, 5.8, 0.82, 0.94, 12], // round
  [15.0, 10.0, 1.0, 0.88, 26], // press — fast and critically damped, so a plosive snaps
  [6.0, 5.2, 0.86, 0.95, 11], // protrude
  [13.0, 10.0, 0.95, 0.95, 22], // tuck
  [12.0, 10.0, 0.9, 0.95, 20], // tongue
  [5.6, 4.6, 0.78, 0.9, 10], // corner
];

/** Fill `out` with the resolved dominance for one phone. */
export function alphaOf(sym: string, place: Place, out: Chan) {
  const base = PLACE_ALPHA[place];
  for (let c = 0; c < NCH; c++) out[c] = base[c]!;
  const ov = DOM_OVERRIDE[baseSym(sym)];
  if (ov) for (const [k, v] of Object.entries(ov)) if (v !== undefined) out[+k] = v;
}

/** Fill `wa`/`wc` for one segment. Baking the width here costs the frame nothing. */
export function widthsOf(sym: string, dur: number, wa: Chan, wc: Chan) {
  // A 34 ms Arabic tap must not smear like a 175 ms long vowel.
  const durScale = Math.min(1.75, Math.max(0.62, dur / 0.09));
  const mul = WIDTH_MUL[baseSym(sym)];
  for (let c = 0; c < NCH; c++) {
    const m = (mul?.[c] ?? 1) * durScale;
    wa[c] = W_ANT[c]! * m;
    wc[c] = W_CAR[c]! * m;
  }
}
