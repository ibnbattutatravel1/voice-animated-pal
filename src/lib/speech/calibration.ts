/**
 * What we learned about a voice, kept across sessions.
 *
 * The scheduler measures a voice's real speaking rate and join latency from the
 * segments it plays (§ `Speaker.handleEnd`). Persisting that means the **second**
 * reply of a session already has the first segment right instead of spending
 * three segments converging. Every access is wrapped: Safari private mode throws
 * on write, and a corrupt entry must degrade to the prior, never to a crash.
 *
 * If the mouth ever looks systematically early or late, clearing
 * `nova.voicecal.v1` is the first thing to try.
 */

import { CAL_STORAGE_KEY, clamp, CPS_RANGE, JOIN_RANGE_MS } from "./units";

export type BoundarySupport = "word" | "sparse" | "none";

export type Calibration = {
  cps: number;
  joinMs: number;
  boundary: BoundarySupport;
};

type Store = Record<string, [number, number, BoundarySupport]>;

const MAX_ENTRIES = 12;

function read(): Store {
  try {
    const raw = window.localStorage.getItem(CAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function loadCalibration(key: string): Calibration | null {
  const row = read()[key];
  if (!Array.isArray(row) || row.length < 3) return null;
  const [cps, joinMs, boundary] = row;
  if (!Number.isFinite(cps) || !Number.isFinite(joinMs)) return null;
  if (boundary !== "word" && boundary !== "sparse" && boundary !== "none") return null;
  return {
    cps: clamp(cps, CPS_RANGE[0], CPS_RANGE[1]),
    joinMs: clamp(joinMs, JOIN_RANGE_MS[0], JOIN_RANGE_MS[1]),
    boundary,
  };
}

export function saveCalibration(key: string, cal: Calibration): void {
  try {
    const store = read();
    delete store[key]; // re-insert last so the cap evicts the least recently used
    const keys = Object.keys(store);
    for (let i = 0; i <= keys.length - MAX_ENTRIES; i++) {
      const k = keys[i];
      if (k) delete store[k];
    }
    store[key] = [
      clamp(cal.cps, CPS_RANGE[0], CPS_RANGE[1]),
      clamp(cal.joinMs, JOIN_RANGE_MS[0], JOIN_RANGE_MS[1]),
      cal.boundary,
    ];
    window.localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* private mode, quota, or no storage at all — the priors still work */
  }
}
