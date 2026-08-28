/**
 * Co-articulation: plateau dominance.
 *
 * Each segment owns a flat plateau over its own interval and decays outside it,
 * and every channel is the dominance-weighted mean of every gesture in range.
 * Three properties fall out for free, each replacing a hand-written hack:
 *
 *  * **Anticipatory rounding** — in "stew", W's round dominance with a 320 ms
 *    window already wins during the /s/, so the lips purse two segments early.
 *  * **Blocking** — in "seat you" the /iy/ owns the lip channels and blocks the
 *    spurious rounding. The denominator does it, with no special case.
 *  * **Speed-dependent undershoot** — at a fast rate the plateaus shrink, the
 *    windows overlap more, and the normalised sum never reaches any single
 *    target. That is the truth, rather than a fixed fudge factor.
 */

import { A_REST, GAMMA } from "./phones";
import { NCH } from "./types";
import type { Chan, Seg } from "./model";

/** `D = 0.04·α` exactly at `Δ = W`, which is what makes "the 4 % width" legible. */
const LN25 = 3.2188758248682006;

/** Anticipation reaches further than carryover in real speech, so the window is asymmetric. */
const FWD = 0.34;
const BACK = 0.26;

export class Blender {
  private segs: Seg[] = [];
  private g0 = 0;
  private g1 = 0;
  private num = new Float32Array(NCH);
  private den = new Float32Array(NCH);
  /** Index of the segment covering `t`, or the last one that began before it. */
  cur = -1;

  load(segs: Seg[]) {
    this.segs = segs;
    this.g0 = 0;
    this.g1 = 0;
    this.cur = -1;
  }

  /** Rebuild the window cursor after the clock jumps backwards. */
  seek(t: number) {
    const s = this.segs;
    let lo = 0,
      hi = s.length - 1,
      best = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (s[m]!.t0 <= t) {
        best = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    this.g0 = Math.max(0, best - 12);
    this.g1 = this.g0;
    this.cur = s.length ? Math.min(best, s.length - 1) : -1;
  }

  private gather(t: number) {
    const s = this.segs;
    const n = s.length;
    // t1 is not monotone after key reduction extends a hold, so keep slack.
    while (this.g0 < n && s[this.g0]!.t1 < t - BACK - 0.25) this.g0++;
    if (this.g1 < this.g0) this.g1 = this.g0;
    while (this.g1 < n && s[this.g1]!.t0 <= t + FWD) this.g1++;
    let c = this.cur;
    if (c < this.g0 - 1) c = this.g0 - 1;
    while (c + 1 < n && s[c + 1]!.t0 <= t) c++;
    this.cur = c;
  }

  /** The segment at `t`, for the scalar queries the frame needs. */
  at(t: number): Seg | null {
    this.gather(t);
    return this.cur >= 0 ? (this.segs[this.cur] ?? null) : null;
  }

  /** A glottal stop contributes nothing but freezes the mouth while it lasts. */
  inFreeze(t: number): boolean {
    for (let i = this.g0; i < this.g1; i++) {
      const s = this.segs[i]!;
      if (s.freeze && t >= s.t0 && t <= s.t1) return true;
    }
    return false;
  }

  blend(t: number, out: Chan) {
    this.gather(t);
    const num = this.num,
      den = this.den;
    for (let c = 0; c < NCH; c++) {
      num[c] = 0;
      den[c] = A_REST[c]!; // the rest gesture: a non-zero denominator, always
    }
    const pNow = this.cur >= 0 ? this.segs[this.cur]!.pauseBefore : 0;

    for (let i = this.g0; i < this.g1; i++) {
      const s = this.segs[i]!;
      if (s.freeze) continue;
      if (s.t1 < t - BACK || s.t0 > t + FWD) continue;
      // Gesture density does not leak across a pause; the mouth resets there.
      const dp = pNow - s.pauseBefore;
      const gate = dp === 0 ? 1 : Math.exp(-3 * (dp < 0 ? -dp : dp));
      if (gate < 0.02) continue;
      const before = t < s.t0;
      const delta = before ? s.t0 - t : t > s.t1 ? t - s.t1 : 0;
      const W = before ? s.wa : s.wc;
      const target = s.target,
        alpha = s.alpha;
      for (let c = 0; c < NCH; c++) {
        const a = alpha[c]!;
        if (a <= 0) continue;
        let d: number;
        if (delta === 0) d = a;
        else {
          const w = W[c]!;
          if (delta >= w) continue;
          const g = GAMMA[c]!;
          d = a * Math.exp(-LN25 * Math.pow(delta / w, g));
        }
        d *= gate;
        num[c] = num[c]! + d * target[c]!;
        den[c] = den[c]! + d;
      }
    }
    for (let c = 0; c < NCH; c++) out[c] = num[c]! / Math.max(den[c]!, 1e-4);
  }
}
