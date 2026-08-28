/**
 * Semitone arithmetic, deterministic noise, and the timing constants the rest of
 * the speech stack shares.
 *
 * Everything prosodic is computed in **semitones** and converted to the Web
 * Speech API's linear `pitch` multiplier exactly once, at the end. Engines
 * implement `pitch` as an F0 frequency multiplier, so semitones are the
 * perceptually linear coordinate: clamping is symmetric there where clamping a
 * multiplier is not (0.667…1.682 is a lopsided way to write −7…+9 st), and
 * "+2 st" is a musical quantity you can tune by ear while "×1.122" is not.
 *
 * No browser API is touched here, so this module runs in Node.
 */

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const finite = (x: number, fb: number) => (Number.isFinite(x) ? x : fb);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ema = (a: number, b: number, w: number) => a + (b - a) * w;

export const stToRatio = (st: number) => Math.pow(2, st / 12);
export const ratioToSt = (r: number) => (12 * Math.log(Math.max(1e-4, r))) / Math.LN2;

/**
 * FNV-1a over the reply text. The same reply must sound the same twice or the
 * character has no identity and tuning by ear becomes impossible — so every
 * "random" choice in the planner is seeded from this and `Math.random` never
 * appears there.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** murmur3 finaliser, mapped to exactly [-1, 1]. */
export function hash11(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

/** The same stream folded into [0, 1) — for probabilities and list picks. */
export const hash01 = (seed: number, i: number) => hash11(seed, i) * 0.5 + 0.5;

/**
 * C1-continuous soft saturation: identity below `knee`, asymptotic to 1.
 * f(0.95)=0.923, f(1.20)=0.966, f(1.55)=0.996. Used on the jaw so a prosody
 * boost of ×1.55 can never push the shader's `uMouth.x` past the 1.0 its
 * aperture constants are calibrated for.
 */
export function softsat(x: number, knee = 0.85): number {
  if (x <= knee) return x < 0 ? 0 : x;
  const s = 1 - knee;
  return knee + s * (1 - Math.exp(-(x - knee) / s));
}

/**
 * Snap a gap to the rhythmic grid. Unquantised gaps read as network lag;
 * quantised ones read as a person choosing when to speak — the cheapest
 * "performed" cue in the whole design.
 */
export const quantise = (ms: number, grid = GAP_GRID_MS) => Math.round(ms / grid) * grid;

/** The two languages the app speaks, as full BCP-47 tags. */
export type SpeechLang = "en-US" | "ar-EG";

// ───────────────────────────────────────────────────────────── timing constants

/** How far the mouth leads the audio. Anticipation, not latency compensation. */
export const LEAD_MS = 60;
export const GAP_GRID_MS = 60;
export const GAP_MAX_MS = 900;
/** Chrome silently drops a `speak()` that lands too soon after a `cancel()`. */
export const CANCEL_GUARD_MS = 90;
export const SETTLE_TIMEOUT_MS = 350;
export const BREATH_THROTTLE_MS = 2500;
export const WATCHDOG_START_LOCAL_MS = 1500;
export const WATCHDOG_START_REMOTE_MS = 4000;
export const WATCHDOG_END_FACTOR = 2.4;
export const WATCHDOG_END_SLACK_MS = 1200;
export const REPLY_WATCHDOG_SLACK_MS = 2500;
/** Chromium desktop only, and only after an observed over-run. */
export const RESUME_KICK_MS = 7000;
export const LANDING_HOLD_MS = 250;
export const MIC_DUCK_RELEASE_MS = 350;
/** No utterance can approach Chrome's ~15 s truncation bug. */
export const MAX_SEG_SEC_HARD = 6.5;
export const MAX_SEGMENTS = 14;
export const MAX_EMPH_PER_REPLY = 4;
export const CPS_RANGE: readonly [number, number] = [4, 40];
export const JOIN_RANGE_MS: readonly [number, number] = [5, 900];
/** pitch ≈ 1.68. Above this every engine goes from cartoon to chipmunk artefact. */
export const PITCH_ST_CEILING = 9;
export const CAL_STORAGE_KEY = "nova.voicecal.v1";
