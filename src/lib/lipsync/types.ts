/**
 * The contract between the lip-sync engine, the character rig and the UI.
 *
 * `speechSynthesis` hands us no audio — the output never reaches the WebAudio
 * graph — so the mouth is predicted from the text. The engine compiles a reply
 * into a phone-level score with real durations, then plays it back against a
 * clock that the browser's sparse `boundary` events steer. Everything the rest
 * of the app reads comes out of one reused `SpeechFrame`.
 */

/** The eight articulator channels. Indices into the engine's Float32Array(8). */
export const JAW = 0,
  WIDE = 1,
  ROUND = 2,
  PRESS = 3,
  PROT = 4,
  TUCK = 5,
  TONGUE = 6,
  CORNER = 7;
export const NCH = 8;

export type Lang = "en" | "ar";
/** fall | continue | rise */
export type Tone = -1 | 0 | 1;

/**
 * One mouth pose. The first four fields keep their original names and meaning.
 *
 * `jaw` and `lipOpen` are deliberately separate: the jaw is the mandible, the
 * lips are their own muscle. Splitting them is what lets EE be wide and thin
 * rather than a small circle, and it is most of what makes text-driven lip sync
 * stop looking like a hinge opening and closing.
 */
export type MouthShape = {
  /** 0..1 mandible drop. */
  jaw: number;
  /** 0..1 corner retraction / spreading — IY, AE, S. */
  wide: number;
  /** 0..1 aperture narrowing — UW, OW, W. */
  round: number;
  /** 0..1 bilabial compression, 1 = fully closed — P, B, M. */
  press: number;
  /** 0..1 forward funnel, independent of round — SH, CH, W, UW. */
  protrude: number;
  /** 0..1 upper lip tucked over the lower — F, V. */
  tuck: number;
  /** 0..1 tongue raised/visible — TH, L, D, N. */
  tongue: number;
  /** -1..1 corner raise (smile) or depress. */
  corner: number;
};

export const restShape = (): MouthShape => ({
  jaw: 0,
  wide: 0,
  round: 0,
  press: 0,
  protrude: 0,
  tuck: 0,
  tongue: 0,
  corner: 0,
});

export type SpeechEvent =
  | { k: "phraseStart"; t: number; words: number; turn: number }
  | { k: "accent"; t: number; s: number; nuclear: boolean }
  | { k: "pause"; t: number; d: number }
  | { k: "breath"; t: number; d: number }
  | { k: "phraseEnd"; t: number; tone: Tone }
  | { k: "blink"; t: number }
  | { k: "end"; t: number };

/**
 * One frame of performance. A single reused object — `sample()` allocates
 * nothing, so it can never trigger a GC pause mid-utterance. `events` is
 * truncated and refilled each call; drain it in the same frame.
 */
export type SpeechFrame = {
  mouth: MouthShape;
  /** Left/right lip-corner skew, -1..1. Pure appeal, not a blended channel. */
  skew: number;
  /** Engine-owned prosodic smile, 0..1. The brain may add mood on top. */
  smile: number;
  /** 0..1, a decaying spike at each stressed syllable onset. */
  accent: number;
  /** 0..1 slow phrase-level prominence — body lean, arm punch. */
  emphasis: number;
  /** Prosodic brow, -0.4..1. Leads the voice by ~40 ms, because brows do. */
  brow: number;
  /** Head pitch accent: -1 nucleus/down .. +1 question/up. */
  nod: number;
  /** Phrase-level head roll, -1..1 — one slow arc per phrase. */
  tilt: number;
  /** Phrase-level body/gaze reorientation target, -1..1. */
  turn: number;
  /** 0..1 chest/breath; rises on the inhale *before* a phrase. */
  breath: number;
  /** 0..1 perceived loudness, for the glow, the aura and the ground bloom. */
  energy: number;
  /** 0..1 voicing — drives a sub-audible body jitter. */
  voiced: number;
  /** -1 fall .. +1 rise, ramping in over a phrase's last 350 ms. */
  intonation: number;
  /** 0..1 position inside the current phrase, for declination. */
  phrasePos: number;
  /** Drained this frame. */
  events: SpeechEvent[];
  active: boolean;
};

export const restFrame = (): SpeechFrame => ({
  mouth: restShape(),
  skew: 0,
  smile: 0,
  accent: 0,
  emphasis: 0,
  brow: 0,
  nod: 0,
  tilt: 0,
  turn: 0,
  breath: 0,
  energy: 0,
  voiced: 0,
  intonation: 0,
  phrasePos: 0,
  events: [],
  active: false,
});

export const isArabicText = (t: string) => /[؀-ۿݐ-ݿ]/.test(t);
