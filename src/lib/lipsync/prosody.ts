/**
 * Prosody: which syllable matters, what the phrase is doing, and the director's
 * cue sheet.
 *
 * Talking is not a mouth activity. The brow lead, the accent nod, the phrase
 * tilt arc and the boundary blink all come out of the same score as the mouth,
 * which is why the body ends up leaning *because of what it is saying* rather
 * than on a timer.
 */

import { clamp, hash1 } from "./math";
import { JAW } from "./types";
import {
  K_ANTIC,
  K_BREATH,
  K_BROW,
  K_HIT,
  K_NOD,
  K_POP,
  K_PUCKER,
  K_SPREAD,
  type Kick,
  type Phrase,
  type Seg,
  type Syl,
  type Word,
} from "./model";
import type { Lang, SpeechEvent, Tone } from "./types";

export type WordMeta = {
  allCaps: boolean;
  wrapped: boolean;
  contrastive: boolean;
  chars: number;
  exclaim: boolean;
};

/**
 * Feeds the jaw target, the kick amplitudes, vowel duration and `frame.accent`.
 * One number, scored once per syllable at build time.
 */
export function emphasisOf(s: Syl, w: Word, m: WordMeta, lang: Lang, hasEmphatic: boolean): number {
  let e = 0;
  if (s.stress === 2) e += 0.3;
  else if (s.stress === 1) e += 0.12;
  if (w.nuclear) e += 0.18;
  if (m.allCaps) e += 0.2;
  if (m.wrapped) e += 0.18;
  if (m.exclaim) e += 0.15;
  if (!w.func) e += 0.12;
  else e -= 0.25;
  if (s.weight !== "L") e += 0.1;
  if (m.chars >= 8) e += 0.06;
  if (m.contrastive) e += 0.15;
  if (lang === "ar" && hasEmphatic) e += 0.08;
  return clamp(e, 0, 1);
}

const EN_WH = /^(what|who|whose|why|where|when|how|which)$/;
const EN_AUX =
  /^(is|are|was|were|do|does|did|can|could|will|would|should|shall|may|might|have|has|had|am)$/;

/** `?` rises, a comma continues, a full stop falls — and a wh-question falls too. */
export function toneOf(punct: string, firstWord: string, lang: Lang): Tone {
  if (punct === "?" || punct === "؟") return 1;
  if (punct === "," || punct === "،" || punct === ";" || punct === "؛" || punct === ":") return 0;
  if (punct === "…") return 0;
  if (lang === "en") {
    if (EN_WH.test(firstWord)) return -1;
    if (EN_AUX.test(firstWord)) return 1;
  }
  return -1;
}

const SIBILANT = new Set(["S", "Z", "SH", "ZH", "CH", "JH"]);
const ROUNDY = new Set(["W", "UW", "U:", "O:", "OW"]);

/**
 * Turn the laid-out score into a time-ordered cue sheet. Kicks are impulses on
 * the articulator springs; events are what the brain and the renderer consume.
 */
export function schedule(
  segs: Seg[],
  words: Word[],
  phrases: Phrase[],
  total: number,
): { events: SpeechEvent[]; kicks: Kick[] } {
  const events: SpeechEvent[] = [];
  const kicks: Kick[] = [];
  const push = (t: number, k: number, a: number) => kicks.push({ t: Math.max(0, t), k, a });

  for (let pi = 0; pi < phrases.length; pi++) {
    const ph = phrases[pi]!;
    // The inhale lands before the first word — that is the anticipation beat.
    events.push({ k: "breath", t: Math.max(0, ph.t0 - 0.2), d: 0.32 });
    push(ph.t0 - 0.2, K_BREATH, 1);
    events.push({
      k: "phraseStart",
      t: Math.max(0, ph.t0 - 0.02),
      words: ph.w1 - ph.w0,
      turn: ph.turn,
    });
    events.push({ k: "phraseEnd", t: ph.t1, tone: ph.tone });
    // Speakers blink at phrase boundaries; the cheapest life signal there is.
    if (hash1(pi * 7919 + 13) < 0.55) events.push({ k: "blink", t: ph.t1 + 0.03 });
    if (ph.pauseAfter > 0.2) events.push({ k: "pause", t: ph.t1, d: ph.pauseAfter });
  }

  let prevJaw = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const jaw = s.target[JAW]!;
    if (s.nucleus) {
      const e = s.emph;
      const w = words[s.word];
      // The jaw dips the wrong way first, then hits — anticipation, then the beat.
      push(s.t0 - 0.045, K_ANTIC, e * Math.max(0, jaw - prevJaw));
      push(s.t0 - 0.01, K_HIT, e);
      if (s.stress >= 1) {
        events.push({ k: "accent", t: s.t0, s: e, nuclear: Boolean(w?.nuclear) });
        push(s.t0 - 0.04, K_BROW, e); // brows lead the voice, always
        push(s.t0 + 0.01, K_NOD, e * (w?.nuclear ? 1.4 : 0.7));
      }
    }
    if (s.closure && i + 1 < segs.length && !segs[i + 1]!.closure)
      push(s.t1, K_POP, s.voiced ? 0.7 : 1);
    if (SIBILANT.has(s.sym) && (i === 0 || segs[i - 1]!.sym !== s.sym)) push(s.t0, K_SPREAD, 1);
    if (ROUNDY.has(s.sym)) push(s.t0 - 0.03, K_PUCKER, 1);
    prevJaw = jaw;
  }

  events.push({ k: "end", t: total });
  events.sort((a, b) => a.t - b.t);
  kicks.sort((a, b) => a.t - b.t);
  return { events, kicks };
}
