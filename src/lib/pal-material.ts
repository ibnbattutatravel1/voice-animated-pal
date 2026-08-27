import * as THREE from "three";

import {
  ARM_L,
  ARM_L_DIR,
  ARM_L_LEN,
  ARM_R,
  ARM_R_DIR,
  ARM_R_LEN,
  BLUSH,
  BROWS,
  CREASE_HEX,
  EYES,
  FACE_F,
  FACE_R,
  FACE_U,
  GROUND_Y,
  HIP,
  MOUTH,
  SKIN_HEX,
  type PalPose,
  type Vec3,
} from "./pal-rig";

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);

/**
 * The Pal has no bones, so the whole performance is a set of analytic region
 * deformers evaluated per-vertex on the GPU:
 *
 *   eyes   — each eyeball is rotated about its fitted centre of curvature, which
 *            leaves |p - centre| unchanged. The silhouette is therefore exactly
 *            preserved and only the painted iris slides across the surface: a
 *            genuine eye rotation rather than a texture trick.
 *   mouth  — NOT deformed. The smile, lips and tongue are baked into the albedo,
 *            so deforming geometry to open it stretched that artwork into a
 *            rubbery mess and it could never actually close for M/B/P. It is
 *            erased and redrawn procedurally in the fragment stage instead, from
 *            two lip curves driven by the viseme channels. The vertex stage only
 *            carves a smooth bowl so an open mouth has real depth.
 *   brows  — local skin displacement along the face's up axis.
 *   arms   — capsule-weighted rotation about each shoulder.
 *   body   — height-weighted shear about the hip (a blob leans, it doesn't bend)
 *            then squash & stretch and a travelling jelly wave, both faded out at
 *            the feet so they stay planted on the ground.
 *
 * Eyelids are painted in the fragment stage from the *rest* position, so they
 * stay locked to the eye no matter how the body is deformed.
 */

/** Shared by both stages: the face frame plus a smoothstep that tolerates e0 > e1. */
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
uniform vec4 uMouth;
uniform float uSmile;

// quadratic fit of the face skin around the mouth, in the face frame
const vec3 PAL_FIT_A = vec3(0.1293, 0.00107, -0.24845);
const vec3 PAL_FIT_B = vec3(-0.81492, -0.11998, -0.21588);
const float PAL_MOUTH_Y = -0.010;

float palStep(float e0, float e1, float x) {
  float d = e1 - e0;
  float t = clamp((x - e0) / (abs(d) < 1e-6 ? 1e-6 : d), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec3 palLocal(vec3 v) { return vec3(dot(v, uFaceR), dot(v, uFaceU), dot(v, uFaceF)); }
vec3 palWorld(vec3 q) { return uFaceR * q.x + uFaceU * q.y + uFaceF * q.z; }

// The lip curves. Everything about the mouth's silhouette comes from these four
// numbers, so the vertex and fragment stages stay in exact agreement.
void palMouthShape(out float hw, out float upOpen, out float dnOpen, out float arc) {
  hw = 0.101 * (1.0 + uMouth.y * 0.34 - uMouth.z * 0.44);
  float press = uMouth.w;
  upOpen = (0.018 + uMouth.x * 0.048) * (1.0 - press);
  dnOpen = (0.045 + uMouth.x * 0.105) * (1.0 - press);
  arc = 0.010 + uSmile * 0.028;
}

// 0 on the face, 1 deep inside the mouth pocket that is baked into the mesh.
float palPocket(vec3 q) {
  float zs = PAL_FIT_A.x + PAL_FIT_A.y * q.x + PAL_FIT_A.z * q.y
           + PAL_FIT_B.x * q.x * q.x + PAL_FIT_B.y * q.x * q.y + PAL_FIT_B.z * q.y * q.y;
  return palStep(0.016, 0.055, zs - q.z);
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
uniform vec4 uArm;
uniform vec4 uBody;
uniform vec4 uDyn;
uniform vec3 uHip;
varying vec3 vPalRest;

vec3 palRot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
vec3 palRotP(vec3 p, vec3 piv, vec3 k, float a) { return piv + palRot(p - piv, k, a); }

void palEye(inout vec3 p, inout vec3 n, vec3 c, vec3 rest) {
  vec3 d = p - c;
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

// The mouth is not deformed at all: the smile, lips and tongue are painted into
// the albedo, so any jaw motion smeared them and it could never actually close.
// It is drawn procedurally in the fragment stage instead. The only geometry left
// here is a smooth bowl that carves real depth where the drawn mouth extends past
// the mesh's own pocket, so an open mouth catches genuine shading.
void palMouthDent(inout vec3 p) {
  vec3 q = palLocal(p - uMouthC);
  if (length(vec2(q.x / 0.150, q.y / 0.120)) >= 1.3) return;
  float hw, up, dn, arc;
  palMouthShape(hw, up, dn, arc);
  float span = up + dn;
  float spanEff = max(span, 0.02);
  float br = length(vec2(q.x / (hw * 1.15), (q.y - PAL_MOUTH_Y) / (spanEff * 0.85 + 0.015)));
  float bowl = 1.0 - palStep(0.15, 1.0, br);
  if (bowl <= 0.001) return;
  p -= uFaceF * (span * 0.45 * bowl * (1.0 - palPocket(q)));
}

void palBrow(inout vec3 p, vec3 b, float side) {
  float w = 1.0 - palStep(0.10, 0.26, length(p - b));
  if (w <= 0.001) return;
  p += uFaceU * ((uBrowP.x * 0.055 + uBrowP.y * 0.035 * side) * w);
}

void palArm(inout vec3 p, inout vec3 n, vec3 s, vec3 dir, float armLen, float ang) {
  if (abs(ang) < 1e-4) return;
  vec3 v = p - s;
  float along = dot(v, dir);
  if (along < -0.05 || along > armLen + 0.24) return;
  float perp = length(v - dir * along);
  float w = palStep(-0.02, armLen * 0.70, along) * (1.0 - palStep(0.17, 0.34, perp));
  if (w <= 0.001) return;
  p = palRotP(p, s, uFaceF, ang * w);
  n = palRot(n, uFaceF, ang * w);
}

void palBody(inout vec3 p, inout vec3 n) {
  float hw = palStep(-0.60, 0.45, p.y);
  if (hw > 0.001) {
    if (abs(uBody.y) > 1e-4) { p = palRotP(p, uHip, vec3(0.0, 1.0, 0.0), uBody.y * hw); n = palRot(n, vec3(0.0, 1.0, 0.0), uBody.y * hw); }
    if (abs(uBody.x) > 1e-4) { p = palRotP(p, uHip, vec3(1.0, 0.0, 0.0), uBody.x * hw); n = palRot(n, vec3(1.0, 0.0, 0.0), uBody.x * hw); }
    if (abs(uBody.z) > 1e-4) { p = palRotP(p, uHip, vec3(0.0, 0.0, 1.0), uBody.z * hw); n = palRot(n, vec3(0.0, 0.0, 1.0), uBody.z * hw); }
  }

  float ground = uDyn.w;
  float plant = palStep(ground + 0.02, ground + 0.30, p.y);
  float sy = 1.0 + uDyn.x + uBody.w * 0.014;
  float sxz = 1.0 - uDyn.x * 0.45 - uBody.w * 0.010;
  p.x *= 1.0 + (sxz - 1.0) * plant;
  p.z *= 1.0 + (sxz - 1.0) * plant;
  p.y = ground + (p.y - ground) * (1.0 + (sy - 1.0) * plant);

  if (uDyn.y > 0.0001) {
    float ph = p.y * 4.2 - uDyn.z * 6.0;
    p.x += sin(ph) * uDyn.y * plant;
    p.z += cos(ph * 0.85) * uDyn.y * 0.6 * plant;
  }
}

void palDeform(inout vec3 p, inout vec3 n) {
  palEye(p, n, uEyeC0, uEyeD0);
  palEye(p, n, uEyeC1, uEyeD1);
  palMouthDent(p);
  palBrow(p, uBrow0, -1.0);
  palBrow(p, uBrow1, 1.0);
  palArm(p, n, uArmLS, uArmLD, uArm.z, uArm.x);
  palArm(p, n, uArmRS, uArmRD, uArm.w, uArm.y);
  palBody(p, n);
  n = normalize(n);
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
uniform vec4 uFx;
uniform vec3 uSkinCol;
uniform vec3 uCavityCol;
uniform vec3 uTongueCol;
uniform vec3 uLipCol;
varying vec3 vPalRest;

// erase: how much baked mouth artwork to wipe back to skin
// cavity/tongue/lip: the mouth we draw instead
// shade: darker toward the roof of the mouth | aoc: contact shadow above the lip
void palMouthPaint(vec3 rest, out float erase, out float cavity, out float tongue,
                   out float lip, out float shade, out float aoc) {
  erase = 0.0; cavity = 0.0; tongue = 0.0; lip = 0.0; shade = 0.0; aoc = 0.0;
  vec3 q = palLocal(rest - uMouthC);
  if (abs(q.x) > 0.40 || abs(q.y) > 0.40 || q.z < -0.22) return;

  float e = length(vec2(q.x / 0.150, (q.y + 0.010) / 0.118));
  float win = 1.0 - palStep(0.80, 1.06, e);
  float pk = palPocket(q) * (1.0 - palStep(1.0, 1.28, e));
  erase = win * (1.0 - pk);   // never repaint the pocket as skin

  float hw, up, dn, arc;
  palMouthShape(hw, up, dn, arc);
  float y = q.y - PAL_MOUTH_Y;
  float X = q.x / hw;
  float cap = pow(max(0.0, 1.0 - X * X), 0.62);
  float seam = arc * X * X;
  float yT = seam + up * cap;
  float yB = seam - dn * cap;

  float dIn = min(hw - abs(q.x), min(yT - y, y - yB));
  float aa = 0.0030;
  float open = clamp((dIn + aa) / (2.0 * aa), 0.0, 1.0);
  cavity = max(open, pk);
  lip = (1.0 - palStep(0.0, 0.0105, abs(dIn))) * (1.0 - palStep(1.0, 1.18, abs(X)));

  float tongueH = min(dn * 0.58, 0.048);
  float tTop = yB + tongueH * sqrt(max(0.0, 1.0 - X * X));
  tongue = open * clamp((tTop - y + aa) / (2.0 * aa), 0.0, 1.0) * palStep(0.030, 0.062, dn);
  shade = open * (1.0 - clamp((y - yB) / max(1e-4, yT - yB), 0.0, 1.0));

  float above = y - yT;
  aoc = (1.0 - open) * (1.0 - palStep(0.0, 0.055, above)) * palStep(-0.02, 0.0, above)
      * (1.0 - palStep(0.85, 1.25, abs(X)));
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
    uSmile: { value: 0 },
    uBrow0: { value: v3(BROWS[0] ?? [0, 0, 0]) },
    uBrow1: { value: v3(BROWS[1] ?? [0, 0, 0]) },
    uBrowP: { value: new THREE.Vector2(0, 0) },
    uArmLS: { value: v3(ARM_L.shoulder) },
    uArmLD: { value: v3(ARM_L_DIR) },
    uArmRS: { value: v3(ARM_R.shoulder) },
    uArmRD: { value: v3(ARM_R_DIR) },
    uArm: { value: new THREE.Vector4(0, 0, ARM_L_LEN, ARM_R_LEN) },
    uBody: { value: new THREE.Vector4(0, 0, 0, 0) },
    uDyn: { value: new THREE.Vector4(0, 0, 0, GROUND_Y) },
    uHip: { value: v3(HIP) },
    uBlush0: { value: v3(BLUSH[0] ?? [0, 0, 0]) },
    uBlush1: { value: v3(BLUSH[1] ?? [0, 0, 0]) },
    uLidCol: { value: new THREE.Color(SKIN_HEX) },
    uSkinCol: { value: new THREE.Color("#a494b4") },
    uCavityCol: { value: new THREE.Color("#2a1f30") },
    uTongueCol: { value: new THREE.Color("#c9808e") },
    uLipCol: { value: new THREE.Color("#3a2a40") },
    uCreaseCol: { value: new THREE.Color(CREASE_HEX) },
    uBlushCol: { value: new THREE.Color("#f0879f") },
    uRimCol: { value: new THREE.Color("#c4a6ff") },
    uFx: { value: new THREE.Vector4(0.35, 0, 0, 0) },
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
       palDeform(palPos, palNor);
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
         float mErase, mCav, mTng, mLip, mShade, mAoc;
         palMouthPaint(vPalRest, mErase, mCav, mTng, mLip, mShade, mAoc);
         if (mErase > 0.001) {
           // Wipe only the mouth artwork — dark lips/cavity and the red tongue —
           // so the surrounding skin keeps its own baked shading and the patch
           // stays invisible.
           float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
           float art = max(1.0 - palStep(0.012, 0.10, lum),
                           palStep(0.03, 0.12, diffuseColor.r - diffuseColor.b));
           diffuseColor.rgb = mix(diffuseColor.rgb, uSkinCol, clamp(art, 0.0, 1.0) * mErase);
         }
         // pressed lips read as skin-in-shadow rather than an open cavity
         vec3 cavCol = mix(uCavityCol, uLipCol, uMouth.w * 0.75) * (0.55 + 0.45 * (1.0 - mShade));
         diffuseColor.rgb = mix(diffuseColor.rgb, cavCol, mCav);
         diffuseColor.rgb = mix(diffuseColor.rgb, uTongueCol, mTng);
         diffuseColor.rgb *= 1.0 - 0.30 * mAoc;
         diffuseColor.rgb = mix(diffuseColor.rgb, uLipCol, mLip);

         if (uFx.y > 0.001) {
           float b = max(1.0 - palStep(0.05, 0.18, distance(vPalRest, uBlush0)),
                         1.0 - palStep(0.05, 0.18, distance(vPalRest, uBlush1)));
           diffuseColor.rgb = mix(diffuseColor.rgb, uBlushCol, b * uFx.y * 0.6);
         }
       }`,
      "fragment/map",
    );
    f = replaceOnce(
      f,
      "#include <opaque_fragment>",
      `{
         float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
         outgoingLight += uRimCol * (fres * uFx.x + uFx.z * 0.12 * fres);
       }
       #include <opaque_fragment>`,
      "fragment/opaque",
    );
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => "pal-rig-v1";
  material.needsUpdate = true;
}

/** Push one frame of the performance into the GPU uniforms. */
export function writePose(u: PalUniforms, p: PalPose) {
  (u["uEyeLook"]!.value as THREE.Vector2).set(p.eyeYaw, p.eyePitch);
  u["uEyeWiden"]!.value = p.eyeWiden;
  (u["uLid"]!.value as THREE.Vector2).set(p.lidUpper, p.lidLower);
  (u["uLidF"]!.value as THREE.Vector3).set(p.lidUpper, p.lidLower, p.lidCurve);
  (u["uMouth"]!.value as THREE.Vector4).set(p.jawOpen, p.mouthWide, p.mouthRound, p.mouthPress);
  u["uSmile"]!.value = p.smile;
  (u["uBrowP"]!.value as THREE.Vector2).set(p.browRaise, p.browAngle);
  (u["uArm"]!.value as THREE.Vector4).set(p.armLSwing, p.armRSwing, ARM_L_LEN, ARM_R_LEN);
  (u["uBody"]!.value as THREE.Vector4).set(p.leanX, p.leanY, p.roll, p.breathe);
  (u["uDyn"]!.value as THREE.Vector4).set(p.squash, p.jiggle, p.time, GROUND_Y);
  (u["uFx"]!.value as THREE.Vector4).set(p.rim, p.blushBoost, p.blushBoost, 0);
}
