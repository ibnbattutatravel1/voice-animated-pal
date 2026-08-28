/**
 * The physics underneath the performance.
 *
 * Everything here is deterministic and allocation-free once constructed. The
 * brain runs this 60 times a second with a 500k-triangle canvas mounted, so a
 * single object literal per frame is a GC pause the user can actually see.
 */

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Frame-rate independent exponential approach. */
export const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const smoothstep01 = (x: number) => x * x * (3 - 2 * x);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const d = e1 - e0;
  return smoothstep01(clamp01((x - e0) / (d === 0 ? 1e-6 : d)));
};

/**
 * A damped oscillator integrated by its **exact** solution rather than by a
 * Euler step.
 *
 * The semi-implicit form this replaces was conditionally stable — its effective
 * frequency drifted with the frame rate, so the same spring rang differently at
 * 60 and 144 Hz, and only a `min(dt, 1/30)` clamp kept it from exploding when a
 * backgrounded tab handed it a two-second step. The closed form has neither
 * problem: it is unconditionally stable, exact for a step input, and identical
 * at every frame rate, which is what lets the same ζ read as the same weight on
 * every machine.
 */
export class DelaySpring {
  value = 0;
  vel = 0;
  private readonly w: number;
  private readonly zw: number;
  private readonly wd: number;
  private readonly w2: number;
  private h = -1;
  private e = 0;
  private c = 1;
  private s = 0;

  constructor(w: number, z: number) {
    this.w = w;
    // This is the underdamped branch; ζ ≥ 1 would need sinh/cosh. Nothing in
    // the rig is overdamped, and pinning ζ just under 1 reproduces critical
    // damping to six figures while keeping ω_d far from zero, where the
    // (v + ζωA)/ω_d term would lose precision.
    const zz = clamp(z, 0, 0.999);
    this.zw = zz * w;
    this.wd = w * Math.sqrt(1 - zz * zz);
    this.w2 = w * w;
  }

  /** The three transcendentals only move when the frame time does. */
  private coeffs(h: number) {
    if (Math.abs(h - this.h) < 1e-5) return;
    this.h = h;
    this.e = Math.exp(-this.zw * h);
    this.c = Math.cos(this.wd * h);
    this.s = Math.sin(this.wd * h);
  }

  step(target: number, h: number, force = 0) {
    this.coeffs(h);
    const d = target + force / this.w2;
    const a = this.value - d;
    const v0 = this.vel;
    const b = (v0 + this.zw * a) / this.wd;
    this.vel = this.e * (v0 * this.c - ((this.zw * v0 + this.w2 * a) / this.wd) * this.s);
    return (this.value = d + this.e * (a * this.c + b * this.s));
  }

  /**
   * The overlap signal. Zero at rest, positive while the driver accelerates
   * away, and it **reverses** as the spring overshoots on the way down — which
   * is exactly drag-then-whip, for free, on motion nobody authored.
   */
  residual(target: number) {
    return target - this.value;
  }

  kick(v: number) {
    this.vel += v;
  }

  reset(v = 0) {
    this.value = v;
    this.vel = 0;
  }
}

/**
 * Acceleration of a driver signal, for the inertial jelly.
 *
 * Raw second differences of a 60 Hz channel are almost pure differentiation
 * noise, so each stage is filtered: velocity through a 40 rad/s EMA and
 * acceleration through a 25 rad/s one. The final length clamp is the numerical
 * guard — without it one long frame is a step input to a differentiator and the
 * whole body wobbles at full amplitude for half a second.
 */
export class Accel3 {
  ax = 0;
  ay = 0;
  az = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private primed = false;

  step(x: number, y: number, z: number, h: number) {
    if (!this.primed) {
      this.primed = true;
      this.px = x;
      this.py = y;
      this.pz = z;
      return;
    }
    const inv = 1 / h;
    const kv = 1 - Math.exp(-40 * h);
    const ka = 1 - Math.exp(-25 * h);

    const nvx = this.vx + ((x - this.px) * inv - this.vx) * kv;
    const nvy = this.vy + ((y - this.py) * inv - this.vy) * kv;
    const nvz = this.vz + ((z - this.pz) * inv - this.vz) * kv;
    this.px = x;
    this.py = y;
    this.pz = z;

    this.ax += ((nvx - this.vx) * inv - this.ax) * ka;
    this.ay += ((nvy - this.vy) * inv - this.ay) * ka;
    this.az += ((nvz - this.vz) * inv - this.az) * ka;
    this.vx = nvx;
    this.vy = nvy;
    this.vz = nvz;

    const m = Math.hypot(this.ax, this.ay, this.az);
    if (m > 60) {
      const k = 60 / m;
      this.ax *= k;
      this.ay *= k;
      this.az *= k;
    }
  }

  reset() {
    this.primed = false;
    this.ax = this.ay = this.az = 0;
    this.vx = this.vy = this.vz = 0;
  }
}

/**
 * A short history of one scalar, sampled at an arbitrary lag.
 *
 * The attention chain needs the *same* gaze target 60 ms and 140 ms ago; a
 * fixed slot count would encode the frame rate into the delay, so each sample
 * carries its own timestamp and the read interpolates.
 */
export class Delay {
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private readonly cap: number;
  private head = 0;
  private n = 0;

  constructor(cap = 64) {
    this.cap = cap;
    this.ts = new Float64Array(cap);
    this.vs = new Float64Array(cap);
  }

  push(t: number, v: number) {
    this.head = this.n === 0 ? 0 : (this.head + 1) % this.cap;
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    if (this.n < this.cap) this.n++;
  }

  /** The value as it was `lag` seconds ago; holds the oldest sample if asked further back. */
  at(now: number, lag: number): number {
    if (this.n === 0) return 0;
    const want = now - lag;
    let i = this.head;
    for (let k = 1; k < this.n; k++) {
      const prev = (i - 1 + this.cap) % this.cap;
      const t0 = this.ts[prev]!;
      if (t0 <= want) {
        const t1 = this.ts[i]!;
        const s = t1 > t0 ? clamp01((want - t0) / (t1 - t0)) : 1;
        const v0 = this.vs[prev]!;
        return v0 + (this.vs[i]! - v0) * s;
      }
      i = prev;
    }
    return this.vs[i]!;
  }

  reset() {
    this.head = 0;
    this.n = 0;
  }
}

const hash1 = (i: number, seed: number) => {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
};

/**
 * Value noise in -1..1, C2 across cell boundaries because the quintic fade has
 * zero first *and* second derivative at both ends. C1 would be enough for the
 * value; C2 is what keeps the drift's contribution to the acceleration
 * estimator smooth, so idle breathing never tickles the jelly.
 */
export function vnoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash1(i, seed);
  return a + (hash1(i + 1, seed) - a) * u;
}

/**
 * Three octaves at irrational ratios. Integer ratios would relock every few
 * seconds and the drift would develop a visible beat — the exact mechanical
 * tell the drift layer exists to hide.
 */
const PHI = 1.6180339887;
export function fbm(t: number, seed: number): number {
  return (
    (vnoise(t, seed) +
      0.5 * vnoise(t * PHI + 11.7, seed ^ 0x9e37) +
      0.25 * vnoise(t * PHI * PHI + 23.4, seed ^ 0x85eb)) /
    1.75
  );
}

/** Seeded xorshift32. Every random decision in the brain goes through one of
 * these, so a bad-looking sequence can be reproduced from its seed. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  /** Uniform in [a, b). */
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  chance(p: number) {
    return this.next() < p;
  }
  reseed(seed: number) {
    this.s = seed >>> 0 || 1;
  }
}

export type EaseId = "li" | "si" | "qi" | "qo" | "bi" | "bo" | "eo" | "hd";

/**
 * The cartoon vocabulary, as functions.
 *
 * `qi`/`bi` are the anticipation shapes — they leave slowly, and `bi` actually
 * goes the wrong way first. `qo`/`bo` are arrivals; `bo` overshoots and comes
 * back, which is the single most important curve in the table. `eo` is the
 * settle, `hd` is a hold that steps at the key rather than gliding into it.
 */
const P = Math.PI;
export const EASE: Record<EaseId, (s: number) => number> = {
  li: (s) => s,
  si: (s) => 0.5 - 0.5 * Math.cos(P * s),
  qi: (s) => s * s,
  qo: (s) => 1 - (1 - s) * (1 - s),
  bi: (s) => s * s * (2.9 * s - 1.9),
  bo: (s) => 1 + (s - 1) * (s - 1) * (2.9 * (s - 1) + 1.9),
  eo: (s) => (s >= 1 ? 1 : 1 - Math.pow(2, -10 * s) * Math.cos((s * 10 - 0.75) * ((2 * P) / 3))),
  hd: () => 0,
};
