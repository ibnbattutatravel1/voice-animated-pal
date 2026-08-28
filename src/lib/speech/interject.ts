/**
 * Non-lexical vocalisations.
 *
 * Cartoon characters vocalise *between* sentences, and the sound they make
 * before they answer is most of what makes them read as reacting rather than
 * responding. These are one- or two-segment scores with hand-set scalars, played
 * through the same queue as a real reply so nothing about the timing, the mouth
 * or the watchdogs is special-cased.
 *
 * `hmm` doubles as latency cover: it masks the 300–800 ms a network voice takes
 * to produce its first segment.
 */

import { interjectText, type InterjectKind, type Score, type Segment } from "./prosody";
import { clamp, ratioToSt, type SpeechLang } from "./units";
import { stripTerminal, weightedChars } from "./text";

type Shape = { pitch: number; rate: number; volume: number; parts?: number };

const SHAPES: Readonly<Record<InterjectKind, Shape>> = {
  hmm: { pitch: 0.86, rate: 0.78, volume: 0.66 },
  ooh: { pitch: 1.45, rate: 1.15, volume: 1.0 },
  // Two segments: the second beat lower than the first is what makes it a laugh
  // rather than a repeated syllable.
  haha: { pitch: 1.5, rate: 1.35, volume: 0.95, parts: 2 },
  mhm: { pitch: 1.05, rate: 0.9, volume: 0.55 },
};

export function interjectionScore(kind: InterjectKind, lang: SpeechLang, cps: number): Score {
  const ar = lang === "ar-EG";
  const shape = SHAPES[kind];
  const full = interjectText(kind, ar);
  const parts = shape.parts === 2 && !ar ? splitTwo(full) : [full];
  // Offsets index `interjectionText()` — the same string the lip-sync engine is
  // handed — so a boundary from the second beat lands on the second beat.
  let at = 0;
  const segments: Segment[] = parts.map((text, i) => {
    const pitch = i === 0 ? shape.pitch : shape.pitch * 0.92;
    const wchars = weightedChars(text);
    const bare = stripTerminal(text);
    const srcStart = at;
    at += bare.length + 1;
    return {
      text,
      role: "interject" as const,
      srcStart,
      srcEnd: srcStart + bare.length,
      pitch,
      rate: shape.rate,
      volume: shape.volume,
      st: ratioToSt(pitch),
      emphasis: 0.5,
      jawGain: clamp(0.9 + 0.4 * (pitch - 1), 0.7, 1.55),
      pauseAfterMs: i === parts.length - 1 ? 0 : 60,
      wchars,
      estMs: (wchars / Math.max(1, cps * shape.rate)) * 1000,
      sentence: 0,
      u: 0,
      breathBefore: i === 0,
      isFinal: i === parts.length - 1,
    };
  });
  const estTotalMs = segments.reduce((a, s) => a + s.estMs + s.pauseAfterMs, 0);
  return { id: `interject:${kind}`, lang, emotion: "playful", segments, estTotalMs };
}

/** The string the lip-sync engine times, matching the segments' `srcStart`. */
export function interjectionText(kind: InterjectKind, lang: SpeechLang): string {
  const ar = lang === "ar-EG";
  const full = interjectText(kind, ar);
  const parts = SHAPES[kind].parts === 2 && !ar ? splitTwo(full) : [full];
  return parts.map(stripTerminal).join(" ");
}

/** "Ha ha!" → "Ha," + "ha!" — the comma is what keeps the first beat from landing. */
function splitTwo(t: string): string[] {
  const at = t.indexOf(" ");
  if (at <= 0) return [t];
  return [`${t.slice(0, at)},`, t.slice(at + 1)];
}
