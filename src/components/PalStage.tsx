import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, useProgress } from "@react-three/drei";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { PalCharacter } from "@/components/PalCharacter";
import type { PalBrain } from "@/lib/pal-brain";
import type { PalSignal } from "@/lib/pal-signal";

/** Keeps the Pal framed the same way on a phone as on a desktop. */
function FrameCamera() {
  const { camera, size } = useThree();
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(1, size.height);
    // Portrait viewports need the camera further back to fit the same body.
    const dist = aspect < 0.85 ? 5.3 : aspect < 1.4 ? 4.5 : 4.1;
    const target = new THREE.Vector3(0, 0.86, dist);
    cam.position.lerp(target, 0.12);
    cam.lookAt(0, 0.78, 0);
    if (cam.fov !== 30) {
      cam.fov = 30;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

/**
 * Soft blob shadow + bloom on the floor. A real depth-buffer contact shadow
 * would mean re-rendering 500k triangles every frame; a procedural radial
 * gradient reads the same at this camera angle for a fraction of the cost.
 */
function GroundGlow({ signal }: { signal: PalSignal }) {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uLevel: { value: 0 },
      uShadow: { value: new THREE.Color("#2b1b46") },
      uGlow: { value: new THREE.Color("#a78bfa") },
    }),
    [],
  );
  useFrame((_, dt) => {
    uniforms.uLevel.value += (signal.level - uniforms.uLevel.value) * Math.min(1, dt * 8);
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
      <planeGeometry args={[5, 5]} />
      <shaderMaterial
        ref={mat}
        transparent
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={
          /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `
        }
        fragmentShader={
          /* glsl */ `
          uniform float uLevel;
          uniform vec3 uShadow;
          uniform vec3 uGlow;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            p.y *= 1.25;                       // the body is deeper than it is wide
            float r = length(p);
            float core = smoothstep(0.46, 0.05, r);
            float halo = smoothstep(0.95, 0.20, r);
            vec3 col = mix(uGlow, uShadow, core);
            float a = core * 0.42 + halo * (0.10 + uLevel * 0.22);
            gl_FragColor = vec4(col, a);
          }
        `
        }
      />
    </mesh>
  );
}

/**
 * A soft round dot. Without it `pointsMaterial` draws hard little squares, which
 * read as dead pixels rather than motes of light whenever one crosses the face.
 */
function useMoteSprite() {
  return useMemo(() => {
    if (typeof document === "undefined") return null;
    const S = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

/** Motes of light that swirl around the Pal and flare with its voice. */
function Aura({ signal, count = 220 }: { signal: PalSignal; count?: number }) {
  const points = useRef<THREE.Points>(null);
  const level = useRef(0);
  const sprite = useMoteSprite();
  useEffect(() => () => sprite?.dispose(), [sprite]);

  const { positions, seeds, colors } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      // Motes drifting between the camera and the face read as dirt on the lens,
      // so the ring is pushed out where it would cross the body's silhouette.
      const front = Math.max(0, Math.sin(a));
      const r = 1.15 + front * 0.75 + Math.random() * 1.5;
      const y = Math.random() * 2.2;
      positions.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
      seeds.set([r, a, 0.25 + Math.random() * 1.1], i * 3);
      c.setHSL(0.72 + Math.random() * 0.09, 0.7, 0.62 + Math.random() * 0.22);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    return { positions, seeds, colors };
  }, [count]);

  useFrame((state, delta) => {
    const pts = points.current;
    if (!pts) return;
    const dt = Math.min(delta, 0.05);
    level.current += (signal.level - level.current) * Math.min(1, dt * 6);
    const t = state.clock.elapsedTime;
    const attr = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const boost = 1 + level.current * 0.5;
    for (let i = 0; i < count; i++) {
      const r = (seeds[i * 3] ?? 1) * boost;
      const spin = seeds[i * 3 + 2] ?? 0.5;
      const a = (seeds[i * 3 + 1] ?? 0) + t * spin * 0.13;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 2] = Math.sin(a) * r;
      let y = (arr[i * 3 + 1] ?? 0) + dt * (0.1 + spin * 0.1) * (1 + level.current);
      if (y > 2.35) y = -0.05;
      arr[i * 3 + 1] = y;
    }
    attr.needsUpdate = true;
    const m = pts.material as THREE.PointsMaterial;
    m.opacity = 0.34 + level.current * 0.45;
    m.size = 0.046 + level.current * 0.034;
  });

  return (
    <points ref={points} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        vertexColors
        map={sprite}
        alphaMap={sprite}
        size={0.05}
        sizeAttenuation
        transparent
        opacity={0.4}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Scene({
  signal,
  brainRef,
}: {
  signal: PalSignal;
  brainRef: { current: PalBrain | null };
}) {
  return (
    <>
      <FrameCamera />
      <ambientLight intensity={0.55} color="#e6dcff" />
      <hemisphereLight intensity={0.7} color="#dcd0ff" groundColor="#f7c9dd" />
      <directionalLight position={[2.6, 4.2, 3.4]} intensity={1.35} color="#fff6f0" />
      <directionalLight position={[-3.2, 1.6, -2.4]} intensity={0.85} color="#b79dff" />
      <pointLight position={[0, 0.4, 2.4]} intensity={0.5} color="#ffd9ec" distance={7} />

      {/* Studio reflections built in-scene — no HDRI download. */}
      <Environment frames={1} resolution={128}>
        <Lightformer intensity={2.2} color="#ffffff" position={[0, 3.4, 1.6]} scale={[6, 3, 1]} />
        <Lightformer intensity={1.1} color="#c9b3ff" position={[-3, 1.2, 1]} scale={[3, 4, 1]} />
        <Lightformer intensity={0.9} color="#ffc7dd" position={[3, 0.6, -1.4]} scale={[3, 4, 1]} />
      </Environment>

      <GroundGlow signal={signal} />
      <Aura signal={signal} />

      <Suspense fallback={null}>
        <PalCharacter signal={signal} brainRef={brainRef} />
      </Suspense>
    </>
  );
}

export function PalStage({
  signal,
  brainRef,
  className,
}: {
  signal: PalSignal;
  brainRef: { current: PalBrain | null };
  className?: string;
}) {
  const { progress, active } = useProgress();

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      signal.pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
      signal.pointerY = -(((e.clientY - r.top) / r.height) * 2 - 1);
      signal.pointerActive = true;
    },
    [signal],
  );
  const onLeave = useCallback(() => {
    signal.pointerActive = false;
  }, [signal]);

  return (
    <div
      className={className}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerCancel={onLeave}
    >
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ position: [0, 0.86, 4.5], fov: 30, near: 0.1, far: 40 }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <Scene signal={signal} brainRef={brainRef} />
      </Canvas>

      {active && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="glass flex items-center gap-3 rounded-full px-4 py-2.5">
            <span className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            <span className="text-xs font-medium text-muted-foreground">
              Waking up… {Math.round(progress)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default PalStage;
