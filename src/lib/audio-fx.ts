// Tiny WebAudio synth for UI sound effects — no asset downloads needed.
let ctx: AudioContext | null = null;
let failed = false;

/**
 * Safari caps a page at four AudioContexts and throws on the fifth, so this can
 * fail — and it is called from the same pointerdown handler as the mic button.
 * An escaping throw there would take the button's whole click with it, so a
 * missing sound effect must never be more than a missing sound effect.
 */
function getCtx(): AudioContext | null {
  if (typeof window === "undefined" || failed) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      failed = true;
      return null;
    }
  }
  try {
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* a context the browser has torn down; the tones below simply go quiet */
  }
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
  breath,
};

/**
 * A breath, from one filtered noise burst.
 *
 * It fills the dead air between `speak()` and the first audio — every engine has
 * 100–400 ms of it — and the long comedy pauses. The **direction of the sweep**
 * is what makes it read: an inhale climbs as the throat opens, an exhale falls.
 * Reverse them and it sounds like a leak.
 */
export function breath(kind: "in" | "out" = "in", ms = 180, gain = 0.035) {
  const c = getCtx();
  if (!c) return;
  const dur = Math.max(0.04, ms / 1000);
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.6;

  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 0.7;
  const t = c.currentTime;
  bp.frequency.setValueAtTime(kind === "in" ? 420 : 1500, t);
  bp.frequency.exponentialRampToValueAtTime(kind === "in" ? 1500 : 420, t + dur);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(bp).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
