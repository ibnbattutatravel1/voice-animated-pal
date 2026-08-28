/**
 * Which voice, and what that voice can actually do.
 *
 * Two independent problems live here. The first is *inventory*: voices arrive
 * late, or never announce themselves — Chrome fires `voiceschanged`, Safari
 * sometimes has them already and never fires, Edge publishes hundreds of network
 * voices seconds after load. So we listen AND poll AND time out.
 *
 * The second is *ranking*. `getVoices().find(/natural|neural|google/)` picks a
 * random en-GB male on Edge and eSpeak on Linux, and can never find Salma for
 * Egyptian Arabic because it has no notion of better. Scoring here is
 * **additive**, which is the whole trick: the name tables reorder good
 * candidates but never gate them, so an unmatched-but-good voice still keeps its
 * language score, its `localService` bonus and its `natural|neural` bonus and
 * still beats eSpeak. Treat the tables as configuration, not logic.
 *
 * Engine is detected **per voice**, not per browser: one Windows Chrome install
 * can carry SAPI, Google network and Edge natural voices in a single list.
 */

import { loadCalibration, type BoundarySupport, type Calibration } from "./calibration";
import { PITCH_ST_CEILING, type SpeechLang } from "./units";

export type EngineId =
  | "edge-natural"
  | "google-network"
  | "apple"
  | "espeak"
  | "android-network"
  | "android-local"
  | "sapi"
  | "unknown";

export type EngineProfile = {
  readonly pitchResponse: number;
  readonly stMin: number;
  readonly stMax: number;
  readonly rateMin: number;
  readonly rateMax: number;
  /** SAPI needs more rate to sound the same; Apple needs less. */
  readonly rateGain: number;
  readonly cpsEn: number;
  readonly cpsAr: number;
  readonly joinMs: number;
  readonly startMs: number;
  readonly boundary: BoundarySupport;
  /** `pause()/resume()` can kill audio outright on Safari — never kick there. */
  readonly resumeKick: boolean;
  readonly elongate: boolean;
};

/**
 * Every number is a **prior**. `startMs`, `joinMs` and `cps` are measured at
 * runtime and folded in with an EMA, so a wrong prior costs one segment of
 * accuracy and never correctness. `boundary` is a prior too — the scheduler
 * probes it inside the first segment and the probe wins.
 */
const ENGINES: Readonly<Record<EngineId, EngineProfile>> = {
  "edge-natural": eng(1.0, -7, 9, 0.5, 1.6, 1.0, 15.2, 12.4, 60, 260, "word", false, true),
  "google-network": eng(0.2, -7, 8, 0.7, 1.5, 1.0, 14.2, 11.8, 280, 300, "none", false, true),
  sapi: eng(0.85, -8, 9, 0.55, 1.9, 1.25, 15.5, 12.5, 30, 110, "word", true, true),
  apple: eng(0.95, -7, 9, 0.55, 1.8, 0.85, 16.0, 12.8, 35, 130, "sparse", false, true),
  espeak: eng(1.0, -9, 9, 0.5, 2.0, 1.0, 17.0, 13.0, 25, 60, "word", false, false),
  "android-local": eng(0.6, -6, 8, 0.6, 1.6, 1.0, 14.6, 12.0, 90, 240, "none", false, true),
  "android-network": eng(0.6, -6, 8, 0.7, 1.45, 1.0, 14.0, 11.6, 350, 500, "none", false, true),
  unknown: eng(0.7, -7, 8, 0.6, 1.5, 1.0, 15.0, 12.2, 120, 200, "sparse", false, false),
};

function eng(
  pitchResponse: number,
  stMin: number,
  stMax: number,
  rateMin: number,
  rateMax: number,
  rateGain: number,
  cpsEn: number,
  cpsAr: number,
  joinMs: number,
  startMs: number,
  boundary: BoundarySupport,
  resumeKick: boolean,
  elongate: boolean,
): EngineProfile {
  return {
    pitchResponse,
    stMin,
    stMax: Math.min(stMax, PITCH_ST_CEILING),
    rateMin,
    rateMax,
    rateGain,
    cpsEn,
    cpsAr,
    joinMs,
    startMs,
    boundary,
    resumeKick,
    elongate,
  };
}

export function detectEngine(v: SpeechSynthesisVoice): EngineId {
  const n = v.name ?? "";
  const uri = v.voiceURI ?? "";
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Online\s*\(Natural\)/i.test(n) || /Microsoft Server Speech/i.test(uri))
    return "edge-natural";
  if (/^Google\b/.test(n) && v.localService === false) return "google-network";
  if (/com\.apple\./i.test(uri)) return "apple";
  if (/espeak|festival|pico|flite/i.test(uri + n)) return "espeak";
  if (/-x-[a-z]{3}-network$/i.test(uri)) return "android-network";
  if (/-x-[a-z]{3}(-local)?$/i.test(uri)) return "android-local";
  if (/^Microsoft\b/i.test(n)) return "sapi";
  if (/Android/i.test(ua)) return "android-local";
  return "unknown";
}

/** One chosen voice, plus everything learned about it this session. */
export type VoiceProfile = {
  readonly uri: string;
  readonly name: string;
  readonly lang: string;
  readonly engine: EngineId;
  readonly localService: boolean;
  readonly engineProfile: EngineProfile;
  readonly score: number;
  readonly pitchBiasSt: number;
  /** Which language it was picked *for* — may differ from `lang` (§ ladder). */
  readonly want: SpeechLang;
  cps: number;
  joinMs: number;
  startMs: number;
  boundary: BoundarySupport;
};

export type VoiceAuditRow = {
  name: string;
  lang: string;
  engine: EngineId;
  local: boolean;
  score: number;
  pitchBiasSt: number;
};

type NameRule = { re: RegExp; bonus: number; bias: number; novelty?: boolean };

/**
 * `pitchBiasSt` lands different engines on the same *perceived* character pitch:
 * a voice that is already a child does not need another +45 %.
 *
 * Nova is a small round purple blob — the gender hint is female, the age hint is
 * young. Brighter formants read as smaller and rounder, which is the silhouette.
 */
const NAMES_EN: readonly NameRule[] = [
  { re: /\bAna\b.*(Natural|Online)/i, bonus: 85, bias: -2.5 },
  { re: /\bJunior\b/i, bonus: 78, bias: -2.5 },
  { re: /\b(Aria|Jenny|Michelle|Ava|Emma|Sara)\b.*(Natural|Online)/i, bonus: 72, bias: 0 },
  { re: /\bBubbles\b/i, bonus: 66, bias: -1, novelty: true },
  { re: /Google US English/i, bonus: 60, bias: 0 },
  { re: /\bSamantha\b/i, bonus: 58, bias: 0 },
  { re: /\bJester\b|Good News/i, bonus: 58, bias: -1, novelty: true },
  { re: /^Google .*English/i, bonus: 55, bias: 0 },
  { re: /\bSuperstar\b/i, bonus: 54, bias: -1, novelty: true },
  { re: /\b(Guy|Andrew|Brian|Christopher|Eric)\b.*(Natural|Online)/i, bonus: 52, bias: 2.5 },
  { re: /\bKaren\b/i, bonus: 50, bias: 0 },
  { re: /-x-[a-z]{3}-local$/i, bonus: 48, bias: 0 },
  { re: /\b(Rocko|Sandy|Flo|Eddy|Reed|Shelley|Kathy)\b/i, bonus: 46, bias: -0.5 },
  { re: /\b(Moira|Tessa|Fiona|Nicky|Allison|Susan|Zoe)\b/i, bonus: 42, bias: 0 },
  { re: /-x-[a-z]{3}-network$/i, bonus: 40, bias: 0 },
  { re: /\b(Daniel|Oliver|Arthur|Alex)\b/i, bonus: 36, bias: 2.5 },
  { re: /Microsoft (Zira|Hazel|Susan)/i, bonus: 18, bias: 1 },
  { re: /Microsoft (David|Mark|George)/i, bonus: 14, bias: 1.5 },
  { re: /\b(Boing|Wobble)\b/i, bonus: 30, bias: -1, novelty: true },
  {
    re: /\b(Zarvox|Trinoids|Whisper|Bahh|Bells|Organ|Cellos|Deranged|Hysterical|Bad News|Albert|Ralph|Bruce|Agnes|Victoria|Fred)\b/i,
    bonus: -70,
    bias: 0,
  },
];

/** Only Microsoft ships true `ar-EG` voices; Apple ships none. */
const NAMES_AR: readonly NameRule[] = [
  { re: /\bSalma\b/i, bonus: 95, bias: 0 },
  { re: /ar-eg-x-/i, bonus: 80, bias: 0 },
  { re: /\bShakir\b/i, bonus: 76, bias: 2.5 },
  { re: /\bHoda\b/i, bonus: 58, bias: 0 },
  { re: /Google\s*(العربية|Arabic)/i, bonus: 55, bias: 0 },
  { re: /\b(Zariyah|Amina|Fatima|Laila|Hala|Noura|Iman|Rana)\b/i, bonus: 50, bias: 0 },
  { re: /\b(Maged|Majed|Tarik|Hamdan|Naayf|Hamed|Ali)\b/i, bonus: 42, bias: 2 },
];

const NEAR_AR: Readonly<Record<string, number>> = {
  ar: 180,
  "ar-001": 120,
  "ar-sa": 120,
  "ar-ae": 80,
  "ar-jo": 80,
  "ar-lb": 80,
  "ar-ma": 40,
};
const NEAR_EN: Readonly<Record<string, number>> = {
  "en-ca": 130,
  "en-gb": 120,
  "en-au": 110,
  "en-ie": 80,
  "en-za": 60,
  "en-nz": 60,
  "en-in": 40,
};

const FEMALE_HINT =
  /\b(female|woman|girl|child|kid|junior|ana|aria|jenny|michelle|ava|emma|sara|samantha|karen|moira|tessa|fiona|nicky|allison|susan|zoe|zira|hazel|salma|hoda|zariyah|amina|fatima|laila|hala|noura|iman|rana)\b/i;

const normLang = (l: string) => l.replace(/_/g, "-").toLowerCase();

function langScore(voiceLang: string, want: SpeechLang): number {
  const v = normLang(voiceLang);
  const w = normLang(want);
  if (v === w) return 1000;
  const vb = v.slice(0, 2);
  if (vb !== w.slice(0, 2)) return -1;
  const near = want === "ar-EG" ? NEAR_AR[v] : NEAR_EN[v];
  return 400 + (near ?? 0);
}

function nameScore(name: string, uri: string, want: SpeechLang): NameRule | null {
  const table = want === "ar-EG" ? NAMES_AR : NAMES_EN;
  const subject = `${name} ${uri}`;
  for (const r of table) if (r.re.test(subject)) return r;
  return null;
}

export type VoiceMode = "normal" | "goofy";

export class VoicePool {
  private synth: SpeechSynthesis | null =
    typeof window === "undefined" ? null : (window.speechSynthesis ?? null);
  private voices: SpeechSynthesisVoice[] = [];
  /** Keyed by `uri|want` so a profile keeps its identity — and its learning —
   *  across every re-rank. */
  private profiles = new Map<string, VoiceProfile>();
  private blocked = new Set<string>();
  /** In flight, so the two mount-time callers share one poll instead of two. */
  private loading: Promise<SpeechSynthesisVoice[]> | null = null;
  private endLoad: (() => void) | null = null;

  constructor(private mode: VoiceMode = "normal") {}

  /** Listener + 120 ms poll + hard deadline. All three are load-bearing. */
  load(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
    const synth = this.synth;
    if (!synth) return Promise.resolve([]);
    this.refresh();
    if (this.voices.length) return Promise.resolve(this.voices);
    if (this.loading) return this.loading;

    this.loading = new Promise((resolve) => {
      // Every handle is a local: a second concurrent load would otherwise
      // overwrite shared fields and orphan the first poll for the page's life.
      let poll = 0;
      let deadline = 0;
      let listener: (() => void) | null = null;
      const done = () => {
        window.clearInterval(poll);
        window.clearTimeout(deadline);
        if (listener) synth.removeEventListener("voiceschanged", listener);
        listener = null;
        this.loading = null;
        this.endLoad = null;
        resolve(this.voices);
      };
      const check = () => {
        this.refresh();
        if (this.voices.length) done();
      };
      listener = check;
      synth.addEventListener("voiceschanged", check);
      poll = window.setInterval(check, 120);
      deadline = window.setTimeout(done, timeoutMs);
      this.endLoad = done;
    });
    return this.loading;
  }

  private refresh() {
    try {
      this.voices = this.synth?.getVoices?.() ?? [];
    } catch {
      this.voices = [];
    }
  }

  private score(v: SpeechSynthesisVoice, want: SpeechLang): { score: number; bias: number } | null {
    const ls = langScore(v.lang ?? "", want);
    if (ls < 0) return null;
    const name = v.name ?? "";
    const uri = v.voiceURI ?? "";
    const rule = nameScore(name, uri, want);
    const engine = detectEngine(v);
    const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    let s = ls + (rule?.bonus ?? 0);
    if (/natural|neural|online|premium|enhanced|wavenet|studio/i.test(name)) s += 30;
    if (/desktop|compact|legacy|low[- ]?quality/i.test(name)) s -= 25;
    if (v.localService) s += 14;
    if (v.default) s += 4;
    if (FEMALE_HINT.test(name)) s += 10;
    if (!online && !v.localService) s -= 400;
    // eSpeak is intelligible and honours pitch perfectly; it just sounds like a
    // robot. Demote hard, but stay above nothing at all.
    if (engine === "espeak") s -= 220;
    if (rule?.novelty && this.mode !== "goofy") s -= 1000;
    if (this.blocked.has(uri)) s -= 1000;
    return { score: s, bias: rule?.bias ?? 0 };
  }

  best(want: SpeechLang): VoiceProfile | null {
    this.refresh();
    let bestV: SpeechSynthesisVoice | null = null;
    let bestS = -Infinity;
    let bestBias = 0;
    for (const v of this.voices) {
      const r = this.score(v, want);
      if (!r || r.score <= bestS) continue;
      bestS = r.score;
      bestV = v;
      bestBias = r.bias;
    }
    // Below the base-language score there is no usable voice for this language.
    if (!bestV || bestS < 400) return null;
    return this.profileFor(bestV, want, bestS, bestBias);
  }

  private profileFor(
    v: SpeechSynthesisVoice,
    want: SpeechLang,
    score: number,
    bias: number,
  ): VoiceProfile {
    const uri = v.voiceURI ?? v.name ?? "default";
    const key = `${uri}|${want}`;
    const existing = this.profiles.get(key);
    if (existing) return existing;
    const engine = detectEngine(v);
    const E = ENGINES[engine];
    const cal = loadCalibration(key);
    const p: VoiceProfile = {
      uri,
      name: v.name ?? "",
      lang: v.lang ?? want,
      engine,
      localService: Boolean(v.localService),
      engineProfile: E,
      score,
      pitchBiasSt: bias,
      want,
      cps: cal?.cps ?? (want === "ar-EG" ? E.cpsAr : E.cpsEn),
      joinMs: cal?.joinMs ?? E.joinMs,
      startMs: E.startMs,
      boundary: cal?.boundary ?? E.boundary,
    };
    this.profiles.set(key, p);
    return p;
  }

  /** The storage key a profile's learning is filed under. */
  static calKey(p: VoiceProfile): string {
    return `${p.uri}|${p.want}`;
  }

  static calOf(p: VoiceProfile): Calibration {
    return { cps: p.cps, joinMs: p.joinMs, boundary: p.boundary };
  }

  /**
   * `voiceschanged` can *replace* the voice objects. A stale object is ignored
   * by some engines and throws on others, so re-resolve by URI at every speak.
   */
  resolve(sel: VoiceProfile | null): SpeechSynthesisVoice | null {
    if (!sel) return null;
    this.refresh();
    return (
      this.voices.find((v) => (v.voiceURI ?? "") === sel.uri) ??
      this.voices.find((v) => (v.name ?? "") === sel.name) ??
      null
    );
  }

  blacklist(uri: string) {
    if (uri) this.blocked.add(uri);
  }

  isBlacklisted(uri: string) {
    return this.blocked.has(uri);
  }

  audit(want: SpeechLang = "en-US"): VoiceAuditRow[] {
    this.refresh();
    const rows: VoiceAuditRow[] = [];
    for (const v of this.voices) {
      const r = this.score(v, want);
      if (!r) continue;
      rows.push({
        name: v.name ?? "",
        lang: v.lang ?? "",
        engine: detectEngine(v),
        local: Boolean(v.localService),
        score: r.score,
        pitchBiasSt: r.bias,
      });
    }
    return rows.sort((a, b) => b.score - a.score);
  }

  dispose() {
    // Settles a pending load with whatever arrived, and takes its poll,
    // listener and deadline with it.
    this.endLoad?.();
  }
}

/** Fallback engine limits when no voice at all could be chosen. */
export const UNKNOWN_ENGINE = ENGINES.unknown;
