/**
 * Numeric helpers shared by the lip-sync modules.
 *
 * Everything here is allocation-free and branch-cheap; `sample()` calls several
 * of them a few hundred times per frame and must never trigger a GC pause.
 */

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function smoothstep(a: number, b: number, x: number) {
  const d = b - a;
  const t = clamp(d === 0 ? (x < a ? 0 : 1) : (x - a) / d, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Integer hash, uniform in 0..1. Determinism is a feature, not an accident: the
 * same reply must jitter and blink identically on every playback, or a timing
 * bug is impossible to reproduce.
 */
export function hash1(i: number) {
  let x = Math.imul(i | 0, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** 1-D value noise, -1..1. A held shape is never perfectly still on a real face. */
export function vnoise(x: number) {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), s) * 2 - 1;
}

/**
 * C¹ max/min. A hard `Math.max` on an already-filtered value puts a velocity
 * kink in the release, which reads as a tick; the log-sum-exp form does not.
 */
export const softmax = (a: number, b: number, k: number) =>
  Math.max(a, b) + k * Math.log1p(Math.exp(-Math.abs(a - b) / k));

export const softmin = (a: number, b: number, k: number) => -softmax(-a, -b, k);

/** A hard clamp shows up as a visible "stick" at the top of a pose; this rolls off. */
export const softclip = (x: number) =>
  x <= 0.88 ? x : 0.88 + 0.12 * (1 - Math.exp(-(x - 0.88) / 0.16));

/** Frame-rate independent approach to a target with time constant `tau`. */
export const toward = (cur: number, tgt: number, tau: number, dt: number) =>
  cur + (tgt - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
