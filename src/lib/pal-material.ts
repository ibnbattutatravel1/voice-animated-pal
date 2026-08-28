import * as THREE from "three";

import {
  ARM_L,
  ARM_L_DIR,
  ARM_L_LEN,
  ARM_L_REACH,
  ARM_R,
  ARM_R_DIR,
  ARM_R_LEN,
  ARM_R_REACH,
  BLUSH,
  BROWS,
  COM,
  CREASE_HEX,
  CROWN_PIVOT,
  EYES,
  FACE_F,
  FACE_R,
  FACE_U,
  FLOOR_K,
  FOOT_SPLIT_X,
  GROUND_Y,
  HEAD_PIVOT,
  HEAD_RAMP,
  HIP,
  MOUTH,
  SKIN_HEX,
  SOLE_H,
  type PalPose,
  type Vec3,
} from "./pal-rig";

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);

/**
 * The Pal has no bones, so the whole performance is a set of analytic region
 * deformers evaluated per-vertex on the GPU. Every one of them reads its region
 * weight from the **rest** position (Rule A): the stack is then a well-defined
 * map, and a raised arm can no longer drag the body ramp with it.
 *
 *   eyes   — each eyeball rotates about its fitted centre of curvature, which
 *            leaves |p - centre| unchanged: the silhouette is exactly preserved
 *            and only the painted iris slides.
 *   mouth  — the mesh has a real 0.222-deep grin invaginated into it, with a
 *            tongue on its floor. That hole is permanent geometry, so it is
 *            SEALED: `bakeSeal` relaxes a harmonic membrane across it at load
 *            and the vertex stage folds the pocket onto it. The mouth is then
 *            drawn from scratch — the mesh carries about one triangle per pixel
 *            here, so geometry physically cannot hold a crisp lip line and the
 *            vertex stage only owns shape, occlusion and parallax.
 *   jaw    — a weighted rotation about a virtual TMJ behind the head. A blob has
 *            no mandible, but it has mass; a shear would need slope 1.5 over the
 *            0.075 drop and fold, a rotation spreads the strain over the ramp.
 *   brows  — local skin displacement along the face's up axis.
 *   arms   — 3 DOF (lift, reach, twist) plus a wrist hinge, capsule-weighted.
 *   body   — crown follow-through, then the head, then the hip lean, then squash,
 *            sway, foot contact, jelly slosh and the soft floor.
 *
 * Eyelids are painted in the fragment stage from the *rest* position, so they
 * stay locked to the eye no matter how the body is deformed.
 */

/**
 * Shared by both stages. Everything about the mouth lives here, because the two
 * stages have to agree exactly: both evaluate the mouth on the *analytic* skin
 * surface rather than on the raw vertex z, so the polynomial's residual enters
 * both identically and cancels. `palSkinZ` does not need to be accurate — it
 * only needs to be smooth.
 */
const COMMON_GLSL = /* glsl */ `
uniform vec3 uFaceR;
uniform vec3 uFaceU;
uniform vec3 uFaceF;
uniform vec3 uEyeC0;
uniform vec3 uEyeC1;
uniform vec3 uEyeD0;
uniform vec3 uEyeD1;
uniform vec2 uEyeR;
uniform vec3 uMouthC;
uniform vec4 uMouth;    // jawOpen, wide, round, press
uniform vec4 uMouth2;   // smile(signed), sneer(signed), tongueUp, lipOpen
uniform vec4 uMouth3;   // tongueTip, shiftX, shiftY, loud
uniform vec4 uMouth4;   // cornerL, cornerR, teethShow, roll
uniform vec4 uMouth5;   // funnel, cheekPuff, tension, tuck

float palStep(float e0, float e1, float x) {
  float d = e1 - e0;
  float t = clamp((x - e0) / (abs(d) < 1e-6 ? 1e-6 : d), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float palStepD(float e0, float e1, float x) {
  float d = e1 - e0;
  float dd = abs(d) < 1e-6 ? 1e-6 : d;
  float t = (x - e0) / dd;
  return (t <= 0.0 || t >= 1.0) ? 0.0 : 6.0 * t * (1.0 - t) / dd;
}
vec3 palLocal(vec3 v) { return vec3(dot(v, uFaceR), dot(v, uFaceU), dot(v, uFaceF)); }
vec3 palWorld(vec3 q) { return uFaceR * q.x + uFaceU * q.y + uFaceF * q.z; }

// ─────────────────────────────────────────────────────────── the skin surface
// Robust cubic fit of the muzzle with the cavity cells masked out, so it
// describes the skin the mouth was cut *into*. rms 0.0007–0.0013 over the rings
// the seal has to match; that is 0.3 px at shipping framing.
const vec4 PAL_SKA = vec4( 0.134479, -0.227536, -0.106407,  0.496428); // 1, y, y², y³
const vec3 PAL_SKB = vec3( 0.004288, -0.077438,  0.355134);            // x, xy, xy²
const vec3 PAL_SKC = vec3(-0.892920, -0.897001, -0.069899);            // x², x²y, x³

float palSkinZ(vec2 c) {
  float x = c.x, y = c.y, x2 = x * x, y2 = y * y;
  return PAL_SKA.x + PAL_SKA.y * y + PAL_SKA.z * y2 + PAL_SKA.w * y2 * y
       + PAL_SKB.x * x + PAL_SKB.y * x * y + PAL_SKB.z * x * y2
       + PAL_SKC.x * x2 + PAL_SKC.y * x2 * y + PAL_SKC.z * x2 * x;
}
vec2 palSkinG(vec2 c) {
  float x = c.x, y = c.y;
  return vec2(PAL_SKB.x + PAL_SKB.y * y + PAL_SKB.z * y * y
                + 2.0 * PAL_SKC.x * x + 2.0 * PAL_SKC.y * x * y + 3.0 * PAL_SKC.z * x * x,
              PAL_SKA.y + 2.0 * PAL_SKA.z * y + 3.0 * PAL_SKA.w * y * y
                + PAL_SKB.y * x + 2.0 * PAL_SKB.z * x * y + PAL_SKC.y * x * x);
}

// Mirrors MUZ_C / MUZ_A / MOUTH_A / MOUTH_W0 in pal-rig.ts.
const vec2  PAL_MUZ_C = vec2( 0.004, -0.020);
const vec2  PAL_MUZ_A = vec2( 0.175,  0.125);
const vec2  PAL_MA    = vec2( 0.008, -0.020);
const float PAL_W0    = 0.102;
float palMuzR(vec2 c) { vec2 e = (c - PAL_MUZ_C) / PAL_MUZ_A; return length(e); }

vec2 palRot2 (vec2 v, float a) { float c = cos(a), s = sin(a); return vec2( c * v.x + s * v.y, -s * v.x + c * v.y); }
vec2 palRot2i(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2( c * v.x - s * v.y,  s * v.x + c * v.y); }
vec2 palToMouth(vec2 c) { return palRot2(c - (PAL_MA + uMouth3.yz), uMouth4.w); }

// ───────────────────────────────────────────────────────────── the aperture
// Superellipse: s = 0 is quadratic (soft, eye-like), s = 1 is linear (a diamond
// with genuinely pointed corners). palQ(±1, s) == 1 for every s, so the
// half-axes stay exact while the sharpness animates, the field gradient stays
// bounded at the corners — which is where a distance-based AA blows up if you
// use pow(1-X², e) — and the shape collapses to an exact seam when the
// half-heights reach zero, which is what makes M/B/P work.
float palQ (float a, float s) { float b = abs(a); return mix(b * b, b, s); }
float palQd(float a, float s) { return mix(2.0 * a, sign(a), s); }
float palQinv(float k, float s) {                       // exact inverse, one sqrt
  k = max(k, 0.0);
  float a = 1.0 - s;
  return (a < 1.0e-3) ? k / max(s, 1.0e-3) : (sqrt(s * s + 4.0 * a * k) - s) / (2.0 * a);
}

void palMouthK(out float W, out float up, out float dn, out float sharp,
               out float eL, out float eR, out float tSide, out float tUp, out float tDn) {
  float jaw = uMouth.x, wid = uMouth.y, rnd = uMouth.z, prs = uMouth.w;
  float smi = uMouth2.x, sne = uMouth2.y, lop = uMouth2.w;
  float lou = uMouth3.w, ten = uMouth5.z, tck = uMouth5.w;
  float smP = max(smi, 0.0), smN = max(-smi, 0.0), o = 1.0 - prs;

  float k = 1.0 + 0.28 * wid - 0.50 * rnd + 0.10 * smP - 0.10 * jaw - 0.06 * prs;
  W = PAL_W0 * max(k, 0.28) * (1.0 + 0.10 * lou);

  // 1 : 2.3 up:down. The jaw drops, the upper lip barely moves. This ratio IS
  // lip sync — a mouth that opens symmetrically reads as a hinge, not a face.
  up = (0.006 + 0.030 * jaw + 0.026 * lop + 0.016 * rnd) * o * (1.0 + 0.35 * lou) * (1.0 - 0.50 * tck);
  dn = (0.010 + 0.070 * jaw + 0.030 * lop + 0.030 * rnd) * o * (1.0 + 0.35 * lou);

  sharp = clamp(0.45 + 0.28 * wid - 0.32 * rnd + 0.16 * smP, 0.05, 0.95);

  float arc = 0.016 + 0.058 * smi;                    // signed: +grin, −frown
  eL = arc * 0.92 - max(-sne, 0.0) * 0.030 + uMouth4.x * 0.030;
  eR = arc * 1.08 + 0.010 + max(sne, 0.0) * 0.030 + uMouth4.y * 0.030;  // +0.010: the mesh's own asymmetry

  tSide = 0.0092 * (1.0 + 0.30 * prs - 0.20 * wid - 0.35 * ten);
  tUp   = 0.0046 * (1.0 + 0.55 * prs + 0.25 * smN - 0.30 * ten) * (1.0 - 0.55 * tck);
  tDn   = 0.0066 * (1.0 + 0.70 * prs + 0.55 * smN - 0.30 * ten) * (1.0 + 0.30 * tck);
}

// The seam is anchored at the corners rather than at the centre: mix(eL, eR)
// lets the two corners be placed independently with no derivative kink in the
// middle, which is where a face's asymmetry lives. hook(u) is flat across the
// middle and curls hard in the last quarter — what a drawn smile does, and what
// a parabola does not.
void palSeamAt(float mx, float W, float eL, float eR, out float u, out float y0, out float dy0) {
  u = clamp(mx / max(W, 1.0e-4), -1.6, 1.6);
  float t   = clamp((u + 0.30) / 0.60, 0.0, 1.0);
  float su  = t * t * (3.0 - 2.0 * t);
  float dsu = 6.0 * t * (1.0 - t) / 0.60;
  float h   = 0.55 * u * u + 0.45 * u * u * u * u;
  float dh  = 1.10 * u + 1.80 * u * u * u;
  float e   = mix(eL, eR, su);
  y0  = e * h + 0.006 * uMouth5.w;                    // the tuck rides the seam up over the teeth
  dy0 = ((eR - eL) * dsu * h + e * dh) / max(W, 1.0e-4);
}

// The cupid's bow — a narrow notch flanked by two peaks, on the upper lip only.
// This is the one detail that makes the mouth look drawn rather than generated,
// and it survives into a fully pressed seam, which is why a closed cartoon mouth
// is not a dash.
float palBow(float u) {
  float gN = max(0.0, 1.0 - (u / 0.24) * (u / 0.24)); gN *= gN;
  float tp = (abs(u) - 0.36) / 0.28;
  float gP = max(0.0, 1.0 - tp * tp); gP *= gP;
  // Held at this size the bow is a charm on a closed mouth and a ripple on an
  // open one — three bumps across 75 px read as a torn edge, not a lip — so it
  // flattens as the jaw drops, which is also what a real upper lip does.
  return (0.0018 * gP - 0.0030 * gN) * (1.0 - uMouth.z * 0.75) * (1.0 - uMouth.w * 0.30)
       * (1.0 - 0.60 * uMouth.x);
}

// g < 1 is inside the shape. grad is the analytic gradient in mouth units, which
// is what turns the field into a true distance — the clamp on n is the key
// numerical guard, because up and dn reach exactly 0 when the lips seal.
float palField(vec2 m, float y0, float dy0, float Wf, float hu, float hd, float s, out vec2 grad) {
  float ux = m.x / max(Wf, 1.0e-4);
  float ty = m.y - y0;
  float h  = (ty >= 0.0) ? max(hu, 1.0e-4) : max(hd, 1.0e-4);
  float n  = clamp(ty / h, -12.0, 12.0);
  float dq = (abs(ty / h) < 12.0) ? palQd(n, s) / h : 0.0;
  grad = vec2(palQd(ux, s) / max(Wf, 1.0e-4) - dq * dy0, dq);
  return palQ(ux, s) + palQ(n, s);
}
float palDist(float g, vec2 grad) { return (1.0 - g) / max(length(grad), 1.0e-3); }

// The aperture's top and bottom edge at one point — from the same field, so the
// interior features can never drift off the silhouette that occludes them.
void palAper(vec2 mm, float W, float up, float dn, float s, float eL, float eR,
             out float u, out float y0, out float dy0, out float yT, out float yB, out float nE) {
  palSeamAt(mm.x, W, eL, eR, u, y0, dy0);
  y0 += palBow(u);
  nE = palQinv(max(0.0, 1.0 - palQ(u, s)), s);
  yT = y0 + up * nE;
  yB = y0 - dn * nE;
}

// ────────────────────────────────────────────────── the relief (carve) field
// > 0 proud of the sealed skin, < 0 carved behind it, along +FACE_F. Shared by
// the vertex stage (geometry) and the fragment stage (shading normal).
float palRelief(vec2 m) {
  float W, up, dn, s, eL, eR, tS, tU, tD;
  palMouthK(W, up, dn, s, eL, eR, tS, tU, tD);
  float u, y0, dy0, yT, yB, nE;
  palAper(m, W, up, dn, s, eL, eR, u, y0, dy0, yT, yB, nE);

  vec2 ga, gb;
  float gIn  = palField(m, y0, dy0, W,              up,              dn,              s, ga);
  float gPad = palField(m, y0, dy0, W + tS + 0.014, up + tU + 0.012, dn + tD + 0.014, s, gb);
  float open = 1.0 - palStep(0.06, 1.00, gIn);
  float pad  = 1.0 - palStep(0.30, 1.30, gPad);

  // The bowl is deepest just under the upper lip — that is where the throat is —
  // and shallow at the front, with the wall slope held under ~1.6:1.
  float c    = clamp((yT - m.y) / max(yT - yB, 1.0e-4), 0.0, 1.0);
  float D    = min(0.014 + 0.85 * (up + dn), 0.090);
  float bowl = D * (0.55 + 0.45 * palStep(0.80, 0.18, c)) * (1.0 - 0.30 * u * u) * open;

  // Tongue shelf: lifting the floor is what lets the tongue catch its own light.
  float rise = 0.28 + 0.55 * uMouth2.z;
  float capT = sqrt(max(0.0, 1.0 - 0.92 * u * u));
  float yTg  = yB + (yT - yB) * (rise * capT + 0.20 * uMouth3.x * max(0.0, 1.0 - (u / 0.32) * (u / 0.32)));
  bowl *= 1.0 - 0.60 * palStep(0.0, 0.55, clamp((yTg - m.y) / max((yT - yB) * 0.40, 1e-4), 0.0, 1.0));

  // A raised rim just OUTSIDE the aperture, peaking 0.006 out. This is what gives
  // the lower lip a real rolling specular, and what makes a pressed mouth read as
  // two lips with a groove rather than a line drawn on a ball.
  float go = max(0.0, -palDist(gPad, gb));
  float e  = go - 0.006;
  float ridge = (0.0032 + 0.0030 * uMouth.w + 0.0048 * uMouth5.x)
              * (1.0 + 0.55 * u * u) * exp(-e * e * 6173.0);

  float closed = 1.0 - palStep(0.004, 0.016, up + dn);
  float sg = max(0.0, 1.0 - abs(m.y - y0) / 0.0075); sg *= sg;
  float groove = 0.0060 * closed * sg * pad;

  float dimA = (0.30 + 0.70 * max(uMouth2.x, 0.0)) * (0.5 + 0.5 * uMouth.y);
  float dd = min(length((m - vec2(-W - 0.016, eL + 0.008)) / vec2(0.021, 0.027)),
                 length((m - vec2( W + 0.016, eR + 0.008)) / vec2(0.021, 0.027)));
  float dim = (1.0 - palStep(0.55, 1.05, dd)) * dimA * 0.008;

  // A permanent, very shallow hollow over the mesh aperture's footprint. Real
  // faces have one, and it hides the seal's residual so the sealed patch never
  // reads as a patch.
  float pr = length((m - vec2(-0.004, 0.004)) / vec2(0.150, 0.100));
  float pillow = 0.0085 * (1.0 - palStep(0.50, 1.05, pr));

  return pad * 0.0038 + ridge - bowl - groove - dim - pillow;
}

// ────────────────────────────────────────────────────────────── the jaw map
// Virtual TMJ derived from the target, not guessed: the chin has to travel down
// 0.075 and back 0.031 (the mandibular arc, 23°), which fixes z_r/|y_r| = 2.4
// and puts the pivot at (0, +0.10, −0.55) with a = 0.104 rad.
const vec3 PAL_JAW_P = vec3(0.0, 0.100, -0.550);

float palJawAmt() {
  return clamp(0.85 * uMouth.x + 0.22 * uMouth.z + 0.20 * uMouth3.w
             + 0.12 * max(0.0, -uMouth2.x), 0.0, 1.15);
}

// Rest face-local weight: zero at and above the seam, 1 by the chin, gone before
// the belly — a jaw, not a sagging body.
float palJawW(vec3 q) {
  return palStep(0.010, -0.150, q.y)
       * (1.0 - palStep(-0.20, -0.42, q.y))
       * (1.0 - palStep(0.30, 0.58, abs(q.x - 0.004)))
       * palStep(-0.46, -0.10, q.z);
}

// Rest face-local point -> deformed face-local point. IDENTICAL in both stages;
// the fragment paint is therefore glued to skin the jaw has moved, which is what
// makes an open mouth look like a jaw dropped instead of a hole growing.
vec3 palFaceDeform(vec3 q) {
  vec3 o = q;
  float jd = palJawAmt();
  float w  = palJawW(q);
  if (w > 0.002) {
    float a = 0.104 * jd * w;
    vec3 r = q - PAL_JAW_P;
    float ca = cos(a), sa = sin(a);
    o.y = PAL_JAW_P.y + r.y * ca - r.z * sa;
    o.z = PAL_JAW_P.z + r.y * sa + r.z * ca;
  }
  // Cheek volume — the half of the jaw read everyone skips, and worth more than
  // the drop itself. wide and round pull the cheeks IN, which is what makes an
  // EE feel tense and an OO pursed rather than both being differently shaped holes.
  for (int i = 0; i < 2; i++) {
    float sd = (i == 0) ? -1.0 : 1.0;
    vec2 d = (q.xy - vec2(sd * 0.30, -0.02)) / vec2(0.20, 0.15);
    float wc = max(0.0, 1.0 - dot(d, d)); wc *= wc; wc *= palStep(-0.34, -0.06, q.z);
    float amt = 0.016 * jd - 0.011 * uMouth.y - 0.013 * uMouth.z
              + 0.009 * uMouth.w + 0.045 * uMouth5.y;
    o.x += sd * wc * amt * 0.78;
    o.z += wc * amt * 0.62;
  }
  // The OO/W snout. Rounding that only narrows the aperture reads as a small
  // mouth; pushing the lip mass forward reads as a pucker.
  vec2  mm = palToMouth(q.xy);
  float wp = 1.0 - palStep(0.05, 0.17, length(mm * vec2(0.80, 1.0)));
  o.z  += wp * (0.030 * uMouth.z + 0.020 * uMouth5.x + 0.007 * uMouth.w) * palStep(-0.30, -0.05, q.z);
  o.xy -= palRot2i(mm, uMouth4.w) * (uMouth.z * 0.16 * wp);
  return o;
}
`;

const VERTEX_GLSL = /* glsl */ `
uniform vec2 uEyeLook;
uniform float uEyeWiden;
uniform vec2 uLid;
uniform vec3 uBrow0;
uniform vec3 uBrow1;
uniform vec2 uBrowP;
uniform vec3 uArmLS;
uniform vec3 uArmLD;
uniform vec3 uArmRS;
uniform vec3 uArmRD;
uniform vec4 uArmL;      // composed axis, angle
uniform vec4 uArmR;
uniform vec4 uArmW;      // lenL, lenR, wristL, wristR
uniform vec4 uHead;      // composed axis, angle
uniform vec3 uHeadP;
uniform vec2 uHeadRamp;
uniform vec4 uCrown;     // composed axis, angle
uniform vec4 uCrownP;    // pivot, vertical lag
uniform vec4 uBody;      // composed lean axis, angle
uniform vec3 uHip;
uniform vec4 uDyn;       // squash, breathe, airborne, groundY
uniform vec4 uSlosh;     // jiggleX, jiggleZ, sway, comY
uniform vec4 uFeet;      // footL, footR, splitX, soleH
uniform vec4 uPoke;      // contact point, depth
uniform vec4 uPokeD;     // inward direction, radius
uniform vec3 uFaceRb;    // the face frame carried by uHead then uBody
uniform vec3 uFaceUb;
uniform vec3 uFaceFb;
attribute float palSeal;
attribute float palCav;
varying vec3 vPalRest;
varying mat3 vPalNM;

// Mirrors BODY_RAMP / CROWN_RAMP / SWAY_RAMP / ARM_* / FLOOR_K in pal-rig.ts.
const vec2  PAL_BODY_RAMP  = vec2(-0.70, -0.18);
const vec2  PAL_CROWN_RAMP = vec2( 0.42,  0.72);
const vec2  PAL_SWAY_RAMP  = vec2(-0.78, -0.10);
const float PAL_FLOOR_K    = 0.030;

vec3 palRot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
vec3 palRotP(vec3 p, vec3 piv, vec3 k, float a) { return piv + palRot(p - piv, k, a); }

// Trapezoidal-derivative ramp: peak slope 1.3333/Δ against smoothstep's 1.5/Δ,
// an 11% larger safe angle for six more instructions, C1 at both ends.
float palRampT(float e0, float e1, float x) {
  float d = e1 - e0;
  float t = clamp((x - e0) / (abs(d) < 1e-6 ? 1e-6 : d), 0.0, 1.0);
  float lo = t * t * 2.66666667;
  float hi = 1.0 - (1.0 - t) * (1.0 - t) * 2.66666667;
  float mid = (t - 0.125) / 0.75;
  return mix(mix(lo, mid, step(0.25, t)), hi, step(0.75, t));
}
float palRampTd(float e0, float e1, float x) {
  float d = e1 - e0;
  float dd = abs(d) < 1e-6 ? 1e-6 : d;
  float t = (x - e0) / dd;
  if (t <= 0.0 || t >= 1.0) return 0.0;
  return mix(mix(t * 5.33333333, 1.33333333, step(0.25, t)), (1.0 - t) * 5.33333333, step(0.75, t)) / dd;
}

/**
 * Weighted rotation, with the normal correction the shipped rig dropped.
 * J = R + θ(k×u)⊗∇w, and Sherman-Morrison gives J⁻ᵀn = R(n − ∇w·θ(k×v)·n/(1+g))
 * with g = θ ∇w·(k×v) = det J − 1. Without that second term a hard lean lays a
 * faint shading band across the belly, because the normal never sees the ramp.
 */
void palTurn(inout vec3 p, inout vec3 n, vec3 piv, vec3 k, float ang, float w, vec3 gradW) {
  vec3 v = p - piv;
  vec3 kv = cross(k, v);
  float g = ang * dot(gradW, kv);
  p = piv + palRot(v, k, ang * w);
  n = palRot(n - gradW * (ang * dot(kv, n) / max(1.0 + g, 0.15)), k, ang * w);
}

void palEye(inout vec3 p, inout vec3 n, vec3 r, vec3 c, vec3 rest) {
  vec3 d = r - c;
  float dist = length(d);
  float shell = 1.0 - palStep(0.155, 0.190, dist);
  if (shell <= 0.0) return;
  float ca = dot(d / max(dist, 1e-5), rest);
  float w = shell * palStep(0.2419, 0.5, ca);
  if (w <= 0.001) return;

  float yaw = uEyeLook.x * w;
  float pit = uEyeLook.y * w;
  p = palRotP(p, c, uFaceU, yaw);
  p = palRotP(p, c, uFaceR, pit);
  n = palRot(palRot(n, uFaceU, yaw), uFaceR, pit);

  float closed = max(uLid.x, uLid.y);
  if (abs(uEyeWiden) > 0.001 || closed > 0.01) {
    vec3 q = palLocal(p - c);
    q.x *= 1.0 + uEyeWiden * 0.06;
    q.y *= (1.0 + uEyeWiden * 0.10) * (1.0 - closed * 0.07);
    q.z *= 1.0 - closed * 0.08;
    p = mix(p, c + palWorld(q), w);
  }
}

/**
 * ∂palFaceDeform/∂q, as the three columns of the Jacobian in the face frame.
 * Every term of that map is a closed-form weight times a fixed direction — the
 * jaw is a weighted rotation, the cheeks and the pucker weighted offsets — so
 * the derivative is closed form too, and cof(J) then carries the normal. Without
 * it the chin shades bit-identically to the closed pose and a puffed cheek
 * bulges the silhouette while staying lit as a smooth ball.
 */
mat3 palFaceDeformJ(vec3 q) {
  mat3 J = mat3(1.0);
  float jd = palJawAmt();

  float wj = palJawW(q);
  if (wj > 0.002) {
    // ∇palJawW — the product rule over the four ramps palJawW multiplies.
    float ax  = abs(q.x - 0.004);
    float wy0 = palStep(0.010, -0.150, q.y);
    float wy1 = 1.0 - palStep(-0.20, -0.42, q.y);
    float wx  = 1.0 - palStep(0.30, 0.58, ax);
    float wz  = palStep(-0.46, -0.10, q.z);
    vec3 gw = vec3(
      -wy0 * wy1 * wz * palStepD(0.30, 0.58, ax) * sign(q.x - 0.004),
      (palStepD(0.010, -0.150, q.y) * wy1 - wy0 * palStepD(-0.20, -0.42, q.y)) * wx * wz,
      wy0 * wy1 * wx * palStepD(-0.46, -0.10, q.z));

    float a  = 0.104 * jd * wj;
    float ca = cos(a), sa = sin(a);
    vec3  rr = q - PAL_JAW_P;
    // R + (k × R·r) ⊗ ∇a: the rotation itself, plus the rank-1 term the ramp
    // contributes because the angle is a function of position.
    vec3  v  = vec3(rr.x, rr.y * ca - rr.z * sa, rr.y * sa + rr.z * ca);
    vec3  kv = vec3(0.0, -v.z, v.y);
    vec3  ga = gw * (0.104 * jd);
    J = mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, ca, sa), vec3(0.0, -sa, ca));
    J[0] += kv * ga.x;
    J[1] += kv * ga.y;
    J[2] += kv * ga.z;
  }

  for (int i = 0; i < 2; i++) {
    float sd = (i == 0) ? -1.0 : 1.0;
    vec2  d  = (q.xy - vec2(sd * 0.30, -0.02)) / vec2(0.20, 0.15);
    float b  = max(0.0, 1.0 - dot(d, d));
    float sz = palStep(-0.34, -0.06, q.z);
    float amt = 0.016 * jd - 0.011 * uMouth.y - 0.013 * uMouth.z
              + 0.009 * uMouth.w + 0.045 * uMouth5.y;
    vec3 gc = vec3(-4.0 * b * d.x / 0.20 * sz, -4.0 * b * d.y / 0.15 * sz,
                   b * b * palStepD(-0.34, -0.06, q.z));
    vec3 dv = vec3(sd * 0.78, 0.0, 0.62) * amt;
    J[0] += dv * gc.x;
    J[1] += dv * gc.y;
    J[2] += dv * gc.z;
  }

  vec2  mc = q.xy - (PAL_MA + uMouth3.yz);
  vec2  mm = palRot2(mc, uMouth4.w);
  float L  = length(mm * vec2(0.80, 1.0));
  float wp = 1.0 - palStep(0.05, 0.17, L);
  // ∇q L = Rᵀ ∇m L, and palRot2i is exactly palRot2's transpose.
  vec2  gwp = (L > 1.0e-6)
            ? palRot2i(vec2(0.64 * mm.x, mm.y) / L, uMouth4.w) * -palStepD(0.05, 0.17, L)
            : vec2(0.0);
  float T = palStep(-0.30, -0.05, q.z);
  float K = 0.030 * uMouth.z + 0.020 * uMouth5.x + 0.007 * uMouth.w;
  J[0].z += K * T * gwp.x;
  J[1].z += K * T * gwp.y;
  J[2].z += K * wp * palStepD(-0.30, -0.05, q.z);
  // palRot2i undoes palToMouth exactly, so the lateral pucker term is a plain
  // radial pull of q.xy toward the mouth centre.
  float g16 = uMouth.z * 0.16;
  J[0].xy -= vec2(g16 * wp, 0.0) + mc * (g16 * gwp.x);
  J[1].xy -= vec2(0.0, g16 * wp) + mc * (g16 * gwp.y);
  return J;
}

/**
 * Seal the sculpted grin, carve the drawn one, and swing the jaw.
 *
 * palSeal is baked at load: a harmonic membrane relaxed across the cavity with
 * the rim held fixed, so continuity with the surrounding skin is exact by
 * construction rather than by fitting. The relief and the jaw/cheek/pucker map
 * are then evaluated on the analytic skin surface — the same one the fragment
 * stage uses — and the jaw displacement is applied over its own, much wider
 * region, so the muzzle window's edge carries no step.
 */
void palMouthGeo(inout vec3 p, inout vec3 n, vec3 r) {
  vec3 q = palLocal(r - uMouthC);
  if (q.z < -0.46 || q.y > 0.17 || q.y < -0.46 || abs(q.x - 0.004) > 0.58) return;

  float wR = 0.0, w = 0.0;
  if (q.z > -0.36) {
    wR = 1.0 - palStep(1.00, 1.45, palMuzR(q.xy));
    // The eye shells reach toward the mouth corners, so the analytic stand-in,
    // the relief and the paint are all tapered away from them. The SEAL is not:
    // it is measured on the pocket, whose sheets sit up to 0.222 deep and are
    // therefore *nearer* the fitted eye centres than the skin in their own
    // column — tapering there folds the pocket only partway onto the membrane
    // and tears it open in depth.
    w = wR * min(palStep(0.150, 0.205, distance(r, uEyeC0)),
                 palStep(0.150, 0.205, distance(r, uEyeC1)));
  }

  // Inside the window the analytic surface stands in for the vertex, which is
  // what keeps the two stages in exact agreement; outside it the polynomial is
  // meaningless and the vertex speaks for itself.
  vec3 S = mix(q, vec3(q.xy, palSkinZ(q.xy)), w);
  vec3 D = palFaceDeform(S);
  vec3 disp = palWorld(D - S);

  // Every term of the map is weighted, so where it displaces nothing it has no
  // gradient either — this skips the Jacobian for the whole rest pose.
  if (dot(disp, disp) > 1.0e-10) {
    mat3 J = palFaceDeformJ(S);
    vec3 nf = palLocal(n);
    n = palWorld(cross(J[1], J[2]) * nf.x + cross(J[2], J[0]) * nf.y + cross(J[0], J[1]) * nf.z);
  }

  // Accumulated, like every other deformer: the eye shells overlap this window's
  // taper, so assigning p would silently drop the eyeball rotation for the ring
  // of vertices inside both.
  if (w <= 0.0015) { p += uFaceF * (palSeal * wR) + disp; return; }

  float rel = palRelief(palToMouth(D.xy));
  p += uFaceF * (palSeal * wR + rel * w) + disp;

  // The folded pocket walls face inwards, so their own normals light the bowl
  // from behind — the silent bug in the shipped build, where an open mouth
  // caught no light at all. Inside the window the sealed surface owns the normal.
  vec2 g = palSkinG(q.xy);
  vec3 na = normalize(palWorld(vec3(-g.x, -g.y, 1.0)));
  n = normalize(mix(n, na, w * max(palCav, palStep(0.30, 0.80, w))));
}

void palBrow(inout vec3 p, vec3 r, vec3 b, float side) {
  float w = 1.0 - palStep(0.10, 0.26, length(r - b));
  if (w <= 0.001) return;
  p += uFaceU * ((uBrowP.x * 0.055 + uBrowP.y * 0.035 * side) * w);
}

/**
 * 3 DOF at the shoulder plus a distal wrist hinge. The radial falloff is the
 * dominant fold source — steeper than any ramp in the rig — so it is
 * deliberately wide: (0.10, 0.52) keeps the left arm safe to 0.522 rad, where
 * the shipped (0.17, 0.34) inverted the shoulder at 0.619 and the wave already
 * reached 0.58. Widening it is what actually unlocks a stronger wave.
 */
void palArm(inout vec3 p, inout vec3 n, vec3 r, vec3 s, vec3 dir, float L, vec4 rot, float wrist) {
  vec3 v = r - s;
  float along = dot(v, dir);
  if (along < -0.13 || along > L + 0.26) return;
  vec3 perpV = v - dir * along;
  float perp = length(perpV);
  if (perp > 0.54) return;
  float rad = 1.0 - palStep(0.10, 0.52, perp);
  if (rad <= 1e-3) return;
  vec3 ph = perpV / max(perp, 1e-5);
  float dRad = -palStepD(0.10, 0.52, perp);

  // The hinge is distal, so it goes first and in rest space: the shoulder swing
  // then carries an already-cocked hand.
  float wA = palRampT(L * 0.60, L * 1.02, along);
  if (wA * rad > 1e-3 && abs(wrist) > 1e-4) {
    vec3 g = dir * (palRampTd(L * 0.60, L * 1.02, along) * rad) + ph * (wA * dRad);
    palTurn(p, n, s + dir * (L * 0.60), uFaceF, wrist, wA * rad, g);
  }
  float aA = palRampT(-0.08, L * 0.86, along);
  if (aA * rad <= 1e-3 || abs(rot.w) < 1e-4) return;
  vec3 g2 = dir * (palRampTd(-0.08, L * 0.86, along) * rad) + ph * (aA * dRad);
  palTurn(p, n, s, rot.xyz, rot.w, aA * rad, g2);
}

/** A dent at the contact point, with its analytic normal, springing back. */
void palPoke(inout vec3 p, inout vec3 n, vec3 r) {
  if (uPoke.w <= 1e-4) return;
  vec3 d = r - uPoke.xyz;
  float dist = length(d);
  if (dist >= uPokeD.w) return;
  float t = dist / uPokeD.w;
  float b = 1.0 - t * t;
  vec3 grad = d * (uPoke.w * (-4.0 * t * b / uPokeD.w) / max(dist, 1e-5));
  p -= uPokeD.xyz * (uPoke.w * b * b);
  n += grad * dot(uPokeD.xyz, n);
}

// The crown runs BEFORE the head, so the head then carries the bent crown —
// which is what "the top trails the head" actually means. Driven only by the lag
// solver and impact kicks; gestures never key it.
void palCrown(inout vec3 p, inout vec3 n, vec3 r) {
  float fh = dot(r, uFaceU);
  float w = palRampT(PAL_CROWN_RAMP.x, PAL_CROWN_RAMP.y, fh);
  if (w <= 5e-4) return;
  float wd = palRampTd(PAL_CROWN_RAMP.x, PAL_CROWN_RAMP.y, fh);
  if (abs(uCrown.w) > 1e-4) palTurn(p, n, uCrownP.xyz, uCrown.xyz, uCrown.w, w, uFaceU * wd);
  if (abs(uCrownP.w) > 1e-5) {
    float a = uCrownP.w * wd;
    p.y += uCrownP.w * w;
    n -= uFaceU * (a * n.y / max(1.0 + a * uFaceU.y, 0.15));
  }
}

// Ramped in face height, not world y: an fh ramp has iso-surfaces parallel to the
// face's own horizon, so both eyes and both brows weight exactly 1.000 even
// though the head carries a 13° roll. It also makes yaw exactly volume
// preserving (∇w ∥ k ⇒ det J ≡ 1), which is why yaw is the channel to spend on.
void palHead(inout vec3 p, inout vec3 n, vec3 r) {
  if (abs(uHead.w) < 1e-4) return;
  float fh = dot(r, uFaceU);
  float w = palRampT(uHeadRamp.x, uHeadRamp.y, fh);
  if (w <= 5e-4) return;
  palTurn(p, n, uHeadP, uHead.xyz, uHead.w, w, uFaceU * palRampTd(uHeadRamp.x, uHeadRamp.y, fh));
}

// Plateaued so the whole face rides rigid (weight 1.000 at mouth, eyes and brows)
// and the feet stay nailed (0.000 at the sole and at the top of the feet).
void palBodyLean(inout vec3 p, inout vec3 n, vec3 r) {
  if (abs(uBody.w) < 1e-4) return;
  float w = palRampT(PAL_BODY_RAMP.x, PAL_BODY_RAMP.y, r.y);
  if (w <= 5e-4) return;
  palTurn(p, n, uHip, uBody.xyz, uBody.w, w,
          vec3(0.0, palRampTd(PAL_BODY_RAMP.x, PAL_BODY_RAMP.y, r.y), 0.0));
}

// Squash pivots on the floor while she is planted and on the COM once she is in
// the air, so a hop cannot scale her off the ground. Breathing is anisotropic —
// 3% taller, 2.2% deeper, 1.2% narrower — because the shipped ±1% on x and z
// alike is simply invisible at this camera.
void palSquash(inout vec3 p, inout vec3 n, vec3 r) {
  if (abs(uDyn.x) < 1e-5 && abs(uDyn.y) < 1e-5) return;
  float pivotY = mix(uDyn.w, uSlosh.w, uDyn.z);
  float plant  = mix(palRampT(uDyn.w + 0.02, uDyn.w + 0.34, r.y), 1.0, uDyn.z);
  float sy  = 1.0 + uDyn.x + uDyn.y * 0.030;
  float sxz = 1.0 - uDyn.x * 0.45 - uDyn.y * 0.012;
  float szf = 1.0 - uDyn.x * 0.45 + uDyn.y * 0.022;
  float a = 1.0 + (sxz - 1.0) * plant;
  float b = 1.0 + (sy  - 1.0) * plant;
  float c = 1.0 + (szf - 1.0) * plant;
  p.x *= a;
  p.z *= c;
  p.y = pivotY + (p.y - pivotY) * b;
  n = vec3(n.x * b * c, n.y * a * c, n.z * a * b);   // inverse-transpose, up to scale
}

void palSway(inout vec3 p, inout vec3 n, vec3 r) {
  if (abs(uSlosh.z) < 1e-5) return;
  float w  = palRampT(PAL_SWAY_RAMP.x, PAL_SWAY_RAMP.y, r.y);
  float wd = palRampTd(PAL_SWAY_RAMP.x, PAL_SWAY_RAMP.y, r.y);
  p.x += uSlosh.z * w;
  n.y -= uSlosh.z * wd * n.x;
}

// The loaded sole pancakes and spreads. The 0.026 sink deliberately pushes it
// into the soft floor's 0.030 knee, so it flattens against the ground instead of
// sinking through it.
void palFeet(inout vec3 p, vec3 r) {
  float sole = 1.0 - palStep(uDyn.w, uDyn.w + uFeet.w, r.y);
  if (sole <= 1e-3) return;
  float sideR = palStep(uFeet.z - 0.09, uFeet.z + 0.09, r.x);
  float k = sole * mix(uFeet.x, uFeet.y, sideR);
  vec2 c = vec2(mix(-0.285, 0.313, sideR), mix(0.062, 0.090, sideR));
  p.y  -= 0.026 * k;
  p.xz += (p.xz - c) * (0.055 * k);
}

// Soft mass lags the rigid frame along one direction. The shipped corkscrew
// (sin in x, cos in z) sloshed the mass in a circle, which no impact ever does.
void palJelly(inout vec3 p, inout vec3 n, vec3 r) {
  if (dot(uSlosh.xy, uSlosh.xy) < 1e-8) return;
  float h = clamp((r.y - uDyn.w) / 1.64, 0.0, 1.0);
  float w = h * h * (3.0 - 2.0 * h);
  float lag = w * (1.0 + 0.45 * w);                     // the crown whips past the belly
  float dl  = 6.0 * h * (1.0 - h) * (1.0 + 0.90 * w) / 1.64;
  p.x += uSlosh.x * lag;
  p.z += uSlosh.y * lag;
  n.y -= dl * (uSlosh.x * n.x + uSlosh.y * n.z);        // a pure shear, exactly
}

// C1, and bit-exact identity at rest: the asymptote sits at GROUND_Y − k, which
// is the β = 1 root of 0.25k(β+1)² = kβ.
void palFloor(inout vec3 p) {
  float g = uDyn.w - PAL_FLOOR_K, d = p.y - g;
  float t = clamp(d / PAL_FLOOR_K, -1.0, 1.0);
  p.y = mix(g + PAL_FLOOR_K * 0.25 * (t + 1.0) * (t + 1.0), p.y, step(PAL_FLOOR_K, d));
}

void palDeform(vec3 r, inout vec3 p, inout vec3 n) {
  palEye(p, n, r, uEyeC0, uEyeD0);
  palEye(p, n, r, uEyeC1, uEyeD1);
  palMouthGeo(p, n, r);
  palBrow(p, r, uBrow0, -1.0);
  palBrow(p, r, uBrow1, 1.0);
  palArm(p, n, r, uArmLS, uArmLD, uArmW.x, uArmL, uArmW.z);
  palArm(p, n, r, uArmRS, uArmRD, uArmW.y, uArmR, uArmW.w);
  palPoke(p, n, r);
  palCrown(p, n, r);
  palHead(p, n, r);
  palBodyLean(p, n, r);
  palSquash(p, n, r);
  palSway(p, n, r);
  palFeet(p, r);
  palJelly(p, n, r);
  palFloor(p);
  n = normalize(n);
}

// The face frame after the head turn and the body lean, handed to the fragment
// stage so the relief normal survives both. It reads only uniforms, so it is one
// value for the whole draw: writePose composes it — body∘head, the order
// palDeform applies them in, and the one writeCamera inverts — and all that is
// left here is the camera-space fixup, which is per-object anyway.
mat3 palFaceNM() {
  return normalMatrix * mat3(uFaceRb, uFaceUb, uFaceFb);
}
`;

const FRAGMENT_GLSL = /* glsl */ `
uniform vec3 uLidF;
uniform vec3 uLidCol;
uniform vec3 uCreaseCol;
uniform vec3 uBlushCol;
uniform vec3 uRimCol;
uniform vec3 uBlush0;
uniform vec3 uBlush1;
uniform vec2 uFx;
uniform vec3 uCamL;
uniform vec3 uCavDeep;
uniform vec3 uCavMid;
uniform vec3 uCavWarm;
uniform vec3 uSSSCol;
uniform vec3 uToothCol;
uniform vec3 uTongueCol;
uniform vec3 uTongueTip;
uniform vec3 uLipCol;
uniform vec3 uLipDark;
uniform vec3 uLipLight;
varying vec3 vPalRest;
varying mat3 vPalNM;

// Written by palMouthPaint, consumed by the roughness, normal and rim patches.
float palPx, palMuzW, palCavM, palOccM, palTeethM, palTongueM, palLipM;
vec2 palMouthM;

// Every boundary here is a curve with a known gradient, so coverage is a linear
// function of the true signed distance rather than a smoothstep of the raw
// field. That is what keeps a sub-pixel lip line from strobing as the head
// turns; palThin fades any feature narrower than a pixel toward its average,
// which is the correct band-limit and why the mouth still reads at thumbnail size.
float palCov (float d) { return clamp(d / max(palPx, 1.0e-6) + 0.5, 0.0, 1.0); }
float palBand(float d, float a, float b) { return palCov(d - a) * palCov(b - d); }
float palThin(float wdt) { return clamp(wdt / max(palPx, 1.0e-6), 0.0, 1.0); }

void palMouthPaint(vec3 rest, inout vec3 col) {
  palMuzW = 0.0; palCavM = 0.0; palOccM = 0.0; palTeethM = 0.0; palTongueM = 0.0; palLipM = 0.0;
  palMouthM = vec2(0.0);

  vec3 q0 = palLocal(rest - uMouthC);
  vec2 m0 = palToMouth(q0.xy);
  // One footprint per fragment, from a quantity that is affine in the
  // interpolated rest position, taken in uniform control flow BEFORE any
  // early-out. fwidth() of a composite field flares along every kink it has.
  palPx = max(length(vec2(dFdx(m0.x), dFdy(m0.x))), length(vec2(dFdx(m0.y), dFdy(m0.y))));
  palPx = clamp(palPx, 3.0e-5, 6.0e-3);
  if (q0.z < -0.36) return;
  float rp = palMuzR(q0.xy);
  if (rp > 1.45) return;
  float muz = (1.0 - palStep(1.00, 1.45, rp))
            * min(palStep(0.150, 0.205, distance(rest, uEyeC0)),
                  palStep(0.150, 0.205, distance(rest, uEyeC1)));
  if (muz <= 0.002) return;
  palMuzW = muz;

  // The texture ships as clean skin, so nothing is erased: its own shading is
  // kept as a multiplier instead, and assigning a flat colour anywhere below
  // would make the mouth look pasted onto the face. But the muzzle's charts are
  // a photogrammetry unwrap whose luminance swings 7x across the patch, so the
  // range is bounded around the measured skin mean — the mouth breathes with the
  // face, it just cannot go blotchy.
  float lum = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.16, 0.36);

  vec3 S = vec3(q0.xy, palSkinZ(q0.xy));
  vec3 D = palFaceDeform(S);
  vec2 m = palToMouth(D.xy);
  palMouthM = m;

  float W, up, dn, s, eL, eR, tS, tU, tD;
  palMouthK(W, up, dn, s, eL, eR, tS, tU, tD);

  // In profile the lip band foreshortens to sub-pixel, so its thickness is
  // compensated by the grazing angle and never drops below about two pixels.
  vec3  Vl = normalize(uCamL - D);
  float graze = 1.0 - clamp(Vl.z, 0.0, 1.0);
  float thick = 1.0 + 0.55 * graze * graze;
  tS *= thick; tU *= thick; tD *= thick;

  float u, y0u, dy0, yT, yB, nE;
  palAper(m, W, up, dn, s, eL, eR, u, y0u, dy0, yT, yB, nE);

  vec2 ga, gb, gc;
  float gIn  = palField(m, y0u, dy0, W,              up,              dn,              s, ga);
  float gOut = palField(m, y0u, dy0, W + tS,         up + tU,         dn + tD,         s, gb);
  float gAO  = palField(m, y0u, dy0, W + tS + 0.050, up + tU + 0.034, dn + tD + 0.046, s, gc);
  float dIn  = palDist(gIn,  ga);
  float dOut = palDist(gOut, gb);
  float inAp  = palCov(dIn);
  float inLip = palCov(dOut);
  float lipB  = max(inLip - inAp, 0.0);
  float open01 = palStep(0.004, 0.016, up + dn);
  float cT = clamp((yT - m.y) / max(yT - yB, 1.0e-4), 0.0, 1.0);   // 0 upper lip … 1 lower lip

  // ── contact shadow. This is what puts the mouth IN the face rather than on it.
  float halo = (1.0 - palStep(0.35, 1.00, gAO)) * (1.0 - inLip);
  float aoK  = halo * (0.42 + 0.55 * palStep(0.0,  0.030, m.y - y0u)
                            + 0.85 * palStep(0.0, -0.030, m.y - y0u))
             * (0.40 + 0.80 * clamp((up + dn) / 0.070, 0.0, 1.0));
  col *= 1.0 - 0.30 * clamp(aoK, 0.0, 1.0) * muz;

  // the crease the lower lip throws on the chin, deepening as the jaw opens
  float cy = (yB - m.y) - (0.012 + 0.020 * uMouth.x);
  col *= 1.0 - 0.24 * (1.0 - palCov(abs(cy) - 0.0018)) * palThin(0.0036) * (0.30 + 0.70 * uMouth.x);

  // ── the interior sits on shallow planes behind the lip; sampling it straight
  // at m makes the mouth a decal the moment the head turns.
  float Vz  = max(Vl.z, 0.22);
  vec2  par = -palRot2(Vl.xy, uMouth4.w) / Vz;
  float grz = palStep(0.15, 0.45, Vl.z);

  if (inAp > 0.002) {
    vec3 cav = mix(uCavMid, uCavDeep, palStep(0.20, 0.95, 1.0 - cT));
    cav *= 1.0 - 0.45 * palStep(0.62, 1.00, 1.0 - cT);       // the soft palate
    cav += uCavWarm * (0.14 * cT * cT);                      // bounce off the tongue
    cav *= 0.88 + 0.12 * (1.0 - clamp(abs(u), 0.0, 1.0));    // the corners recede
    cav *= 0.42 + 0.95 * lum;
    cav  = mix(cav, uLipDark * (0.55 + 0.7 * lum), uMouth.w * 0.8);
    col  = mix(col, cav, inAp);
    // Subsurface warmth in the first 1.4 mm inside the rim — cheap, and the
    // single biggest "flesh, not hole" cue there is.
    col = mix(col, uSSSCol * (0.50 + 0.90 * lum), (1.0 - palStep(0.0, 0.014, dIn)) * inAp * 0.55);
    palCavM = inAp;
    // How shadowed this fragment is by the mouth itself, deepest under the upper
    // lip where the throat is. Albedo alone cannot make a cavity read: the bowl's
    // own normal still faces the key light, so a dark colour comes back lit and
    // the whole interior washes out to a pale card.
    palOccM = inAp * (0.74 + 0.26 * (1.0 - cT));
  }

  // ── ONE continuous upper tooth band, never a set. She is a noseless lavender
  // blob, so full dentition reads as threat; but without a bright near surface an
  // open mouth is a flat dark blob and every vowel looks the same. W swings 2.8×
  // between OO and a wide EE, so individual teeth would stretch — the canonical
  // rubber-teeth tell — and at 75 px of mouth each one is a 12 px edge that
  // shimmers under minification.
  float teethOn = uMouth4.z * palStep(0.020, 0.055, up + dn)
                * (1.0 - uMouth.w) * (0.74 + 0.26 * uMouth.y);
  // F and V are the one closed shape that must still show teeth: the upper lip
  // rolls back and the incisors rest on the lower lip. Without this every
  // labiodental in the language collapses into the same pressed mouth as M.
  float biteOn = uMouth4.z * uMouth5.w * (1.0 - palStep(0.030, 0.075, up + dn));
  if (teethOn > 0.002 || biteOn > 0.002) {
    vec2 mT = m + par * 0.013;
    float uT, y0T, dy0T, yTT, yBT, nET;
    palAper(mT, W, up, dn, s, eL, eR, uT, y0T, dy0T, yTT, yBT, nET);
    float tH   = (0.010 + 0.020 * (uMouth.x + max(uMouth2.x, 0.0) * 0.5)) * (1.0 - 0.45 * uMouth.z);
    float arch = (0.55 + 0.45 * nET) * (1.0 - palStep(0.70, 0.96, abs(uT)));
    float td   = min(mT.y - (yTT - tH * arch), yTT + 0.004 - mT.y);
    float bite = palCov(min(y0T + 0.011 * arch - mT.y, mT.y - y0T + 0.001));
    float tm   = max(palCov(td) * inAp * grz * teethOn, bite * biteOn);
    // Enamel is the brightest thing in the mouth and it has to survive being lit
    // by the bowl's own inward-facing normal, so it carries a floor of its own.
    vec3  tc = uToothCol * (0.70 + 0.60 * lum) * (0.78 + 0.22 * palStep(yTT, yTT - tH, mT.y));
    tc *= 1.0 - 0.30 * (1.0 - palStep(0.0, 0.010, yTT - mT.y));   // the upper lip's shelf shadow
    float notch = (1.0 - palCov(abs(mT.x - PAL_MA.x) - 0.0010)) * palThin(0.0018) * 0.20;
    col = mix(col, tc * (1.0 - notch), tm);
    palTeethM = tm;

    // a hint of lower teeth only on a big grin — a real cartoon convention
    float lo = palCov(min((yBT + (0.006 + 0.010 * uMouth.x) * arch) - mT.y, mT.y - yBT))
             * inAp * grz * teethOn * 0.55 * max(uMouth2.x, 0.0) * uMouth.y;
    col = mix(col, uToothCol * (0.45 + 0.68 * lum) * 0.86, lo);
    palTeethM = max(palTeethM, lo);
  }

  // ── the tongue. L, TH, N, D and T are identified BY the tongue; text-driven
  // lip sync without one reads as a flapping hole.
  float tn = uMouth2.z, tip = uMouth3.x;
  if ((tn > 0.02 || tip > 0.02) && (up + dn) > 0.010) {
    vec2 mG = m + par * 0.030;
    float uG, y0G, dy0G, yTG, yBG, nEG;
    palAper(mG, W, up, dn, s, eL, eR, uG, y0G, dy0G, yTG, yBG, nEG);
    float cu = clamp(uG / 0.88, -1.0, 1.0);
    float dome = sqrt(max(0.0, 1.0 - cu * cu));
    float tTop = yBG + (yTG - yBG) * (0.16 + 0.46 * tn) * dome + 0.026 * tip * dome;
    float tm   = palCov(min(tTop - mG.y, mG.y - (yBG - 0.006)))
               * max(inAp * grz, tip * (1.0 - palCov(-dIn - 0.010)));
    vec3 tc = mix(uTongueCol, uTongueTip, palStep(0.30, 1.00, dome * (1.0 - abs(uG))));
    tc *= 0.72 + 0.28 * palStep(yBG, tTop, mG.y);                 // dark at the root
    tc *= 1.0 - 0.16 * (1.0 - palStep(0.0, 0.14, abs(uG)));       // the centre groove
    tc *= 0.40 + 0.80 * lum;
    col = mix(col, tc, tm);
    // the wet highlight is what makes it a tongue and not a pink card
    float gl = (1.0 - palCov(abs(mG.y - (tTop - 0.009)) - 0.0020)) * palThin(0.0040)
             * (1.0 - palStep(0.20, 0.75, abs(uG - 0.12))) * tm;
    col += vec3(1.0, 0.94, 0.95) * (gl * 0.22 * lum);
    palTongueM = tm;
  }

  // ── the lips. The lip line is the strongest graphic element on the face, and a
  // constant-width stroke is exactly what makes a procedural mouth look procedural.
  float upper = palStep(-0.004, 0.004, m.y - y0u);
  float lipH  = mix(dn + tD, up + tU, upper);
  float ap    = mix(dn, up, upper) / max(lipH, 1e-4);
  float bandU = clamp((clamp(abs(m.y - y0u) / max(lipH, 1e-4), 0.0, 1.0) - ap)
                      / max(1.0 - ap, 1e-3), 0.0, 1.0);
  vec3 lip = uLipCol;
  lip = mix(lip, uLipDark, palStep(0.55, 1.00, bandU) * 0.85);    // the vermilion border
  lip = mix(lip, uLipDark, palStep(0.25, 0.00, bandU) * 0.55);    // the roll into the mouth
  lip = mix(lip, uLipDark, upper * uMouth5.w * 0.50);             // the tucked upper lip
  float wet = palStep(0.30, 0.54, bandU) * (1.0 - palStep(0.70, 0.96, bandU))
            * (1.0 - palStep(0.0, 0.5, (m.y - y0u) / max(dn + tD, 1e-4)))
            * (1.0 - palStep(0.30, 0.85, abs(u - 0.15)))          // offset to the key light
            * (0.35 + 0.65 * open01);
  lip = mix(lip, uLipLight, wet * 0.26);
  col = mix(col, lip * (0.40 + 0.75 * lum), lipB);
  palLipM = lipB;

  // the rim contour, with an animator's weight distribution: heavier along the
  // upper lip and at the corners, lighter under the lower lip.
  float wProf = 1.0 + 0.34 * upper * max(0.0, 1.0 - abs(u) / 0.45)
                    + 0.55 * palStep(0.62, 1.00, abs(u))
                    - 0.28 * (1.0 - upper) * max(0.0, 1.0 - abs(u) / 0.55);
  float rimW = max(0.0022 * wProf, palPx * 1.20);
  col = mix(col, uLipDark * (0.40 + 0.75 * lum),
            (1.0 - palCov(abs(dOut) - rimW)) * palThin(2.0 * rimW));

  // the closed seam: a crisp line with a lit ledge under it
  float seamW = 0.0016 + 0.0016 * uMouth.w;
  float ds = abs(m.y - y0u) * inversesqrt(1.0 + dy0 * dy0);
  float sl = (1.0 - palCov(ds - seamW)) * (1.0 - open01) * (1.0 - palStep(1.0, 1.20, abs(u)))
           * palThin(2.0 * seamW);
  col  = mix(col, uLipDark * (0.55 + 0.6 * lum), sl * 0.90);
  col *= 1.0 + 0.16 * palBand(m.y - y0u, -(seamW + 0.0035), -(seamW + 0.0006)) * (1.0 - open01);

  // corner dimple and smile crease — what makes a big grin read as a grin
  float cs = 0.35 + 0.65 * max(uMouth2.x, 0.0) + 0.30 * uMouth.y + 0.25 * uMouth.w;
  for (int i = 0; i < 2; i++) {
    float sd = (i == 0) ? -1.0 : 1.0;
    vec2  c2 = vec2(sd * (W + tS * 0.5), (i == 0) ? eL : eR);
    vec2  d2 = (m - c2) / vec2(0.020, 0.014);
    float dim = 1.0 - palStep(0.30, 1.05, length(d2));
    float cx  = (m.x - c2.x) * sd;
    float cyv = (m.y - c2.y) - (0.42 * cx + 4.5 * cx * cx);       // the crease arcs up and out
    float crs = (1.0 - palCov(abs(cyv) - 0.0018)) * palThin(0.0037)
              * palStep(0.0, 0.008, cx) * (1.0 - palStep(0.010, 0.048, cx));
    col *= 1.0 - 0.26 * (dim * 0.70 + crs) * cs * muz;
  }
}

// -> vec3(lid coverage, fold line, contact shadow)
vec3 palLidOne(vec3 rest, vec3 c, vec3 gaze, float r) {
  vec3 d = rest - c;
  float dist = length(d);
  float shell = 1.0 - palStep(0.158, 0.190, dist);
  if (shell <= 0.0) return vec3(0.0);
  float ca = dot(d / max(dist, 1e-5), gaze);
  float inEye = shell * palStep(0.18, 0.32, ca);
  if (inEye <= 0.01) return vec3(0.0);

  vec3 q = palLocal(d);
  float x = clamp(q.x / r, -1.0, 1.0);
  float h = q.y / r + uLidF.z * (1.0 - x * x);
  float ue = 1.30 - uLidF.x * 2.60;
  float le = -1.30 + uLidF.y * 2.60;

  float cU = palStep(ue - 0.055, ue + 0.055, h);
  float cL = palStep(le + 0.055, le - 0.055, h);
  float cover = min(1.0, cU + cL) * inEye;

  float uc = max(ue, -0.06);
  float lc = min(le, -0.20);
  float taper = 1.0 - palStep(0.62, 0.99, abs(x));
  float kU = (1.0 - palStep(0.05, 0.125, abs(h - uc))) * palStep(0.05, 0.18, uLidF.x);
  float kL = (1.0 - palStep(0.04, 0.10, abs(h - lc))) * palStep(0.12, 0.32, uLidF.y);
  float crease = min(1.0, kU + kL) * inEye * taper;

  float shade = (1.0 - palStep(0.0, 0.40, abs(h - ue))) * (1.0 - cU) * palStep(0.03, 0.25, uLidF.x) * inEye;
  return vec3(cover, crease, shade);
}
`;

export type PalUniforms = Record<string, THREE.IUniform>;

function replaceOnce(src: string, token: string, next: string, label: string) {
  if (!src.includes(token)) {
    console.warn(`[pal] shader chunk "${label}" not found — this three.js build may differ`);
    return src;
  }
  return src.replace(token, next);
}

export function createPalUniforms(): PalUniforms {
  return {
    uFaceR: { value: v3(FACE_R) },
    uFaceU: { value: v3(FACE_U) },
    uFaceF: { value: v3(FACE_F) },
    uFaceRb: { value: v3(FACE_R) },
    uFaceUb: { value: v3(FACE_U) },
    uFaceFb: { value: v3(FACE_F) },
    uEyeC0: { value: v3(EYES[0].centre) },
    uEyeC1: { value: v3(EYES[1].centre) },
    uEyeD0: { value: v3(EYES[0].rest) },
    uEyeD1: { value: v3(EYES[1].rest) },
    uEyeR: { value: new THREE.Vector2(EYES[0].radius, EYES[1].radius) },
    uEyeLook: { value: new THREE.Vector2(0, 0) },
    uEyeWiden: { value: 0 },
    uLid: { value: new THREE.Vector2(0, 0) },
    uLidF: { value: new THREE.Vector3(0, 0, 0) },
    uMouthC: { value: v3(MOUTH) },
    uMouth: { value: new THREE.Vector4(0, 0, 0, 0) },
    uMouth2: { value: new THREE.Vector4(0.22, 0, 0.25, 0) },
    uMouth3: { value: new THREE.Vector4(0, 0, 0, 0) },
    uMouth4: { value: new THREE.Vector4(0, 0, 0.85, 0.04) },
    uMouth5: { value: new THREE.Vector4(0, 0, 0, 0) },
    // The camera in the rest-pose face frame. Without the un-lean the whole
    // interior swims whenever she leans, because the lean happens in the shader.
    uCamL: { value: new THREE.Vector3(0, 0.05, 4.06) },
    uBrow0: { value: v3(BROWS[0] ?? [0, 0, 0]) },
    uBrow1: { value: v3(BROWS[1] ?? [0, 0, 0]) },
    uBrowP: { value: new THREE.Vector2(0, 0) },
    uArmLS: { value: v3(ARM_L.shoulder) },
    uArmLD: { value: v3(ARM_L_DIR) },
    uArmRS: { value: v3(ARM_R.shoulder) },
    uArmRD: { value: v3(ARM_R_DIR) },
    uArmL: { value: new THREE.Vector4(0, 1, 0, 0) },
    uArmR: { value: new THREE.Vector4(0, 1, 0, 0) },
    uArmW: { value: new THREE.Vector4(ARM_L_LEN, ARM_R_LEN, 0, 0) },
    uHead: { value: new THREE.Vector4(0, 1, 0, 0) },
    uHeadP: { value: v3(HEAD_PIVOT) },
    uHeadRamp: { value: new THREE.Vector2(HEAD_RAMP[0], HEAD_RAMP[1]) },
    uCrown: { value: new THREE.Vector4(0, 1, 0, 0) },
    uCrownP: { value: new THREE.Vector4(CROWN_PIVOT[0], CROWN_PIVOT[1], CROWN_PIVOT[2], 0) },
    uBody: { value: new THREE.Vector4(0, 1, 0, 0) },
    uHip: { value: v3(HIP) },
    uDyn: { value: new THREE.Vector4(0, 0, 0, GROUND_Y) },
    uSlosh: { value: new THREE.Vector4(0, 0, 0, COM[1]) },
    uFeet: { value: new THREE.Vector4(0.5, 0.5, FOOT_SPLIT_X, SOLE_H) },
    uPoke: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPokeD: { value: new THREE.Vector4(0, 0, 1, 0.3) },
    uBlush0: { value: v3(BLUSH[0] ?? [0, 0, 0]) },
    uBlush1: { value: v3(BLUSH[1] ?? [0, 0, 0]) },
    uLidCol: { value: new THREE.Color(SKIN_HEX) },
    // Never black anywhere in here: ACES at exposure 1.05 crushes a dark cavity
    // to a featureless void on a pale lavender character.
    uCavDeep: { value: new THREE.Color("#2a1230") },
    uCavMid: { value: new THREE.Color("#5a2b3c") },
    uCavWarm: { value: new THREE.Color("#8a3c46") },
    uSSSCol: { value: new THREE.Color("#a8536a") },
    uToothCol: { value: new THREE.Color("#ece2e8") },
    uTongueCol: { value: new THREE.Color("#b56676") },
    uTongueTip: { value: new THREE.Color("#cd7d8a") },
    uLipCol: { value: new THREE.Color("#7a4f63") },
    uLipDark: { value: new THREE.Color("#4a2a40") },
    uLipLight: { value: new THREE.Color("#b98ea3") },
    uCreaseCol: { value: new THREE.Color(CREASE_HEX) },
    uBlushCol: { value: new THREE.Color("#f0879f") },
    uRimCol: { value: new THREE.Color("#c4a6ff") },
    uFx: { value: new THREE.Vector2(0.35, 0) },
  };
}

/** Patch a standard material so it carries the whole rig. */
export function attachPalRig(material: THREE.MeshStandardMaterial, uniforms: PalUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    let v = shader.vertexShader;
    v = replaceOnce(
      v,
      "#include <common>",
      `#include <common>\n${COMMON_GLSL}\n${VERTEX_GLSL}`,
      "vertex/common",
    );
    // The deformation has to run before <defaultnormal_vertex> consumes objectNormal.
    v = replaceOnce(
      v,
      "#include <beginnormal_vertex>",
      `vec3 palPos = position;
       vec3 palNor = normal;
       palDeform(position, palPos, palNor);
       vPalNM = palFaceNM();
       vec3 objectNormal = palNor;
       #ifdef USE_TANGENT
         vec3 objectTangent = vec3( tangent.xyz );
       #endif`,
      "vertex/beginnormal",
    );
    v = replaceOnce(
      v,
      "#include <begin_vertex>",
      `vec3 transformed = palPos;\n       vPalRest = position;`,
      "vertex/begin",
    );
    shader.vertexShader = v;

    let f = shader.fragmentShader;
    f = replaceOnce(
      f,
      "#include <common>",
      `#include <common>\n${COMMON_GLSL}\n${FRAGMENT_GLSL}`,
      "fragment/common",
    );
    f = replaceOnce(
      f,
      "#include <map_fragment>",
      `#include <map_fragment>
       {
         vec3 lid = max(palLidOne(vPalRest, uEyeC0, uEyeD0, uEyeR.x),
                        palLidOne(vPalRest, uEyeC1, uEyeD1, uEyeR.y));
         diffuseColor.rgb *= 1.0 - 0.42 * lid.z;
         diffuseColor.rgb = mix(diffuseColor.rgb, uLidCol * (1.0 - 0.12 * lid.y), lid.x);
         diffuseColor.rgb = mix(diffuseColor.rgb, uCreaseCol, lid.y);

         vec3 palCol = diffuseColor.rgb;
         palMouthPaint(vPalRest, palCol);
         diffuseColor.rgb = palCol;

         if (uFx.y > 0.001) {
           float b = max(1.0 - palStep(0.05, 0.18, distance(vPalRest, uBlush0)),
                         1.0 - palStep(0.05, 0.18, distance(vPalRest, uBlush1)));
           diffuseColor.rgb = mix(diffuseColor.rgb, uBlushCol, b * uFx.y * 0.6);
         }
       }`,
      "fragment/map",
    );
    // With the relief normal below, these give the tongue a real moving specular
    // and the lower lip a real rolling highlight, both tracking the head turn.
    f = replaceOnce(
      f,
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
       roughnessFactor = mix(roughnessFactor, 0.80, palCavM * 0.65);
       roughnessFactor = mix(roughnessFactor, 0.44, palTongueM * 0.90);
       roughnessFactor = mix(roughnessFactor, 0.32, palTeethM * 0.85);
       roughnessFactor = mix(roughnessFactor, 0.26, palLipM * 0.70);`,
      "fragment/roughness",
    );
    // Geometry carries the low-frequency shape, the fragment carries the crisp
    // lip roll. The differencing step is tied to the pixel footprint, so the
    // normal is pre-filtered for free: the rim never shimmers when she is small.
    f = replaceOnce(
      f,
      "#include <normal_fragment_begin>",
      `#include <normal_fragment_begin>
       if (palMuzW > 0.002) {
         float h = max(0.0018, 0.90 * palPx);
         vec2 g = vec2(palRelief(palMouthM + vec2(h, 0.0)) - palRelief(palMouthM - vec2(h, 0.0)),
                       palRelief(palMouthM + vec2(0.0, h)) - palRelief(palMouthM - vec2(0.0, h)))
                / (2.0 * h);
         g = palRot2i(g, uMouth4.w);
         vec3 nf = vec3(dot(normal, vPalNM[0]), dot(normal, vPalNM[1]), dot(normal, vPalNM[2]));
         nf.xy -= g * nf.z;
         normal = normalize(mix(normal, normalize(vPalNM * normalize(nf)), palMuzW));
       }`,
      "fragment/normal",
    );
    // Without the cavity guard the fresnel lights the lip crease at glancing
    // angles and the whole mouth glows.
    f = replaceOnce(
      f,
      "#include <opaque_fragment>",
      `{
         float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
         outgoingLight += uRimCol * (fres * (uFx.x + uFx.y * 0.12)) * (1.0 - 0.85 * palCavM);
         // Enamel keeps most of its light — it is the one bright surface in there,
         // and it is what gives an open mouth its scale.
         outgoingLight *= 1.0 - 0.66 * palOccM * (1.0 - 0.95 * palTeethM);
       }
       #include <opaque_fragment>`,
      "fragment/opaque",
    );
    shader.fragmentShader = f;
  };
  // Bumping this is what makes any of the above appear: three.js otherwise hands
  // back the cached v1 program and every new uniform silently reads zero.
  material.customProgramCacheKey = () => "pal-rig-v3";
  material.needsUpdate = true;
}

// writePose runs once a frame, so every temporary here is module scope.
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qHead = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _faceR = v3(FACE_R);
const _faceU = v3(FACE_U);
const _faceF = v3(FACE_F);
const _armLReach = v3(ARM_L_REACH);
const _armRReach = v3(ARM_R_REACH);
const _armLDir = v3(ARM_L_DIR);
const _armRDir = v3(ARM_R_DIR);
const _hip = v3(HIP);
const _headP = v3(HEAD_PIVOT);
const _mouthC = v3(MOUTH);
const _com = v3(COM);
const _ex = new THREE.Vector3(1, 0, 0);
const _ey = new THREE.Vector3(0, 1, 0);
const _ez = new THREE.Vector3(0, 0, 1);

/**
 * Three Euler rotations cost three Rodrigues and three sincos per vertex; one
 * composed axis-angle costs one of each, and it interpolates as a proper
 * geodesic across the weight ramp instead of as three stacked shears.
 */
function writeAxisAngle(out: THREE.Vector4, q: THREE.Quaternion) {
  const w = Math.min(1, Math.max(-1, q.w));
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-6) {
    out.set(0, 1, 0, 0);
    return;
  }
  out.set(q.x / s, q.y / s, q.z / s, 2 * Math.acos(w));
}

/** Push one frame of the performance into the GPU uniforms. */
export function writePose(u: PalUniforms, p: PalPose) {
  (u["uEyeLook"]!.value as THREE.Vector2).set(p.eyeYaw, p.eyePitch);
  u["uEyeWiden"]!.value = p.eyeWiden;
  (u["uLid"]!.value as THREE.Vector2).set(p.lidUpper, p.lidLower);
  (u["uLidF"]!.value as THREE.Vector3).set(p.lidUpper, p.lidLower, p.lidCurve);
  (u["uBrowP"]!.value as THREE.Vector2).set(p.browRaise, p.browAngle);

  (u["uMouth"]!.value as THREE.Vector4).set(p.jawOpen, p.mouthWide, p.mouthRound, p.mouthPress);
  (u["uMouth2"]!.value as THREE.Vector4).set(p.smile, p.sneer, p.tongueUp, p.lipOpen);
  (u["uMouth3"]!.value as THREE.Vector4).set(p.tongueTip, p.mouthShiftX, p.mouthShiftY, p.loud);
  (u["uMouth4"]!.value as THREE.Vector4).set(p.cornerL, p.cornerR, p.teethShow, p.mouthRoll);
  (u["uMouth5"]!.value as THREE.Vector4).set(p.funnel, p.cheekPuff, p.tension, p.tuck);

  _q.setFromAxisAngle(_faceU, p.headYaw);
  _q.multiply(_q2.setFromAxisAngle(_faceR, p.headPitch));
  _q.multiply(_q2.setFromAxisAngle(_faceF, p.headTilt));
  _qHead.copy(_q);
  writeAxisAngle(u["uHead"]!.value as THREE.Vector4, _q);

  _q.setFromAxisAngle(_faceU, p.crownYaw);
  _q.multiply(_q2.setFromAxisAngle(_faceR, p.crownPitch));
  _q.multiply(_q2.setFromAxisAngle(_faceF, p.crownTilt));
  writeAxisAngle(u["uCrown"]!.value as THREE.Vector4, _q);
  (u["uCrownP"]!.value as THREE.Vector4).w = p.crownLagY;

  _q.setFromAxisAngle(_ey, p.leanY);
  _q.multiply(_q2.setFromAxisAngle(_ex, p.leanX));
  _q.multiply(_q2.setFromAxisAngle(_ez, p.roll));
  writeAxisAngle(u["uBody"]!.value as THREE.Vector4, _q);

  // The face frame the fragment stage shades the relief in. palDeform turns the
  // head first and leans the body second, so the composition is body∘head — and
  // it is one value for the whole draw, not something to rebuild per vertex.
  _q.multiply(_qHead);
  (u["uFaceRb"]!.value as THREE.Vector3).copy(_faceR).applyQuaternion(_q);
  (u["uFaceUb"]!.value as THREE.Vector3).copy(_faceU).applyQuaternion(_q);
  (u["uFaceFb"]!.value as THREE.Vector3).copy(_faceF).applyQuaternion(_q);

  // Both arms swing about the shared FACE_F, so lift is mirrored in the geometry.
  // The sign flip lives here and nowhere else: +lift always raises the hand.
  _q.setFromAxisAngle(_faceF, -p.armLLift);
  _q.multiply(_q2.setFromAxisAngle(_armLReach, p.armLReach));
  _q.multiply(_q2.setFromAxisAngle(_armLDir, p.armLTwist));
  writeAxisAngle(u["uArmL"]!.value as THREE.Vector4, _q);
  _q.setFromAxisAngle(_faceF, p.armRLift);
  _q.multiply(_q2.setFromAxisAngle(_armRReach, p.armRReach));
  _q.multiply(_q2.setFromAxisAngle(_armRDir, p.armRTwist));
  writeAxisAngle(u["uArmR"]!.value as THREE.Vector4, _q);
  (u["uArmW"]!.value as THREE.Vector4).set(ARM_L_LEN, ARM_R_LEN, -p.armLWrist, p.armRWrist);

  (u["uDyn"]!.value as THREE.Vector4).set(p.squash, p.breathe, p.airborne, GROUND_Y);
  (u["uSlosh"]!.value as THREE.Vector4).set(p.jiggleX, p.jiggleZ, p.sway, COM[1]);
  (u["uFeet"]!.value as THREE.Vector4).set(p.footL, p.footR, FOOT_SPLIT_X, SOLE_H);

  (u["uPoke"]!.value as THREE.Vector4).set(p.pokeX, p.pokeY, p.pokeZ, p.pokeAmt);
  if (p.pokeAmt > 1e-4) {
    // A blob has no surface normal to hand us, but the outward radial from the
    // centroid is one to within a few degrees anywhere on a shape this round.
    _axis.set(p.pokeX - _com.x, p.pokeY - _com.y, p.pokeZ - _com.z);
    if (_axis.lengthSq() < 1e-8) _axis.set(0, 0, 1);
    _axis.normalize();
    (u["uPokeD"]!.value as THREE.Vector4).set(_axis.x, _axis.y, _axis.z, 0.22 + 1.6 * p.pokeAmt);
  }

  (u["uFx"]!.value as THREE.Vector2).set(p.rim, p.blushBoost);
}

/**
 * The camera as the rest-pose face sees it, for the interior parallax. The head
 * turn and the body lean both happen in the shader and the face rides both at
 * weight 1, so they are undone here rather than guessed at.
 */
export function writeCamera(u: PalUniforms, camWorld: THREE.Vector3, liftY: number) {
  const body = u["uBody"]!.value as THREE.Vector4;
  const head = u["uHead"]!.value as THREE.Vector4;
  _cam.set(camWorld.x, camWorld.y - liftY, camWorld.z);
  if (Math.abs(body.w) > 1e-4) {
    _q.setFromAxisAngle(_axis.set(body.x, body.y, body.z), -body.w);
    _cam.sub(_hip).applyQuaternion(_q).add(_hip);
  }
  if (Math.abs(head.w) > 1e-4) {
    _q.setFromAxisAngle(_axis.set(head.x, head.y, head.z), -head.w);
    _cam.sub(_headP).applyQuaternion(_q).add(_headP);
  }
  _cam.sub(_mouthC);
  (u["uCamL"]!.value as THREE.Vector3).set(_cam.dot(_faceR), _cam.dot(_faceU), _cam.dot(_faceF));
}
