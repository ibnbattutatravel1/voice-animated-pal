import { useEffect, useState } from "react";
import mascot from "@/assets/mascot.png";
import type { Mood } from "@/hooks/useVoiceSession";

export function Mascot({ level, mood }: { level: number; mood: Mood }) {
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 130);
        schedule();
      }, 2200 + Math.random() * 3200);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const talk = mood === "speaking" ? level : level * 0.6;
  const squash = 1 + talk * 0.07;
  const stretch = 1 - talk * 0.05;
  const tilt = mood === "listening" ? Math.sin(Date.now() / 700) * 2 : 0;

  return (
    <div className="relative flex items-center justify-center">
      <div
        className="pointer-events-none absolute inset-0 rounded-full blur-3xl transition-opacity duration-300"
        style={{
          background: "var(--gradient-aura)",
          opacity: 0.5 + talk * 0.4,
          transform: `scale(${1 + talk * 0.15})`,
        }}
      />
      <div className="animate-float relative">
        <img
          src={mascot}
          alt="Nova, a friendly lavender assistant character waving hello"
          width={1024}
          height={1024}
          className="relative w-[clamp(230px,52vw,430px)] drop-shadow-[0_30px_50px_rgba(124,58,237,0.28)] will-change-transform"
          style={{
            transform: `scale(${stretch}, ${squash}) rotate(${tilt}deg)`,
            transition: "transform 90ms linear",
            filter: blink ? "brightness(1.02)" : undefined,
          }}
        />
        {/* eyelids for blinking */}
        <div
          className="pointer-events-none absolute left-[30%] top-[33%] h-[9%] w-[42%] origin-top rounded-full bg-[oklch(0.78_0.09_300)] transition-transform duration-100"
          style={{ transform: `scaleY(${blink ? 1 : 0})` }}
        />
      </div>

      {mood === "speaking" && (
        <div className="pointer-events-none absolute bottom-[14%] flex items-end gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="w-1.5 rounded-full bg-primary/70"
              style={{
                height: `${8 + Math.abs(Math.sin(Date.now() / 130 + i)) * 26 * (0.4 + level)}px`,
                transition: "height 90ms linear",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default Mascot;
