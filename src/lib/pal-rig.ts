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
 */

export type Vec3 = readonly [number, number, number];

/** Orthonormal face frame — right, up, forward. */
export const FACE_R: Vec3 = [0.9727, -0.2287, 0.0388];
export const FACE_U: Vec3 = [0.2259, 0.972, 0.0648];
export const FACE_F: Vec3 = [-0.0525, -0.0543, 0.9971];

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
 * Centre of the mouth. The mesh has a real ~0.20-deep pocket here with a tongue
 * modelled inside, and the smile is painted into the albedo — which is why the
 * mouth is drawn procedurally rather than deformed. Measured half-extents of the
 * painted mouth: 0.101 wide, 0.051 tall, in the face frame.
 */
export const MOUTH: Vec3 = [0.0516, 0.052, 0.4406];

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

/** Base albedo sampled off the face, used to paint the eyelids. */
export const SKIN_HEX = "#ab9bbe";
export const CREASE_HEX = "#4a385c";

export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const ARM_L_DIR = norm3(sub3(ARM_L.tip, ARM_L.shoulder));
export const ARM_L_LEN = len3(sub3(ARM_L.tip, ARM_L.shoulder));
export const ARM_R_DIR = norm3(sub3(ARM_R.tip, ARM_R.shoulder));
export const ARM_R_LEN = len3(sub3(ARM_R.tip, ARM_R.shoulder));

/**
 * Everything the shader needs for one frame. Kept as a flat mutable record so
 * the render loop can write into it without allocating.
 */
export type PalPose = {
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
  /** Viseme channels. */
  jawOpen: number;
  mouthWide: number;
  mouthRound: number;
  mouthPress: number;
  smile: number;
  browRaise: number;
  browAngle: number;
  armLSwing: number;
  armRSwing: number;
  /** Body lean, radians — pitch, yaw, roll about the hip. */
  leanX: number;
  leanY: number;
  roll: number;
  /** Breathing 0..1, squash&stretch (+ = taller), jelly wobble amplitude. */
  breathe: number;
  squash: number;
  jiggle: number;
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
  jawOpen: 0,
  mouthWide: 0,
  mouthRound: 0,
  mouthPress: 0,
  smile: 0,
  browRaise: 0,
  browAngle: 0,
  armLSwing: 0,
  armRSwing: 0,
  leanX: 0,
  leanY: 0,
  roll: 0,
  breathe: 0,
  squash: 0,
  jiggle: 0,
  rim: 0.35,
  blushBoost: 0,
  time: 0,
});
