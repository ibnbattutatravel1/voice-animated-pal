/**
 * The clip library.
 *
 * A gesture is a set of keyed or oscillating tracks on abstract channels, not
 * on `PalPose` fields — the brain owns the mapping, so a clip can be mirrored,
 * scaled, gated and blended against five other layers without ever knowing what
 * a `crownLagY` is.
 *
 * **Every clip obeys the cartoon timing law**, which is the whole reason this
 * reads as performance rather than as a screensaver: *anticipation 15–25% of
 * the clip in the opposite direction → action 20–30% arriving with overshoot →
 * hold 35–50% → settle.* On a 24 fps grid that is snaps of 2–3 frames, moves of
 * 6–10 and holds of 8–16. Continuous sinusoids — what the rig used to do — read
 * as floating; the hold is what reads as intent. The brain's drift layer keeps
 * those holds alive at 35% amplitude so they are *moving* holds, never freezes.
 *
 * Amplitudes are authored inside the measured caps in `CAP` below, which come
 * from the fold sweep in `pal-rig.ts`. Author new clips inside them.
 */

import { EASE, clamp01, smoothstep01, type EaseId } from "./pal-motion";
import type { Mood } from "./pal-signal";

/** Abstract animation channels. `Ch.COUNT` sizes the evaluation buffer. */
export const Ch = {
  HEAD_YAW: 0,
  HEAD_PITCH: 1,
  HEAD_TILT: 2,
  LEAN_X: 3,
  LEAN_Y: 4,
  ROLL: 5,
  SWAY: 6,
  SHIFT: 7,
  HOP: 8,
  SQUASH: 9,
  BREATHE: 10,
  JIGGLE: 11,
  ARM_L_LIFT: 12,
  ARM_L_REACH: 13,
  ARM_L_TWIST: 14,
  ARM_L_WRIST: 15,
  ARM_R_LIFT: 16,
  ARM_R_REACH: 17,
  ARM_R_TWIST: 18,
  ARM_R_WRIST: 19,
  EYE_YAW: 20,
  EYE_PITCH: 21,
  EYE_WIDEN: 22,
  LID_UPPER: 23,
  LID_LOWER: 24,
  LID_CURVE: 25,
  BROW_RAISE: 26,
  BROW_ANGLE: 27,
  SMILE: 28,
  SMIRK: 29,
  JAW: 30,
  MOUTH_WIDE: 31,
  MOUTH_ROUND: 32,
  MOUTH_PRESS: 33,
  CHEEK: 34,
  FOOT_L: 35,
  FOOT_R: 36,
  BLUSH: 37,
  COUNT: 38,
} as const;

/**
 * Buses. Two clips may never hold the same bit at the same time, which is what
 * lets three clips run concurrently and still look authored: `blinkFlurry`
 * (NONE) inside `swayBeat` (BODY|FEET), `chinTap` (ARMS|HEAD) inside a body
 * loop. Sequencing them instead is what makes idle systems read as a playlist.
 */
export const Claim = {
  NONE: 0,
  ARMS: 1,
  HEAD: 2,
  MOUTH: 4,
  GAZE: 8,
  BODY: 16,
  FEET: 32,
} as const;

export const MoodBit = { IDLE: 1, LISTENING: 2, THINKING: 4, SPEAKING: 8, ANY: 15 } as const;

export const MOOD_BIT: Record<Mood, number> = {
  idle: MoodBit.IDLE,
  listening: MoodBit.LISTENING,
  thinking: MoodBit.THINKING,
  speaking: MoodBit.SPEAKING,
};

/**
 * Publish clamps, in the units of the corresponding `PalPose` field.
 *
 * The rotational ones are the fold-sweep caps from `pal-rig.ts` (det ≥ 0.55
 * solo); the arm ones are the widened-capsule numbers — the left arm inverts at
 * 1.161 rad and used to run at 0.58 on every wave, which is exactly why the old
 * rig could not simply be turned up. `applyFoldBudget` handles the *stacked*
 * case; these caps only stop a single channel running away.
 */
export const CAP = {
  headYaw: 0.45,
  headPitch: 0.31,
  headTilt: 0.22,
  leanX: 0.312,
  leanY: 0.45,
  roll: 0.28,
  sway: 0.11,
  hop: 0.28,
  squash: 0.2,
  jiggle: 0.035,
  crownYaw: 0.3,
  crownPitch: 0.2,
  crownTilt: 0.18,
  crownLagY: 0.06,
  /** Fold-safe, not collision-safe: the collision limit is 1.45. */
  armLLift: 0.6,
  armRLiftMin: -0.55,
  armRLiftMax: 0.73,
  armReach: 0.7,
  armTwist: 0.9,
  armWrist: 0.9,
} as const;

export type Key = readonly [t: number, v: number, e?: EaseId];
export type Osc = { f: number; amp: number; phase?: number; decay?: number };
export type KeyTrack = { ch: number; keys: readonly Key[]; mode?: "add" | "max" };
export type OscTrack = { ch: number; osc: Osc };
export type Track = KeyTrack | OscTrack;

export type Impulse = { t: number; jiggle?: number; squash?: number; crown?: number };
export type Tag = "big" | "subtle" | "social" | "self" | "loop";

export type Gesture = {
  id: string;
  dur: number;
  blendIn: number;
  blendOut: number;
  tracks: readonly Track[];
  /** Buses this clip occupies for its whole duration. */
  claims: number;
  /** Moods it may be scheduled in. */
  moods: number;
  /** 0 keeps it out of the random pool entirely — reaction-only. */
  weight: number;
  cooldown: number;
  /** Arousal band it sits best in, 0..1. */
  energy: number;
  mirrorable?: boolean;
  /** `false` excludes it under prefers-reduced-motion. */
  reduced?: boolean;
  tags?: readonly Tag[];
  impulses?: readonly Impulse[];
};

const tr = (ch: number, ...keys: Key[]): Track => ({ ch, keys });

/**
 * Mirroring negates the signed lateral channels and swaps the arms. Both arms
 * rotate about the shared `FACE_F`, but `PalPose.armLLift > 0` already means
 * "raise" on both sides — `writePose` owns that sign flip — so a swap here is a
 * true mirror and nothing else needs to know.
 */
const MIRROR_NEG = [
  Ch.HEAD_YAW,
  Ch.HEAD_TILT,
  Ch.LEAN_Y,
  Ch.ROLL,
  Ch.SWAY,
  Ch.SHIFT,
  Ch.EYE_YAW,
  Ch.BROW_ANGLE,
  Ch.SMIRK,
];

export const MIRROR_SIGN = (() => {
  const a = new Int8Array(Ch.COUNT).fill(1);
  for (const c of MIRROR_NEG) a[c] = -1;
  return a;
})();

/** Channel a track lands on when the clip is mirrored. */
export const MIRROR_CH = (() => {
  const a = new Int8Array(Ch.COUNT);
  for (let i = 0; i < Ch.COUNT; i++) a[i] = i;
  for (let k = 0; k < 4; k++) {
    a[Ch.ARM_L_LIFT + k] = Ch.ARM_R_LIFT + k;
    a[Ch.ARM_R_LIFT + k] = Ch.ARM_L_LIFT + k;
  }
  a[Ch.FOOT_L] = Ch.FOOT_R;
  a[Ch.FOOT_R] = Ch.FOOT_L;
  return a;
})();

/**
 * Keys interpolate with the ease named on the key they arrive *at* — the ease
 * describes the segment's landing, which is how the anticipation/overshoot
 * pairs above read when you scan a track left to right. `si` is the default so
 * an unannotated corner still leaves and arrives at zero velocity.
 */
function sampleKeys(keys: readonly Key[], u: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  const first = keys[0]!;
  if (u <= first[0]) return first[1];
  const last = keys[n - 1]!;
  if (u >= last[0]) return last[1];
  let i = 1;
  while (i < n && keys[i]![0] <= u) i++;
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const span = b[0] - a[0];
  const s = span > 1e-6 ? (u - a[0]) / span : 1;
  return a[1] + (b[1] - a[1]) * EASE[b[2] ?? "si"](s);
}

export function sampleTrack(tk: Track, u: number, dur: number): number {
  if ("keys" in tk) return sampleKeys(tk.keys, u);
  const o = tk.osc;
  const t = u * dur;
  const decay = o.decay === undefined ? 1 : Math.exp(-t / o.decay);
  return o.amp * decay * Math.sin(2 * Math.PI * o.f * t + (o.phase ?? 0));
}

/** Blend envelope, in seconds at both ends so short clips fade proportionally. */
export const clipEnv = (u: number, dur: number, bIn: number, bOut: number) =>
  smoothstep01(clamp01((u * dur) / Math.max(1e-3, bIn))) *
  smoothstep01(clamp01(((1 - u) * dur) / Math.max(1e-3, bOut)));

// ───────────────────────────────────────────────────────────────── the library

export const GESTURES: readonly Gesture[] = [
  {
    id: "glance",
    dur: 1.3,
    blendIn: 0.08,
    blendOut: 0.25,
    claims: Claim.HEAD | Claim.GAZE,
    moods: MoodBit.IDLE | MoodBit.LISTENING | MoodBit.THINKING,
    weight: 10,
    cooldown: 5,
    energy: 0.2,
    mirrorable: true,
    reduced: true,
    tags: ["subtle", "self"],
    tracks: [
      tr(Ch.EYE_YAW, [0, 0], [0.09, 0.85, "qo"], [0.55, 0.82], [0.78, 0, "si"], [1, 0]),
      tr(Ch.HEAD_YAW, [0, 0], [0.1, -0.035, "qi"], [0.4, 0.32, "bo"], [0.72, 0.3], [1, 0, "si"]),
      tr(Ch.HEAD_TILT, [0, 0], [0.42, 0.05], [1, 0]),
      // The blink lands on the saccade. Real eyes hide about a third of their
      // big look-arounds this way, and without it the turn reads as a servo.
      tr(Ch.LID_UPPER, [0.04, 0], [0.1, 0.9, "qo"], [0.2, 0, "qo"], [1, 0]),
    ],
  },
  {
    id: "headTilt",
    dur: 1.7,
    blendIn: 0.12,
    blendOut: 0.35,
    claims: Claim.HEAD,
    moods: MoodBit.ANY,
    weight: 9,
    cooldown: 8,
    energy: 0.25,
    mirrorable: true,
    reduced: true,
    tags: ["subtle", "social"],
    tracks: [
      tr(Ch.HEAD_TILT, [0, 0], [0.08, -0.04, "qi"], [0.32, 0.21, "bo"], [0.7, 0.19], [1, 0, "si"]),
      tr(Ch.HEAD_YAW, [0, 0], [0.32, 0.1], [1, 0]),
      tr(Ch.BROW_RAISE, [0, 0], [0.28, 0.45, "qo"], [0.74, 0.4], [1, 0]),
      tr(Ch.EYE_WIDEN, [0, 0], [0.34, 0.25], [1, 0]),
      // Eyes counter-rotate so the target stays fixed while the head moves.
      tr(Ch.EYE_YAW, [0, 0], [0.3, -0.16], [1, 0]),
    ],
  },
  {
    id: "curiousLean",
    dur: 2.1,
    blendIn: 0.16,
    blendOut: 0.4,
    claims: Claim.HEAD | Claim.BODY,
    moods: MoodBit.IDLE | MoodBit.LISTENING,
    weight: 7,
    cooldown: 14,
    energy: 0.45,
    mirrorable: true,
    reduced: true,
    tags: ["social"],
    tracks: [
      tr(Ch.LEAN_X, [0, 0], [0.09, -0.035, "qi"], [0.34, 0.14, "bo"], [0.72, 0.13], [1, 0, "si"]),
      tr(Ch.HEAD_PITCH, [0, 0], [0.36, -0.1], [0.72, -0.09], [1, 0]),
      tr(Ch.SWAY, [0, 0], [0.4, 0.03], [0.76, 0.028], [1, 0]),
      tr(Ch.EYE_WIDEN, [0, 0], [0.3, 0.55, "qo"], [0.74, 0.5], [1, 0]),
      tr(Ch.BROW_RAISE, [0, 0], [0.26, 0.6, "qo"], [0.74, 0.5], [1, 0]),
      tr(Ch.SMIRK, [0, 0], [0.4, 0.5], [0.75, 0.45], [1, 0]),
      tr(Ch.BLUSH, [0, 0], [0.5, 0.22], [1, 0]),
    ],
  },
  {
    // The long-idle payoff: the one clip worth waiting 45 seconds for.
    id: "bigStretch",
    dur: 3.4,
    blendIn: 0.2,
    blendOut: 0.5,
    claims: Claim.ARMS | Claim.HEAD | Claim.MOUTH | Claim.BODY,
    moods: MoodBit.IDLE,
    weight: 4,
    cooldown: 75,
    energy: 0.15,
    reduced: false,
    tags: ["big", "self"],
    impulses: [{ t: 0.86, jiggle: 0.014, crown: 0.34 }],
    tracks: [
      tr(
        Ch.SQUASH,
        [0, 0],
        [0.1, -0.09, "qi"],
        [0.22, -0.12],
        [0.34, 0.16, "bo"],
        [0.5, 0.2],
        [0.62, 0.1, "si"],
        [0.78, -0.035],
        [1, 0, "eo"],
      ),
      tr(Ch.HOP, [0, 0], [0.3, 0], [0.44, 0.022, "qo"], [0.6, 0], [1, 0]), // heels lift
      tr(Ch.ARM_L_LIFT, [0.18, 0], [0.44, 0.52, "bo"], [0.62, 0.5], [0.84, -0.06, "qi"], [1, 0]),
      tr(Ch.ARM_R_LIFT, [0.18, 0], [0.44, 0.5, "bo"], [0.62, 0.48], [0.84, -0.05, "qi"], [1, 0]),
      // A real stretch pulls the arms *back*, not up.
      tr(Ch.ARM_L_REACH, [0.18, 0], [0.5, -0.3], [0.84, 0], [1, 0]),
      tr(Ch.ARM_R_REACH, [0.18, 0], [0.5, -0.26], [0.84, 0], [1, 0]),
      tr(Ch.ARM_L_TWIST, [0.18, 0], [0.5, 0.45], [0.84, 0], [1, 0]),
      tr(Ch.HEAD_PITCH, [0.18, 0], [0.48, -0.24, "qo"], [0.7, -0.2], [0.88, 0.05], [1, 0]),
      tr(Ch.JAW, [0.26, 0], [0.5, 0.88, "qo"], [0.68, 0.74], [0.86, 0, "qi"], [1, 0]), // yawn
      tr(Ch.LID_UPPER, [0.24, 0], [0.44, 0.96, "qo"], [0.72, 0.92], [0.88, 0, "qo"], [1, 0]),
      tr(Ch.MOUTH_ROUND, [0, 0], [0.5, 0.45], [0.8, 0], [1, 0]),
      tr(Ch.BLUSH, [0.3, 0], [0.55, 0.35], [1, 0]),
      tr(Ch.LEAN_X, [0.18, 0], [0.5, -0.12], [0.82, 0.03], [1, 0]),
    ],
  },
  {
    id: "shrug",
    dur: 1.35,
    blendIn: 0.1,
    blendOut: 0.28,
    claims: Claim.ARMS | Claim.HEAD,
    moods: MoodBit.IDLE | MoodBit.THINKING,
    weight: 6,
    cooldown: 22,
    energy: 0.4,
    reduced: true,
    tags: ["social"],
    tracks: [
      tr(Ch.ARM_L_LIFT, [0, 0], [0.08, -0.08, "qi"], [0.3, 0.42, "bo"], [0.62, 0.4], [1, 0, "qo"]),
      tr(Ch.ARM_R_LIFT, [0, 0], [0.08, -0.06, "qi"], [0.3, 0.44, "bo"], [0.62, 0.42], [1, 0, "qo"]),
      // Palms up. Twist is exactly fold-free, so it can be spent freely.
      tr(Ch.ARM_L_TWIST, [0, 0], [0.34, 0.75, "bo"], [0.62, 0.72], [1, 0]),
      tr(Ch.ARM_R_TWIST, [0, 0], [0.34, -0.75, "bo"], [0.62, -0.72], [1, 0]),
      tr(Ch.ARM_L_REACH, [0, 0], [0.3, 0.22], [0.62, 0.2], [1, 0]),
      tr(Ch.ARM_R_REACH, [0, 0], [0.3, 0.2], [0.62, 0.18], [1, 0]),
      tr(Ch.SQUASH, [0, 0], [0.3, -0.055], [0.66, -0.05], [0.86, 0.02], [1, 0]),
      tr(Ch.HEAD_PITCH, [0, 0], [0.3, 0.1], [0.66, 0.09], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.34, 0.08], [1, 0]),
      tr(Ch.BROW_RAISE, [0, 0], [0.26, 0.6, "qo"], [0.66, 0.55], [1, 0]),
      tr(Ch.SMIRK, [0, 0], [0.4, 0.45], [0.7, 0.4], [1, 0]),
    ],
  },
  {
    id: "happyBounce",
    dur: 1.66,
    blendIn: 0.06,
    blendOut: 0.24,
    claims: Claim.BODY | Claim.FEET | Claim.ARMS,
    moods: MoodBit.IDLE | MoodBit.LISTENING,
    weight: 5,
    cooldown: 26,
    energy: 0.85,
    reduced: false,
    tags: ["big"],
    impulses: [
      { t: 0.44, jiggle: 0.03, crown: 0.22 },
      { t: 0.88, jiggle: 0.02, crown: 0.15 },
    ],
    tracks: [
      tr(
        Ch.HOP,
        [0, 0, "hd"],
        [0.16, 0, "qo"],
        [0.29, 0.19, "si"],
        [0.42, 0, "qi"],
        [0.55, 0, "hd"],
        [0.62, 0, "qo"],
        [0.74, 0.13, "si"],
        [0.86, 0, "qi"],
        [1, 0, "hd"],
      ),
      tr(
        Ch.SQUASH,
        [0, -0.02],
        [0.13, -0.13, "qi"],
        [0.17, 0.15, "qo"],
        [0.29, 0.02],
        [0.42, 0.09],
        [0.47, -0.16, "qo"],
        [0.56, 0.02, "eo"],
        [0.62, -0.09, "qi"],
        [0.66, 0.11, "qo"],
        [0.74, 0.01],
        [1, 0, "eo"],
      ),
      { ch: Ch.ARM_L_LIFT, osc: { f: 1.8, amp: 0.3, phase: 0.4 } },
      { ch: Ch.ARM_R_LIFT, osc: { f: 1.8, amp: 0.3, phase: 0.4 } },
      tr(Ch.SMILE, [0, 0], [0.15, 0.75, "qo"], [0.85, 0.7], [1, 0]),
      tr(Ch.EYE_WIDEN, [0, 0], [0.15, 0.45], [0.85, 0.4], [1, 0]),
      tr(Ch.LID_UPPER, [0, 0], [0.2, 0.3], [0.85, 0.28], [1, 0]), // happy squint
    ],
  },
  {
    id: "swayBeat",
    dur: 3.2,
    blendIn: 0.45,
    blendOut: 0.55,
    claims: Claim.BODY | Claim.FEET,
    moods: MoodBit.IDLE | MoodBit.LISTENING | MoodBit.SPEAKING,
    weight: 6,
    cooldown: 30,
    energy: 0.55,
    reduced: true,
    tags: ["loop"],
    tracks: [
      { ch: Ch.SWAY, osc: { f: 0.625, amp: 0.048 } },
      { ch: Ch.ROLL, osc: { f: 0.625, amp: -0.04, phase: 0.35 } },
      // The head stays level while the body rocks under it — the counter is the
      // difference between a weight shift and a wobble.
      { ch: Ch.HEAD_TILT, osc: { f: 0.625, amp: 0.055, phase: 0.75 } },
      { ch: Ch.SHIFT, osc: { f: 0.625, amp: 0.85 } },
      { ch: Ch.SQUASH, osc: { f: 1.25, amp: 0.022, phase: 1.4 } },
      { ch: Ch.ARM_L_LIFT, osc: { f: 0.625, amp: 0.14, phase: 1.0 } },
      { ch: Ch.ARM_R_LIFT, osc: { f: 0.625, amp: 0.16, phase: 1.0 } },
      tr(Ch.SMILE, [0, 0], [0.15, 0.35], [0.85, 0.32], [1, 0]),
    ],
  },
  {
    id: "sniff",
    dur: 1.4,
    blendIn: 0.1,
    blendOut: 0.28,
    claims: Claim.HEAD | Claim.MOUTH,
    moods: MoodBit.IDLE,
    weight: 5,
    cooldown: 34,
    energy: 0.35,
    mirrorable: true,
    reduced: true,
    tags: ["self"],
    tracks: [
      tr(Ch.HEAD_PITCH, [0, 0], [0.1, 0.05, "qi"], [0.3, -0.2, "qo"], [0.62, -0.19], [1, 0, "si"]),
      tr(Ch.LEAN_X, [0, 0], [0.3, 0.09], [0.62, 0.085], [1, 0]),
      tr(
        Ch.CHEEK,
        [0, 0],
        [0.28, 0.55, "qo"],
        [0.36, 0.15],
        [0.46, 0.55, "qo"],
        [0.54, 0.12],
        [0.64, 0.5, "qo"],
        [0.78, 0],
        [1, 0],
      ),
      { ch: Ch.MOUTH_PRESS, osc: { f: 6.4, amp: 0.3, decay: 0.42 } },
      tr(Ch.BROW_ANGLE, [0, 0], [0.28, -0.45], [0.7, -0.35], [1, 0]),
      tr(Ch.LID_LOWER, [0, 0], [0.28, 0.34], [0.7, 0.28], [1, 0]),
    ],
  },
  {
    id: "blinkFlurry",
    dur: 0.95,
    blendIn: 0.02,
    blendOut: 0.1,
    claims: Claim.NONE,
    moods: MoodBit.ANY,
    weight: 6,
    cooldown: 18,
    energy: 0.3,
    reduced: true,
    tags: ["subtle"],
    tracks: [
      tr(
        Ch.LID_UPPER,
        [0, 0],
        [0.08, 1, "qo"],
        [0.16, 0, "qo"],
        [0.3, 1, "qo"],
        [0.38, 0, "qo"],
        [0.54, 1, "qo"],
        [0.64, 0, "qo"],
        [1, 0],
      ),
      tr(Ch.BROW_RAISE, [0, 0], [0.3, 0.25], [0.8, 0.1], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.4, 0.04], [1, 0]),
    ],
  },
  {
    // The comedy beat. A: casual glance away · B: SNAP back with overshoot ·
    // C: recoil · D: settle. The snap is three frames at 24 fps, on purpose.
    id: "doubleTake",
    dur: 1.45,
    blendIn: 0.05,
    blendOut: 0.3,
    claims: Claim.HEAD | Claim.GAZE | Claim.BODY,
    moods: MoodBit.IDLE | MoodBit.LISTENING,
    weight: 3,
    cooldown: 70,
    energy: 0.9,
    mirrorable: true,
    reduced: false,
    tags: ["big", "social"],
    impulses: [{ t: 0.44, jiggle: 0.028, crown: 0.3 }],
    tracks: [
      tr(
        Ch.HEAD_YAW,
        [0, 0],
        [0.16, 0.3, "qo"],
        [0.3, 0.28],
        [0.365, -0.22, "qo"],
        [0.44, 0.06, "bo"],
        [0.62, 0.02],
        [1, 0, "eo"],
      ),
      tr(
        Ch.EYE_YAW,
        [0, 0],
        [0.12, 0.9, "qo"],
        [0.3, 0.85],
        [0.35, -0.35, "qo"],
        [0.46, 0.06],
        [1, 0],
      ),
      tr(Ch.LEAN_X, [0, 0], [0.3, 0.02], [0.42, -0.15, "qo"], [0.6, -0.12], [0.8, 0.03], [1, 0]),
      tr(
        Ch.SQUASH,
        [0, 0],
        [0.36, 0],
        [0.42, 0.075, "qo"],
        [0.6, 0.02],
        [0.78, -0.02],
        [1, 0, "eo"],
      ),
      tr(Ch.EYE_WIDEN, [0, 0], [0.34, 0], [0.4, 0.95, "qo"], [0.72, 0.8], [1, 0, "si"]),
      tr(Ch.BROW_RAISE, [0, 0], [0.34, 0], [0.4, 0.95, "qo"], [0.72, 0.8], [1, 0]),
      tr(Ch.LID_UPPER, [0, 0], [0.3, 0.15], [0.38, 0, "qo"], [1, 0]),
      tr(Ch.JAW, [0, 0], [0.38, 0], [0.44, 0.35, "qo"], [0.72, 0.15], [1, 0]),
    ],
  },
  {
    // Head away, eyes back: the whole read is in the disagreement between them.
    id: "peek",
    dur: 2.3,
    blendIn: 0.14,
    blendOut: 0.4,
    claims: Claim.HEAD | Claim.GAZE,
    moods: MoodBit.IDLE,
    weight: 5,
    cooldown: 40,
    energy: 0.3,
    mirrorable: true,
    reduced: true,
    tags: ["social"],
    tracks: [
      tr(Ch.HEAD_YAW, [0, 0], [0.26, 0.36, "bo"], [0.8, 0.32], [1, 0, "si"]),
      tr(Ch.EYE_YAW, [0, 0], [0.2, 0.3], [0.34, -0.95, "qo"], [0.74, -0.9], [0.9, 0], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.3, -0.1], [0.8, -0.08], [1, 0]),
      tr(Ch.SMIRK, [0, 0], [0.4, 0.8, "qo"], [0.82, 0.72], [1, 0]),
      tr(Ch.LID_LOWER, [0, 0], [0.4, 0.28], [0.82, 0.24], [1, 0]),
      tr(Ch.BLUSH, [0, 0], [0.4, 0.3], [0.85, 0.22], [1, 0]),
    ],
  },
  {
    id: "shyTurn",
    dur: 2.5,
    blendIn: 0.18,
    blendOut: 0.45,
    claims: Claim.HEAD | Claim.ARMS | Claim.GAZE,
    moods: MoodBit.IDLE | MoodBit.LISTENING,
    weight: 3,
    cooldown: 90,
    energy: 0.28,
    mirrorable: true,
    reduced: true,
    tags: ["social"],
    tracks: [
      tr(Ch.HEAD_YAW, [0, 0], [0.3, -0.34, "si"], [0.72, -0.3], [1, 0]),
      tr(Ch.HEAD_PITCH, [0, 0], [0.3, 0.16], [0.72, 0.14], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.3, -0.12], [0.72, -0.1], [1, 0]),
      tr(Ch.ARM_L_LIFT, [0, 0], [0.3, 0.48, "bo"], [0.74, 0.45], [1, 0, "si"]),
      // The hand comes up in front of the face — reach, not lift, is what puts it there.
      tr(Ch.ARM_L_REACH, [0, 0], [0.3, 0.52], [0.74, 0.5], [1, 0]),
      tr(Ch.LID_UPPER, [0, 0], [0.3, 0.34], [0.76, 0.3], [1, 0]),
      tr(Ch.LID_CURVE, [0, 0], [0.3, -0.5], [0.85, 0], [1, 0]),
      tr(Ch.SMILE, [0, 0], [0.34, 0.55], [0.8, 0.48], [1, 0]),
      tr(Ch.BLUSH, [0, 0], [0.3, 0.85, "qo"], [0.8, 0.7], [1, 0]),
      tr(Ch.SHIFT, [0, 0], [0.34, -0.45], [0.78, -0.4], [1, 0]),
    ],
  },
  {
    id: "nod",
    dur: 1.05,
    blendIn: 0.06,
    blendOut: 0.22,
    claims: Claim.HEAD,
    moods: MoodBit.ANY,
    weight: 8,
    cooldown: 7,
    energy: 0.5,
    reduced: true,
    tags: ["social"],
    tracks: [
      // Anticipation goes UP first. Negative pitch raises the chin.
      tr(
        Ch.HEAD_PITCH,
        [0, 0],
        [0.08, -0.07, "qi"],
        [0.26, 0.24, "qo"],
        [0.44, -0.06, "si"],
        [0.62, 0.2, "qo"],
        [0.82, -0.03, "si"],
        [1, 0, "eo"],
      ),
      tr(Ch.LEAN_X, [0, 0], [0.26, 0.07], [0.62, 0.06], [1, 0]),
      tr(Ch.SMILE, [0, 0], [0.3, 0.3], [0.85, 0.26], [1, 0]),
    ],
  },
  {
    id: "shake",
    dur: 1.15,
    blendIn: 0.06,
    blendOut: 0.22,
    claims: Claim.HEAD,
    moods: MoodBit.ANY,
    weight: 5,
    cooldown: 16,
    energy: 0.55,
    reduced: true,
    tags: ["social"],
    tracks: [
      // An fh-ramped yaw is exactly volume preserving, so this one channel is
      // free. Spend it here rather than on pitch, which is not.
      { ch: Ch.HEAD_YAW, osc: { f: 2.3, amp: 0.34 } },
      { ch: Ch.HEAD_TILT, osc: { f: 2.3, amp: 0.05, phase: 1.5 } },
      { ch: Ch.EYE_YAW, osc: { f: 2.3, amp: -0.42 } }, // eyes stay locked on target
      tr(Ch.BROW_ANGLE, [0, 0], [0.3, -0.35], [0.85, -0.25], [1, 0]),
    ],
  },
  {
    id: "wiggle",
    dur: 1.5,
    blendIn: 0.08,
    blendOut: 0.28,
    claims: Claim.BODY | Claim.ARMS,
    moods: MoodBit.IDLE,
    weight: 4,
    cooldown: 45,
    energy: 0.95,
    reduced: false,
    tags: ["big"],
    impulses: [{ t: 0.02, jiggle: 0.022, crown: 0.18 }],
    tracks: [
      { ch: Ch.SWAY, osc: { f: 3.6, amp: 0.038, decay: 0.6 } },
      { ch: Ch.ROLL, osc: { f: 3.6, amp: -0.055, phase: 0.5, decay: 0.6 } },
      { ch: Ch.HEAD_YAW, osc: { f: 3.6, amp: 0.16, phase: 1.1, decay: 0.6 } },
      { ch: Ch.ARM_L_LIFT, osc: { f: 3.6, amp: 0.24, phase: 0.8, decay: 0.6 } },
      { ch: Ch.ARM_R_LIFT, osc: { f: 3.6, amp: 0.24, phase: 0.8, decay: 0.6 } },
      tr(Ch.SMILE, [0, 0], [0.12, 0.7, "qo"], [0.8, 0.6], [1, 0]),
      tr(Ch.LID_CURVE, [0, 0], [0.15, -0.8], [0.85, -0.7], [1, 0]),
      tr(Ch.CHEEK, [0, 0], [0.2, 0.4], [0.85, 0.3], [1, 0]),
    ],
  },
  {
    id: "settle",
    dur: 1.9,
    blendIn: 0.25,
    blendOut: 0.5,
    claims: Claim.NONE,
    moods: MoodBit.ANY,
    weight: 9,
    cooldown: 12,
    energy: 0.15,
    mirrorable: true,
    reduced: true,
    tags: ["subtle", "self"],
    tracks: [
      // The weight moves to the other foot and STAYS there. A pose that returns
      // to where it started reads as a twitch; one that doesn't reads as a
      // decision, and the next clip inherits a different stance.
      tr(Ch.SHIFT, [0, 0], [0.34, 0.9, "si"], [1, 0.85]),
      tr(Ch.SQUASH, [0, 0], [0.2, -0.035, "qo"], [0.46, 0.012], [1, 0]),
      tr(Ch.BREATHE, [0, 0], [0.24, 0.7, "qo"], [0.62, 0, "qi"], [1, 0]), // a small sigh
      tr(Ch.LID_UPPER, [0, 0], [0.28, 0.32], [0.5, 0, "qo"], [1, 0]),
      tr(Ch.HEAD_PITCH, [0, 0], [0.3, 0.05], [1, 0]),
    ],
  },
  {
    id: "deepBreath",
    dur: 3.2,
    blendIn: 0.3,
    blendOut: 0.6,
    claims: Claim.BODY,
    moods: MoodBit.IDLE | MoodBit.THINKING,
    weight: 5,
    cooldown: 55,
    energy: 0.1,
    reduced: true,
    tags: ["self"],
    tracks: [
      tr(Ch.BREATHE, [0, 0], [0.34, 1, "qo"], [0.45, 1], [0.8, 0, "si"], [1, 0]),
      tr(Ch.SQUASH, [0, 0], [0.34, 0.05, "qo"], [0.45, 0.048], [0.82, -0.015], [1, 0, "eo"]),
      tr(Ch.HEAD_PITCH, [0, 0], [0.34, -0.085], [0.45, -0.08], [0.82, 0.03], [1, 0]),
      tr(Ch.ARM_L_LIFT, [0, 0], [0.34, 0.14], [0.82, -0.02], [1, 0]),
      tr(Ch.ARM_R_LIFT, [0, 0], [0.34, 0.14], [0.82, -0.02], [1, 0]),
      tr(Ch.LID_UPPER, [0, 0], [0.4, 0.45], [0.78, 0.15], [1, 0]),
      tr(Ch.MOUTH_ROUND, [0, 0], [0.62, 0.3], [0.88, 0], [1, 0]),
    ],
  },
  {
    id: "chinTap",
    dur: 2.6,
    blendIn: 0.18,
    blendOut: 0.4,
    claims: Claim.ARMS | Claim.HEAD | Claim.GAZE,
    moods: MoodBit.THINKING | MoodBit.IDLE,
    weight: 7,
    cooldown: 30,
    energy: 0.3,
    reduced: true,
    tags: ["self"],
    tracks: [
      tr(Ch.ARM_R_LIFT, [0, 0], [0.1, -0.08, "qi"], [0.22, 0.62, "bo"], [0.8, 0.6], [1, 0, "si"]),
      tr(Ch.ARM_R_REACH, [0, 0], [0.22, 0.55], [0.8, 0.54], [1, 0]),
      // Three taps from the WRIST while the arm holds its pose. Tapping with
      // the whole arm is what makes a thinking pose read as a robot arm.
      { ch: Ch.ARM_R_WRIST, osc: { f: 1.3, amp: 0.34, phase: 0.9 } },
      tr(Ch.EYE_YAW, [0, 0], [0.2, -0.65, "qo"], [0.82, -0.6], [1, 0]),
      tr(Ch.EYE_PITCH, [0, 0], [0.2, 0.55, "qo"], [0.82, 0.5], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.26, 0.1], [0.82, 0.09], [1, 0]),
      tr(Ch.BROW_ANGLE, [0, 0], [0.26, 0.62], [0.82, 0.58], [1, 0]),
      tr(Ch.MOUTH_PRESS, [0, 0], [0.26, 0.36], [0.82, 0.32], [1, 0]),
      tr(Ch.LID_LOWER, [0, 0], [0.26, 0.2], [0.82, 0.18], [1, 0]),
    ],
  },

  // ── reaction-only, weight 0: played by id, never by the random pool ────────
  {
    id: "greetWave",
    dur: 1.9,
    blendIn: 0.1,
    blendOut: 0.3,
    claims: Claim.ARMS | Claim.HEAD,
    moods: MoodBit.ANY,
    weight: 0,
    cooldown: 2,
    energy: 0.75,
    reduced: true,
    tags: ["social"],
    tracks: [
      tr(Ch.ARM_L_LIFT, [0, 0], [0.06, -0.07, "qi"], [0.2, 0.46, "bo"], [0.8, 0.44], [1, 0, "si"]),
      tr(Ch.ARM_L_REACH, [0, 0], [0.2, 0.3], [0.8, 0.28], [1, 0]),
      tr(Ch.ARM_L_TWIST, [0, 0], [0.2, 0.35], [0.8, 0.32], [1, 0]),
      // The wave lives in the wrist. Swinging the whole arm through 50° is what
      // used to run the shoulder at twice its fold limit; a flapping hand on a
      // held arm reads bigger and costs a fifth of the angle.
      { ch: Ch.ARM_L_WRIST, osc: { f: 2.7, amp: 0.55 } },
      { ch: Ch.ARM_R_LIFT, osc: { f: 2.7, amp: 0.1, phase: 1.2 } },
      tr(Ch.SMILE, [0, 0], [0.15, 0.65, "qo"], [0.85, 0.6], [1, 0]),
      tr(Ch.EYE_WIDEN, [0, 0], [0.18, 0.35], [0.85, 0.3], [1, 0]),
      tr(Ch.BROW_RAISE, [0, 0], [0.16, 0.5, "qo"], [0.85, 0.4], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.24, 0.09], [0.8, 0.08], [1, 0]),
      tr(Ch.LEAN_X, [0, 0], [0.2, 0.05], [0.8, 0.045], [1, 0]),
    ],
  },
  {
    id: "pokeReact",
    dur: 1.1,
    blendIn: 0.03,
    blendOut: 0.3,
    claims: Claim.NONE,
    moods: MoodBit.ANY,
    weight: 0,
    cooldown: 0,
    energy: 0.9,
    reduced: true,
    tags: ["social"],
    impulses: [{ t: 0.01, jiggle: 0.03, squash: -0.09, crown: 0.34 }],
    tracks: [
      tr(
        Ch.SQUASH,
        [0, -0.02],
        [0.08, -0.15, "qo"],
        [0.24, 0.06, "eo"],
        [0.5, -0.02],
        [1, 0, "eo"],
      ),
      tr(Ch.EYE_WIDEN, [0, 0], [0.06, 0.95, "qo"], [0.34, 0.5], [1, 0]),
      // Startle, then the squint: the eyes go wide for four frames and only
      // then crease into the grin. Grinning first reads as a canned response.
      tr(Ch.LID_UPPER, [0, 0], [0.05, 0.85, "qo"], [0.14, 0.1, "qo"], [0.5, 0.25], [1, 0]),
      tr(Ch.BROW_RAISE, [0, 0], [0.06, 0.85, "qo"], [0.5, 0.5], [1, 0]),
      tr(Ch.SMILE, [0, 0], [0.12, 0.85, "qo"], [0.7, 0.6], [1, 0]),
      tr(Ch.BLUSH, [0, 0], [0.1, 0.9, "qo"], [0.7, 0.5], [1, 0]),
      tr(Ch.JAW, [0, 0], [0.08, 0.4, "qo"], [0.3, 0.05], [1, 0]),
      tr(Ch.HEAD_TILT, [0, 0], [0.1, -0.06, "qo"], [0.5, 0.04], [1, 0]),
      tr(Ch.CHEEK, [0, 0], [0.2, 0.35], [0.7, 0.25], [1, 0]),
    ],
  },
  {
    id: "landImpact",
    dur: 0.55,
    blendIn: 0.02,
    blendOut: 0.2,
    claims: Claim.NONE,
    moods: MoodBit.ANY,
    weight: 0,
    cooldown: 0,
    energy: 0.9,
    reduced: false,
    tags: ["big"],
    impulses: [{ t: 0.0, jiggle: 0.03, squash: -0.14, crown: 0.28 }],
    tracks: [
      tr(Ch.SQUASH, [0, 0], [0.12, -0.14, "qo"], [0.34, 0.05, "eo"], [1, 0, "eo"]),
      // Both soles slam to fully loaded, then release. FOOT_* rest at 0.5.
      tr(Ch.FOOT_L, [0, 0], [0.06, 0.5], [0.3, 0.15], [1, 0]),
      tr(Ch.FOOT_R, [0, 0], [0.06, 0.5], [0.3, 0.15], [1, 0]),
      tr(Ch.LID_UPPER, [0, 0], [0.08, 0.35, "qo"], [0.22, 0, "qo"], [1, 0]),
      tr(Ch.CHEEK, [0, 0], [0.1, 0.25], [0.4, 0.1], [1, 0]),
    ],
  },
];

export const CLIP = ((): Record<string, number> => {
  const m: Record<string, number> = {};
  for (let i = 0; i < GESTURES.length; i++) m[GESTURES[i]!.id] = i;
  return m;
})();
