/**
 * The articulator plant.
 *
 * The blend produces a muscle *command*; the articulator adds mass. Solving
 * `ẍ + 2ζωẋ + ω²x = ω²u` in closed form over the frame makes the step exact for
 * a constant target at *any* `dt`, so a GC pause, a backgrounded tab or a
 * thermally-throttled phone can slow the animation but can never ring or
 * explode it.
 *
 * Because the director's impulses are applied to *velocity*, this one class
 * produces anticipation, overshoot and follow-through with no extra state — the
 * three animation principles that separate animation from interpolation.
 */

import { clamp } from "./math";

export class Osc2 {
  x = 0;
  v = 0;

  constructor(
    private fUp: number,
    private fDn: number,
    private zUp: number,
    private zDn: number,
    private vmax: number,
    private lo = 0,
    private hi = 1,
  ) {}

  step(u: number, dt: number, speed = 1): number {
    // Switching ω and ζ on direction is a *parameter* discontinuity, not a state
    // one — x and v carry through, so there is no visual pop at the turnaround.
    const rising = u > this.x;
    const w = 2 * Math.PI * (rising ? this.fUp : this.fDn) * speed;
    const z = rising ? this.zUp : this.zDn;
    const y0 = this.x - u,
      v0 = this.v,
      a = z * w,
      e = Math.exp(-a * dt);
    let y: number, vv: number;
    if (Math.abs(1 - z) < 1e-3) {
      y = e * (y0 + (v0 + w * y0) * dt);
      vv = e * (v0 - dt * w * (v0 + w * y0));
    } else if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z),
        c = Math.cos(wd * dt),
        s = Math.sin(wd * dt);
      y = e * (y0 * c + ((v0 + a * y0) / wd) * s);
      vv = e * (v0 * c - ((w * w * y0 + a * v0) / wd) * s);
    } else {
      const r = w * Math.sqrt(z * z - 1),
        ch = Math.cosh(r * dt),
        sh = Math.sinh(r * dt);
      y = e * (y0 * ch + ((v0 + a * y0) / r) * sh);
      vv = e * (v0 * ch - ((w * w * y0 + a * v0) / r) * sh);
    }
    this.x = u + y;
    this.v = clamp(vv, -this.vmax, this.vmax);
    // One NaN reaching the uniform makes the whole mouth region garbage on some
    // drivers, so this guard is load-bearing rather than defensive noise.
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
      this.x = u;
      this.v = 0;
    }
    if (this.x < this.lo) {
      this.x = this.lo;
      if (this.v < 0) this.v *= -0.15; // the lip smack
    }
    if (this.x > this.hi) {
      this.x = this.hi;
      if (this.v > 0) this.v *= -0.15;
    }
    return this.x;
  }

  kick(dv: number) {
    this.v += dv;
  }

  /** Anti-windup: a post-filter guarantee forced `x`, so carry the state rather than fight it. */
  reseat(val: number, dt: number) {
    this.v += ((val - this.x) / Math.max(dt, 1e-4)) * 0.5;
    this.v = clamp(this.v, -this.vmax, this.vmax);
    this.x = val;
  }

  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
}
