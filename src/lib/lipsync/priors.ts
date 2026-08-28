/**
 * Per-voice tempo calibration.
 *
 * The phone model shapes *relative* timing; one empirical constant sets the
 * absolute tempo, and `onend` teaches us the truth for next time. After two or
 * three utterances with the same voice the *first* word of every reply is
 * already in sync — which is the one moment `boundary` events can never fix,
 * and it is what makes Safari, which fires none at all, converge.
 */

import { clamp } from "./math";

/** Versioned: a duration-table change should invalidate old priors, not fight them. */
const KEY = "pal.lipsync.prior.v2";

export type Prior = { k: number; n: number };

const DEFAULT: Prior = { k: 1, n: 0 };

type Store = Record<string, Prior>;

let cache: Store | null = null;

/** Everything here is optional: SSR and private-mode browsers have no storage. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): Store {
  if (cache) return cache;
  cache = {};
  const s = storage();
  if (!s) return cache;
  try {
    const raw = s.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      for (const key of Object.keys(parsed)) {
        const p = parsed[key];
        // Clamp on read as well as write: a shared browser can persist a bad value.
        if (p && typeof p.k === "number" && Number.isFinite(p.k))
          cache[key] = { k: clamp(p.k, 0.5, 2.2), n: Math.min(Math.max(p.n | 0, 0), 32) };
      }
    }
  } catch {
    /* corrupt or blocked — the default prior is a perfectly good answer */
  }
  return cache;
}

export function getPrior(voiceKey: string): Prior {
  return read()[voiceKey] ?? DEFAULT;
}

export function learn(voiceKey: string, actualSec: number, predictedSec: number) {
  if (!(actualSec > 0.15) || !(predictedSec > 0.15)) return;
  const store = read();
  const p = store[voiceKey] ?? { ...DEFAULT };
  const obs = clamp(actualSec / predictedSec, 0.55, 1.85);
  // A running mean over the first eight observations, then a slow follower.
  p.k = clamp(p.k + (obs - p.k) / Math.min(p.n + 1, 8), 0.6, 1.7);
  p.n = Math.min(p.n + 1, 32);
  store[voiceKey] = p;
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota or private mode — the in-memory prior still helps this session */
  }
}
