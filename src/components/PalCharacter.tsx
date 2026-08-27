import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { PalBrain } from "@/lib/pal-brain";
import { attachPalRig, createPalUniforms, writePose } from "@/lib/pal-material";
import { GROUND_Y } from "@/lib/pal-rig";
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
    };
  }, [brain, brainRef]);

  const { geometry, material } = useMemo(() => {
    const mesh = findMesh(gltf.scene);
    if (!mesh) throw new Error("pal.glb contained no mesh");

    const geo = mesh.geometry as THREE.BufferGeometry;
    // The GLB ships POSITION + TEXCOORD_0 only — no normals at all, so nothing
    // would be lit until we build them. Indexed geometry gives smooth normals.
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
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
  useFrame((_, delta) => {
    if (frozen.current) return; // dev: hold a pose so the rig can be inspected
    const pose = brain.update(delta, signal);
    writePose(uniforms, pose);
  });

  // Dev handle for driving the rig straight from the console:
  //   __palRig.freeze(true); __palRig.uniforms.uMouth.value.set(1, 0, 0, 0)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    Object.defineProperty(window, "__palRig", {
      configurable: true,
      value: { uniforms, brain, freeze: (v: boolean) => (frozen.current = v) },
    });
  }, [uniforms, brain]);

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
