/**
 * The scheduler.
 *
 * `planReply` decides *what* the performance is; this decides *when* each piece
 * of it reaches the engine, and it is where every reliability hazard in
 * `speechSynthesis` gets a named guard. The API is a minefield: Chrome silently
 * drops a `speak()` that lands too soon after a `cancel()`, garbage-collects a
 * still-speaking utterance that nothing holds a reference to (and then stops
 * firing its events forever), fires `end` for cancelled utterances
 * non-deterministically, and truncates anything near fifteen seconds. Safari can
 * lose audio outright if you `pause()` it. Nothing here trusts any of it.
 *
 * The two ideas that make the rest work:
 *  - a **generation token** captured by every handler, so a callback from a
 *    cancelled reply is inert rather than advancing the wrong score;
 *  - **measurement over assumption** — join latency and speaking rate are learned
 *    from the segments as they play, so a wrong prior costs one segment of
 *    accuracy and never correctness.
 */

import { sfx } from "../audio-fx";
import { isArabicText, type Lang } from "../lipsync/types";
import { saveCalibration } from "./calibration";
import { interjectionScore, interjectionText } from "./interject";
import {
  planReply,
  type DeliveryHint,
  type EmotionName,
  type InterjectKind,
  type Score,
  type Segment,
  type PlanEnv,
} from "./prosody";
import { normaliseForSpeech, stripTerminal, translitAr } from "./text";
import {
  BREATH_THROTTLE_MS,
  CANCEL_GUARD_MS,
  clamp,
  ema,
  finite,
  LEAD_MS,
  REPLY_WATCHDOG_SLACK_MS,
  RESUME_KICK_MS,
  SETTLE_TIMEOUT_MS,
  stToRatio,
  WATCHDOG_END_FACTOR,
  WATCHDOG_END_SLACK_MS,
  WATCHDOG_START_LOCAL_MS,
  WATCHDOG_START_REMOTE_MS,
  type SpeechLang,
} from "./units";
import { UNKNOWN_ENGINE, VoicePool, type VoiceMode, type VoiceProfile } from "./voices";

export type EndReason = "complete" | "cancelled" | "error" | "silent" | "stalled";

export type SpeakerConfig = {
  /** E. Scales deviations only — the character's own pitch is never scaled. */
  expressiveness?: number | undefined;
  /** Semitones added to every preset's base — Nova's identity trim. */
  character?: number | undefined;
  voiceMode?: VoiceMode | undefined;
  arFallback?: "twin" | "translit" | "silent" | undefined;
  masterPitchSt?: number | undefined;
  masterRate?: number | undefined;
  enabled?: boolean | undefined;
  reduced?: boolean | undefined;
};

export type SpeakerHooks = {
  onPlan: ((score: Score) => void) | undefined;
  onStart: ((score: Score) => void) | undefined;
  /**
   * Compile the mouth timeline for the WHOLE reply and hand back the exact
   * string the engine must speak — the lip-sync engine is allowed to rewrite it
   * (Arabic tashkeel is stripped for TTS but kept for the phone score). Called
   * once per reply, at plan time, so the anticipatory breath has somewhere to
   * live during the engine's 100–400 ms of start latency.
   */
  onPrepare: ((text: string, lang: Lang, rate: number, voiceKey: string) => string) | undefined;
  onSegmentStart: ((s: Segment, i: number, cps: number, startAt: number) => void) | undefined;
  onSegmentEnd: ((s: Segment, i: number, pauseMs: number, actualMs: number) => void) | undefined;
  /** `charIndex` is already absolute in the prepared string. */
  onWord: ((charIndex: number, charLength: number, name: string) => void) | undefined;
  onEnd: ((reason: EndReason, actualSec: number) => void) | undefined;
};

export type SpeakHandle = {
  readonly id: number;
  readonly score: Score;
  cancel(): void;
  readonly done: Promise<EndReason>;
};

export type SpeakerDiagnostics = {
  voice: string;
  engine: string;
  lang: string;
  cps: number;
  joinMs: number;
  boundary: string;
  segments: number;
  realisedSec: number;
  estSec: number;
  silenceFraction: number;
  meanSegSec: number;
  stalls: number;
  dialectCompromise: boolean;
};

/** Engines append silence after terminal punctuation; subtract it before
 *  inferring a speaking rate, or every full stop looks like slow speech. */
const TRAIL_SILENCE: Readonly<Record<string, number>> = {
  ",": 0.1,
  "،": 0.1,
  ".": 0.22,
  "!": 0.18,
  "?": 0.24,
  "؟": 0.24,
  ":": 0.2,
  "…": 0.35,
};

const isChromiumDesktop = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Chrome|Chromium|Edg\//.test(ua) && !/Android|Mobile|iPhone|iPad/.test(ua);
};

export class Speaker {
  readonly hooks: SpeakerHooks = {
    onPlan: undefined,
    onStart: undefined,
    onPrepare: undefined,
    onSegmentStart: undefined,
    onSegmentEnd: undefined,
    onWord: undefined,
    onEnd: undefined,
  };

  private synth: SpeechSynthesis | null =
    typeof window === "undefined" ? null : (window.speechSynthesis ?? null);
  private pool: VoicePool;

  /** The cancel-race killer: every handler is inert unless it still owns this. */
  private gen = 0;
  private score: Score | null = null;
  /** Kept past `finish()` so the dev HUD can still be asked what just happened. */
  private lastScore: Score | null = null;
  private selection: VoiceProfile | null = null;
  private queued = 0;
  private playing = -1;
  /** GC pin. Chrome collects a still-speaking utterance nothing references. */
  private live = new Map<number, SpeechSynthesisUtterance>();
  private speakAt = new Map<number, number>();
  private prequeued = new Set<number>();
  private startedSeg = new Set<number>();
  /** Segments handed to the engine whose `onSegmentStart` is not due yet. */
  private hookOwed = new Set<number>();
  private timer = 0;
  /** Keyed by segment: a prequeue pass has two utterances in flight at once. */
  private startGuards = new Map<number, number>();
  private endGuard = 0;
  private replyGuard = 0;
  private kicker = 0;
  private settleTimer = 0;
  private cancelAt = 0;
  private speakCalledAt = 0;
  private segStartAt = 0;
  private lastEndAt = 0;
  private scheduledSleep = 0;
  private endGuardStage = 0;
  private stallRetries = 0;
  private retriedSeg = -1;
  private realisedMs = 0;
  private firstAudioAt = 0;
  private sawBoundary = false;
  private boundaryDeadline = 0;
  private silentTimer = 0;
  private handleId = 0;
  private settle: ((r: EndReason) => void) | null = null;
  private lastBreathAt = -Infinity;
  private lastInterject = "";
  private recentEmotions: EmotionName[] = [];
  private rateScale = 1;
  private lastCharIndex = -1;
  private onVisible: (() => void) | null = null;
  private onLeave: (() => void) | null = null;

  dialectCompromise = false;

  constructor(
    hooks?: Partial<SpeakerHooks>,
    private config: SpeakerConfig = {},
  ) {
    if (hooks) Object.assign(this.hooks, hooks);
    this.pool = new VoicePool(config.voiceMode ?? "normal");
    void this.pool.load();
    this.arm();
  }

  /**
   * Attach the page-lifetime guards. Idempotent, and separate from the
   * constructor because the effect that wires this Speaker up is torn down and
   * re-run once on mount, so its cleanup would otherwise leave the page with a
   * live Speaker and no guards for the rest of the session — the tab could then
   * be closed mid-sentence and keep talking.
   */
  arm(): void {
    if (typeof window === "undefined" || this.onVisible) return;
    this.onVisible = () => {
      if (document.visibilityState === "visible" && this.synth?.paused) {
        try {
          this.synth.resume();
        } catch {
          /* nothing to resume */
        }
      }
    };
    this.onLeave = () => {
      try {
        this.synth?.cancel();
      } catch {
        /* the page is going away anyway */
      }
    };
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("pagehide", this.onLeave);
  }

  /**
   * iOS only unlocks speech inside a real user gesture, and only if nothing has
   * awaited first. Speaks one silent space; also warms a network voice.
   */
  static prime(): void {
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (!synth || Speaker.primed) return;
    Speaker.primed = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.rate = 2;
      synth.speak(u);
    } catch {
      Speaker.primed = false;
    }
  }
  private static primed = false;

  get speaking() {
    return this.score !== null;
  }

  get currentScore() {
    return this.score;
  }

  get voice() {
    return this.selection;
  }

  setExpressiveness(e: number) {
    this.config.expressiveness = clamp(e, 0, 2);
  }

  /** Calmer contours, and no breath SFX at all. */
  setReduced(on: boolean) {
    this.config.reduced = on;
  }

  async ready(): Promise<VoiceProfile | null> {
    await this.pool.load();
    return this.pool.best("en-US");
  }

  audit(want: SpeechLang = "en-US") {
    return this.pool.audit(want);
  }

  /** Compile only — the tuning surface, and what the unit tests snapshot. */
  plan(display: string, hint?: DeliveryHint): Score {
    const prepared = this.prepare(display, hint);
    return prepared.score;
  }

  say(display: string, hint?: DeliveryHint): SpeakHandle {
    this.stop();
    // The voice is re-ranked here and only here. A late `voiceschanged` can add
    // Salma halfway through a reply, but switching timbre mid-performance
    // destroys character identity harder than any prosody gain repairs it.
    const { score, profile } = this.prepare(display, hint, true);
    this.selection = profile;
    this.score = score;
    this.lastScore = score;
    this.queued = 0;
    this.playing = -1;
    this.realisedMs = 0;
    this.sawBoundary = false;
    this.lastCharIndex = -1;
    this.endGuardStage = 0;
    this.stallRetries = 0;
    this.retriedSeg = -1;
    this.firstAudioAt = 0;
    this.recentEmotions.unshift(score.emotion);
    this.recentEmotions.length = Math.min(this.recentEmotions.length, 3);
    const opener = score.segments[0];
    if (opener?.role === "interject") this.lastInterject = stripTerminal(opener.text);

    const id = ++this.handleId;
    let resolve: (r: EndReason) => void = () => undefined;
    const done = new Promise<EndReason>((res) => {
      resolve = res;
    });
    this.settle = resolve;
    const handle: SpeakHandle = { id, score, cancel: () => this.stop(), done };

    this.hooks.onPlan?.(score);
    if (!score.segments.length) {
      this.finish("complete");
      return handle;
    }
    this.hooks.onStart?.(score);
    this.breath(180);
    this.armReplyWatchdog();
    if (!profile || this.config.enabled === false) {
      // Silent performance: the identical schedule on wall-clock timers. Nova
      // mimes the reply while the bubble shows the text — the character stays
      // alive, only the audio is missing, and because it reuses the same hooks
      // it cannot drift from the audio path.
      this.runSilent(0);
      return handle;
    }
    this.pump();
    return handle;
  }

  interject(kind: InterjectKind): SpeakHandle {
    this.stop();
    const lang: SpeechLang = this.selection?.want ?? "en-US";
    const profile = this.selection ?? this.pool.best(lang);
    const score = interjectionScore(kind, lang, profile?.cps ?? 15);
    this.selection = profile;
    this.score = score;
    this.lastScore = score;
    this.queued = 0;
    this.playing = -1;
    this.realisedMs = 0;
    this.firstAudioAt = 0;
    this.rateScale = 1;
    this.lastCharIndex = -1;
    this.startedSeg.clear();
    // An interjection is a performance like any other: it gets its own mouth
    // timeline, or `armIfIdle` would bind to whatever was compiled last.
    this.hooks.onPrepare?.(
      interjectionText(kind, lang),
      lang === "ar-EG" ? "ar" : "en",
      score.segments[0]?.rate ?? 1,
      `${profile?.uri ?? "default"}|${lang}`,
    );
    const id = ++this.handleId;
    let resolve: (r: EndReason) => void = () => undefined;
    const done = new Promise<EndReason>((res) => {
      resolve = res;
    });
    this.settle = resolve;
    this.hooks.onPlan?.(score);
    this.hooks.onStart?.(score);
    this.armReplyWatchdog();
    if (!profile) this.runSilent(0);
    else this.pump();
    return { id, score, cancel: () => this.stop(), done };
  }

  // ───────────────────────────────────────────────────────────────── planning

  private prepare(
    display: string,
    hint: DeliveryHint | undefined,
    live = false,
  ): { score: Score; profile: VoiceProfile | null } {
    const norm = normaliseForSpeech(display);
    let text = norm.text;
    let lang: SpeechLang = isArabicText(text) ? "ar-EG" : "en-US";
    let profile = this.pool.best(lang);
    let rateScale = 1;
    this.dialectCompromise = false;

    if (lang === "ar-EG") {
      const mode = this.config.arFallback ?? "twin";
      if (profile) {
        // Egyptian is what we want; Modern Standard is understood, not native.
        this.dialectCompromise = profile.lang.replace(/_/g, "-").toLowerCase() !== "ar-eg";
      } else if (mode === "twin" && hint?.latin) {
        // A human wrote these phonetics, which is exactly why short Cairene
        // phrases come out startlingly intelligible through an English voice.
        text = normaliseForSpeech(hint.latin).text;
        lang = "en-US";
        profile = this.pool.best("en-US");
        rateScale = 0.86;
      } else if (mode === "translit" && text.length <= 120) {
        text = translitAr(text);
        lang = "en-US";
        profile = this.pool.best("en-US");
        rateScale = 0.86;
      }
      // Otherwise: no voice, no twin → silent performance. Never read Arabic
      // script through an English voice; that is worse than silence.
    }

    const emphasis = [
      ...(hint?.emphasis ?? []),
      ...norm.emphasis.map((s) => norm.text.slice(s[0], s[1])),
    ];
    const merged: DeliveryHint = { ...hint, emphasis };
    const env = this.envFor(profile, lang);
    let score = planReply(text, env, merged);

    if (live) {
      this.rateScale = rateScale;
      const key = `${profile?.uri ?? "default"}|${lang}`;
      const spoken = this.hooks.onPrepare?.(
        text,
        lang === "ar-EG" ? "ar" : "en",
        meanRate(score) * rateScale,
        key,
      );
      // The lip-sync engine owns the string it timed; if it rewrote it, re-plan
      // against the rewrite so every segment offset still indexes what the
      // engine will actually be handed.
      if (spoken && spoken !== text) score = planReply(spoken, env, merged);
    }
    return { score, profile };
  }

  private envFor(profile: VoiceProfile | null, lang: SpeechLang): PlanEnv {
    const E = profile?.engineProfile ?? UNKNOWN_ENGINE;
    const cps = profile?.cps ?? (lang === "ar-EG" ? E.cpsAr : E.cpsEn);
    const reduced = this.config.reduced === true;
    return {
      lang,
      cps,
      pitchBiasSt: profile?.pitchBiasSt ?? 0,
      pitchStMin: E.stMin,
      pitchStMax: E.stMax,
      rateMin: E.rateMin,
      rateMax: E.rateMax,
      rateGain: E.rateGain,
      joinMs: profile?.joinMs ?? E.joinMs,
      pitchResponse: E.pitchResponse,
      elongate: E.elongate,
      expressiveness: reduced ? 0.45 : clamp(this.config.expressiveness ?? 1, 0, 2),
      characterSt: this.config.character ?? 0,
      recentEmotions: this.recentEmotions,
      lastInterject: this.lastInterject,
    };
  }

  // ───────────────────────────────────────────────────────────────── the queue

  private pump(): void {
    const score = this.score;
    const synth = this.synth;
    if (!score || !synth) return;
    const my = this.gen;

    const since = performance.now() - this.cancelAt;
    if (since < CANCEL_GUARD_MS) {
      // Chrome drops a speak() that lands inside the cancel window, with no
      // error and no event: the reply simply never happens.
      this.timer = window.setTimeout(() => {
        if (this.gen === my) this.pump();
      }, CANCEL_GUARD_MS - since);
      return;
    }
    if (synth.paused) {
      try {
        synth.resume();
      } catch {
        /* nothing was paused */
      }
    }

    while (this.queued < score.segments.length && this.live.size < this.depth()) {
      const i = this.queued++;
      const seg = score.segments[i];
      if (!seg) break;
      // Prequeued means: handed to the engine while the previous segment is
      // still sounding, so the realised gap is the engine's own join latency.
      const isPrequeue = this.live.size > 0;
      const u = new SpeechSynthesisUtterance(seg.text);
      const v = this.pool.resolve(this.selection);
      if (v) u.voice = v;
      u.lang = this.selection?.lang ?? score.lang;
      u.pitch = clamp(finite(seg.pitch * stToRatio(this.config.masterPitchSt ?? 0), 1), 0.1, 2);
      u.rate = clamp(finite(seg.rate * (this.config.masterRate ?? 1) * this.rateScale, 1), 0.1, 4);
      u.volume = clamp(finite(seg.volume, 1), 0, 1);
      u.onstart = () => {
        if (this.gen === my) this.handleStart(i);
      };
      u.onend = () => {
        if (this.gen === my) this.handleEnd(i, "end");
      };
      u.onerror = (e) => {
        if (this.gen === my) this.handleError(i, e);
      };
      u.onboundary = (e) => {
        if (this.gen === my) this.handleBoundary(i, e);
      };
      this.live.set(i, u);
      this.speakCalledAt = performance.now();
      this.speakAt.set(i, this.speakCalledAt);
      this.hookOwed.add(i);
      if (isPrequeue) this.prequeued.add(i);

      // A prequeued segment's start is a whole segment away, so `advance`
      // announces it at the gap instead: announcing it here would aim the mouth
      // at a segment nobody can hear yet, and its unhold would arrive while
      // nothing is held — dropped, leaving the mouth shut for that segment.
      //
      // Anticipation: tell the mouth to open LEAD_MS *before* the learned
      // latency elapses, so it is already alive when the first phoneme lands
      // instead of snapping open two hundred milliseconds late.
      if (!isPrequeue) {
        const lead = Math.max(0, this.startMs() - LEAD_MS);
        this.fireSegmentStart(i, this.speakCalledAt + lead);
      }

      try {
        synth.speak(u);
      } catch {
        this.handleError(i, null);
        return;
      }
      // A prequeued segment's start guard cannot begin counting until the
      // engine reaches it; `advance` arms it when the previous segment ends.
      if (!isPrequeue) this.armStartWatchdog(i, my);
    }
  }

  /** Each segment is announced exactly once, whoever gets there first. */
  private fireSegmentStart(i: number, startAt: number): void {
    if (!this.hookOwed.delete(i)) return;
    const seg = this.score?.segments[i];
    if (seg) this.hooks.onSegmentStart?.(seg, i, this.cps(), startAt);
  }

  /** Prequeue only when the intended gap is shorter than the engine's own join. */
  private depth(): number {
    const seg = this.score?.segments[this.queued - 1];
    if (!seg) return 1;
    return seg.pauseAfterMs <= this.joinMs() + 40 ? 2 : 1;
  }

  private cps() {
    return this.selection?.cps ?? UNKNOWN_ENGINE.cpsEn;
  }
  private joinMs() {
    return this.selection?.joinMs ?? UNKNOWN_ENGINE.joinMs;
  }
  private startMs() {
    return this.selection?.startMs ?? UNKNOWN_ENGINE.startMs;
  }

  private handleStart(i: number): void {
    if (this.startedSeg.has(i)) return; // defect 3: never restart a running timeline
    this.startedSeg.add(i);
    const now = performance.now();
    this.playing = i;
    this.segStartAt = now;
    this.endGuardStage = 0;
    if (this.firstAudioAt === 0) this.firstAudioAt = now;

    const p = this.selection;
    if (this.prequeued.has(i)) {
      // The prequeued path measures the join we could not schedule away, and
      // nothing about start latency: its `speak()` was called a whole segment
      // ago, so folding that in would teach a start of seconds.
      const observed = this.lastEndAt > 0 ? now - this.lastEndAt : -1;
      if (p && observed >= 0 && observed < 2000)
        p.joinMs = clamp(ema(p.joinMs, observed, 0.4), 5, 900);
    } else {
      const called = this.speakAt.get(i);
      const latency = called === undefined ? -1 : now - called;
      if (p && latency >= 0 && latency < 3000) p.startMs = ema(p.startMs, latency, 0.3);
    }
    this.prequeued.delete(i);
    // Belt and braces: if the gap announcement never happened, the mouth still
    // learns of this segment at the moment it becomes audible.
    this.fireSegmentStart(i, now);
    this.clearStartWatchdog(i);
    this.armEndWatchdog(i, this.gen);
    this.armBoundaryProbe(i, now);
  }

  private handleBoundary(i: number, e: SpeechSynthesisEvent): void {
    if (i !== this.playing) return;
    const seg = this.score?.segments[i];
    if (!seg || seg.srcStart < 0) return; // an injected opener indexes nothing
    const raw = e.charIndex;
    if (!Number.isFinite(raw) || raw < 0 || raw > seg.text.length) return;
    const abs = seg.srcStart + Math.min(raw, seg.text.length);
    // Firefox reports the END of a word and Edge interleaves sentence events;
    // a non-monotonic index would teleport the mouth backwards.
    if (abs < this.lastCharIndex - 2) return;
    this.lastCharIndex = abs;
    this.sawBoundary = true;
    const len = Number.isFinite(e.charLength) && e.charLength > 0 ? e.charLength : 1;
    this.hooks.onWord?.(abs, len, e.name || "word");
  }

  private handleEnd(i: number, why: "end" | "forced"): void {
    const now = performance.now();
    const seg = this.score?.segments[i];
    // A segment whose `start` never fired still ends; without this its duration
    // would be measured from a stale anchor and poison the rate estimate.
    const heard = this.startedSeg.has(i);
    const began = heard ? this.segStartAt : (this.speakAt.get(i) ?? now);
    this.startedSeg.add(i);
    this.live.delete(i);
    this.speakAt.delete(i);
    this.clearEndWatchdog();
    this.clearKicker();
    this.clearStartWatchdog(i);
    if (!seg) return;
    if (this.firstAudioAt === 0) this.firstAudioAt = began;
    const actual = now - began;
    this.realisedMs += actual;

    if (why === "end" && heard && i === this.playing) {
      // Every segment's true duration is a free lesson in how fast this voice
      // reads — but only after the engine's own trailing silence comes off.
      const trail = TRAIL_SILENCE[seg.text.slice(-1)] ?? 0.04;
      const audio = actual / 1000 - trail;
      const p = this.selection;
      if (p && audio > 0.18 && seg.wchars >= 8) {
        const obs = seg.wchars / audio / seg.rate;
        if (obs >= 4 && obs <= 40) {
          p.cps = clamp(ema(p.cps, obs, 0.35), 4, 40);
          saveCalibration(VoicePool.calKey(p), VoicePool.calOf(p));
        }
      }
    }
    this.lastEndAt = now;
    // Re-armed against what is LEFT: one optimistic estimate taken before any
    // audio existed declares a slow voice stalled halfway through the reply.
    this.armReplyWatchdog(i + 1);
    this.hooks.onSegmentEnd?.(seg, i, seg.pauseAfterMs, actual);
    this.advance(i);
  }

  private handleError(i: number, e: SpeechSynthesisErrorEvent | null): void {
    const err = e?.error ?? "";
    this.live.delete(i);
    this.speakAt.delete(i);
    this.clearEndWatchdog();
    // "interrupted" and "canceled" are OUR cancels arriving late, not failures.
    if (err === "interrupted" || err === "canceled") return;
    const p = this.selection;
    if (
      p &&
      /network|synthesis-unavailable|synthesis-failed|audio-busy/.test(err) &&
      this.retriedSeg !== i
    ) {
      this.pool.blacklist(p.uri);
      const next = this.pool.best(p.want);
      this.retriedSeg = i;
      this.stallRetries++;
      if (next && next.uri !== p.uri) {
        this.selection = next;
        try {
          this.synth?.cancel(); // a later segment may already be queued behind it
        } catch {
          /* nothing queued */
        }
        this.live.clear();
        this.queued = i;
        this.startedSeg.delete(i);
        this.cancelAt = performance.now();
        this.pump();
        return;
      }
      // Nothing left to speak with: mime the rest rather than dropping the reply.
      this.selection = null;
      this.runSilent(i);
      return;
    }
    this.advance(i);
  }

  private advance(i: number): void {
    const score = this.score;
    if (!score) return;
    const seg = score.segments[i];
    const next = score.segments[i + 1];
    if (!next) {
      if (this.live.size === 0) this.finish("complete");
      return;
    }
    if (this.queued > i + 1) {
      this.beginPrequeued(i + 1);
      return; // already in the engine's own queue
    }
    const my = this.gen;
    const pause = seg?.pauseAfterMs ?? 0;
    // A bad join estimate must never make a gap LONGER than intended.
    const sleep = clamp(pause - this.joinMs(), 0, pause);
    this.scheduledSleep = sleep;
    // The inhale belongs at the START of the gap, where it covers the silence.
    if (next.breathBefore && pause >= 380) this.breath(Math.min(220, pause * 0.6));
    this.timer = window.setTimeout(() => {
      if (this.gen !== my) return;
      // What the timer could not schedule away is the engine's own overhead.
      const overhead = performance.now() - this.lastEndAt - this.scheduledSleep;
      const p = this.selection;
      if (p && overhead >= 0 && overhead < 600) p.joinMs = clamp(ema(p.joinMs, overhead, 0.25), 5, 900); // prettier-ignore
      this.scheduledSleep = 0;
      this.pump();
    }, sleep);
  }

  /**
   * The engine has just released the device and a prequeued utterance is next.
   * Only now is it worth announcing — one join latency out, so the mouth still
   * leads the audio — and only now can its start guard begin counting.
   */
  private beginPrequeued(j: number): void {
    if (!this.live.has(j) || this.startedSeg.has(j)) return;
    this.fireSegmentStart(j, performance.now() + Math.max(0, this.joinMs() - LEAD_MS));
    this.armStartWatchdog(j, this.gen);
  }

  // ────────────────────────────────────────────────────────────── silent path

  private runSilent(from: number): void {
    const score = this.score;
    if (!score) return;
    const my = this.gen;
    let i = from;
    // The wall clock owns the schedule from here; nothing is owed to an
    // utterance any more.
    this.hookOwed.clear();
    const step = () => {
      if (this.gen !== my || !this.score) return;
      const seg = this.score.segments[i];
      if (!seg) {
        this.finish("silent");
        return;
      }
      const now = performance.now();
      this.playing = i;
      this.segStartAt = now;
      if (this.firstAudioAt === 0) this.firstAudioAt = now;
      this.startedSeg.add(i);
      this.hooks.onSegmentStart?.(seg, i, this.cps(), now);
      if (seg.breathBefore) this.breath(160);
      this.silentTimer = window.setTimeout(() => {
        if (this.gen !== my || !this.score) return;
        this.realisedMs += seg.estMs;
        this.hooks.onSegmentEnd?.(seg, i, seg.pauseAfterMs, seg.estMs);
        i++;
        this.silentTimer = window.setTimeout(step, seg.pauseAfterMs);
      }, seg.estMs);
    };
    step();
  }

  // ────────────────────────────────────────────────────────────────  watchdogs

  private armStartWatchdog(i: number, my: number): void {
    this.clearStartWatchdog(i);
    const local = this.selection?.localService !== false;
    const wait = local ? WATCHDOG_START_LOCAL_MS : WATCHDOG_START_REMOTE_MS;
    const guard = window.setTimeout(() => {
      this.startGuards.delete(i);
      if (this.gen !== my || this.startedSeg.has(i)) return;
      if (this.synth?.speaking) {
        // Audio is running, the event just never came. Synthesise the start at
        // the moment the engine most likely began.
        const called = this.speakAt.get(i) ?? performance.now();
        this.handleStart(i);
        this.segStartAt = called + this.joinMs();
      } else {
        this.handleError(i, null);
      }
    }, wait);
    this.startGuards.set(i, guard);
  }

  private armEndWatchdog(i: number, my: number): void {
    this.clearEndWatchdog();
    const seg = this.score?.segments[i];
    if (!seg) return;
    const hard =
      this.endGuardStage === 0 ? seg.estMs * WATCHDOG_END_FACTOR + WATCHDOG_END_SLACK_MS : 800;
    this.endGuard = window.setTimeout(() => {
      if (this.gen !== my || !this.live.has(i)) return;
      const synth = this.synth;
      if (this.endGuardStage === 0 && synth?.speaking && !synth.paused && this.canKick()) {
        this.endGuardStage = 1;
        try {
          synth.pause();
          synth.resume();
        } catch {
          /* some engines refuse; the second stage still fires */
        }
        this.armEndWatchdog(i, my);
        return;
      }
      this.endGuardStage = 0;
      this.stallRetries++;
      try {
        synth?.cancel();
      } catch {
        /* already gone */
      }
      this.cancelAt = performance.now();
      this.live.clear();
      this.queued = i + 1;
      this.handleEnd(i, "forced");
    }, hard);
    this.armKicker(i, my, seg);
  }

  /**
   * Chrome's ~15 s cutoff is structurally unreachable (no segment exceeds 6.5 s),
   * so this is a backstop only — and it is Chromium-desktop only, because
   * `pause()` can kill audio outright on Safari and iOS.
   */
  private armKicker(i: number, my: number, seg: Segment): void {
    this.clearKicker();
    if (!this.canKick() || seg.estMs < 4000) return;
    this.kicker = window.setInterval(() => {
      const synth = this.synth;
      if (this.gen !== my || !this.live.has(i) || !synth) return this.clearKicker();
      if (document.hidden) return;
      if (performance.now() - this.segStartAt < 9000) return;
      if (synth.speaking && !synth.paused) {
        try {
          synth.pause();
          synth.resume();
        } catch {
          /* ignore */
        }
      }
    }, RESUME_KICK_MS);
  }

  private canKick(): boolean {
    return isChromiumDesktop() && (this.selection?.engineProfile.resumeKick ?? false);
  }

  /**
   * Probe `boundary` support inside the first segment instead of trusting the
   * per-engine prior — neither claim about Chrome's remote voices is stable
   * across versions, and the mouth must not depend on either.
   */
  private armBoundaryProbe(i: number, now: number): void {
    if (i !== 0) return;
    const seg = this.score?.segments[0];
    if (!seg) return;
    this.boundaryDeadline = now + Math.min(600, seg.estMs * 0.6);
    const my = this.gen;
    window.setTimeout(
      () => {
        if (this.gen !== my) return;
        const p = this.selection;
        if (!p) return;
        const support = this.sawBoundary ? (p.boundary === "none" ? "sparse" : p.boundary) : "none";
        if (support !== p.boundary) {
          p.boundary = support;
          saveCalibration(VoicePool.calKey(p), VoicePool.calOf(p));
        }
      },
      Math.max(0, this.boundaryDeadline - now) + 40,
    );
  }

  private armReplyWatchdog(from = 0): void {
    window.clearTimeout(this.replyGuard);
    const segs = this.score?.segments;
    if (!segs) return;
    let left = 0;
    for (let i = from; i < segs.length; i++) {
      const s = segs[i];
      if (s) left += s.estMs + s.pauseAfterMs;
    }
    const my = this.gen;
    const budget = left * 1.6 + REPLY_WATCHDOG_SLACK_MS;
    this.replyGuard = window.setTimeout(() => {
      if (this.gen === my && this.score) this.finish("stalled");
    }, budget);
  }

  // ──────────────────────────────────────────────────────────────── finishing

  private finish(reason: EndReason): void {
    // Wall clock from the first sound to the last, gaps included: the lip-sync
    // engine subtracts its own held time from this to learn the voice's rate.
    const sec = this.firstAudioAt > 0 ? (performance.now() - this.firstAudioAt) / 1000 : 0;
    this.clearTimers();
    // A natural completion leaves nothing live. Anything else — a watchdog
    // calling the turn over — must silence what is still inside the engine, or
    // the mic reopens on a voice the whole app believes has stopped.
    if (this.live.size > 0) {
      this.gen++;
      const synth = this.synth;
      if (synth) {
        try {
          synth.cancel();
        } catch {
          /* nothing in flight */
        }
        this.cancelAt = performance.now();
        this.armSettlePoll();
      }
    }
    this.live.clear();
    this.speakAt.clear();
    this.prequeued.clear();
    this.startedSeg.clear();
    this.hookOwed.clear();
    this.score = null;
    this.playing = -1;
    this.queued = 0;
    const settle = this.settle;
    this.settle = null;
    this.hooks.onEnd?.(reason, sec);
    settle?.(reason);
  }

  /**
   * Barge-in. A hard cut mid-viseme is jarring, so a segment that is nearly over
   * is allowed to land; anything longer is cancelled. A character that *reacts*
   * to being interrupted is more alive than one that vanishes mid-word.
   */
  stop(soft = false): void {
    if (soft && this.score) {
      const seg = this.score.segments[this.playing];
      const remaining = seg ? seg.estMs - (performance.now() - this.segStartAt) : 0;
      if (seg && remaining > 0 && remaining < 400) {
        this.score = { ...this.score, segments: this.score.segments.slice(0, this.playing + 1) };
        this.queued = this.playing + 1;
        window.clearTimeout(this.timer);
        return;
      }
    }
    this.gen++;
    this.clearTimers();
    this.live.clear();
    this.speakAt.clear();
    this.prequeued.clear();
    this.startedSeg.clear();
    this.hookOwed.clear();
    const synth = this.synth;
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* nothing in flight */
      }
      this.cancelAt = performance.now();
      this.armSettlePoll();
    }
    if (this.score) {
      const settle = this.settle;
      this.settle = null;
      this.score = null;
      this.playing = -1;
      this.queued = 0;
      const sec = this.firstAudioAt > 0 ? (performance.now() - this.firstAudioAt) / 1000 : 0;
      this.hooks.onEnd?.("cancelled", sec);
      settle?.("cancelled");
    }
  }

  /** `synth.speaking` can stick true forever; a second cancel usually clears it. */
  private armSettlePoll(): void {
    window.clearInterval(this.settleTimer);
    const started = performance.now();
    this.settleTimer = window.setInterval(() => {
      const synth = this.synth;
      if (!synth || !synth.speaking) {
        window.clearInterval(this.settleTimer);
        this.settleTimer = 0;
        return;
      }
      if (performance.now() - started < SETTLE_TIMEOUT_MS) return;
      window.clearInterval(this.settleTimer);
      this.settleTimer = 0;
      try {
        synth.cancel();
        window.setTimeout(() => {
          try {
            synth.cancel();
          } catch {
            /* out of ideas */
          }
        }, CANCEL_GUARD_MS - 30);
      } catch {
        /* out of ideas */
      }
    }, 25);
  }

  private breath(ms: number): void {
    if (this.config.reduced) return;
    const now = performance.now();
    if (now - this.lastBreathAt < BREATH_THROTTLE_MS) return;
    this.lastBreathAt = now;
    sfx.breath("in", ms);
  }

  private clearStartWatchdog(i?: number) {
    if (i === undefined) {
      for (const t of this.startGuards.values()) window.clearTimeout(t);
      this.startGuards.clear();
      return;
    }
    const t = this.startGuards.get(i);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.startGuards.delete(i);
    }
  }
  private clearEndWatchdog() {
    window.clearTimeout(this.endGuard);
    this.endGuard = 0;
  }
  private clearKicker() {
    if (this.kicker) window.clearInterval(this.kicker);
    this.kicker = 0;
  }
  private clearTimers() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.replyGuard);
    window.clearTimeout(this.silentTimer);
    this.timer = 0;
    this.replyGuard = 0;
    this.silentTimer = 0;
    this.scheduledSleep = 0;
    this.clearStartWatchdog();
    this.clearEndWatchdog();
    this.clearKicker();
  }

  diagnostics(): SpeakerDiagnostics {
    const segs = (this.score ?? this.lastScore)?.segments ?? [];
    const est = segs.reduce((a, s) => a + s.estMs, 0);
    const pause = segs.reduce((a, s) => a + s.pauseAfterMs, 0);
    return {
      voice: this.selection?.name ?? "(none)",
      engine: this.selection?.engine ?? "unknown",
      lang: this.selection?.lang ?? "-",
      cps: this.cps(),
      joinMs: this.joinMs(),
      boundary: this.selection?.boundary ?? "?",
      segments: segs.length,
      realisedSec: this.realisedMs / 1000,
      estSec: est / 1000,
      silenceFraction: est + pause > 0 ? pause / (est + pause) : 0,
      meanSegSec: segs.length ? est / segs.length / 1000 : 0,
      stalls: this.stallRetries,
      dialectCompromise: this.dialectCompromise,
    };
  }

  dispose(): void {
    this.stop();
    this.pool.dispose();
    window.clearInterval(this.settleTimer);
    this.settleTimer = 0;
    if (typeof window !== "undefined") {
      if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
      if (this.onLeave) window.removeEventListener("pagehide", this.onLeave);
    }
    this.onVisible = null;
    this.onLeave = null;
  }
}

/** Duration-weighted mean rate — what the lip-sync engine should time against. */
function meanRate(score: Score): number {
  let num = 0;
  let den = 0;
  for (const s of score.segments) {
    num += s.rate * s.wchars;
    den += s.wchars;
  }
  return den > 0 ? num / den : 1;
}
