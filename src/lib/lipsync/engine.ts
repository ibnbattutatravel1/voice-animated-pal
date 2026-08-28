/**
 * The LipSync engine.
 *
 * `prepare()` compiles a reply into a phone-level score with real durations;
 * `sample()` plays that score back against a clock which the browser's sparse
 * `boundary` events steer. The clock is a drained-reservoir PLL with a strict
 * monotonicity floor, so it never rewinds and never snaps — and when it does
 * genuinely diverge it cuts, hidden behind 75 ms of forced lip closure, the way
 * an animator cuts on a blink.
 *
 * `sample()` integrates state. Call it exactly once per rAF.
 */

import { Blender } from "./blend";
import { Osc2 } from "./filter";
import { clamp, lerp, smoothstep, softclip, softmax, softmin, toward, vnoise } from "./math";
import { getPrior, learn } from "./priors";
import { FILT } from "./phones";
import { buildScore, fallbackScore } from "./score";
import {
  CORNER,
  JAW,
  NCH,
  PRESS,
  PROT,
  ROUND,
  TONGUE,
  TUCK,
  WIDE,
  isArabicText,
  restFrame,
  type Lang,
  type SpeechEvent,
  type SpeechFrame,
} from "./types";
import {
  K_ANTIC,
  K_BREATH,
  K_BROW,
  K_HIT,
  K_NOD,
  K_POP,
  K_PUCKER,
  K_SPREAD,
  type Chan,
  type Phrase,
  type Score,
  type Seg,
} from "./model";

export type Phase = "idle" | "preroll" | "speak" | "outro";

/**
 * Film convention puts the mouth shape one or two frames ahead of the sound.
 * Visual *lead* is far more tolerable than visual lag, and it also absorbs the
 * browser's boundary dispatch latency.
 */
const LEAD = 0.045;

const K_WARP = 7.5; // a correction drains with τ ≈ 133 ms
const KP = 0.9,
  KI = 0.25;
const RHO_MIN = 0.55,
  RHO_MAX = 2.0;
/** The monotonicity floor — the whole no-snap guarantee lives in this constant. */
const MIN_RATE = 0.12;
const SOFT = 0.32,
  HARD = 0.45;

/** 0 = naturalistic, 1 = Saturday morning. */
const DEFAULT_STYLE = 0.85;

const shape = (v: number, k: number) =>
  k < 1e-3 ? v : 0.5 + (0.5 * Math.tanh(k * (2 * v - 1))) / Math.tanh(k);

export class LipSync {
  /** 0..1 cartoon strength, live-tunable. */
  style = DEFAULT_STYLE;
  /** Honour the OS "reduce motion" setting: smaller idle life, gentler stylizer. */
  reduced = false;
  /** What the face does while nothing is being spoken. */
  idleMood: "idle" | "listening" | "thinking" = "idle";
  /** 0..1 mic amplitude, for the listening back-channel. */
  micLevel = 0;

  private score: Score | null = null;
  private ph: Phase = "idle";
  private frame: SpeechFrame = restFrame();

  private f: Osc2[] = FILT.map(
    ([fu, fd, zu, zd, vm], i) => new Osc2(fu, fd, zu, zd, vm, i === CORNER ? -1 : 0, 1),
  );
  private nod = new Osc2(2.4, 2.2, 0.7, 0.8, 8, -1, 1);
  private cmd = new Float32Array(NCH);
  private lastCmd = new Float32Array(NCH);
  private blender = new Blender();
  private closures: Seg[] = [];
  private cloI = 0;
  private phraseI = 0;

  // ── clock ────────────────────────────────────────────────────────────────
  private tNom = 0;
  private rho = 1;
  private wRem = 0;
  private iErr = 0;
  private lastNow = 0;
  private gateUntil = -1;
  private ev = 0;
  private kk = 0;

  // ── boundary hygiene ─────────────────────────────────────────────────────
  private first = true;
  private lastChar = -1;
  private lastWord = -1;
  private lastBoundaryWall = 0;
  private burst = 0;
  private unreliable = false;
  private gotBoundary = false;
  private openLoop = false;
  private eScale = 0;
  private e0 = -1;
  private eWall = 0;

  // ── envelopes ────────────────────────────────────────────────────────────
  private accentX = 0;
  private lastAccent = 0;
  private emphSm = 0;
  private voicedSm = 0;
  private loudSm = 0;
  private browX = 0;
  private browPulse = 0;
  private breathX = 0;
  private breathPulse = 0;

  // ── phase bookkeeping ────────────────────────────────────────────────────
  private prerollT = 0;
  private outroT = 0;
  private outroJaw = 0;
  private idleT = 0;
  private partAt = -10;
  private nextPart = 7;
  private swallowAt = -10;
  private nextSwallow = 26;
  private lifeN = 0;
  private held = false;
  /** This score has already been played into: a re-arm resumes, never rewinds. */
  private spoke = false;
  /** Cleared once a segment outlives the score, so only `end()`/`stop()` may finish. */
  private endsOnScore = true;
  private releaseAt: number | null = null;
  private holdStart = 0;
  private heldTotal = 0;
  private armAt: number | null = null;
  private voiceKey = "";
  private seed = Math.random() * 100;
  private smirk = Math.random() < 0.5 ? -1 : 1;

  // ─────────────────────────────────────────────────────────────── the API

  /**
   * Compile the score and begin the inhale. Call this alongside
   * `speechSynthesis.speak()`, not at `onstart` — the engine's own start
   * latency is where the anticipatory breath belongs.
   */
  prepare(text: string, opts?: { rate?: number; lang?: Lang; voiceKey?: string }): Score {
    const lang: Lang = opts?.lang ?? (isArabicText(text) ? "ar" : "en");
    const rate = opts?.rate ?? 1;
    this.voiceKey = opts?.voiceKey ?? `default|${lang}`;
    const priorK = getPrior(this.voiceKey).k;
    let score: Score;
    try {
      score = buildScore(text, { rate, lang, priorK });
    } catch {
      // A rule-table bug must degrade to v1's best case, never to a still mouth.
      score = fallbackScore(text, rate, lang);
    }
    this.load(score);
    return score;
  }

  /** The string to hand `speechSynthesis` — Arabic has its tashkeel stripped. */
  get ttsText(): string {
    return this.score?.ttsText ?? "";
  }

  /**
   * Bind the clock. Idempotent, so it is safe from BOTH `onstart` and a
   * watchdog. The outro is interruptible: the timeline can run out before the
   * voice does, and a later segment of the same reply must be able to take the
   * mouth back rather than mime the outro through the rest of the sentence.
   */
  armIfIdle(now = performance.now()) {
    if (this.ph === "speak") return;
    if (!this.score) return;
    if (this.armAt === null) this.armAt = now;
  }

  /** Back-compat: prepare and arm in one call. */
  start(text: string, rate = 1, now = performance.now()) {
    this.prepare(text, { rate });
    this.armIfIdle(now);
  }

  /**
   * Freeze the clock between queued utterance segments. One reply is one
   * timeline and N utterances, so the score keeps its absolute times while the
   * mouth settles through the real gap between them.
   */
  hold(on: boolean, now = performance.now()) {
    if (on) {
      if (this.held) return;
      this.held = true;
      this.releaseAt = null;
      this.holdStart = now;
    } else {
      if (!this.held) return;
      this.releaseAt = now;
    }
  }

  boundary(
    charIndex: number,
    now = performance.now(),
    charLength?: number,
    name?: string,
    elapsed?: number,
  ) {
    const sc = this.score;
    if (!sc || this.ph !== "speak" || this.unreliable) return;
    if (name && name !== "word") return; // Chrome also fires "sentence"
    if (charIndex <= this.lastChar && charIndex !== 0) return;
    const nowS = now / 1000;
    if (nowS - this.lastBoundaryWall < 0.02 && ++this.burst > 3) {
      this.unreliable = true;
      return;
    }
    if (nowS - this.lastBoundaryWall >= 0.02) this.burst = 0;

    const wi = this.findWord(charIndex, charLength);
    // Strict progress. Engines that report 0 for every sentence start would
    // otherwise re-anchor us onto word 0 halfway through the reply.
    if (this.lastWord >= 0 && wi <= this.lastWord) return;
    const w = sc.words[wi];
    if (!w) return;
    this.gotBoundary = true;
    const wall = this.audioClock(elapsed, nowS);
    const err = w.t0 - this.tNom;

    if (this.first) {
      this.first = false;
      if (Math.abs(err) > 0.12) this.reseek(w.t0);
    } else if (Math.abs(err) > HARD) {
      this.hardCut(w.t0);
    } else {
      if (this.lastWord >= 0) {
        const prev = sc.words[this.lastWord];
        const dNom = prev ? w.t0 - prev.t0 : 0;
        const dWall = wall - this.lastBoundaryWall;
        if (dWall > 0.06 && dNom > 0.03) {
          const obs = clamp(dNom / dWall, 0.45, 2.4);
          const trust = Math.min(1, dWall / 0.35) * 0.35; // long gaps are more informative
          this.rho = clamp(lerp(this.rho, obs, trust), RHO_MIN, RHO_MAX);
        }
      }
      // Phase term: the reservoir is *replaced*, never accumulated, so a stale
      // correction can never keep draining into the next one.
      this.wRem = clamp(err, -SOFT, SOFT) * 0.6;
      this.iErr = clamp(this.iErr + err * 0.2, -0.6, 0.6);
      this.rho = clamp(this.rho + KP * err * 0.25 + KI * this.iErr * 0.1, RHO_MIN, RHO_MAX);
    }
    this.lastWord = wi;
    this.lastChar = charIndex;
    this.lastBoundaryWall = wall;
    this.accentX = Math.max(this.accentX, 0.35 + 0.65 * w.emph);
  }

  /** `onend` / `onerror`: a graceful outro, and it teaches the per-voice prior. */
  end(now = performance.now(), actualSec?: number) {
    if (this.ph === "idle") return;
    const sc = this.score;
    if (
      sc &&
      !sc.fallback &&
      !this.unreliable &&
      this.voiceKey &&
      actualSec != null &&
      Number.isFinite(actualSec) &&
      // `actualSec` is measured to the `end` event and so includes the engine's
      // trailing silence, which the score deliberately ends before; that is a
      // fixed few hundred milliseconds, so only an utterance long enough to
      // dwarf it says anything about tempo. Without this a one-word "Hmm"
      // measures ~2× its score and, being the FIRST observation, replaces the
      // prior outright — pinning every later reply at the 1.7 clamp.
      sc.total >= 1.2 &&
      sc.words.length >= 3
    ) {
      // Time spent frozen between segments is real but is not speech.
      learn(this.voiceKey, actualSec - this.heldTotal, sc.total);
    }
    this.beginOutro(now);
  }

  /** Hard stop (cancel) — no outro. The filters carry on into the idle frame. */
  stop() {
    this.ph = "idle";
    this.held = false;
    this.releaseAt = null;
    this.armAt = null;
    this.spoke = false;
    this.idleT = 0;
  }

  /** Deprecated spellings of `hold`, kept so older callers keep compiling. */
  pause(now = performance.now()) {
    this.hold(true, now);
  }
  resume(now = performance.now()) {
    this.hold(false, now);
  }

  /** After a backgrounded tab: let the next boundary re-anchor instead of gliding. */
  reanchor() {
    this.first = true;
    this.wRem = 0;
    this.iErr = 0;
  }

  get isActive() {
    return this.ph !== "idle";
  }

  get phase(): Phase {
    return this.ph;
  }

  /** Seconds — the number a truncation watchdog should compare against. */
  get expectedDuration() {
    return this.score?.total ?? 0;
  }

  progress(_now?: number) {
    const total = this.score?.total ?? 0;
    return total > 0 ? clamp(this.tNom / total, 0, 1) : 0;
  }

  /** Cached: `sample()` integrates, so recomputing here would double-advance. */
  accent() {
    return this.lastAccent;
  }

  /** Diagnostics for a dev overlay. Cheap, allocates one small object. */
  tempo() {
    return {
      rho: this.rho,
      wRem: this.wRem,
      tNom: this.tNom,
      openLoop: this.openLoop,
      unreliable: this.unreliable,
      prior: this.voiceKey ? getPrior(this.voiceKey).k : 1,
    };
  }

  // ───────────────────────────────────────────────────────────── the frame

  sample(now = performance.now()): SpeechFrame {
    const F = this.frame;
    F.events.length = 0;
    const raw = this.lastNow ? (now - this.lastNow) / 1000 : 1 / 60;
    this.lastNow = now;
    // The clock runs on UNCLAMPED wall time — the voice really did keep talking
    // while rAF was stopped — and only the filters clamp. A timestamp from the
    // future (a pre-scheduled segment start) yields 0 rather than a rewind.
    const dtWall = raw > 0 && raw < 30 ? raw : 0;
    const dt = clamp(dtWall, 0, 1 / 20);

    if (this.armAt !== null && this.ph !== "speak" && now >= this.armAt) this.beginSpeak(now);
    if (this.held && this.releaseAt !== null && now >= this.releaseAt) this.release(now);

    if (this.ph === "idle") return this.idleFrame(dt, F);
    if (this.ph === "preroll") return this.prerollFrame(dt, F);
    if (this.ph === "outro") return this.outroFrame(dt, F);
    if (this.held) return this.holdFrame(now, dt, F);

    const sc = this.score!;
    const nSub = dt > 1 / 45 ? Math.min(4, Math.ceil(dt * 60)) : 1;
    const h = dt / nSub;
    // The tab stall. The cut jumps the clock across the whole gap in one step,
    // so the substep loop must integrate none of it — running both would move
    // the timeline by twice the stall and leave the mouth that far ahead.
    const stalled = dtWall > 0.25;
    if (stalled) this.hardCut(this.tNom + dtWall * this.rho);
    const hw = stalled ? 0 : dtWall / nSub;

    for (let n = 0; n < nSub; n++) {
      const tPrev = this.tNom + LEAD;
      if (hw > 0) this.advance(hw);
      const t = this.tNom + LEAD;
      const cmd = this.cmd;

      this.blender.blend(t, cmd);
      if (this.blender.inFreeze(t)) {
        // A glottal stop is a *hold*: the mouth locks and tenses for ~55 ms.
        cmd.set(this.lastCmd);
        cmd[PRESS] = cmd[PRESS]! + 0.12;
      } else this.lastCmd.set(cmd);

      if (t < this.gateUntil) {
        cmd[PRESS] = Math.max(cmd[PRESS]!, 0.9);
        cmd[JAW] = cmd[JAW]! * 0.15;
      }

      const seg = this.blender.at(t);
      const e = seg?.emph ?? 0;
      cmd[JAW] = cmd[JAW]! * (0.82 + 0.36 * e);
      this.couple(cmd);
      this.stylize(cmd, e, this.accentX, seg?.cls === "SIL", t);

      this.accentX *= Math.exp(-h / 0.16);
      while (this.ev < sc.events.length && sc.events[this.ev]!.t <= t)
        this.fireEvent(sc.events[this.ev++]!, F);
      this.fireKicks(tPrev, t);

      for (let c = 0; c < NCH; c++)
        this.f[c]!.step(clamp(cmd[c]!, c === CORNER ? -1 : 0, 1), h, sc.speedFactor);

      this.applyClosure(t, h);
      if (seg) this.applyAccentFloor(seg, t, h);

      this.emphSm = toward(this.emphSm, e, 0.18, h);
      this.voicedSm = toward(this.voicedSm, seg?.voiced ?? 0, 0.05, h);
      this.loudSm = toward(this.loudSm, seg?.loud ?? 0, 0.045, h);
      this.decayEnvelopes(h);
      this.nod.step(0, h, 1);
    }

    this.publish(this.tNom + LEAD, F, true);
    if (!this.gotBoundary && this.tNom > 0.9 && sc.words.length >= 3) this.openLoop = true;
    if (this.endsOnScore && this.tNom + LEAD > sc.total + 0.25) this.beginOutro(this.lastNow);
    return F;
  }

  // ──────────────────────────────────────────────────────────── the clock

  private advance(dtWall: number) {
    const drain = this.wRem * (1 - Math.exp(-K_WARP * dtWall));
    this.wRem -= drain;
    // vt ≥ MIN_RATE > 0 makes the timeline strictly monotone no matter how large
    // or negative the error. The worst case is a held pose, never a rewind.
    const vt = Math.max(this.rho + drain / dtWall, MIN_RATE);
    this.tNom += vt * dtWall;
  }

  /**
   * `elapsedTime` is immune to rAF jitter, but its units are inconsistent
   * across engines — the spec says seconds and some Chrome builds report
   * milliseconds — so sniff the ratio on the second boundary and fall back to
   * the wall clock when it is neither.
   */
  private audioClock(elapsed: number | undefined, nowS: number): number {
    if (elapsed == null || !Number.isFinite(elapsed)) return nowS;
    if (this.eScale === 0) {
      if (this.e0 < 0) {
        this.e0 = elapsed;
        this.eWall = nowS;
        return nowS;
      }
      const de = elapsed - this.e0,
        dw = nowS - this.eWall;
      if (dw > 0.05) {
        const r = de / dw;
        this.eScale = r >= 0.5 && r <= 2 ? 1 : r >= 500 && r <= 2000 ? 0.001 : -1;
      }
      return nowS;
    }
    if (this.eScale < 0) return nowS;
    return this.eWall + (elapsed - this.e0) * this.eScale;
  }

  /** Tolerant of engines that count characters differently from us. */
  private findWord(ci: number, len?: number): number {
    const W = this.score!.words;
    let lo = 0,
      hi = W.length - 1,
      best = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (W[m]!.c0 <= ci) {
        best = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    let bi = best,
      bs = Infinity;
    for (let k = Math.max(0, best - 3); k <= Math.min(W.length - 1, best + 3); k++) {
      const w = W[k]!;
      const s = Math.abs(w.c0 - ci) * 2 + (len == null ? 0 : Math.abs(w.c1 - w.c0 - len));
      if (s < bs) {
        bs = s;
        bi = k;
      }
    }
    return bi;
  }

  /**
   * Genuine divergence. Do not glide — cut, and hide the cut behind a closed
   * mouth. The total visible artefact is a 75 ms lip closure, indistinguishable
   * from a /p/.
   */
  private hardCut(target: number) {
    // Land just before the word so the attack still plays, and never replay more
    // than 0.30 s: a cut is cheap, but re-animating a whole clause is not.
    this.reseek(Math.max(target - 0.045, this.tNom - 0.3));
    this.gateUntil = this.tNom + LEAD + 0.075;
  }

  private reseek(t: number) {
    const sc = this.score;
    this.tNom = Math.max(0, t);
    this.wRem = 0;
    this.iErr = 0;
    this.blender.seek(this.tNom);
    if (!sc) return;
    const lead = this.tNom + LEAD;
    this.ev = 0;
    while (this.ev < sc.events.length && sc.events[this.ev]!.t < lead) this.ev++;
    this.kk = 0;
    while (this.kk < sc.kicks.length && sc.kicks[this.kk]!.t < lead) this.kk++;
    this.cloI = 0;
    this.phraseI = 0;
  }

  /**
   * A queued reply pauses in *wall* time while the score's pause sits in
   * nominal time; playing both would leave the mouth a whole comma behind.
   */
  private skipPause() {
    const sc = this.score;
    if (!sc) return;
    for (const s of sc.segs) {
      if (s.t0 < this.tNom - 0.001 || s.cls === "SIL") continue;
      const gap = s.t0 - this.tNom;
      if (gap > 0.01 && gap < 1.5) this.reseek(s.t0 - 0.02);
      return;
    }
  }

  // ────────────────────────────────────────────── couplings and stylizer

  private couple(c: Chan) {
    c[WIDE] = c[WIDE]! * (1 - 0.3 * c[JAW]!); // cannot spread with the jaw wide
    c[ROUND] = c[ROUND]! * (1 - 0.35 * Math.max(0, c[JAW]! - 0.55)); // nor pucker on a gape
    c[JAW] = Math.min(c[JAW]!, 1 - 0.92 * c[PRESS]!); // lips shut ⇒ jaw shut
    c[WIDE] = c[WIDE]! * (1 - 0.55 * c[PRESS]!);
    c[PROT] = Math.min(c[PROT]!, 0.25 + 0.85 * c[ROUND]! + 0.6 * c[TUCK]!);
  }

  /**
   * TV cartoon dialogue is accurate in *timing* and deliberately exaggerated in
   * *amplitude*. Keeping the two knobs separate is what lets the timing pipeline
   * above stay honest.
   */
  private stylize(c: Chan, e: number, acc: number, inPause: boolean, t: number) {
    const S = this.reduced ? Math.min(this.style, 0.35) : this.style;
    c[JAW] = shape(c[JAW]!, 1.25 * S);
    c[ROUND] = shape(c[ROUND]!, 1.15 * S);
    c[JAW] = clamp(c[JAW]! * (1 + 0.22 * S * e), 0, 1);
    c[WIDE] = c[WIDE]! * (1 + 0.18 * e);
    c[PROT] = c[PROT]! * (1 + 0.14 * e);
    c[CORNER] = c[CORNER]! + 0.1 * acc;
    // An alive mouth always has some parting mid-phrase.
    c[JAW] = Math.max(c[JAW]!, inPause ? 0.02 : 0.048);
    const g = (1 - c[PRESS]!) * (this.reduced ? 0.35 : 1);
    c[JAW] = c[JAW]! + vnoise(t * 7.3) * 0.014 * g;
    c[WIDE] = c[WIDE]! + vnoise(t * 6.1 + 11) * 0.009 * g;
  }

  // ──────────────────────────────────────────────────────── guarantees

  private closureAt(t: number): Seg | null {
    const C = this.closures;
    while (this.cloI < C.length && C[this.cloI]!.cloT1 < t) this.cloI++;
    while (this.cloI > 0 && C[this.cloI - 1]!.cloT1 >= t) this.cloI--;
    const c = C[this.cloI];
    // The window is wider than the acoustic closure: the lips are already
    // meeting before the burst, and at 60 fps a 33 ms /b/ is two samples.
    return c && t >= c.cloT0 - 0.04 && t <= c.cloT1 + 0.05 ? c : null;
  }

  /**
   * A missed closure is the most conspicuous lip-sync failure there is, so make
   * it structurally impossible at any speaking rate. Applied after the filter,
   * with a reseat: `Math.max` on a filtered value would put a velocity kink in
   * the release.
   */
  private applyClosure(t: number, dt: number) {
    const c = this.closureAt(t);
    if (!c) return;
    const d = c.cloT1 - c.cloT0;
    const rampIn = Math.min(0.035, 0.6 * d),
      rampOut = Math.min(0.045, 0.6 * d);
    // Ramping in before t0 and out after t1 keeps a flat top wide enough that a
    // 60 fps sampler cannot step over it and leave the closure half-made.
    const req = Math.min(
      smoothstep(c.cloT0 - rampIn, c.cloT0 + 0.15 * d, t),
      1 - smoothstep(c.cloT1 - 0.15 * d, c.cloT1 + rampOut, t),
    );
    if (req <= 0.001) return;
    const K = c.closure === 1 ? 1.0 : 0.72;
    const need = K * req * c.duty;
    this.f[PRESS]!.reseat(softmax(this.f[PRESS]!.x, need, 0.06), dt);
    this.f[JAW]!.reseat(softmin(this.f[JAW]!.x, 1 - 0.92 * need, 0.06), dt);
    if (c.closure === 2) this.f[TUCK]!.reseat(softmax(this.f[TUCK]!.x, 0.85 * need, 0.06), dt);
  }

  /** A stressed vowel always opens. Capped, so a mis-stress is mild, never a spasm. */
  private applyAccentFloor(s: Seg, t: number, dt: number) {
    if (!s.nucleus || s.stress < 1) return;
    const d = s.t1 - s.t0;
    const g0 = s.t0 + d * 0.2,
      g1 = s.t1 - d * 0.2;
    if (g1 <= g0) return;
    const gate = Math.min(smoothstep(g0 - 0.025, g0, t), 1 - smoothstep(g1, g1 + 0.025, t));
    if (gate <= 0.001) return;
    const S = this.reduced ? Math.min(this.style, 0.35) : this.style;
    const tgt = s.target[JAW]!;
    const want = Math.min(tgt * (0.9 + 0.25 * s.emph) * (0.82 + 0.36 * S) * 0.8, tgt * 1.25);
    const jaw = this.f[JAW]!.x;
    const lift = Math.max(0, want * gate - jaw) * 0.7;
    if (lift > 0) this.f[JAW]!.reseat(jaw + lift, dt);
  }

  // ─────────────────────────────────────────────────── events and kicks

  private fireEvent(e: SpeechEvent, F: SpeechFrame) {
    if (e.k === "accent") this.accentX = Math.max(this.accentX, 0.35 + 0.65 * e.s);
    else if (e.k === "breath") this.breathPulse = Math.max(this.breathPulse, 0.8);
    F.events.push(e);
  }

  /**
   * The director's impulses. Because they are *velocity*, the exact integrator
   * turns each one into genuine anticipation, overshoot and follow-through with
   * no extra state.
   */
  private fireKicks(t0: number, t1: number) {
    const sc = this.score!;
    const S = this.reduced ? Math.min(this.style, 0.35) : this.style;
    while (this.kk < sc.kicks.length && sc.kicks[this.kk]!.t <= t1) {
      const k = sc.kicks[this.kk++]!;
      if (k.t < t0 - 0.2) continue;
      switch (k.k) {
        case K_ANTIC:
          this.f[JAW]!.kick(-1.8 * k.a);
          break;
        case K_HIT:
          this.f[JAW]!.kick(9 * S * (0.4 + 0.6 * k.a));
          break;
        case K_POP:
          this.f[JAW]!.kick(3.5 * k.a * S);
          this.f[PRESS]!.kick(-6);
          break;
        case K_SPREAD:
          this.f[WIDE]!.kick(2.2 * S);
          break;
        case K_PUCKER:
          this.f[ROUND]!.kick(2.6 * S);
          this.f[PROT]!.kick(2.2 * S);
          break;
        case K_BROW:
          this.browPulse = Math.max(this.browPulse, 0.35 * k.a);
          break;
        case K_NOD:
          this.nod.kick(-4.2 * k.a);
          break;
        case K_BREATH:
          this.breathPulse = Math.max(this.breathPulse, 0.8);
          break;
        default:
          break;
      }
    }
  }

  private decayEnvelopes(h: number) {
    // Brows lead the voice by ~40 ms and fall slowly — 60 ms rise, 260 ms fall.
    this.browX += (this.browPulse - this.browX) * (1 - Math.exp(-h / 0.06));
    this.browPulse *= Math.exp(-h / 0.26);
    this.breathX += (this.breathPulse - this.breathX) * (1 - Math.exp(-h / 0.12));
    this.breathPulse *= Math.exp(-h / 0.9);
  }

  // ───────────────────────────────────────────────────────────── publish

  private phraseAt(t: number): Phrase | null {
    const P = this.score?.phrases;
    if (!P || !P.length) return null;
    while (this.phraseI + 1 < P.length && P[this.phraseI + 1]!.t0 <= t) this.phraseI++;
    while (this.phraseI > 0 && P[this.phraseI]!.t0 > t) this.phraseI--;
    return P[this.phraseI] ?? null;
  }

  private publish(t: number, F: SpeechFrame, active: boolean) {
    const m = F.mouth;
    const jawV = this.f[JAW]!.v;
    // A violently moving jaw drags the corners wide; it is free motion blur.
    const smear = clamp(Math.abs(jawV) * 0.022, 0, 0.12);
    m.jaw = clamp(softclip(this.f[JAW]!.x), 0, 1);
    m.wide = clamp(softclip(this.f[WIDE]!.x + smear), 0, 1);
    m.round = clamp(this.f[ROUND]!.x, 0, 1);
    m.press = clamp(this.f[PRESS]!.x, 0, 1);
    m.protrude = clamp(this.f[PROT]!.x, 0, 1);
    m.tuck = clamp(this.f[TUCK]!.x, 0, 1);
    m.tongue = clamp(this.f[TONGUE]!.x, 0, 1);
    m.corner = clamp(this.f[CORNER]!.x, -1, 1);

    const sc = this.score;
    const ph = active ? this.phraseAt(t) : null;
    const span = ph ? Math.max(0.05, ph.t1 - ph.t0) : 1;
    const pos = ph ? clamp((t - ph.t0) / span, 0, 1) : 0;
    const k = ph ? smoothstep(ph.t1 - 0.35, ph.t1, t) : 0;
    const into = ph ? ph.tone * k : 0;
    // A cartoon character always finishes a line on a positive shape. It costs
    // nothing and changes everything about likeability.
    const land = sc ? smoothstep(sc.total - 0.4, sc.total, t) : 0;

    this.lastAccent = clamp(this.accentX, 0, 1);
    F.accent = this.lastAccent;
    F.emphasis = clamp(this.emphSm, 0, 1);
    F.skew = clamp(
      m.corner * 0.25 + 0.25 * Math.sin(t * 0.82 + this.seed) + 0.4 * this.emphSm * this.smirk,
      -1,
      1,
    );
    F.smile = clamp(
      0.28 +
        0.3 * m.wide -
        0.2 * m.round +
        0.22 * this.emphSm +
        0.35 * Math.max(0, into) +
        0.3 * land,
      0,
      1,
    );
    F.brow = clamp(this.browX + 0.35 * Math.max(0, into), -0.4, 1);
    F.nod = clamp(this.nod.x + (ph ? (ph.tone < 0 ? -0.18 : 0.16) * k : 0), -1, 1);
    F.tilt = ph ? 0.8 * Math.sin(pos * Math.PI) * ph.tilt : 0;
    F.turn = ph ? ph.turn : 0;
    F.breath = clamp(this.breathX, 0, 1);
    F.voiced = clamp(this.voicedSm, 0, 1);
    F.energy =
      clamp(0.14 + 0.66 * this.loudSm * (0.5 + 0.5 * m.jaw) + 0.26 * F.accent, 0, 1) *
      (0.35 + 0.65 * this.voicedSm);
    F.intonation = clamp(into, -1, 1);
    F.phrasePos = pos;
    F.active = active;
  }

  // ────────────────────────────────────────────────────────── the phases

  private load(score: Score) {
    this.score = score;
    this.blender.load(score.segs);
    this.closures = score.segs.filter((s) => s.closure !== 0);
    this.ph = "preroll";
    this.prerollT = 0;
    this.armAt = null;
    this.held = false;
    this.spoke = false;
    this.endsOnScore = true;
    this.releaseAt = null;
    this.heldTotal = 0;
    this.tNom = 0;
    this.rho = 1;
    this.wRem = 0;
    this.iErr = 0;
    this.gateUntil = -1;
    this.ev = 0;
    this.kk = 0;
    this.cloI = 0;
    this.phraseI = 0;
    this.first = true;
    this.lastChar = -1;
    this.lastWord = -1;
    this.lastBoundaryWall = 0;
    this.burst = 0;
    this.unreliable = false;
    this.gotBoundary = false;
    this.openLoop = false;
    this.eScale = 0;
    this.e0 = -1;
  }

  private beginSpeak(now: number) {
    const resume = this.spoke;
    this.ph = "speak";
    this.armAt = null;
    this.lastNow = now;
    this.spoke = true;
    if (resume) {
      // A later segment of a reply whose timeline has already run out — the
      // only way back here, since the overrun is what ended the speak phase.
      // Rewinding would mouth the opening of the reply over its closing
      // sentence, so keep the clock where it is, settle on the score's last
      // pose, and let the real `end()` do the landing.
      this.endsOnScore = false;
      this.wRem = 0;
      this.iErr = 0;
      return;
    }
    // Start the visual timeline at the utterance's own zero rather than LEAD ms
    // into it: a word-initial /p/ closure is shorter than the lookahead, and
    // skipping it is the one closure the guarantee cannot rescue. The first
    // boundary restores the lead within a word.
    this.tNom = -LEAD;
    this.rho = 1;
    this.wRem = 0;
    this.iErr = 0;
    this.gateUntil = -1;
    this.blender.seek(0);
    this.ev = 0;
    this.kk = 0;
    this.cloI = 0;
    this.phraseI = 0;
  }

  private release(now: number) {
    this.held = false;
    this.releaseAt = null;
    this.heldTotal += Math.max(0, (now - this.holdStart) / 1000);
    this.skipPause();
  }

  private beginOutro(now: number) {
    if (this.ph === "outro") return;
    this.ph = "outro";
    this.outroT = 0;
    this.outroJaw = this.f[JAW]!.x;
    this.held = false;
    this.releaseAt = null;
    this.armAt = null;
    this.lastNow = now;
  }

  /**
   * The pull-back before the first word is the classic anticipation beat: the
   * difference between a character that *starts talking* and one whose mouth
   * suddenly begins moving.
   */
  private prerollFrame(dt: number, F: SpeechFrame): SpeechFrame {
    this.prerollT += dt;
    if (this.prerollT > 2.5) {
      this.ph = "idle";
      this.idleT = 0;
      return this.idleFrame(dt, F);
    }
    const x = clamp(this.prerollT / 0.22, 0, 1);
    const a = this.reduced ? 0.4 : 1;
    const tgt = this.cmd;
    tgt.fill(0);
    tgt[JAW] = 0.14 * x * a;
    tgt[ROUND] = 0.1 * x * a;
    for (let c = 0; c < NCH; c++) this.f[c]!.step(tgt[c]!, dt, 1);
    this.breathX = toward(this.breathX, 0.8 * x * a, 0.12, dt);
    this.browX = toward(this.browX, 0.3 * x * a, 0.1, dt);
    this.nod.step(-0.15 * x * a, dt, 1); // the head pulls BACK before it goes forward
    this.publish(0, F, true);
    F.breath = clamp(this.breathX, 0, 1);
    F.brow = this.browX;
    F.energy = 0.1;
    return F;
  }

  /** Between queued segments: settle to a soft closure rather than run on. */
  private holdFrame(now: number, dt: number, F: SpeechFrame): SpeechFrame {
    const tgt = this.cmd;
    tgt.fill(0);
    tgt[JAW] = 0.03;
    tgt[PRESS] = 0.42;
    for (let c = 0; c < NCH; c++) this.f[c]!.step(tgt[c]!, dt, 1);
    // A gap long enough to notice is a gap long enough to breathe in.
    if (now - this.holdStart > 250) this.breathPulse = Math.max(this.breathPulse, 0.55);
    this.decayEnvelopes(dt);
    this.nod.step(0, dt, 1);
    this.accentX *= Math.exp(-dt / 0.16);
    this.emphSm = toward(this.emphSm, 0, 0.25, dt);
    this.voicedSm = toward(this.voicedSm, 0, 0.08, dt);
    this.loudSm = toward(this.loudSm, 0, 0.08, dt);
    this.publish(this.tNom + LEAD, F, true);
    return F;
  }

  /** Replaces v1's `jaw *= 0.8`: follow-through, a settle, then a soft lip smack. */
  private outroFrame(dt: number, F: SpeechFrame): SpeechFrame {
    const t = (this.outroT += dt);
    const tgt = this.cmd;
    tgt.fill(0);
    if (t < 0.12) tgt[JAW] = this.outroJaw + 0.06;
    else if (t < 0.3) {
      tgt[JAW] = 0;
      if (t - dt < 0.12) this.f[JAW]!.kick(-1.2);
    } else if (t < 0.42) tgt[PRESS] = lerp(0.3, 0.1, (t - 0.3) / 0.12);

    for (let c = 0; c < NCH; c++) this.f[c]!.step(tgt[c]!, dt, 1);
    this.decayEnvelopes(dt);
    this.nod.step(0, dt, 1);
    this.accentX *= Math.exp(-dt / 0.2);
    this.emphSm = toward(this.emphSm, 0, 0.3, dt);
    this.voicedSm = toward(this.voicedSm, 0, 0.12, dt);
    this.loudSm = toward(this.loudSm, 0, 0.12, dt);
    this.publish(this.score?.total ?? 0, F, true);
    // The landing: hold the smile for 600 ms after the voice stops.
    F.smile = Math.max(F.smile, t < 0.6 ? 0.42 : lerp(0.42, 0.2, clamp((t - 0.6) / 0.4, 0, 1)));
    F.energy = clamp(0.14 * (1 - t / 1.02), 0, 1);
    if (t > 1.02) {
      this.ph = "idle";
      this.idleT = 0;
    }
    return F;
  }

  /**
   * True idle. The face is never a still frame, which is also why the caller's
   * pump has no "not speaking" branch at all.
   */
  private idleFrame(dt: number, F: SpeechFrame): SpeechFrame {
    const t = (this.idleT += dt);
    const a = this.reduced ? 0.35 : 1;
    const s = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.21 * t + this.seed);
    const tgt = this.cmd;
    tgt.fill(0);
    let jaw = 0.028 + 0.022 * s + 0.006 * vnoise(t * 0.9);

    if (t > this.nextPart) {
      this.partAt = t;
      this.nextPart = t + 6 + 8 * (0.5 + 0.5 * Math.sin(this.lifeN++ * 2.399));
    }
    const pa = t - this.partAt;
    if (pa >= 0 && pa < 0.3) jaw += 0.1 * Math.sin((Math.PI * pa) / 0.3);

    if (t > this.nextSwallow) {
      this.swallowAt = t;
      this.nextSwallow = t + 22 + 23 * (0.5 + 0.5 * Math.sin(this.lifeN++ * 1.732));
    }
    const sa = t - this.swallowAt;
    if (sa >= 0 && sa < 0.18) {
      const k = Math.sin((Math.PI * sa) / 0.18);
      jaw = Math.max(jaw, 0.06 * k);
      tgt[PRESS] = 0.35 * k;
    }

    if (this.idleMood === "thinking") {
      tgt[ROUND] = 0.3;
      tgt[PRESS] = Math.max(tgt[PRESS]!, 0.55);
      tgt[PROT] = 0.22;
      tgt[CORNER] = -0.18;
    } else if (this.idleMood === "listening") {
      // A micro back-channel: the jaw twitches on the peaks of what it hears.
      jaw += clamp(this.micLevel, 0, 1) * 0.05;
      tgt[CORNER] = 0.12;
    }

    tgt[JAW] = jaw * a;
    for (let c = 0; c < NCH; c++) this.f[c]!.step(c === JAW ? tgt[c]! : tgt[c]! * a, dt, 1);
    this.breathX = toward(this.breathX, s, 0.25, dt);
    this.browX = toward(this.browX, 0, 0.3, dt);
    this.accentX *= Math.exp(-dt / 0.2);
    this.emphSm = toward(this.emphSm, 0, 0.3, dt);
    this.voicedSm = toward(this.voicedSm, 0, 0.2, dt);
    this.loudSm = toward(this.loudSm, 0, 0.2, dt);
    this.nod.step(0, dt, 1);
    this.publish(0, F, false);
    F.breath = clamp(this.breathX, 0, 1);
    F.smile = this.idleMood === "thinking" ? 0.18 : 0.3;
    F.energy = 0;
    return F;
  }
}
