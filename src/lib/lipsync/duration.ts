/**
 * How long each phone lasts.
 *
 * A Klatt-style multiplicative model: every phone has an inherent duration and
 * a floor it can never be compressed past, and the context scales the distance
 * between them. Phrase-final lengthening is the highest-value line in here — it
 * is the difference between a sentence that *lands* and one that merely stops.
 */

import { clamp } from "./math";
import { infoOf } from "./phones";
import type { Phone } from "./model";
import type { Lang } from "./types";

export type Ctx = {
  funcWord: boolean;
  prevGem: boolean;
  /** No coda in this syllable. */
  openSyll: boolean;
  voicedCoda: boolean;
  voicelessCoda: boolean;
  wordSyll: number;
  /** 0..1 accentual prominence of the syllable. */
  emph: number;
  /** Position within a consonant cluster; later members compress. */
  clusterIdx: number;
  phraseInitial: boolean;
  coda: boolean;
  inFinalRime: boolean;
  inPreFinalRime: boolean;
  wordFinalSyll: boolean;
  /** `PAUSE_MS / 380`, clamped — how hard the upcoming boundary is. */
  pauseWeight: number;
  syllIdx: number;
};

const STRESS_MUL = [0.8, 1.08, 1.32];

export const PAUSE_MS: Record<string, number> = {
  ",": 190,
  "،": 190,
  ";": 230,
  "؛": 230,
  ":": 230,
  "-": 150,
  "—": 260,
  "–": 260,
  "…": 520,
  ".": 380,
  "!": 340,
  "?": 420,
  "؟": 420,
  "\n": 460,
  '"': 110,
  "'": 90,
  "(": 110,
  ")": 140,
};

export const PHRASE_BREAK = new Set([".", "!", "?", "؟", ",", "،", ";", "؛", ":", "…", "—", "\n"]);

/** Real speech varies syllable to syllable by ±6–9 %; determinism is for debugging. */
const h = (i: number) => {
  let x = Math.imul(i, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
};
export const jitter = (i: number) => 1 + 0.07 * (h(i) * 2 - 1);

/** Engines compress vowels and pauses more than they compress consonants. */
export const rateFor = (rate: number, vowel: boolean) =>
  Math.pow(clamp(rate, 0.3, 3), vowel ? 0.92 : 0.72);
export const pauseRate = (rate: number) => Math.pow(clamp(rate, 0.3, 3), 0.55);

/** Syllables per second at rate 1.0 — the empirical anchor for absolute tempo. */
export const SYLL_RATE: Record<Lang, number> = { en: 4.85, ar: 4.95 };

export function durationOf(p: Phone, c: Ctx, rate: number): number {
  const { di, dm } = infoOf(p.sym);
  let k = STRESS_MUL[p.stress] ?? 1;
  if (p.reduce > 0) k *= 1 - 0.3 * p.reduce;
  if (c.funcWord) k *= 0.76;
  if (p.gem) k *= p.cls.startsWith("STOP") || p.cls === "AFFR" || p.cls === "NAS" ? 1.9 : 1.75;
  if (c.prevGem && p.vowel) k *= 0.82;
  if (p.vowel) {
    k *= c.openSyll ? 1.1 : 0.92;
    // "bad" versus "bat" is about 65 ms of vowel, and it is visible.
    k *= c.voicedCoda ? 1.25 : c.voicelessCoda ? 0.75 : 1.0;
    k *= Math.max(0.72, 1 / (1 + 0.055 * (c.wordSyll - 1)));
    k *= 1 + 0.28 * c.emph;
    if (p.emphF > 0.5) k *= 1.08;
  } else {
    k *= Math.max(0.62, Math.pow(0.85, c.clusterIdx));
    if (c.phraseInitial) k *= 1.18;
    if (c.coda) k *= 1.16;
  }
  if (c.inFinalRime) k *= 1 + 0.62 * c.pauseWeight;
  else if (c.inPreFinalRime) k *= 1.1;
  else if (c.wordFinalSyll) k *= 1.08;

  const d = dm + (di - dm) * k;
  return ((Math.max(dm, d) / 1000) * jitter(c.syllIdx)) / rateFor(rate, p.vowel);
}

export const pauseSeconds = (punct: string, rate: number) =>
  Math.max(0.09, (PAUSE_MS[punct] ?? 120) / 1000 / pauseRate(rate));

export const pauseWeightOf = (punct: string) => clamp((PAUSE_MS[punct] ?? 0) / 380, 0, 1.6);
