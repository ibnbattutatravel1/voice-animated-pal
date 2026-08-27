import { restPose, type PalPose } from "./pal-rig";
import type { PalSignal } from "./pal-signal";

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
const approach = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Critically-damped-ish spring, for anything that should overshoot and settle. */
class Spring {
  value: number;
  private vel = 0;
  constructor(
    initial: number,
    private stiffness: number,
    private damping: number,
  ) {
    this.value = initial;
  }
  step(target: number, dt: number) {
    const d = Math.min(dt, 1 / 30);
    this.vel += (target - this.value) * this.stiffness * d;
    this.vel *= Math.exp(-this.damping * d);
    this.value += this.vel * d;
    return this.value;
  }
  kick(v: number) {
    this.vel += v;
  }
}

type Gaze = { x: number; y: number };

/**
 * Turns "what is happening" into "how the Pal moves".
 *
 * Everything here is time-based and stateful: blinks are scheduled, gaze
 * saccades between targets, gestures play out over their own duration. The
 * result is written into a single reusable pose object each frame.
 */
export class PalBrain {
  readonly pose: PalPose = restPose();

  private t = 0;
  private blinkNext = 1.6;
  private blinkT = -1;
  private blinkDouble = false;

  private gaze: Gaze = { x: 0, y: 0 };
  private gazeTarget: Gaze = { x: 0, y: 0 };
  private gazeNext = 2;

  private waveT = -1;
  private pokeT = -1;
  private jiggle = 0;
  private headBob = 0;
  private idleNext = 6;

  private squash = new Spring(0, 220, 15);
  private lean = {
    x: new Spring(0, 90, 13),
    y: new Spring(0, 90, 13),
    roll: new Spring(0, 80, 13),
  };

  private jaw = 0;
  private wide = 0;
  private round = 0;
  private press = 0;
  private smile = 0;
  private brow = 0;
  private browAngle = 0;
  private lidU = 0;
  private lidL = 0;
  private lidCurve = 0;
  private widen = 0;
  private armL = 0;
  private armR = 0;
  private glow = 0;
  private blush = 0;
  private lastMood: PalSignal["mood"] = "idle";
  private moodAge = 0;

  /** Ask for a wave; the gesture plays out over ~1.7 s. */
  wave() {
    if (this.waveT < 0) this.waveT = 0;
  }

  /** The user poked the Pal. */
  poke() {
    this.pokeT = 0;
    this.squash.kick(-9);
    this.jiggle = Math.min(0.05, this.jiggle + 0.035);
    this.blinkT = -1;
    this.blinkNext = this.t + 0.55;
  }

  update(dt: number, sig: PalSignal): PalPose {
    const d = Math.min(dt, 1 / 20);
    this.t += d;
    const p = this.pose;
    const calm = sig.reduced ? 0.35 : 1;

    if (sig.mood !== this.lastMood) {
      this.lastMood = sig.mood;
      this.moodAge = 0;
      // A change of state is a good moment to look at the user again.
      this.gazeNext = this.t + 0.2;
    }
    this.moodAge += d;

    if (sig.waveRequest > 0) {
      sig.waveRequest = 0;
      this.wave();
    }
    if (sig.poke > 0) {
      sig.poke = 0;
      this.poke();
    }

    // ---------------------------------------------------------------- blinking
    // Blinks come in a natural rhythm, faster when the Pal is engaged, and
    // occasionally double up the way real blinks do.
    if (this.blinkT < 0 && this.t >= this.blinkNext) {
      this.blinkT = 0;
      this.blinkDouble = Math.random() < 0.22;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += d;
      const close = 0.075,
        hold = 0.03,
        open = 0.11;
      const cycle = close + hold + open;
      const local = this.blinkDouble ? this.blinkT % (cycle + 0.06) : this.blinkT;
      if (local < close) blink = local / close;
      else if (local < close + hold) blink = 1;
      else if (local < cycle) blink = 1 - (local - close - hold) / open;
      else blink = 0;
      const span = this.blinkDouble ? (cycle + 0.06) * 2 : cycle;
      if (this.blinkT >= span) {
        this.blinkT = -1;
        const busy = sig.mood === "listening" || sig.mood === "speaking";
        this.blinkNext = this.t + (busy ? 1.6 : 2.6) + Math.random() * (busy ? 2.6 : 4.2);
      }
    }

    // ------------------------------------------------------------------- gaze
    // Follow the pointer when the user is present; otherwise drift around the
    // room in small saccades so the Pal never looks frozen.
    if (sig.pointerActive) {
      this.gazeTarget.x = clamp(sig.pointerX, -1, 1);
      this.gazeTarget.y = clamp(sig.pointerY, -1, 1);
      this.gazeNext = this.t + 1.4;
    } else if (this.t >= this.gazeNext) {
      if (sig.mood === "thinking") {
        // Eyes up and away — the universal "let me think" tell.
        this.gazeTarget.x = -0.55 - Math.random() * 0.25;
        this.gazeTarget.y = 0.5 + Math.random() * 0.3;
        this.gazeNext = this.t + 0.7 + Math.random() * 0.8;
      } else if (Math.random() < 0.42) {
        this.gazeTarget.x = 0;
        this.gazeTarget.y = 0.08;
        this.gazeNext = this.t + 1.4 + Math.random() * 2.4;
      } else {
        this.gazeTarget.x = (Math.random() * 2 - 1) * 0.8;
        this.gazeTarget.y = (Math.random() * 2 - 1) * 0.5 + 0.1;
        this.gazeNext = this.t + 0.9 + Math.random() * 1.8;
      }
    }
    // Saccades are fast, so the eyes snap and the head trails behind them.
    this.gaze.x = approach(this.gaze.x, this.gazeTarget.x, 16, d);
    this.gaze.y = approach(this.gaze.y, this.gazeTarget.y, 16, d);

    // ------------------------------------------------------------- expression
    let tJaw = 0,
      tWide = 0,
      tRound = 0,
      tPress = 0;
    let tSmile = 0.15,
      tBrow = 0,
      tBrowAngle = 0,
      tWiden = 0,
      tLidL = 0,
      tCurve = 0.04;
    let tArmL = 0,
      tArmR = 0;
    let tGlow = 0.3,
      tBlush = 0;
    let mouthRate = 26;

    switch (sig.mood) {
      case "listening": {
        // Leaning in, brows up, a little breathless — visibly paying attention.
        const l = clamp(sig.level, 0, 1);
        tBrow = 0.45 + l * 0.4;
        tWiden = 0.35 + l * 0.35;
        tSmile = 0.35 + l * 0.25;
        tGlow = 0.45 + l * 0.7;
        tBlush = l * 0.5;
        tJaw = l * 0.1;
        tArmR = -0.1 - l * 0.12;
        tCurve = -0.05;
        break;
      }
      case "thinking": {
        tBrow = -0.25;
        tBrowAngle = 0.7;
        tSmile = 0.05;
        tPress = 0.35;
        tLidL = 0.18;
        tWiden = -0.2;
        tGlow = 0.35;
        tCurve = 0.12;
        break;
      }
      case "speaking": {
        const m = sig.mouth;
        tJaw = m.jaw;
        tWide = m.wide;
        tRound = m.round;
        tPress = m.press;
        tSmile = 0.3 + m.wide * 0.35;
        tBrow = 0.2 + sig.accent * 0.55;
        tWiden = 0.15;
        tGlow = 0.5 + m.jaw * 0.5;
        tBlush = 0.25;
        mouthRate = 40; // the mouth has to keep up with the words
        break;
      }
      case "idle":
      default: {
        tSmile = 0.22;
        tBrow = 0.05;
        tGlow = 0.3;
        break;
      }
    }

    // A poke gets a delighted squint-and-grin, briefly overriding the mood.
    if (this.pokeT >= 0) {
      this.pokeT += d;
      const k = Math.max(0, 1 - this.pokeT / 0.9);
      tSmile = Math.max(tSmile, 0.55 + k * 0.45);
      tWiden = Math.max(tWiden, k * 0.9);
      tBrow = Math.max(tBrow, k * 0.8);
      tBlush = Math.max(tBlush, k * 0.9);
      tGlow = Math.max(tGlow, 0.4 + k * 0.8);
      if (this.pokeT > 1.4) this.pokeT = -1;
    }

    this.jaw = approach(this.jaw, tJaw, mouthRate, d);
    this.wide = approach(this.wide, tWide, mouthRate * 0.8, d);
    this.round = approach(this.round, tRound, mouthRate * 0.8, d);
    this.press = approach(this.press, tPress, mouthRate * 0.9, d);
    this.smile = approach(this.smile, tSmile, 7, d);
    this.brow = approach(this.brow, tBrow, 9, d);
    this.browAngle = approach(this.browAngle, tBrowAngle, 7, d);
    this.widen = approach(this.widen, tWiden, 9, d);
    this.lidL = approach(this.lidL, tLidL, 8, d);
    this.lidCurve = approach(this.lidCurve, tCurve, 6, d);
    this.glow = approach(this.glow, tGlow, 6, d);
    this.blush = approach(this.blush, tBlush, 4, d);

    // A wide smile naturally squeezes the eyes a little.
    this.lidU = approach(this.lidU, Math.max(0, this.smile - 0.6) * 0.45, 8, d);

    // --------------------------------------------------------------- gestures
    // A real wave: the whole forearm sweeps through roughly 50°, four times,
    // under an envelope that eases in and out so it starts and lands softly.
    if (this.waveT >= 0) {
      this.waveT += d;
      const dur = 1.9;
      const k = clamp(this.waveT / dur, 0, 1);
      const env = Math.sin(Math.PI * Math.min(1, k * 1.1));
      tArmL = (0.1 + Math.sin(this.waveT * 10.5) * 0.48) * env;
      tArmR += Math.sin(this.waveT * 10.5 + 1.0) * 0.16 * env;
      this.headBob = Math.sin(this.waveT * 10.5) * 0.03 * env;
      if (this.waveT >= dur) this.waveT = -1;
    } else if (sig.mood === "speaking") {
      // Conversational hands: a slow idle sway that punches on stressed words.
      tArmL = Math.sin(this.t * 2.6) * 0.2 + sig.accent * 0.34;
      tArmR = Math.sin(this.t * 2.0 + 2) * 0.14 - sig.accent * 0.2;
      this.headBob = approach(this.headBob, sig.accent * 0.035, 14, d);
    } else if (sig.mood === "listening") {
      tArmL = Math.sin(this.t * 1.4) * 0.09 + sig.level * 0.18;
      tArmR = Math.sin(this.t * 1.1 + 1.4) * 0.07 - sig.level * 0.12;
      this.headBob = approach(this.headBob, sig.level * 0.03, 10, d);
    } else {
      tArmL = Math.sin(this.t * 0.9) * 0.1;
      tArmR = Math.sin(this.t * 0.75 + 1.4) * 0.08;
      this.headBob = approach(this.headBob, 0, 6, d);
    }
    this.armL = approach(this.armL, clamp(tArmL * calm, -0.9, 0.9), 22, d);
    this.armR = approach(this.armR, clamp(tArmR * calm, -0.9, 0.9), 18, d);

    // Idle life: every so often the Pal does something unprompted so it never
    // looks like a paused render.
    if (sig.mood === "idle" && this.waveT < 0 && this.t >= this.idleNext) {
      this.idleNext = this.t + 7 + Math.random() * 8;
      if (Math.random() < 0.45) this.wave();
      else this.squash.kick(Math.random() < 0.5 ? 5 : -5);
    }

    // ------------------------------------------------------------ body motion
    const bob = Math.sin(this.t * 1.15) * 0.006;
    const breathe = (Math.sin(this.t * 1.5) * 0.5 + 0.5) * (sig.mood === "listening" ? 1.4 : 1);
    const voiceBounce =
      sig.mood === "speaking" ? sig.mouth.jaw * 0.012 + sig.accent * 0.01 : sig.level * 0.014;

    const leanTargetY = this.gaze.x * 0.26 + (sig.mood === "thinking" ? -0.09 : 0);
    const leanTargetX = -this.gaze.y * 0.14 + this.headBob + (sig.mood === "listening" ? 0.07 : 0);
    const rollTarget =
      (sig.mood === "listening" ? 0.07 : sig.mood === "thinking" ? -0.09 : 0) +
      Math.sin(this.t * 0.62) * 0.018;

    this.lean.y.step(leanTargetY * calm, d);
    this.lean.x.step(leanTargetX * calm, d);
    this.lean.roll.step(rollTarget * calm, d);
    this.squash.step((bob + voiceBounce) * calm, d);
    this.jiggle = approach(this.jiggle, 0, 3.4, d);

    // ---------------------------------------------------------------- publish
    // The eyes travel further than the head, which is what makes gaze read.
    p.eyeYaw = this.gaze.x * 0.36;
    p.eyePitch = this.gaze.y * 0.24;
    p.eyeWiden = this.widen;
    p.lidUpper = clamp(Math.max(blink, this.lidU), 0, 1);
    p.lidLower = this.lidL;
    p.lidCurve = this.lidCurve;
    p.jawOpen = this.jaw;
    p.mouthWide = this.wide;
    p.mouthRound = this.round;
    p.mouthPress = this.press;
    p.smile = this.smile;
    p.browRaise = this.brow;
    p.browAngle = this.browAngle;
    p.armLSwing = this.armL;
    p.armRSwing = this.armR;
    p.leanX = this.lean.x.value;
    p.leanY = this.lean.y.value;
    p.roll = this.lean.roll.value;
    p.breathe = breathe;
    p.squash = this.squash.value;
    p.jiggle = this.jiggle;
    p.rim = 0.18 + this.glow * 0.5;
    p.blushBoost = this.blush;
    p.time = this.t;
    return p;
  }
}

export { clamp as palClamp, lerp as palLerp, approach as palApproach };
