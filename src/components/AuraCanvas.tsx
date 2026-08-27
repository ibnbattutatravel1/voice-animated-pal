import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

function Particles({ level, hue }: { level: number; hue: number }) {
  const ref = useRef<THREE.Points>(null);
  const COUNT = 320;

  const { positions, seeds, colors } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const r = 1.6 + Math.random() * 2.6;
      const a = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 3.4;
      positions.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
      seeds.set([r, a, 0.3 + Math.random() * 1.2], i * 3);
      c.setHSL(hue + Math.random() * 0.08, 0.65, 0.6 + Math.random() * 0.25);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    return { positions, seeds, colors };
  }, [hue]);

  useFrame((state, delta) => {
    const pts = ref.current;
    if (!pts) return;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const arr = pts.geometry.attributes.position.array as Float32Array;
    const boost = 1 + level * 0.9;
    for (let i = 0; i < COUNT; i++) {
      const r = seeds[i * 3] * boost;
      const a = seeds[i * 3 + 1] + t * seeds[i * 3 + 2] * 0.12;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 2] = Math.sin(a) * r;
      arr[i * 3 + 1] += Math.sin(t * seeds[i * 3 + 2] + i) * dt * 0.25;
      if (arr[i * 3 + 1] > 1.9) arr[i * 3 + 1] = -1.9;
    }
    pts.geometry.attributes.position.needsUpdate = true;
    pts.rotation.y += dt * 0.06;
    const s = 1 + level * 0.12;
    pts.scale.setScalar(s);
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        vertexColors
        size={0.055}
        sizeAttenuation
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Halo({ level }: { level: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const s = 2.1 + level * 0.5 + Math.sin(state.clock.elapsedTime * 1.4) * 0.05;
    m.scale.setScalar(s);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.1 + level * 0.22;
  });
  return (
    <mesh ref={ref} position={[0, 0, -1]}>
      <circleGeometry args={[1, 64]} />
      <meshBasicMaterial color="#a78bfa" transparent opacity={0.14} depthWrite={false} />
    </mesh>
  );
}

export function AuraCanvas({ level, hue = 0.72 }: { level: number; hue?: number }) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 6.5], fov: 55 }}
      gl={{ antialias: true, alpha: true }}
      style={{ pointerEvents: "none" }}
    >
      <Halo level={level} />
      <Particles level={level} hue={hue} />
    </Canvas>
  );
}

export default AuraCanvas;
