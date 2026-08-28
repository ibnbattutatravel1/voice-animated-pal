import { applyFoldBudget, FOLD_BUDGET, restPose, type PalPose } from "./pal-rig";
import type { Mood, PalSignal } from "./pal-signal";
import type { SpeechEvent } from "./lipsync/types";
import {
  Accel3,
  approach,
  clamp,
  clamp01,
  Delay,
  DelaySpring,
  fbm,
  lerp,
  Rng,
  smoothstep,
} from "./pal-motion";
import {
  CAP,
  Ch,
  Claim,
  CLIP,
  clipEnv,
  GESTURES,
  MIRROR_CH,
  MIRROR_SIGN,
  MOOD_BIT,
  sampleTrack,
  type Gesture,
} from "./pal-gestures";

export { clamp as palClamp, lerp as palLerp, approach as palApproach };

/** What the scheduler needs to know about the world this frame. */
type Ctx = {
  mood: Mood;
  reduced: boolean;
  pointerActive: boolean;
  level: number;
  idleFor: number;
  speaking: boolean;
  doze: boolean;
};

type Clip = {
  idx: number;
  g: Gesture;
  u: number;
  /** How many of the clip's impulses have already fired. */
  imp: number;
  speed: number;
  amp: number;
  mirror: number;
  /** Early-release multiplier; a released clip fades instead of cutting. */
  fade: number;
  fadeRate: number;
};

/** The ω/ζ of the springs impulses are aimed at, shared with `kick*` below so
 * an impulse can be authored as the peak it should produce. */
const CROWN_W = 22,
  CROWN_Z = 0.45;
const BELLY_W = 35,
  BELLY_Z = 0.26;
const SQUASH_W = 30,
  SQUASH_Z = 0.35;
const wd = (w: number, z: number) => w * Math.sqrt(1 - z * z);

const DOZE_POOL = ["settle", "deepBreath", "blinkFlurry"];

/**
 * Picks what she does next.
 *
 * Weighted random over the library, filtered by mood, cooldown, bus conflicts
 * and a don't-repeat memory, then biased by how well the clip's energy matches
 * her current arousal and by the situation. The bus filter is the important
 * one: up to three clips run at once as long as they touch different parts of
 * her, which is what stops the idle loop reading as a playlist.
 */
export class GestureDirector {
  readonly out = new Float32Array(Ch.COUNT);
  arousal = 0.3;
  /** Envelope of the loudest clip running, for the drift layer to duck under. */
  peakEnv = 0;
  claims = 0;

  private t = 0;
  private active: Clip[] = [];
  private readonly lastAt = new Float64Array(GESTURES.length).fill(-1e9);
  private readonly wts = new Float64Array(GESTURES.length);
  private recent: number[] = [];
  private nextAt = 3;
  private readonly rng: Rng;
  private readonly onImpulse: (jiggle: number, squash: number, crown: number) => void;

  constructor(rng: Rng, onImpulse: (jiggle: number, squash: number, crown: number) => void) {
    this.rng = rng;
    this.onImpulse = onImpulse;
  }

  tick(dt: number, ctx: Ctx) {
    this.t += dt;

    const drive =
      (ctx.pointerActive ? 0.35 : 0) +
      ctx.level * 0.9 +
      (ctx.mood === "speaking" ? 0.45 : 0) +
      (ctx.mood === "listening" ? 0.3 : 0);
    const want = ctx.reduced ? Math.min(0.45, clamp01(0.12 + drive)) : clamp01(0.12 + drive);
    this.arousal = approach(this.arousal, want, 0.6, dt);

    this.claims = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i]!;
      c.u += (dt * c.speed) / c.g.dur;
      if (c.fadeRate > 0) c.fade = Math.max(0, c.fade - dt * c.fadeRate);
      if (c.u >= 1 || c.fade <= 0) {
        this.lastAt[c.idx] = this.t;
        this.active.splice(i, 1);
        continue;
      }
      this.claims |= c.g.claims;
      this.fireImpulses(c);
    }

    if (this.t >= this.nextAt && this.active.length < 3) this.trySchedule(ctx);
    this.evaluate();
  }

  /** Play a clip by id regardless of weight, cooldown or mood — reactions. */
  playId(id: string, ctx: Ctx, force = false) {
    const idx = CLIP[id];
    if (idx === undefined) return false;
    const g = GESTURES[idx]!;
    if (!force && (this.claims & g.claims) !== 0) return false;
    if (ctx.reduced && g.reduced === false) return false;
    if (force) this.release(g.claims, 0.12);
    this.spawn(idx, ctx);
    return true;
  }

  /** Fade every clip holding any of `mask` instead of cutting it dead. */
  release(mask: number, secs: number) {
    if (mask === 0) return;
    for (const c of this.active) {
      if ((c.g.claims & mask) !== 0 && c.fadeRate === 0) c.fadeRate = 1 / Math.max(0.02, secs);
    }
  }

  /** Hold the scheduler off — used while speech is starting. */
  suppress(secs: number) {
    this.nextAt = Math.max(this.nextAt, this.t + secs);
  }

  isPlaying(id: string) {
    const idx = CLIP[id];
    if (idx === undefined) return false;
    for (const c of this.active) if (c.idx === idx) return true;
    return false;
  }

  /** Let go of everything over `secs`, whatever it claims. */
  releaseAll(secs: number) {
    const r = 1 / Math.max(0.02, secs);
    for (const c of this.active) if (c.fadeRate === 0) c.fadeRate = r;
  }

  reset() {
    // Fade rather than cut: `resume()` also runs after a long frame on a
    // visible tab, and a clip vanishing mid-pose is a pop the user can see.
    this.releaseAll(0.15);
    this.peakEnv = 0;
    // A resume must not dump the whole backlog of cooled-down clips at once;
    // push the next pick out past the settling frames.
    this.nextAt = this.t + 1.2;
  }

  private trySchedule(ctx: Ctx) {
    const moodBit = MOOD_BIT[ctx.mood];
    let total = 0;
    for (let i = 0; i < GESTURES.length; i++) {
      const g = GESTURES[i]!;
      const r = this.recent.indexOf(i);
      let w = 0;
      if (
        g.weight > 0 &&
        (g.moods & moodBit) !== 0 &&
        this.t - this.lastAt[i]! >= g.cooldown &&
        (g.claims & this.claims) === 0 &&
        (!ctx.reduced || g.reduced !== false) &&
        (!ctx.speaking || (g.claims & Claim.MOUTH) === 0) &&
        (!ctx.doze || DOZE_POOL.includes(g.id)) &&
        r !== 0 &&
        r !== 1
      ) {
        w =
          g.weight *
          (1 - 0.6 * Math.abs(g.energy - this.arousal)) *
          (r >= 0 ? 0.25 : 1) *
          (1 + 0.9 * this.contextBonus(g, ctx));
      }
      this.wts[i] = w > 0 ? w : 0;
      total += this.wts[i]!;
    }
    if (total <= 0) {
      this.nextAt = this.t + 1.5;
      return;
    }
    let x = this.rng.next() * total;
    let pick = 0;
    while (pick < GESTURES.length - 1 && (x -= this.wts[pick]!) > 0) pick++;
    this.spawn(pick, ctx);

    const base = lerp(5.5, 1.6, this.arousal) * (ctx.reduced ? 2.2 : 1) * (ctx.doze ? 2.5 : 1);
    this.nextAt = this.t + Math.max(0.8, base * (0.6 + this.rng.next()));
  }

  /**
   * Situational bias, −1 (never) to +1 (please). This is what makes the same
   * library read differently in each mood: a yawn is only funny after a long
   * silence, and a shy turn is only shy if someone is there to be shy at.
   */
  private contextBonus(g: Gesture, ctx: Ctx) {
    const idle = ctx.idleFor;
    switch (g.id) {
      case "bigStretch":
        return idle > 45 ? 1 : -0.9;
      case "deepBreath":
        return idle > 30 ? 0.8 : -0.4;
      case "peek":
        return !ctx.pointerActive && idle > 12 ? 1 : -0.4;
      case "glance":
        return !ctx.pointerActive && idle > 6 ? 0.6 : 0;
      case "curiousLean":
        return ctx.mood === "listening" && ctx.level < 0.05 && idle > 10 ? 1 : 0;
      case "chinTap":
        return ctx.mood === "thinking" ? 1 : -1;
      case "swayBeat":
        return this.arousal > 0.5 ? 0.7 : -0.4;
      case "settle":
        return this.active.length === 0 && this.arousal < 0.25 ? 0.5 : 0;
      default:
        if (g.tags?.includes("social")) return ctx.pointerActive ? 0.8 : -0.5;
        if (g.tags?.includes("big")) return idle > 25 ? 0.6 : -0.4;
        return 0;
    }
  }

  private spawn(idx: number, ctx: Ctx) {
    const g = GESTURES[idx]!;
    this.active.push({
      idx,
      g,
      u: 0,
      imp: 0,
      // ±12% speed and ±15% amplitude. Two takes of the same clip are never
      // frame-identical, which is most of what stretches an 18-clip library
      // past the two minutes it takes a visitor to notice a repeat.
      speed: (1 + (this.rng.next() * 0.24 - 0.12)) * (ctx.reduced ? 0.72 : 1),
      amp: (0.86 + this.rng.next() * 0.3) * (ctx.reduced ? 0.35 : 1),
      mirror: g.mirrorable && this.rng.chance(0.5) ? -1 : 1,
      fade: 1,
      fadeRate: 0,
    });
    this.claims |= g.claims;
    this.recent.unshift(idx);
    if (this.recent.length > 4) this.recent.pop();
  }

  private fireImpulses(c: Clip) {
    const imps = c.g.impulses;
    if (!imps) return;
    while (c.imp < imps.length) {
      const im = imps[c.imp]!;
      if (c.u < im.t) break;
      c.imp++;
      this.onImpulse((im.jiggle ?? 0) * c.amp, (im.squash ?? 0) * c.amp, (im.crown ?? 0) * c.amp);
    }
  }

  private evaluate() {
    this.out.fill(0);
    this.peakEnv = 0;
    for (const c of this.active) {
      const e = clipEnv(c.u, c.g.dur, c.g.blendIn, c.g.blendOut) * c.amp * c.fade;
      if (e <= 1e-4) continue;
      if (e > this.peakEnv) this.peakEnv = e;
      for (const tk of c.g.tracks) {
        const ch = c.mirror < 0 ? MIRROR_CH[tk.ch]! : tk.ch;
        const sign = c.mirror < 0 ? MIRROR_SIGN[tk.ch]! : 1;
        const v = sampleTrack(tk, c.u, c.g.dur) * e * sign;
        if ("keys" in tk && tk.mode === "max") {
          if (v > this.out[ch]!) this.out[ch] = v;
        } else {
          this.out[ch]! += v;
        }
      }
    }
  }
}

/**
 * Turns "what is happening" into "how Nova moves".
 *
 * Six additive layers, in the order they were built and in the order they are
 * summed: a mood base, always-on breath, value-noise drift, the attention
 * chain, the voice, the gesture director, and reflexes. Nothing here is a
 * state machine that owns the body — every layer contributes and the last few
 * steps (arc coupling, the lag solver, the fold budget) reconcile the sum into
 * a pose the deformer can survive.
 *
 * The one thing worth understanding before changing anything: the secondary
 * motion is never authored. Crown follow-through and arm drag come out of
 * spring *residuals* on channels that were driven for other reasons, so every
 * motion — including ones nobody wrote — drags and whips for free.
 */
export class PalBrain {
  readonly pose: PalPose = restPose();

  private t = 0;
  private readonly rng = new Rng(0x9e3779b9);
  /** Reduced-motion amplitude, refreshed every step. Each layer is scaled where
   * it is summed, but a velocity kick is superposed on the spring independently
   * of its target, so the impulses have to carry the factor themselves. */
  private calm = 1;

  // ── mood ──────────────────────────────────────────────────────────────────
  private lastMood: Mood = "idle";
  private lastInputAt = 0;
  private doze = false;
  private dozeNodT = -1;

  // ── blink ─────────────────────────────────────────────────────────────────
  private blinkNext = 1.6;
  private blinkT = -1;
  private blinkDouble = false;

  // ── attention chain ───────────────────────────────────────────────────────
  private wantX = 0;
  private wantY = 0;
  private gazeNext = 2;
  private readonly eyeFx = new DelaySpring(6.5, 1.0);
  private readonly eyeFy = new DelaySpring(6.5, 1.0);
  private readonly headFx = new DelaySpring(2.6, 0.75);
  private readonly headFy = new DelaySpring(2.6, 0.75);
  private readonly bodyFx = new DelaySpring(1.5, 0.9);
  private readonly lagX = new Delay(64);
  private readonly lagY = new Delay(64);

  // ── body springs ──────────────────────────────────────────────────────────
  private readonly leanXS = new DelaySpring(11, 0.62);
  private readonly leanYS = new DelaySpring(11, 0.62);
  private readonly rollS = new DelaySpring(11, 0.62);
  private readonly squashS = new DelaySpring(SQUASH_W, SQUASH_Z);

  // ── lag solver ────────────────────────────────────────────────────────────
  private readonly crownYawS = new DelaySpring(CROWN_W, CROWN_Z);
  private readonly crownPitchS = new DelaySpring(CROWN_W, CROWN_Z);
  private readonly crownTiltS = new DelaySpring(CROWN_W, CROWN_Z);
  private readonly crownYS = new DelaySpring(26, 0.4);
  private readonly armLagL = new DelaySpring(15, 0.38);
  private readonly armLagR = new DelaySpring(18, 0.46);

  // ── inertial jelly ────────────────────────────────────────────────────────
  private readonly accel = new Accel3();
  private readonly jelBx = new DelaySpring(BELLY_W, BELLY_Z);
  private readonly jelBz = new DelaySpring(BELLY_W, BELLY_Z);
  private readonly jelCx = new DelaySpring(CROWN_W, 0.3);
  private readonly jelCy = new DelaySpring(CROWN_W, 0.3);

  // ── smoothed mood base ────────────────────────────────────────────────────
  private bSmile = 0.22;
  private bBrow = 0;
  private bBrowAng = 0;
  private bWiden = 0;
  private bLidU = 0;
  private bLidL = 0;
  private bCurve = 0.04;
  private bGlow = 0.3;
  private bBlush = 0;
  private bArmL = 0;
  private bArmR = 0;
  private bJaw = 0;
  private bWide = 0;
  private bRound = 0;
  private bPress = 0;
  private bProt = 0;
  private bTuck = 0;
  private bTongue = 0;
  private bCorner = 0;

  // ── speech performance ────────────────────────────────────────────────────
  private speakMix = 0;
  private spLean = 0;
  private spRoll = 0;
  private spBrow = 0;
  private spWiden = 0;
  private spBob = 0;
  private spArmL = 0;
  private spArmR = 0;
  private spBreath = 0;
  private beatSide = 0;

  // ── reactions ─────────────────────────────────────────────────────────────
  private pointerAbsent = 99;
  private pointerNearFor = 0;
  private quietFor = 0;
  private quietStage = 0;
  private pokeCount = 0;
  private pokeLast = -99;
  private pokeFirst = -99;
  private readonly dent = new DelaySpring(26, 0.22);
  private prevHop = 0;
  private transient = 0;
  private transientAt = -99;
  private dozePitch = 0;
  private dozeLid = 0;
  private breathPh = 0;

  private readonly dir = new GestureDirector(this.rng, (j, s, c) => this.impulse(j, s, c));
  private readonly ctx: Ctx = {
    mood: "idle",
    reduced: false,
    pointerActive: false,
    level: 0,
    idleFor: 0,
    speaking: false,
    doze: false,
  };

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  /** Drop the listener. Safe to call twice. */
  dispose() {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.resume();
  };

  /**
   * Re-seat every integrator. A backgrounded tab hands the first live frame a
   * multi-second `dt`; the springs are unconditionally stable and would survive
   * it, but the acceleration estimator sees one enormous step and the whole
   * body convulses. Cheaper to admit we lost the thread and start clean.
   */
  resume() {
    // Velocity is what convulses, not position — every spring keeps where it
    // is and loses only its momentum, so a long frame on a *visible* tab
    // settles instead of teleporting.
    for (const s of [
      this.eyeFx,
      this.eyeFy,
      this.headFx,
      this.headFy,
      this.bodyFx,
      this.leanXS,
      this.leanYS,
      this.rollS,
      this.squashS,
      this.crownYawS,
      this.crownPitchS,
      this.crownTiltS,
      this.crownYS,
      this.armLagL,
      this.armLagR,
      this.jelBx,
      this.jelBz,
      this.jelCx,
      this.jelCy,
      this.dent,
    ]) {
      s.reset(s.value);
    }
    this.accel.reset();
    this.lagX.reset();
    this.lagY.reset();
    this.dir.reset();
    // A blink in flight is left to finish for the same reason the springs keep
    // their positions: this also runs after a long frame on a visible tab, and
    // an aborted closure pops the lid open.
    this.blinkNext = this.t + 1.2;
    this.gazeNext = this.t + 1.2;
    this.prevHop = 0;
    this.transient = 0;
    this.transientAt = -99;
    this.dozeNodT = -1;
  }

  /** Ask for a wave. */
  wave() {
    this.dir.playId("greetWave", this.ctx, true);
    this.dir.arousal = Math.max(this.dir.arousal, 0.8);
    this.lastInputAt = this.t;
    this.doze = false;
  }

  /**
   * The user poked her. Coordinates are in model space; the default lands on
   * the belly so a synthetic poke from the console still dents something.
   */
  poke(x = 0.05, y = -0.05, z = 0.58) {
    const p = this.pose;
    // A contact that never made it out of the raycast lands at the origin,
    // which is inside her; dent the front of the belly instead of the middle.
    const inside = Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.05;
    p.pokeX = inside ? 0.05 : x;
    p.pokeY = inside ? -0.05 : y;
    p.pokeZ = inside ? 0.58 : z;
    this.dent.reset(0.045);

    // A dent pushes the soft mass away from the contact, so the slosh runs
    // along the contact direction rather than in the old corkscrew circle.
    const n = Math.hypot(p.pokeX, p.pokeZ) || 1;
    this.kickJelly(0.03, -p.pokeX / n, -p.pokeZ / n);
    this.kickSquash(-0.16 * this.calm);
    this.kickCrown(0.3 * this.calm);
    this.armTransient(1);

    this.pokeCount = this.t - this.pokeLast < 1.2 ? this.pokeCount + 1 : 1;
    if (this.t - this.pokeFirst > 4) {
      this.pokeFirst = this.t;
      if (this.pokeCount > 1) this.pokeCount = 1;
    }
    this.pokeLast = this.t;
    this.lastInputAt = this.t;
    this.doze = false;

    this.dir.playId("pokeReact", this.ctx, true);
    if (this.pokeCount === 2) this.dir.playId("wiggle", this.ctx, true);
    if (this.pokeCount >= 4) {
      this.dir.playId("happyBounce", this.ctx, true);
      this.dir.arousal = 1;
    }
    // Blinking through the reaction would hide the startle; hold the *next* one
    // off. Cutting one already in flight is worse than the blink it saves —
    // `lidUpper` takes a max, so a closed lid would snap open for one frame.
    this.blinkNext = this.t + 0.55;
  }

  /** Play any clip by id. Exposed for the dev console and the audit harness. */
  play(id: string) {
    return this.dir.playId(id, this.ctx, true);
  }

  /** Reproducible sequences for bug reports. */
  seed(n: number) {
    this.rng.reseed(n);
  }

  /**
   * Substepped, because clamping a long frame to a single small step does not
   * slow the *renderer* down — it slows HER down. At 500k triangles a mid phone
   * can sit at 12 fps, and a hard 1/20 clamp there runs the whole performance at
   * 60% speed: blinks stop, gestures never reach their scheduled time, and she
   * reads as a paused render. The springs are exact discretisations and every
   * clip is time-parameterised, so several small steps cost nothing but a loop.
   */
  update(dt: number, sig: PalSignal): PalPose {
    // rAF stops in a background tab, so the first live frame carries the whole
    // gap. Treat anything past half a second as a lost thread, not a big step.
    if (!(dt > 0) || dt > 0.5) this.resume();
    const total = clamp(dt > 0 ? dt : 1 / 60, 1 / 240, 1 / 6);
    const n = total > 1 / 30 ? Math.min(6, Math.ceil(total * 30)) : 1;
    const h = total / n;
    for (let i = 0; i < n; i++) this.step(h, sig);
    return this.pose;
  }

  private step(d: number, sig: PalSignal): PalPose {
    this.t += d;
    const p = this.pose;
    const g = this.dir.out;
    const sp = sig.speech;
    const calm = (this.calm = sig.reduced ? 0.35 : 1);

    if (sig.waveRequest > 0) {
      sig.waveRequest = 0;
      this.wave();
    }
    if (sig.poke > 0) {
      sig.poke = 0;
      this.poke(sig.pokeX, sig.pokeY, sig.pokeZ);
    }

    const speakingNow = sp.active || sig.speaking || sig.mood === "speaking";
    if (sig.mood !== this.lastMood) {
      this.onMoodChange(this.lastMood, sig.mood);
      this.lastMood = sig.mood;
    }

    // ── idleness, arousal, doze ───────────────────────────────────────────
    if (sig.pointerActive || sig.listening || speakingNow || sig.level > 0.06) {
      this.lastInputAt = this.t;
    }
    const idleFor = this.t - this.lastInputAt;
    if (idleFor > 120 && sig.mood === "idle") this.doze = true;
    else if (idleFor < 1) this.doze = false;

    const ctx = this.ctx;
    ctx.mood = sig.mood;
    ctx.reduced = sig.reduced;
    ctx.pointerActive = sig.pointerActive;
    ctx.level = sig.level;
    ctx.idleFor = idleFor;
    ctx.speaking = speakingNow;
    ctx.doze = this.doze;

    this.reactions(d, sig, idleFor);
    this.speech(d, sig, speakingNow);
    this.dir.tick(d, ctx);
    // Runs before the base layer because the jerk-awake has to lift the lids in
    // the same frame it snaps the head up.
    const dozePitch = this.dozeNod(d);

    const arousal = this.dir.arousal;
    // A clip in flight should read cleanly, so the drift ducks under it — but
    // never to zero, or the hold in the middle of the clip freezes.
    const driftGain = (1 - 0.65 * this.dir.peakEnv) * (1 + 0.5 * arousal) * (this.doze ? 0.5 : 1);
    const driftHz = this.doze ? 0.6 : 1;

    // ── L0 base ───────────────────────────────────────────────────────────
    let tSmile = 0.22,
      tBrow = 0.05,
      tBrowAng = 0,
      tWiden = 0,
      tLidL = 0,
      tCurve = 0.04;
    let tGlow = 0.3,
      tBlush = 0,
      tArmL = 0,
      tArmR = 0;
    let leanBias = 0,
      rollBias = 0,
      pitchBias = 0;

    switch (sig.mood) {
      case "listening": {
        // Leaning in, brows up, a little breathless — visibly paying attention.
        const l = clamp01(sig.level);
        tBrow = 0.45 + l * 0.4;
        tWiden = 0.35 + l * 0.35;
        tSmile = 0.35 + l * 0.25;
        tGlow = 0.45 + l * 0.7;
        tBlush = l * 0.5;
        // The near arm comes up a little and the flipper tucks in — an
        // asymmetric attending pose, not a symmetric "ready" stance.
        tArmL = 0.06 + l * 0.14;
        tArmR = -0.1 - l * 0.12;
        tCurve = -0.05;
        leanBias = 0.075;
        rollBias = 0.05;
        break;
      }
      case "thinking": {
        tBrow = -0.25;
        tBrowAng = 0.7;
        tSmile = 0.05;
        tLidL = 0.18;
        tWiden = -0.2;
        tGlow = 0.35;
        tCurve = 0.12;
        tArmL = -0.05;
        rollBias = -0.06;
        pitchBias = 0.03;
        break;
      }
      case "speaking": {
        tSmile = 0.3 + sp.mouth.wide * 0.35;
        tBrow = 0.2;
        tWiden = 0.15;
        tGlow = 0.5 + sp.energy * 0.5;
        tBlush = 0.25;
        break;
      }
      case "idle":
      default:
        break;
    }

    if (this.doze) {
      tGlow *= 0.55;
      tSmile *= 0.6;
      tBrow *= 0.4;
    }

    this.bSmile = approach(this.bSmile, tSmile, 7, d);
    this.bBrow = approach(this.bBrow, tBrow, 9, d);
    this.bBrowAng = approach(this.bBrowAng, tBrowAng, 7, d);
    this.bWiden = approach(this.bWiden, tWiden, 9, d);
    this.bLidL = approach(this.bLidL, tLidL, 8, d);
    this.bCurve = approach(this.bCurve, tCurve, 6, d);
    this.bGlow = approach(this.bGlow, tGlow, 6, d);
    this.bBlush = approach(this.bBlush, tBlush, 4, d);
    this.bArmL = approach(this.bArmL, tArmL, 6, d);
    this.bArmR = approach(this.bArmR, tArmR, 6, d);
    // A wide smile squeezes the eyes; a doze closes them most of the way, and
    // the jerk-awake opens them again faster than the base filter would.
    const lidTarget =
      Math.max(0, this.bSmile - 0.6) * 0.45 + (this.doze ? 0.55 * (1 - this.dozeLid) : 0);
    this.bLidU = approach(this.bLidU, lidTarget, this.dozeLid > 0.1 ? 24 : 8, d);

    // ── L1 breath ─────────────────────────────────────────────────────────
    const breathHz = this.doze ? 0.16 : lerp(0.24, 0.55, arousal);
    this.breathPh += d * breathHz;
    const breathAmp = (this.doze ? 1.4 : 1) * (0.42 + 0.1 * arousal);
    const breathWave = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.breathPh);

    // ── L2 drift ──────────────────────────────────────────────────────────
    // Measured frequencies and amplitudes, deliberately incommensurate and
    // never symmetric between the two arms — symmetry is the loudest tell that
    // an idle is generated.
    const T = this.t * driftHz;
    const dY = fbm(T * 0.13, 11) * 0.055 * driftGain;
    const dP = fbm(T * 0.11, 23) * 0.04 * driftGain;
    const dT = fbm(T * 0.09, 37) * 0.05 * driftGain;
    const dLY = fbm(T * 0.07, 53) * 0.05 * driftGain;
    const dLX = fbm(T * 0.06, 71) * 0.035 * driftGain;
    const dSway = fbm(T * 0.1, 89) * 0.018 * driftGain;
    const dArmL = fbm(T * 0.16, 101) * 0.06 * driftGain;
    const dArmR = fbm(T * 0.14, 149) * 0.06 * driftGain;
    const dSmile = fbm(T * 0.08, 167) * 0.05 * driftGain;
    // Micro-saccades survive reduced motion: they are not a vestibular hazard,
    // and eyes that hold perfectly still are the difference between a character
    // and a photograph.
    const dEyeX = fbm(this.t * 0.55, 181) * 0.045;
    const dEyeY = fbm(this.t * 0.47, 193) * 0.045;

    // ── L3 attention ──────────────────────────────────────────────────────
    this.gaze(d, sig, speakingNow);
    this.lagX.push(this.t, this.wantX);
    this.lagY.push(this.t, this.wantY);
    this.eyeFx.step(this.wantX, d);
    this.eyeFy.step(this.wantY, d);
    this.headFx.step(this.lagX.at(this.t, 0.06), d);
    this.headFy.step(this.lagY.at(this.t, 0.06), d);
    this.bodyFx.step(this.lagX.at(this.t, 0.14), d);

    // ── L6 blink (scheduled here so a saccade can mask it) ────────────────
    const blink = this.blink(d, sig, speakingNow);

    // ── sum ───────────────────────────────────────────────────────────────
    const gazeX = clamp(this.eyeFx.value + g[Ch.EYE_YAW]! + dEyeX, -1, 1);
    const gazeY = clamp(this.eyeFy.value + g[Ch.EYE_PITCH]! + dEyeY, -1, 1);

    const shift = sig.reduced ? 0 : clamp(g[Ch.SHIFT]!, -1, 1);

    let headYaw = this.headFx.value * 0.42 + g[Ch.HEAD_YAW]! + dY;
    let headPitch =
      -this.headFy.value * 0.16 + g[Ch.HEAD_PITCH]! + dP + pitchBias + this.spBob + dozePitch;
    let headTilt = this.headFx.value * 0.09 + g[Ch.HEAD_TILT]! + dT + shift * 0.055;

    const leanTargetY = this.bodyFx.value * 0.16 + g[Ch.LEAN_Y]! + dLY;
    const leanTargetX = leanBias + g[Ch.LEAN_X]! + dLX + this.spLean;
    const rollTarget = rollBias + g[Ch.ROLL]! + this.spRoll - shift * 0.045;

    this.leanYS.step(leanTargetY * calm, d);
    this.leanXS.step(leanTargetX * calm, d);
    this.rollS.step(rollTarget * calm, d);

    const bob = Math.sin(this.t * 1.15) * 0.006;
    const voiceBounce = speakingNow ? sp.mouth.jaw * 0.012 + sp.accent * 0.01 : sig.level * 0.014;
    this.squashS.step((bob + voiceBounce + g[Ch.SQUASH]!) * calm, d);

    headYaw = clamp(headYaw * calm, -CAP.headYaw, CAP.headYaw);
    headPitch *= calm;
    headTilt *= calm;

    // Arc coupling. Three lines, and they do more for a turn than any keyframe:
    // a head that yaws without dipping or tipping reads as a turret.
    headPitch += 0.22 * Math.abs(headYaw);
    headTilt += 0.3 * headYaw + 0.18 * this.rollS.value;

    p.headYaw = headYaw;
    p.headPitch = clamp(headPitch, -CAP.headPitch, CAP.headPitch);
    p.headTilt = clamp(headTilt, -CAP.headTilt, CAP.headTilt);
    p.leanX = clamp(this.leanXS.value, -CAP.leanX, CAP.leanX);
    p.leanY = clamp(this.leanYS.value, -CAP.leanY, CAP.leanY);
    p.roll = clamp(this.rollS.value, -CAP.roll, CAP.roll);

    // Per-channel caps do not compose — all of them at their solo limits
    // inverts the mesh. Normalise the loaded channels together, with a little
    // extra allowance while an impact transient is still ringing. The decay is
    // deliberately fast: the wider budget only holds det ≥ 0.25, which is fine
    // for two frames of a hit and visible as a crease if it lingers.
    this.transient = approach(this.transient, 0, 13, d);
    if (this.transient < 0.02) this.transient = 0; // land back on the exact budget
    applyFoldBudget(p, FOLD_BUDGET + (1.1 - FOLD_BUDGET) * this.transient);

    // ── body ──────────────────────────────────────────────────────────────
    const hopY = sig.reduced ? 0 : clamp(g[Ch.HOP]!, 0, CAP.hop);
    p.hopY = hopY;
    p.airborne = smoothstep(0.015, 0.05, hopY);
    // Derived, never keyed: a hop track and an `airborne` track could disagree,
    // and then the squash pivot swaps while she is still on the floor.
    if (this.prevHop > 0.03 && hopY <= 0.02) {
      this.dir.playId("landImpact", this.ctx, true);
      this.armTransient(1);
    }
    this.prevHop = hopY;

    p.squash = clamp(this.squashS.value, -CAP.squash, CAP.squash);
    p.breathe = clamp01(
      breathWave * breathAmp +
        g[Ch.BREATHE]! * 0.55 +
        this.spBreath +
        sp.breath * 0.3 * this.speakMix,
    );
    p.sway = sig.reduced ? 0 : clamp(g[Ch.SWAY]! + dSway + shift * 0.055, -CAP.sway, CAP.sway);
    p.shift = shift;
    p.footL = clamp01(0.5 - shift * 0.5 + g[Ch.FOOT_L]!);
    p.footR = clamp01(0.5 + shift * 0.5 + g[Ch.FOOT_R]!);

    // ── L6 lag solver ─────────────────────────────────────────────────────
    // Never animate the crown; feed it the residual of the channel that moved.
    // Positive residual means the head is still accelerating away, so the crown
    // trails behind it; when the spring overshoots the residual flips sign and
    // the crown whips through. Drag and whip, on motion nobody authored.
    const lagYDrive = p.hopY + p.squash;
    this.crownYawS.step(p.headYaw, d);
    this.crownPitchS.step(p.headPitch, d);
    this.crownTiltS.step(p.headTilt, d);
    this.crownYS.step(lagYDrive, d);

    p.crownYaw = clamp(-0.7 * this.crownYawS.residual(p.headYaw), -CAP.crownYaw, CAP.crownYaw);
    p.crownPitch = clamp(
      -0.7 * this.crownPitchS.residual(p.headPitch),
      -CAP.crownPitch,
      CAP.crownPitch,
    );

    // ── jelly ─────────────────────────────────────────────────────────────
    this.accel.step(p.sway + p.roll * 0.35, hopY + p.squash * 0.35, p.leanX * 0.35, d);
    const kB = 0.001 * BELLY_W * BELLY_W;
    const kC = 0.001 * CROWN_W * CROWN_W;
    this.jelBx.step(0, d, -this.accel.ax * kB);
    this.jelBz.step(0, d, -this.accel.az * kB);
    this.jelCx.step(0, d, -this.accel.ax * kC);
    this.jelCy.step(0, d, -this.accel.ay * kC);

    // Reduced motion zeroes the vestibular channels outright rather than
    // scaling them: a small wobble is still a wobble.
    const jig = sig.reduced ? 0 : 1;
    p.jiggleX = clamp((this.jelBx.value + g[Ch.JIGGLE]!) * jig, -CAP.jiggle, CAP.jiggle);
    p.jiggleZ = clamp(this.jelBz.value * jig, -CAP.jiggle, CAP.jiggle);
    p.crownTilt = clamp(
      -0.7 * this.crownTiltS.residual(p.headTilt) + this.jelCx.value * 0.6 * jig,
      -CAP.crownTilt,
      CAP.crownTilt,
    );
    p.crownLagY = clamp(
      -0.55 * this.crownYS.residual(lagYDrive) + this.jelCy.value * 0.5 * jig,
      -CAP.crownLagY,
      CAP.crownLagY,
    );

    // ── arms ──────────────────────────────────────────────────────────────
    const armDrive = p.roll + p.sway + 0.4 * p.headTilt;
    this.armLagL.step(armDrive, d);
    this.armLagR.step(armDrive, d);
    const lagL = -0.55 * this.armLagL.residual(armDrive);
    const lagR = -0.35 * this.armLagR.residual(armDrive);

    const idleArmL = Math.sin(this.t * 0.9) * 0.06 + dArmL;
    const idleArmR = Math.sin(this.t * 0.75 + 1.4) * 0.05 + dArmR;

    p.armLLift = clamp(
      (this.bArmL + g[Ch.ARM_L_LIFT]! + idleArmL + this.spArmL) * calm + lagL,
      -CAP.armLLift,
      CAP.armLLift,
    );
    p.armRLift = clamp(
      (this.bArmR + g[Ch.ARM_R_LIFT]! + idleArmR + this.spArmR) * calm + lagR,
      CAP.armRLiftMin,
      CAP.armRLiftMax,
    );
    p.armLReach = clamp(g[Ch.ARM_L_REACH]! * calm, -CAP.armReach, CAP.armReach);
    p.armRReach = clamp(g[Ch.ARM_R_REACH]! * calm, -CAP.armReach, CAP.armReach);
    p.armLTwist = clamp(g[Ch.ARM_L_TWIST]! * calm, -CAP.armTwist, CAP.armTwist);
    p.armRTwist = clamp(g[Ch.ARM_R_TWIST]! * calm, -CAP.armTwist, CAP.armTwist);
    p.armLWrist = clamp(g[Ch.ARM_L_WRIST]! * calm, -CAP.armWrist, CAP.armWrist);
    p.armRWrist = clamp(g[Ch.ARM_R_WRIST]! * calm, -CAP.armWrist, CAP.armWrist);

    // ── face ──────────────────────────────────────────────────────────────
    p.eyeYaw = gazeX * 0.36;
    p.eyePitch = gazeY * 0.24;
    p.eyeWiden = clamp(this.bWiden + g[Ch.EYE_WIDEN]! + this.spWiden, -1, 1);
    // Lids take the max, never the sum: a blink has to win outright or it
    // half-closes and reads as a flinch.
    p.lidUpper = clamp01(
      Math.max(blink, this.bLidU + Math.max(0, -p.eyePitch) * 0.5, g[Ch.LID_UPPER]!),
    );
    p.lidLower = clamp01(Math.max(this.bLidL, g[Ch.LID_LOWER]!));
    p.lidCurve = clamp(this.bCurve + g[Ch.LID_CURVE]! + (this.doze ? 0.3 : 0), -1, 1);
    p.browRaise = clamp(
      this.bBrow + g[Ch.BROW_RAISE]! + this.spBrow + Math.max(0, p.eyePitch) * 1.4,
      -1,
      1.4,
    );
    p.browAngle = clamp(this.bBrowAng + g[Ch.BROW_ANGLE]!, -1, 1);

    const smirk = g[Ch.SMIRK]!;
    p.smile = clamp(
      this.bSmile + g[Ch.SMILE]! + dSmile + sp.smile * 0.5 * this.speakMix + this.bCorner * 0.3,
      -1,
      1,
    );
    p.sneer = clamp(smirk * 0.35, -1, 1);
    // A face that is exactly symmetric reads as computed, so the corners carry
    // the smirk asymmetrically and drift on their own seeds.
    p.cornerL = clamp(this.bCorner * 0.5 - smirk * 0.25 + fbm(this.t * 0.13, 211) * 0.06, -1, 1);
    p.cornerR = clamp(this.bCorner * 0.5 + smirk * 0.75 + fbm(this.t * 0.13, 227) * 0.06, -1, 1);

    this.mouth(d, sig, g);

    // ── extras ────────────────────────────────────────────────────────────
    this.dent.step(0, d);
    p.pokeAmt = Math.max(this.dent.value, -0.012);
    p.rim = clamp(0.18 + this.bGlow * 0.5 + sp.energy * 0.25 * this.speakMix, 0, 1.5);
    p.blushBoost = clamp01(this.bBlush + g[Ch.BLUSH]!);
    p.time = this.t;
    return p;
  }

  // ────────────────────────────────────────────────────────────────── mouth

  /**
   * While the engine is talking it owns the articulators outright — the values
   * arrive already smoothed by the lip-sync blender, and running them through
   * another exponential filter here is what used to eat every plosive. The base
   * path keeps tracking the engine even while idle, so the 120 ms cross-fade at
   * a mood flip has nothing to step over.
   */
  private mouth(d: number, sig: PalSignal, g: Float32Array) {
    const p = this.pose;
    const m = sig.speech.mouth;
    const sp = sig.speech;
    const mix = this.speakMix;
    // Gesture mouth tracks duck out of the way of speech rather than being
    // switched off, so a clip that outlives the utterance lands its own ending.
    const gate = 1 - 0.75 * mix;

    this.bJaw = approach(this.bJaw, m.jaw, 26, d);
    this.bWide = approach(this.bWide, m.wide, 21, d);
    this.bRound = approach(this.bRound, m.round, 21, d);
    this.bPress = approach(this.bPress, m.press, 23, d);
    this.bProt = approach(this.bProt, m.protrude, 21, d);
    this.bTuck = approach(this.bTuck, m.tuck, 23, d);
    this.bTongue = approach(this.bTongue, m.tongue, 24, d);
    this.bCorner = approach(this.bCorner, m.corner, 9, d);

    // The lip-sync engine keeps a live idle mouth of its own, but the brain
    // must not depend on one being wired: a mouth that is a still frame between
    // utterances reads as a paused render rather than as a character waiting.
    const idleLife = (1 - mix) * (this.doze ? 0.008 : 0.014 + 0.014 * p.breathe);
    const jaw = clamp01(lerp(this.bJaw, m.jaw, mix) + g[Ch.JAW]! * gate + idleLife);
    const wide = clamp01(lerp(this.bWide, m.wide, mix) + g[Ch.MOUTH_WIDE]! * gate);
    const round = clamp01(lerp(this.bRound, m.round, mix) + g[Ch.MOUTH_ROUND]! * gate);
    const press = clamp01(lerp(this.bPress, m.press, mix) + g[Ch.MOUTH_PRESS]! * gate);
    const prot = clamp01(lerp(this.bProt, m.protrude, mix));
    const tuck = clamp01(lerp(this.bTuck, m.tuck, mix));
    const tongue = clamp01(lerp(this.bTongue, m.tongue, mix));

    p.jawOpen = jaw;
    p.mouthWide = wide;
    p.mouthRound = round;
    p.mouthPress = press;
    p.funnel = prot;
    p.tuck = tuck;
    // Rest is a tongue sitting in the mouth, not a flat floor.
    p.tongueUp = clamp01(0.25 * (1 - tongue) + tongue);
    // The MouthShape has one tongue channel; the tip only clears the lip at the
    // top of its range, which is exactly where TH lives.
    p.tongueTip = clamp01((tongue - 0.72) / 0.28) * 0.6;

    // The lips are their own muscle. Deriving the aperture from the jaw alone
    // is what makes text-driven lip sync look like a hinge; spreading widens it
    // without dropping the mandible, which is the whole point of EE.
    p.lipOpen = clamp01((jaw * (0.55 + 0.45 * wide) + 0.18 * round) * (1 - press));
    p.loud = clamp01(sp.energy * mix);
    p.tension = clamp01(0.3 * press + 0.45 * tuck + 0.35 * sp.emphasis * mix);
    p.teethShow = clamp01(lerp(0.85, 0.6 + 0.4 * wide - 0.35 * round, mix));
    p.mouthRoll = 0.04 + sp.tilt * 0.03 * mix;
    p.mouthShiftX = sp.skew * 0.012 * mix;
    // Deliberately neutral: a vertical offset of the drawn mouth slides it off
    // the muzzle patch, and the jaw deformer already carries the mouth down.
    p.mouthShiftY = 0;
    p.cheekPuff = clamp01(g[Ch.CHEEK]! + press * 0.15);
  }

  // ─────────────────────────────────────────────────────────────────── gaze

  private gaze(d: number, sig: PalSignal, speaking: boolean) {
    // A GAZE-claiming clip decides where she looks; the underlying want relaxes
    // to centre so the clip's eye track is an offset from a known place.
    if ((this.dir.claims & Claim.GAZE) !== 0) {
      this.wantX = approach(this.wantX, 0, 3, d);
      this.wantY = approach(this.wantY, 0, 3, d);
      this.gazeNext = this.t + 0.4;
      return;
    }

    if (sig.pointerActive) {
      this.retarget(clamp(sig.pointerX, -1, 1), clamp(sig.pointerY, -1, 1), false);
      this.gazeNext = this.t + 1.4;
    } else if (speaking) {
      // Reorienting on the sentence's own structure is what separates
      // intention from fidgeting: she turns because the phrase turned.
      this.retarget(clamp(sig.speech.turn * 0.6, -1, 1), 0.05 + sig.speech.nod * 0.15, false);
      this.gazeNext = this.t + 0.6;
    } else if (this.t >= this.gazeNext) {
      if (sig.mood === "thinking") {
        // Eyes up and away — the universal "let me think" tell.
        this.retarget(-0.55 - this.rng.next() * 0.25, 0.5 + this.rng.next() * 0.3, true);
        this.gazeNext = this.t + 0.7 + this.rng.next() * 0.8;
      } else if (this.rng.chance(0.42)) {
        this.retarget(0, 0.08, true);
        this.gazeNext = this.t + 1.4 + this.rng.next() * 2.4;
      } else {
        this.retarget((this.rng.next() * 2 - 1) * 0.8, (this.rng.next() * 2 - 1) * 0.5 + 0.1, true);
        this.gazeNext = this.t + 0.9 + this.rng.next() * 1.8;
      }
    }
  }

  /**
   * Move the gaze target, and mask a big jump with a blink. Real eyes hide
   * roughly a third of their large saccades this way; without it every
   * look-around reads as a servo sweep.
   */
  private retarget(x: number, y: number, maskable: boolean) {
    const jump = Math.hypot(x - this.wantX, y - this.wantY);
    this.wantX = x;
    this.wantY = y;
    if (maskable && jump > 0.45 && this.blinkT < 0 && this.rng.chance(0.55)) {
      this.blinkNext = Math.min(this.blinkNext, this.t + 0.04);
    }
  }

  // ────────────────────────────────────────────────────────────────── blink

  private blink(d: number, sig: PalSignal, speaking: boolean): number {
    if (this.blinkT < 0 && this.t >= this.blinkNext) {
      this.blinkT = 0;
      this.blinkDouble = this.rng.chance(0.22);
    }
    if (this.blinkT < 0) return 0;

    this.blinkT += d;
    const close = 0.075,
      hold = 0.03,
      open = 0.11;
    const cycle = close + hold + open;
    const local = this.blinkDouble ? this.blinkT % (cycle + 0.06) : this.blinkT;
    let v = 0;
    if (local < close) v = local / close;
    else if (local < close + hold) v = 1;
    else if (local < cycle) v = 1 - (local - close - hold) / open;

    const span = this.blinkDouble ? (cycle + 0.06) * 2 : cycle;
    if (this.blinkT >= span) {
      this.blinkT = -1;
      const busy = sig.mood === "listening" || speaking;
      this.blinkNext = this.t + (busy ? 1.6 : 2.6) + this.rng.next() * (busy ? 2.6 : 4.2);
    }
    return v;
  }

  // ───────────────────────────────────────────────────────────────── speech

  private speech(d: number, sig: PalSignal, speaking: boolean) {
    const sp = sig.speech;
    // Exactly 120 ms, linear: an exponential cross-fade leaves a tail that
    // shows up as the jaw creeping after the last word.
    this.speakMix = clamp01(this.speakMix + (speaking ? d : -d) / 0.12);

    this.spLean = approach(this.spLean, 0, 3.5, d);
    this.spRoll = approach(this.spRoll, 0, 3, d);
    this.spBrow = approach(this.spBrow, 0, 5, d);
    this.spWiden = approach(this.spWiden, 0, 4, d);
    this.spBob = approach(this.spBob, 0, 9, d);
    this.spArmL = approach(this.spArmL, 0, 6, d);
    this.spArmR = approach(this.spArmR, 0, 6, d);
    this.spBreath = approach(this.spBreath, 0, 2.2, d);

    const ev = sp.events;
    for (let i = 0; i < ev.length; i++) this.onSpeechEvent(ev[i]!, sp.emphasis);
    ev.length = 0;

    if (!speaking) return;
    const mix = this.speakMix;

    // Declination: she leans in at the top of a phrase and settles back through
    // it, then lifts again for the next one. It is the single clearest sign
    // that the body is following the sentence and not a timer.
    // Rates rather than per-frame gains: these fight the decays above, so a bare
    // blend factor settles at a different fraction of the target on every step
    // size and the whole performance flattens out on a slow device. 7.67/13.39/
    // 6.32 = −60·ln(1 − g) reproduce the old 0.12/0.2/0.1 gains at 60 Hz.
    this.spLean = approach(this.spLean, lerp(0.06, -0.02, sp.phrasePos), 7.67 * mix, d);
    this.spBob = approach(this.spBob, -sp.nod * 0.075, 13.39 * mix, d);
    this.spRoll = approach(this.spRoll, sp.tilt * 0.06, 6.32 * mix, d);
    this.spBrow = approach(
      this.spBrow,
      sp.brow * 0.55 + Math.max(0, sp.intonation) * 0.25,
      13.39 * mix,
      d,
    );
    this.spLean += sp.emphasis * 0.05 * d;

    // Sub-audible voicing jitter — far too small to see as motion, but it stops
    // the silhouette being perfectly still while a voice is coming out of it.
    if (sp.voiced > 0.05) {
      this.jelBx.kick(sp.voiced * 0.12 * Math.sin(this.t * 61) * d * 60);
    }
  }

  private onSpeechEvent(e: SpeechEvent, emphasis: number) {
    switch (e.k) {
      case "phraseStart": {
        this.spLean += 0.05;
        this.spBrow += 0.15;
        // Beat with whichever arm is free, alternating, so consecutive phrases
        // never punch with the same hand.
        this.beatSide ^= 1;
        if (this.beatSide) this.spArmL += 0.12;
        else this.spArmR += 0.1;
        break;
      }
      case "accent": {
        const k = e.nuclear ? 1.6 : 1;
        this.spBob += 0.035 * e.s * k;
        this.spBrow += 0.35 * e.s * k;
        this.spArmL += 0.3 * e.s * k;
        this.crownPitchS.kick(-1.2 * e.s * k * this.calm);
        if (e.nuclear) {
          // The whole body lands the nucleus. This is the beat the ear expects
          // to see, and missing it is most of why talking heads look dubbed.
          this.kickSquash(-0.07 * this.calm);
          this.armTransient(0.3);
        }
        break;
      }
      case "pause": {
        if (e.d > 0.35) {
          this.retarget(this.rng.range(-0.8, 0.8), this.rng.range(0.1, 0.6), true);
          this.gazeNext = this.t + Math.min(e.d * 0.6, 0.7);
        }
        break;
      }
      case "breath": {
        this.spBreath += 0.35;
        this.spArmL += 0.05;
        this.spArmR += 0.05;
        this.kickSquash(0.045 * this.calm);
        break;
      }
      case "phraseEnd": {
        if (e.tone > 0) {
          this.spRoll += 0.06;
          this.spBrow += 0.3;
          this.spWiden += 0.35;
        } else {
          this.spLean -= 0.03;
          this.spBrow -= 0.1;
          if (emphasis > 0.6) {
            this.kickSquash(-0.13 * this.calm);
            this.kickJelly(0.03, 0, 1);
            this.spArmL += 0.22;
            this.spArmR += 0.2;
            this.armTransient(0.8);
          }
        }
        break;
      }
      case "blink": {
        // Speakers blink at phrase boundaries. Cheapest life signal there is.
        if (this.blinkT < 0) this.blinkT = 0;
        break;
      }
      case "end": {
        this.dir.arousal = Math.max(0, this.dir.arousal - 0.1);
        if (this.rng.chance(0.45)) this.dir.playId("nod", this.ctx);
        else if (this.rng.chance(0.55)) this.dir.playId("settle", this.ctx);
        break;
      }
      default:
        break;
    }
  }

  private onMoodChange(from: Mood, to: Mood) {
    this.gazeNext = this.t + 0.2;
    this.lastInputAt = this.t;
    this.doze = false;
    if (to === "speaking") {
      // Let the body clips go rather than cutting them; a hard stop on the
      // first word reads as a dropped frame.
      this.dir.release(Claim.BODY | Claim.MOUTH, 0.25);
      this.dir.suppress(0.5);
    }
    if (to === "listening" && from !== "listening") {
      this.dir.arousal = Math.max(this.dir.arousal, 0.6);
    }
  }

  // ────────────────────────────────────────────────────────────── reactions

  private reactions(d: number, sig: PalSignal, idleFor: number) {
    if (sig.pointerActive) {
      const wasAway = this.pointerAbsent;
      this.pointerAbsent = 0;
      if (wasAway > 8) {
        this.dir.arousal = Math.min(1, this.dir.arousal + 0.3);
        this.dir.playId(this.rng.chance(0.6) ? "doubleTake" : "glance", this.ctx);
      }
      // Her face sits high in the frame, so "near" is measured against it and
      // not against the origin.
      const near = Math.hypot(sig.pointerX, sig.pointerY - 0.25) < 0.28;
      this.pointerNearFor = near ? this.pointerNearFor + d : 0;
      if (this.pointerNearFor > 1.2 && !this.dir.isPlaying("curiousLean")) {
        this.dir.playId("curiousLean", this.ctx);
        this.bBlush = Math.max(this.bBlush, 0.35);
        this.pointerNearFor = -3;
      }
    } else {
      const was = this.pointerAbsent;
      this.pointerAbsent += d;
      this.pointerNearFor = 0;
      if (was < 6 && this.pointerAbsent >= 6) {
        this.dir.playId(this.rng.chance(0.55) ? "peek" : "settle", this.ctx);
      }
    }

    // A listener who has been talked *at* and then goes quiet is a prompt.
    if (sig.mood === "listening" && sig.level < 0.05) {
      this.quietFor += d;
      if (this.quietStage === 0 && this.quietFor > 6) {
        this.quietStage = 1;
        this.dir.playId("headTilt", this.ctx);
      } else if (this.quietStage === 1 && this.quietFor > 12) {
        this.quietStage = 2;
        this.dir.playId("curiousLean", this.ctx);
        this.spBrow += 0.35;
      }
    } else {
      this.quietFor = 0;
      this.quietStage = 0;
    }

    if (idleFor > 45 && this.dir.arousal > 0.2) {
      this.dir.arousal = approach(this.dir.arousal, 0.12, 0.2, d);
    }
  }

  /**
   * Dozing is a modifier, not a clip — she keeps drifting and breathing, just
   * slower and heavier. The periodic nod-and-jerk is what makes it read as
   * *asleep* rather than as a stalled animation.
   */
  private dozeNod(d: number): number {
    let target = 0;
    let lid = 0;
    if (!this.doze) {
      this.dozeNodT = -1;
    } else {
      if (this.dozeNodT === -1) this.dozeNodT = -this.rng.range(12, 20);
      this.dozeNodT += d;
      const u = this.dozeNodT;
      if (u >= 0) {
        // The head sinks for 1.6 s, then catches itself in two frames. The snap
        // has to be an order of magnitude faster than the sink or it reads as a
        // slow nod rather than as someone jolting awake.
        if (u < 1.6) target = 0.13 * (0.5 - 0.5 * Math.cos((Math.PI * u) / 1.6));
        else if (u < 1.68) {
          target = lerp(0.13, -0.06, (u - 1.6) / 0.08);
          lid = 1;
        } else if (u < 2.5) {
          target = lerp(-0.06, 0, (u - 1.68) / 0.82);
          lid = 1 - (u - 1.68) / 0.82;
        } else this.dozeNodT = -this.rng.range(12, 20);
      }
    }
    this.dozeLid = approach(this.dozeLid, lid, 20, d);
    // Smoothed so that waking mid-nod does not step the head.
    this.dozePitch = approach(this.dozePitch, target, 40, d);
    return this.dozePitch;
  }

  // ──────────────────────────────────────────────────────────────── impulses

  /** Impulse amplitudes are authored as the peak they should produce, then
   * converted to the velocity kick that gets there — otherwise every retune of
   * a spring's ζ silently rescales every hit in the rig. */
  /**
   * Open the wider fold budget for an impact. Rate limited on purpose: the
   * transient allowance only holds det ≥ 0.25, which is fine for two frames of
   * a hit and reads as a crease around the waist if three hits in a row keep
   * re-arming it.
   */
  private armTransient(v: number) {
    if (this.t - this.transientAt < 0.45) return;
    this.transientAt = this.t;
    if (v > this.transient) this.transient = v;
  }

  private kickCrown(peak: number) {
    this.crownPitchS.kick((-peak * wd(CROWN_W, CROWN_Z)) / 0.7);
  }

  private kickSquash(peak: number) {
    this.squashS.kick(peak * wd(SQUASH_W, SQUASH_Z));
  }

  private kickJelly(peak: number, dx: number, dz: number) {
    const v = peak * wd(BELLY_W, BELLY_Z);
    this.jelBx.kick(v * dx);
    this.jelBz.kick(v * dz);
  }

  private impulse(jiggle: number, squash: number, crown: number) {
    if (jiggle !== 0) {
      // Slosh along whichever way the body is already travelling; a fixed axis
      // is what made the old jiggle read as mass moving in a circle.
      const ax = this.accel.ax,
        az = this.accel.az;
      const n = Math.hypot(ax, az);
      if (n > 1e-3) this.kickJelly(jiggle, -ax / n, -az / n);
      else this.kickJelly(jiggle, 0, 1);
    }
    if (squash !== 0) this.kickSquash(squash);
    if (crown !== 0) {
      this.kickCrown(crown);
      this.armTransient(1);
    }
  }
}
