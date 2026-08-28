import { restFrame, restShape, type MouthShape, type SpeechFrame } from "./lipsync/types";

export type Mood = "idle" | "listening" | "thinking" | "speaking";

/**
 * A single mutable object shared between the voice session and the renderer.
 *
 * The mic analyser runs at 60 fps; routing that through React state would
 * re-render the whole page every frame with a 500k-triangle canvas mounted, so
 * the fast-moving values live here and the components only re-render for things
 * that actually change the DOM (mood, messages, transcript).
 */
export type PalSignal = {
  mood: Mood;
  /** Smoothed voice amplitude, 0..1. */
  level: number;
  /** Fast-attack peak, good for punchy reactions. */
  peak: number;
  listening: boolean;
  speaking: boolean;
  /** Current mouth target from the lip-sync engine. */
  mouth: MouthShape;
  /**
   * The whole performance bundle: prosody, accents, brows, nods, breath and the
   * queued events. Mirrors `mouth` and `accent`, which are kept as their own
   * fields so nothing has to reach through two objects on the hot path.
   */
  speech: SpeechFrame;
  /** Decaying spike at each spoken word onset. */
  accent: number;
  /** Pointer in -1..1 view space, and whether it is currently over the stage. */
  pointerX: number;
  pointerY: number;
  pointerActive: boolean;
  /** One-shot impulses; the brain consumes and clears them. */
  poke: number;
  /** Where the poke landed, in model space. */
  pokeX: number;
  pokeY: number;
  pokeZ: number;
  waveRequest: number;
  /** Honour the OS "reduce motion" setting. */
  reduced: boolean;
};

export const createSignal = (): PalSignal => ({
  mood: "idle",
  level: 0,
  peak: 0,
  listening: false,
  speaking: false,
  mouth: restShape(),
  speech: restFrame(),
  accent: 0,
  pointerX: 0,
  pointerY: 0,
  pointerActive: false,
  poke: 0,
  pokeX: 0,
  pokeY: 0,
  pokeZ: 0,
  waveRequest: 0,
  reduced: false,
});
