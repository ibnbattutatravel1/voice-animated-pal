// Tiny WebAudio synth for UI sound effects — no asset downloads needed.
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  getCtx();
}

type Tone = { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number };

function play(tones: Tone[]) {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  for (const t of tones) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = t.type ?? "sine";
    osc.frequency.setValueAtTime(t.freq, now + t.at);
    const peak = t.gain ?? 0.14;
    g.gain.setValueAtTime(0.0001, now + t.at);
    g.gain.exponentialRampToValueAtTime(peak, now + t.at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t.at + t.dur);
    osc.connect(g).connect(c.destination);
    osc.start(now + t.at);
    osc.stop(now + t.at + t.dur + 0.05);
  }
}

export const sfx = {
  tap: () => play([{ freq: 620, at: 0, dur: 0.12, type: "triangle", gain: 0.1 }]),
  start: () =>
    play([
      { freq: 523.25, at: 0, dur: 0.18 },
      { freq: 659.25, at: 0.08, dur: 0.2 },
      { freq: 783.99, at: 0.16, dur: 0.3 },
    ]),
  stop: () =>
    play([
      { freq: 523.25, at: 0, dur: 0.18 },
      { freq: 349.23, at: 0.09, dur: 0.28 },
    ]),
  message: () =>
    play([
      { freq: 880, at: 0, dur: 0.1, type: "triangle", gain: 0.08 },
      { freq: 1174.66, at: 0.07, dur: 0.14, type: "triangle", gain: 0.07 },
    ]),
  error: () => play([{ freq: 220, at: 0, dur: 0.3, type: "sawtooth", gain: 0.06 }]),
};
