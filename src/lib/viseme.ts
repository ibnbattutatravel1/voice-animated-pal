/**
 * Lip sync.
 *
 * `speechSynthesis` gives us no audio to analyse — the output never reaches the
 * WebAudio graph — so the mouth is driven from the text instead. We turn the
 * utterance into a stream of visemes indexed by character position, then use the
 * `boundary` events the browser fires at each word to continuously re-estimate
 * how fast it is reading. Between boundaries we coast at the measured rate, so
 * the mouth stays locked to the voice even on engines that only report a couple
 * of events.
 *
 * Both Latin and Arabic are mapped. Arabic is normally written unvocalised, so a
 * short implicit vowel is inserted between adjacent consonants — without it the
 * jaw would barely move on Arabic replies.
 */

export type Viseme =
  | "REST"
  | "AA"
  | "AH"
  | "EE"
  | "IH"
  | "OH"
  | "OO"
  | "MBP"
  | "FV"
  | "TH"
  | "L"
  | "RR"
  | "SS"
  | "KG"
  | "NN";

export type MouthShape = { jaw: number; wide: number; round: number; press: number };

const SHAPES: Record<Viseme, MouthShape> = {
  REST: { jaw: 0.0, wide: 0.0, round: 0.0, press: 0.0 },
  AA: { jaw: 0.95, wide: 0.15, round: 0.0, press: 0.0 },
  AH: { jaw: 0.7, wide: 0.1, round: 0.0, press: 0.0 },
  EE: { jaw: 0.35, wide: 0.95, round: 0.0, press: 0.0 },
  IH: { jaw: 0.4, wide: 0.45, round: 0.0, press: 0.0 },
  OH: { jaw: 0.6, wide: 0.0, round: 0.6, press: 0.0 },
  OO: { jaw: 0.28, wide: 0.0, round: 1.0, press: 0.0 },
  MBP: { jaw: 0.0, wide: 0.0, round: 0.1, press: 1.0 },
  FV: { jaw: 0.16, wide: 0.35, round: 0.0, press: 0.55 },
  TH: { jaw: 0.3, wide: 0.4, round: 0.0, press: 0.1 },
  L: { jaw: 0.42, wide: 0.3, round: 0.0, press: 0.0 },
  RR: { jaw: 0.35, wide: 0.1, round: 0.35, press: 0.0 },
  SS: { jaw: 0.18, wide: 0.6, round: 0.0, press: 0.25 },
  KG: { jaw: 0.4, wide: 0.2, round: 0.0, press: 0.0 },
  NN: { jaw: 0.22, wide: 0.3, round: 0.0, press: 0.35 },
};

const LATIN: Record<string, Viseme> = {
  a: "AA",
  e: "EE",
  i: "IH",
  o: "OH",
  u: "OO",
  y: "EE",
  m: "MBP",
  b: "MBP",
  p: "MBP",
  f: "FV",
  v: "FV",
  w: "OO",
  l: "L",
  r: "RR",
  s: "SS",
  z: "SS",
  c: "SS",
  x: "SS",
  j: "SS",
  g: "KG",
  k: "KG",
  q: "KG",
  h: "KG",
  n: "NN",
  d: "NN",
  t: "NN",
};

const ARABIC: Record<string, Viseme> = {
  ا: "AA",
  أ: "AA",
  إ: "EE",
  آ: "AA",
  ى: "AA",
  ة: "AH",
  ء: "AA",
  و: "OO",
  ؤ: "OO",
  ي: "EE",
  ئ: "EE",
  "َ": "AA", // fatha
  "ُ": "OO", // damma
  "ِ": "EE", // kasra
  "ً": "AA",
  "ٌ": "OO",
  "ٍ": "EE",
  م: "MBP",
  ب: "MBP",
  ف: "FV",
  ث: "TH",
  ذ: "TH",
  ظ: "TH",
  ل: "L",
  ر: "RR",
  ن: "NN",
  س: "SS",
  ص: "SS",
  ز: "SS",
  ش: "SS",
  ج: "SS",
  ض: "SS",
  ت: "NN",
  ط: "NN",
  د: "NN",
  ك: "KG",
  ق: "KG",
  غ: "KG",
  خ: "KG",
  ح: "KG",
  ع: "AH",
  ه: "KG",
};

const VOWELS = new Set<Viseme>(["AA", "AH", "EE", "IH", "OH", "OO"]);

export type VisemeToken = { at: number; v: Viseme };

export const isArabicText = (t: string) => /[؀-ۿ]/.test(t);

/** Turn text into visemes tagged with the character index that produces them. */
export function textToVisemes(text: string): VisemeToken[] {
  const out: VisemeToken[] = [];
  const lower = text.toLowerCase();
  let prevWasConsonant = false;

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i] ?? "";
    if (/\s/.test(ch)) {
      out.push({ at: i, v: "REST" });
      prevWasConsonant = false;
      continue;
    }
    if (ch === "ّ") continue; // shadda — doubles the consonant, no new shape
    if (ch === "ْ") {
      prevWasConsonant = true;
      continue;
    } // sukun — no vowel

    // Latin digraphs read better than the letters taken one at a time.
    const two = lower.slice(i, i + 2);
    let v: Viseme | undefined;
    if (two === "th") {
      v = "TH";
      i++;
    } else if (two === "sh" || two === "ch") {
      v = "SS";
      i++;
    } else if (two === "oo") {
      v = "OO";
      i++;
    } else if (two === "ee" || two === "ea") {
      v = "EE";
      i++;
    } else if (two === "ou" || two === "ow") {
      v = "OH";
      i++;
    } else if (two === "ng") {
      v = "NN";
      i++;
    } else {
      v = LATIN[ch] ?? ARABIC[ch];
    }
    if (!v) {
      if (/[.,!?؟،:;]/.test(ch)) out.push({ at: i, v: "REST" });
      continue;
    }

    const vowel = VOWELS.has(v);
    // Unvocalised Arabic: slip a short vowel between stacked consonants.
    if (!vowel && prevWasConsonant) out.push({ at: i, v: "AH" });
    out.push({ at: i, v });
    prevWasConsonant = !vowel;
  }

  if (out.length === 0) out.push({ at: 0, v: "REST" });
  out.push({ at: text.length + 1, v: "REST" });
  return out;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rough reading speed, characters per second, before the boundary events tune it. */
function baseCps(text: string, rate: number) {
  return (isArabicText(text) ? 11.5 : 14.5) * Math.max(0.4, rate);
}

export class LipSync {
  private tokens: VisemeToken[] = [];
  private anchorChar = 0;
  private anchorAt = 0;
  private cps = 14;
  private active = false;
  private total = 0;
  private startedAt = 0;
  /** Decaying spike at each word onset — used for brow and head accents. */
  private accentAt = -1;

  start(text: string, rate = 1, now = performance.now()) {
    this.tokens = textToVisemes(text);
    this.total = text.length;
    this.cps = baseCps(text, rate);
    this.anchorChar = 0;
    this.anchorAt = now;
    this.startedAt = now;
    this.accentAt = now;
    this.active = true;
  }

  /** A `boundary` event: recalibrate where we are and how fast we are going. */
  boundary(charIndex: number, now = performance.now()) {
    if (!this.active) return;
    const dt = (now - this.anchorAt) / 1000;
    const dc = charIndex - this.anchorChar;
    if (dt > 0.08 && dc > 0) {
      const measured = dc / dt;
      // Trust the running estimate; a single long word shouldn't whipsaw it.
      this.cps = Math.min(34, Math.max(5, lerp(this.cps, measured, 0.45)));
    }
    this.anchorChar = charIndex;
    this.anchorAt = now;
    this.accentAt = now;
  }

  stop() {
    this.active = false;
  }

  get isActive() {
    return this.active;
  }

  /** How far through the utterance we think we are, 0..1. */
  progress(now = performance.now()) {
    if (!this.active || this.total === 0) return 0;
    const pos = this.anchorChar + ((now - this.anchorAt) / 1000) * this.cps;
    return Math.min(1, pos / this.total);
  }

  /** 1 right after a word starts, decaying over ~250 ms. */
  accent(now = performance.now()) {
    if (!this.active || this.accentAt < 0) return 0;
    const age = (now - this.accentAt) / 250;
    return age < 0 || age > 1 ? 0 : (1 - age) * (1 - age);
  }

  sample(now = performance.now()): MouthShape {
    if (!this.active || this.tokens.length === 0) return SHAPES.REST;
    const pos = this.anchorChar + ((now - this.anchorAt) / 1000) * this.cps;

    // Locate the two tokens straddling this character position.
    let i = 0;
    while (i < this.tokens.length - 1 && (this.tokens[i + 1]?.at ?? Infinity) <= pos) i++;
    const cur = this.tokens[i];
    const nxt = this.tokens[Math.min(i + 1, this.tokens.length - 1)];
    if (!cur || !nxt) return SHAPES.REST;

    const span = Math.max(0.5, nxt.at - cur.at);
    const raw = Math.min(1, Math.max(0, (pos - cur.at) / span));
    const t = raw * raw * (3 - 2 * raw);

    const a = SHAPES[cur.v];
    const b = SHAPES[nxt.v];

    // Speech never fully reaches a target before moving on; a small dip between
    // shapes is what stops text-driven lip sync from looking like a metronome.
    const travel = 1 - 0.18 * Math.sin(raw * Math.PI);

    return {
      jaw: lerp(a.jaw, b.jaw, t) * travel,
      wide: lerp(a.wide, b.wide, t),
      round: lerp(a.round, b.round, t),
      press: lerp(a.press, b.press, t),
    };
  }
}

export const restShape = (): MouthShape => ({ ...SHAPES.REST });
