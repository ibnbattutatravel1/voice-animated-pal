/**
 * Anatomy of the Pal.
 *
 * The GLB is a single static mesh — no skeleton, no morph targets, no clips.
 * Every landmark below was measured off the actual geometry (sphere fits on the
 * eye bulges, texture-colour clustering for the iris / mouth / brows, medial-axis
 * tracking for the limbs) and verified by re-rendering the mesh with markers.
 *
 * All coordinates are in the model's own space:
 *   +X right · +Y up · +Z front (the face looks down +Z)
 *   bounds  x[-0.900, 0.900]  y[-0.819, 0.819]  z[-0.600, 0.600]
 *
 * The head is authored with a ~13° roll, so the face has its own frame rather
 * than being axis-aligned. `FACE_R/U/F` is that frame, orthonormalised from the
 * eye axis and the eye→mouth direction.
 *
 * Scale reference: the camera sits 4.5 away at fov 30°, so the visible frame is
 * 2.41 units tall and the Pal is 1.638 of them. **0.01 units ≈ 3 px at 720p** —
 * 0.05 reads clearly, 0.20 is a big cartoon move.
 */

export type Vec3 = readonly [number, number, number];

/** Orthonormal face frame — right, up, forward. */
export const FACE_R: Vec3 = [0.9727, -0.2287, 0.0388];
export const FACE_U: Vec3 = [0.2259, 0.972, 0.0648];
export const FACE_F: Vec3 = [-0.0525, -0.0543, 0.9971];

/**
 * "Face height": how far up the *face's* own axis a point sits. This is the
 * coordinate every head-region weight ramps in, and it is not interchangeable
 * with world y — the head carries a 13° roll, so both eyes land at fh 0.224 and
 * 0.226 while sitting 0.10 apart in y. A ramp in fh has iso-surfaces parallel to
 * the face's horizon, which is what gives paired features identical weight.
 *
 * It also makes head *yaw* exactly volume preserving: for a rotation weighted by
 * w with ∇w ∥ FACE_U about the axis FACE_U, det J = 1 + θ·(∇w · (k × v)) ≡ 1.
 */
export const dotFaceU = (p: Vec3) => p[0] * FACE_U[0] + p[1] * FACE_U[1] + p[2] * FACE_U[2];

/**
 * Eyeballs. `centre` is the fitted centre of curvature (rms error < 0.007), so
 * rotating a vertex about it keeps `|p - centre|` constant — the silhouette is
 * preserved exactly and only the painted iris slides. `rest` is the direction
 * the iris currently faces; the two eyes diverge slightly, which is how the
 * model was authored, and keeping each eye's own rest direction preserves that.
 */
export const EYES = [
  {
    centre: [-0.1388, 0.2392, 0.3562] as Vec3,
    rest: [-0.3003, 0.4095, 0.8615] as Vec3,
    radius: 0.1452,
  },
  {
    centre: [0.3039, 0.1374, 0.3692] as Vec3,
    rest: [0.3605, 0.2214, 0.9061] as Vec3,
    radius: 0.1429,
  },
] as const;

/**
 * Centre of the mouth, in model space. Everything about the mouth is expressed
 * in the face frame relative to this point.
 *
 * The mesh has a real invagination here — a sculpted open grin 0.204 wide,
 * 0.116 tall and **0.222 deep**, with a tongue modelled on its floor. That hole
 * is permanent geometry: no amount of repainting could ever close it, which is
 * why the mouth used to look like it had a second layer stuck over it. It is
 * sealed in the vertex stage (see `pal-material.ts`) and the whole mouth is
 * drawn procedurally onto skin instead.
 */
export const MOUTH: Vec3 = [0.0516, 0.052, 0.4406];

/** The muzzle resurfacing patch, in the face frame relative to MOUTH. */
export const MUZ_C: readonly [number, number] = [0.004, -0.02];
/** Ellipse semi-axes: core at r ≤ 1, tapering out to r = 1.45. */
export const MUZ_A: readonly [number, number] = [0.175, 0.125];
/** Anchor of the drawn mouth — where the closed-lip seam sits. */
export const MOUTH_A: readonly [number, number] = [0.008, -0.02];
/** Rest half-width of the drawn mouth. */
export const MOUTH_W0 = 0.102;
/** Deepest point of the sculpted cavity, used to normalise the seal. */
export const MOUTH_DEPTH = 0.222;

/**
 * The face's skin surface over the muzzle, as a cubic in the face frame:
 * z = f(x, y). Fitted robustly with the cavity cells masked out, so it describes
 * the skin the mouth is *cut into* rather than the cut itself. Residual rms is
 * 0.0007–0.0013 over the rings the seal has to match (≈0.3 px at shipping
 * framing) and 0.0025 overall.
 *
 * Both the vertex and fragment stages evaluate the mouth on this analytic
 * surface rather than on the raw vertex z, which is what keeps them in exact
 * agreement — the fit's residual enters both identically and cancels.
 */
export const SKIN_A: readonly [number, number, number, number] = [
  0.134479, -0.227536, -0.106407, 0.496428,
]; // 1, y, y², y³
export const SKIN_B: readonly [number, number, number] = [0.004288, -0.077438, 0.355134]; // x, xy, xy²
export const SKIN_C: readonly [number, number, number] = [-0.89292, -0.897001, -0.069899]; // x², x²y, x³

/** The skin surface height, in the face frame relative to MOUTH. */
export function skinZ(x: number, y: number): number {
  const x2 = x * x,
    y2 = y * y;
  return (
    SKIN_A[0] +
    SKIN_A[1] * y +
    SKIN_A[2] * y2 +
    SKIN_A[3] * y2 * y +
    SKIN_B[0] * x +
    SKIN_B[1] * x * y +
    SKIN_B[2] * x * y2 +
    SKIN_C[0] * x2 +
    SKIN_C[1] * x2 * y +
    SKIN_C[2] * x2 * x
  );
}

/** Virtual jaw hinge, in mouth space (face frame relative to MOUTH). */
export const JAW_PIVOT: Vec3 = [0.0, 0.1, -0.55];
/** Radians of jaw rotation at full open — drops the chin 0.075 and back 0.031. */
export const JAW_ANGLE = 0.104;

/** Painted eyebrows, used as displacement anchors. */
export const BROWS: readonly Vec3[] = [
  [-0.1517, 0.5005, 0.3754],
  [0.394, 0.3738, 0.4111],
];

/** Blush anchors — brightened when the Pal is excited or bashful. */
export const BLUSH: readonly Vec3[] = [
  [-0.2786, 0.1512, 0.4411],
  [0.4022, 0.003, 0.4705],
];

/** The raised, waving arm (-X) and the little flipper (+X). */
export const ARM_L = {
  shoulder: [-0.52, 0.21, 0.06] as Vec3,
  tip: [-0.8975, 0.4294, 0.135] as Vec3,
};
export const ARM_R = {
  shoulder: [0.6, -0.15, 0.15] as Vec3,
  tip: [0.8892, -0.4443, 0.1651] as Vec3,
};

export const GROUND_Y = -0.819;
/** Pivot for the whole-body lean — low in the belly so the blob shears nicely. */
export const HIP: Vec3 = [0, -0.3, 0.03];
/** Vertex centroid — the pivot squash uses while the Pal is off the ground. */
export const COM: Vec3 = [0.0277, -0.0638, 0.0794];

/**
 * Head band, ramped in face height. Both eyes, both brows and the mouth all
 * weight exactly 1.000 here, so the whole face rides the head rigidly, and the
 * soles and the tops of the feet weight exactly 0.000.
 */
export const HEAD_PIVOT: Vec3 = [0.02, -0.24, 0.0];
export const HEAD_RAMP: readonly [number, number] = [-0.5, 0.05];

/**
 * The crown — the top 7% of the mesh (18,735 verts, centroid [0.118,0.711,-0.042]).
 * It is not a separate knob; the body is one continuous pear. This band exists
 * only to carry follow-through, and it is driven purely by the lag solver and
 * impact kicks. Gestures never key it.
 */
export const CROWN_PIVOT: Vec3 = [0.1, 0.46, -0.03];
export const CROWN_RAMP: readonly [number, number] = [0.42, 0.72];

/**
 * Body lean band, in world y. Plateaued so the face rides rigid (weight 1.000
 * at the mouth, eyes and brows) and the feet stay nailed (0.000 at the sole and
 * at the top of the feet).
 */
export const BODY_RAMP: readonly [number, number] = [-0.7, -0.18];

export const FOOT_L: Vec3 = [-0.285, GROUND_Y, 0.062];
export const FOOT_R: Vec3 = [0.313, GROUND_Y, 0.09];
/** The two soles are separate pads with a real gap; they split at x ≈ 0.012. */
export const FOOT_SPLIT_X = 0.012;
export const SOLE_H = 0.22;
/** Soft-floor knee. The asymptote sits at GROUND_Y − FLOOR_K so rest is exact. */
export const FLOOR_K = 0.03;
export const SWAY_RAMP: readonly [number, number] = [-0.78, -0.1];

export const SKIN_HEX = "#ab9bbe";
export const CREASE_HEX = "#4a385c";

export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const ARM_L_DIR = norm3(sub3(ARM_L.tip, ARM_L.shoulder));
export const ARM_L_LEN = len3(sub3(ARM_L.tip, ARM_L.shoulder));
export const ARM_R_DIR = norm3(sub3(ARM_R.tip, ARM_R.shoulder));
export const ARM_R_LEN = len3(sub3(ARM_R.tip, ARM_R.shoulder));

/**
 * The "reach" axis of each arm — rotating about it swings the tip toward the
 * viewer. Both arms share FACE_F as their *lift* axis, so lift is mirrored in
 * the shader; `PalPose.armLLift > 0` always means "raise" and `writePose`
 * applies the sign flip in exactly one place.
 */
export const ARM_L_REACH = norm3(cross3(ARM_L_DIR, FACE_F));
export const ARM_R_REACH = norm3(cross3(ARM_R_DIR, FACE_F));

/** Arm region mask. The radial falloff is the dominant fold source, so it is
 * deliberately wide: (0.10, 0.52) keeps the left arm safe to 0.522 rad, where
 * the shipped (0.17, 0.34) inverted the shoulder at 0.619 and the wave already
 * reached 0.58. */
export const ARM_RAMP_A = -0.08;
export const ARM_RAMP_B = 0.86;
export const ARM_R_IN = 0.1;
export const ARM_R_OUT = 0.52;
export const WRIST_T = 0.6;

/**
 * Per-channel fold coefficients, measured by sweeping each rotation over all
 * 266k vertices and finding where the deformation Jacobian's determinant drops.
 * det ≈ 1 − 0.68·load, where load = Σ cᵢ·|θᵢ|. Yaw and leanY cost exactly
 * nothing (their gradient is parallel to their axis), so they are excluded.
 */
export const FOLD_C = {
  headPitch: 1.452,
  headTilt: 2.027,
  leanX: 1.442,
  roll: 1.607,
} as const;
/** Holds det ≥ 0.55. Raise to 1.10 only for transients under ~0.15 s. */
export const FOLD_BUDGET = 0.66;

/**
 * Everything the shader needs for one frame. Kept as a flat mutable record so
 * the render loop can write into it without allocating.
 */
export type PalPose = {
  // ─────────────────────────────────────────────────────────────────── eyes
  /** Eyeball rotation in the face frame, radians. */
  eyeYaw: number;
  eyePitch: number;
  /** >0 widens the eye (surprise), <0 narrows it. */
  eyeWiden: number;
  /** Eyelid sweep, 0 = fully open, 1 = fully shut. */
  lidUpper: number;
  lidLower: number;
  /** Bows the lash line: <0 arcs up (happy ‿), >0 arcs down (sleepy ⌒). */
  lidCurve: number;
  browRaise: number;
  browAngle: number;

  // ────────────────────────────────────────────────────────────────── mouth
  /** The four viseme channels the lip-sync engine drives most directly. */
  jawOpen: number;
  mouthWide: number;
  mouthRound: number;
  mouthPress: number;
  /** Signed: >0 grin, <0 frown. */
  smile: number;
  /** Signed one-sided lip curl. */
  sneer: number;
  /** Tongue body raised toward the palate — L, N, T, TH. */
  tongueUp: number;
  /** Lip aperture independent of the jaw. This is what makes EE wide-and-thin
   * instead of a small circle. */
  lipOpen: number;
  /** Tongue tip protruding past the lip — TH. */
  tongueTip: number;
  /** Whole-mouth offset in the face frame, for a smirk or a chew. */
  mouthShiftX: number;
  mouthShiftY: number;
  /** Perceived loudness, 0..1 — widens and lengthens the aperture on a shout. */
  loud: number;
  /** Independent corner raise, -1..1. Asymmetry is what stops a face reading
   * as computed. */
  cornerL: number;
  cornerR: number;
  /** Upper tooth band opacity. */
  teethShow: number;
  /** Roll of the whole mouth about the face's forward axis, radians. */
  mouthRoll: number;
  /** Forward funnel — the OO/W snout. Rounding that only narrows the aperture
   * reads as a small mouth; pushing the lip mass forward reads as a pucker. */
  funnel: number;
  cheekPuff: number;
  /** 0..1 muscular tension — thins the lips. */
  tension: number;
  /** Upper lip tucked over the lower — F, V. */
  tuck: number;

  // ─────────────────────────────────────────────────────────────────── head
  /** Free: yaw about FACE_U with an fh ramp is exactly volume preserving. */
  headYaw: number;
  headPitch: number;
  headTilt: number;
  /** Crown follow-through. Driven by the lag solver and impacts only. */
  crownYaw: number;
  crownPitch: number;
  crownTilt: number;
  crownLagY: number;

  // ─────────────────────────────────────────────────────────────────── body
  /** Body lean about the hip, radians. leanY (yaw) is fold-free. */
  leanX: number;
  leanY: number;
  roll: number;
  /** Lateral weight shift: `sway` translates the hips, `shift` (-1..1) selects
   * which sole is loaded. */
  sway: number;
  shift: number;
  /** Vertical hop, applied as a group translation so it cannot shear. */
  hopY: number;
  /** 0..1, derived from hopY — migrates the squash pivot to the COM. */
  airborne: number;
  /** Squash & stretch (+ = taller), and breathing 0..1. */
  squash: number;
  breathe: number;
  /** Directional jelly slosh — soft mass lagging the rigid frame. */
  jiggleX: number;
  jiggleZ: number;
  /** Per-sole load, 0..1: the loaded sole pancakes and spreads. */
  footL: number;
  footR: number;

  // ─────────────────────────────────────────────────────────────────── arms
  /** +lift always raises the hand, on both sides. */
  armLLift: number;
  armLReach: number;
  armLTwist: number;
  armLWrist: number;
  armRLift: number;
  armRReach: number;
  armRTwist: number;
  armRWrist: number;

  // ───────────────────────────────────────────────────────────────── extras
  /** Poke dent: contact point in model space, and how deep. */
  pokeX: number;
  pokeY: number;
  pokeZ: number;
  pokeAmt: number;
  /** Fresnel rim strength and overall excitement, drives the glow. */
  rim: number;
  blushBoost: number;
  time: number;
};

export const restPose = (): PalPose => ({
  eyeYaw: 0,
  eyePitch: 0,
  eyeWiden: 0,
  lidUpper: 0,
  lidLower: 0,
  lidCurve: 0,
  browRaise: 0,
  browAngle: 0,

  jawOpen: 0,
  mouthWide: 0,
  mouthRound: 0,
  mouthPress: 0,
  smile: 0.22,
  sneer: 0,
  tongueUp: 0.25,
  lipOpen: 0,
  tongueTip: 0,
  mouthShiftX: 0,
  mouthShiftY: 0,
  loud: 0,
  cornerL: 0,
  cornerR: 0,
  teethShow: 0.85,
  mouthRoll: 0.04,
  funnel: 0,
  cheekPuff: 0,
  tension: 0,
  tuck: 0,

  headYaw: 0,
  headPitch: 0,
  headTilt: 0,
  crownYaw: 0,
  crownPitch: 0,
  crownTilt: 0,
  crownLagY: 0,

  leanX: 0,
  leanY: 0,
  roll: 0,
  sway: 0,
  shift: 0,
  hopY: 0,
  airborne: 0,
  squash: 0,
  breathe: 0,
  jiggleX: 0,
  jiggleZ: 0,
  footL: 0.5,
  footR: 0.5,

  armLLift: 0,
  armLReach: 0,
  armLTwist: 0,
  armLWrist: 0,
  armRLift: 0,
  armRReach: 0,
  armRTwist: 0,
  armRWrist: 0,

  pokeX: 0,
  pokeY: 0,
  pokeZ: 0,
  pokeAmt: 0,
  rim: 0.35,
  blushBoost: 0,
  time: 0,
});

/**
 * Because `det J − 1` is linear in θ per channel, the stacked load is very
 * nearly additive — and it does *not* compose if each channel is clamped
 * independently: all six at their measured solo caps yields det = −0.164, an
 * inverted mesh. Scale the loaded channels together instead. Yaw and leanY are
 * left alone because they contribute nothing.
 */
export function applyFoldBudget(p: PalPose, budget = FOLD_BUDGET) {
  const load =
    FOLD_C.headPitch * Math.abs(p.headPitch) +
    FOLD_C.headTilt * Math.abs(p.headTilt) +
    FOLD_C.leanX * Math.abs(p.leanX) +
    FOLD_C.roll * Math.abs(p.roll);
  if (load > budget) {
    const k = budget / load;
    p.headPitch *= k;
    p.headTilt *= k;
    p.leanX *= k;
    p.roll *= k;
  }
}
