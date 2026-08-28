import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { PalBrain } from "@/lib/pal-brain";
import { attachPalRig, createPalUniforms, writeCamera, writePose } from "@/lib/pal-material";
import {
  FACE_F,
  FACE_R,
  FACE_U,
  GROUND_Y,
  MOUTH,
  MOUTH_DEPTH,
  MOUTH_W0,
  MUZ_A,
  MUZ_C,
  skinZ,
} from "@/lib/pal-rig";
import type { PalSignal } from "@/lib/pal-signal";

export const PAL_URL = "/pal.glb";
const DRACO_PATH = "/draco/";

/** Lift the model so the feet rest on y = 0. */
export const PAL_LIFT = -GROUND_Y;

function findMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

/**
 * Position-only weld. The GLB carries 16,670 UV-split vertices — one for every
 * seam in a photogrammetry unwrap — and each copy only ever sees the faces on
 * its own side of the seam. `mergeVertices` will not help: it hashes position
 * *and* uv, so it keeps the splits it is meant to remove.
 *
 * Returns, for each vertex, the index of the first vertex sharing its position.
 * Duplicates are bit-identical floats, so a quantised hash bucket plus an exact
 * comparison is both exact and linear.
 */
function weldByPosition(pos: THREE.BufferAttribute): Int32Array {
  const n = pos.count;
  const a = pos.array as ArrayLike<number>;
  const rep = new Int32Array(n);
  const next = new Int32Array(n).fill(-1);
  const head = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const x = a[i * 3] as number,
      y = a[i * 3 + 1] as number,
      z = a[i * 3 + 2] as number;
    const key =
      ((Math.round(x * 32768) * 73856093) ^
        (Math.round(y * 32768) * 19349663) ^
        (Math.round(z * 32768) * 83492791)) |
      0;
    const first = head.get(key) ?? -1;
    let found = -1;
    for (let j = first; j >= 0; j = next[j] as number) {
      if (a[j * 3] === x && a[j * 3 + 1] === y && a[j * 3 + 2] === z) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      rep[i] = found;
    } else {
      rep[i] = i;
      next[i] = first;
      head.set(key, i);
    }
  }
  return rep;
}

/** Average each split vertex's normal over every face that touches its position. */
function weldNormals(geo: THREE.BufferGeometry, rep: Int32Array) {
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
  const n = nrm.count;
  const acc = new Float32Array(n * 3);
  const src = nrm.array as ArrayLike<number>;
  for (let i = 0; i < n; i++) {
    const r = (rep[i] as number) * 3;
    acc[r] = (acc[r] as number) + (src[i * 3] as number);
    acc[r + 1] = (acc[r + 1] as number) + (src[i * 3 + 1] as number);
    acc[r + 2] = (acc[r + 2] as number) + (src[i * 3 + 2] as number);
  }
  const out = nrm.array as Float32Array;
  for (let i = 0; i < n; i++) {
    const r = (rep[i] as number) * 3;
    const x = acc[r] as number,
      y = acc[r + 1] as number,
      z = acc[r + 2] as number;
    const l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l;
    out[i * 3 + 1] = y / l;
    out[i * 3 + 2] = z / l;
  }
  nrm.needsUpdate = true;
}

/** The sculpted grin's own footprint, dilated — see SCULPT_AP in the mouth spec. */
const SCULPT_HW = MOUTH_W0;
const SCULPT_HH = 0.058;
const SCULPT_CY = -0.016;
/** Behind the fitted skin by more than this and the vertex is pocket, not face. */
const CAV_MIN = 0.014;

/**
 * Seal the sculpted mouth.
 *
 * The mesh has a real 0.222-deep invagination here with a tongue modelled on its
 * floor, so the character could never actually close her mouth — you always
 * looked into a hole, and the drawn mouth sat on top of it as a second layer.
 *
 * A polynomial refit of the missing skin is window-sensitive (seeded badly, my
 * own refits produced coefficients like −57y³) and would leave a ring at the
 * aperture. A membrane does not: relax z to be harmonic over the cavity with the
 * rim held fixed and continuity with the surrounding skin is exact *by
 * construction*, whatever the fit does. The analytic fit is used for two things
 * only — classifying which vertices are pocket, and seeding the relaxation so it
 * converges in a few hundred passes instead of a few thousand.
 */
function bakeSeal(geo: THREE.BufferGeometry, rep: Int32Array) {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const n = pos.count;
  const a = pos.array as ArrayLike<number>;

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);
  const d0 = new Float64Array(n);
  const cav = new Uint8Array(n);
  const inWin = new Uint8Array(n);
  const cavIdx: number[] = [];

  for (let i = 0; i < n; i++) {
    const dx = (a[i * 3] as number) - MOUTH[0];
    const dy = (a[i * 3 + 1] as number) - MOUTH[1];
    const dz = (a[i * 3 + 2] as number) - MOUTH[2];
    const x = dx * FACE_R[0] + dy * FACE_R[1] + dz * FACE_R[2];
    const y = dx * FACE_U[0] + dy * FACE_U[1] + dz * FACE_U[2];
    const z = dx * FACE_F[0] + dy * FACE_F[1] + dz * FACE_F[2];
    fx[i] = x;
    fy[i] = y;
    fz[i] = z;
    if (z < -0.36) continue;
    if (Math.hypot((x - MUZ_C[0]) / MUZ_A[0], (y - MUZ_C[1]) / MUZ_A[1]) > 1.45) continue;
    inWin[i] = 1;
    d0[i] = skinZ(x, y) - z;
    // Gate the classification on the grin's own footprint. The eye bulges were
    // excluded from the skin fit, so d0 is meaningless there and the crease under
    // the right eye would otherwise be sealed shut along with the mouth.
    const sr = Math.hypot((x - MUZ_C[0]) / SCULPT_HW, (y - SCULPT_CY) / SCULPT_HH);
    if ((d0[i] as number) > CAV_MIN && sr <= 1.6 && rep[i] === i) {
      cav[i] = 1;
      cavIdx.push(i);
    }
  }

  // Adjacency over the welded representatives — the seam splits would tear the
  // membrane in half — and only for edges that touch the cavity at all.
  const adj = new Map<number, Set<number>>();
  const link = (p: number, q: number) => {
    if (!cav[p] && !cav[q]) return;
    let s = adj.get(p);
    if (!s) {
      s = new Set<number>();
      adj.set(p, s);
    }
    s.add(q);
  };
  if (idx) {
    for (let t = 0; t < idx.count; t += 3) {
      const p = rep[idx.getX(t)] as number;
      const q = rep[idx.getX(t + 1)] as number;
      const r = rep[idx.getX(t + 2)] as number;
      link(p, q);
      link(q, p);
      link(q, r);
      link(r, q);
      link(r, p);
      link(p, r);
    }
  }

  // Successive over-relaxation, seeded with the fit. Plain Jacobi needs O(k²)
  // passes to diffuse k vertices deep, and the throat is ~45 edges from the rim:
  // 80 cold passes leave the deepest sheet 0.18 short, which is the whole hole.
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = fz[i] as number;
  for (const i of cavIdx) z[i] = skinZ(fx[i] as number, fy[i] as number);
  for (let it = 0; it < 240; it++) {
    for (const i of cavIdx) {
      const nb = adj.get(i);
      if (!nb || !nb.size) continue;
      let s = 0;
      for (const j of nb) s += z[j] as number;
      z[i] = (z[i] as number) + 1.85 * (s / nb.size - (z[i] as number));
    }
  }

  const seal = new Float32Array(n);
  const cavA = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inWin[i]) continue;
    const c = rep[i] as number;
    cavA[i] = THREE.MathUtils.smoothstep(d0[i] as number, 0.02, 0.055);
    if (!cav[c]) continue;
    // A monotone ordering epsilon: the ~6,200 pocket sheets collapse onto each
    // other, so the deepest is pushed 0.006 further back and adjacent sheets stay
    // ~5e-4 apart — about 40× the depth precision at this camera.
    const t = Math.min(1, Math.max(0, (d0[i] as number) / MOUTH_DEPTH));
    seal[i] = (z[c] as number) - (fz[c] as number) - 0.006 * t;
  }
  geo.setAttribute("palSeal", new THREE.BufferAttribute(seal, 1));
  geo.setAttribute("palCav", new THREE.BufferAttribute(cavA, 1));
}

export function PalCharacter({
  signal,
  brainRef,
}: {
  signal: PalSignal;
  brainRef?: { current: PalBrain | null };
}) {
  const gltf = useGLTF(PAL_URL, DRACO_PATH);
  const uniforms = useMemo(() => createPalUniforms(), []);
  const brain = useMemo(() => new PalBrain(), []);
  const group = useRef<THREE.Group>(null);

  useEffect(() => {
    if (brainRef) brainRef.current = brain;
    return () => {
      if (brainRef) brainRef.current = null;
      // The brain's visibilitychange listener is what keeps it alive: document
      // holds the bound handler, so without this every unmount retains a whole
      // brain and every tab focus resumes brains nothing renders.
      brain.dispose();
    };
  }, [brain, brainRef]);

  const { geometry, material } = useMemo(() => {
    const mesh = findMesh(gltf.scene);
    if (!mesh) throw new Error("pal.glb contained no mesh");

    const geo = mesh.geometry as THREE.BufferGeometry;
    // The GLB ships POSITION + TEXCOORD_0 only — no normals at all, so nothing
    // would be lit until we build them. Indexed geometry gives smooth normals.
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    if (!geo.getAttribute("palSeal")) {
      const rep = weldByPosition(geo.getAttribute("position") as THREE.BufferAttribute);
      weldNormals(geo, rep);
      bakeSeal(geo, rep);
    }
    geo.computeBoundingSphere();

    const src = mesh.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({
      map: src.map,
      // The baked metallic/roughness map claims metalness 0.63, which is a
      // generation artefact — it would render this toy as dark chrome.
      metalness: 0.0,
      roughness: 0.52,
      envMapIntensity: 0.9,
    });
    if (mat.map) {
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.anisotropy = 8;
      mat.map.needsUpdate = true;
    }
    attachPalRig(mat, uniforms);
    return { geometry: geo, material: mat };
  }, [gltf, uniforms]);

  useEffect(() => () => material.dispose(), [material]);

  const frozen = useRef(false);
  const hopY = useRef(0);
  useFrame(({ camera }, delta) => {
    if (!frozen.current) {
      // dev: freeze holds the pose so the rig can be inspected, but the camera
      // still has to be tracked or the interior parallax freezes with it.
      const pose = brain.update(delta, signal);
      writePose(uniforms, pose);
      hopY.current = pose.hopY;
    }
    // The hop is a rigid group translation: applied in the shader it would shear,
    // and it would fight the soft floor's object-space clamp.
    if (group.current) group.current.position.y = PAL_LIFT + hopY.current;
    writeCamera(uniforms, camera.position, PAL_LIFT + hopY.current);
  });

  // Dev handle for driving the rig straight from the console:
  //   __palRig.freeze(true); __palRig.uniforms.uMouth.value.set(1, 0, 0, 0)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    Object.defineProperty(window, "__palRig", {
      configurable: true,
      value: { uniforms, brain, geometry, material, freeze: (v: boolean) => (frozen.current = v) },
    });
  }, [uniforms, brain, geometry, material]);

  return (
    <group ref={group} position={[0, PAL_LIFT, 0]}>
      <mesh
        geometry={geometry}
        material={material}
        castShadow={false}
        receiveShadow={false}
        // 500k triangles: never let the raycaster walk them. The invisible
        // proxy below handles hit-testing instead.
        raycast={() => null}
      />
      <mesh
        visible={false}
        position={[0, 0.05, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          signal.poke = 1;
          // Where it landed, in the model's own space — the dent needs a contact
          // point, not just an impulse.
          const p = e.point.clone();
          group.current?.worldToLocal(p);
          signal.pokeX = p.x;
          signal.pokeY = p.y;
          signal.pokeZ = p.z;
        }}
      >
        <sphereGeometry args={[0.95, 12, 10]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}

useGLTF.preload(PAL_URL, DRACO_PATH);

export default PalCharacter;
