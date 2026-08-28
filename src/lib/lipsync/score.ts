/**
 * Score assembly: text in, a time-ordered list of gestures out.
 *
 * Everything expensive happens here, once per utterance and off the render
 * path — `send()` already waits before speaking, and every engine has 100–400 ms
 * of latency before `onstart`. The per-frame path then does nothing but read.
 */

import { clamp, hash1, lerp } from "./math";
import { normalize } from "./normalize";
import { enWord, markReduction } from "./g2p-en";
import { arRegister, arWord, endsInVowel } from "./g2p-ar";
import {
  durationOf,
  PAUSE_MS,
  pauseSeconds,
  pauseWeightOf,
  PHRASE_BREAK,
  SYLL_RATE,
  type Ctx,
} from "./duration";
import {
  alphaOf,
  baseSym,
  emphShift,
  infoOf,
  SALIENCE,
  TARGET,
  targetOf,
  widthsOf,
} from "./phones";
import { emphasisOf, schedule, toneOf, type WordMeta } from "./prosody";
import { CORNER, JAW, NCH, PRESS, PROT, ROUND, TONGUE, TUCK, WIDE } from "./types";
import type { Lang, Tone } from "./types";
import type { Chan, Cls, Phone, Phrase, Score, Seg, Syl, Word, WordPlan } from "./model";

const WORD_CH = /[\p{L}\p{M}\p{N}']/u;

type Tok = { w: boolean; a0: number; a1: number; s: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (WORD_CH.test(c)) {
      const a0 = i;
      while (i < text.length && WORD_CH.test(text[i]!)) i++;
      let a1 = i;
      while (a1 > a0 && text[a1 - 1] === "'") a1--;
      let b0 = a0;
      while (b0 < a1 && text[b0] === "'") b0++;
      if (b0 < a1) out.push({ w: true, a0: b0, a1, s: text.slice(b0, a1) });
      continue;
    }
    if (PAUSE_MS[c] !== undefined) out.push({ w: false, a0: i, a1: i + 1, s: c });
    i++;
  }
  return out;
}

type WB = {
  plan: WordPlan;
  meta: WordMeta;
  text: string;
  c0: number;
  c1: number;
  emph: number;
  nuclear: boolean;
  phrase: number;
};

type Item = { k: "w"; wb: WB } | { k: "p"; punct: string; brk: boolean };

/** English EY/AY/OY/AW/OW are two gestures; the blend then draws the arc for free. */
const DIPH: Record<string, readonly [string, string, number]> = {
  EY: ["EH", "IY", 0.55],
  AY: ["AA", "IH", 0.58],
  OY: ["AO", "IH", 0.55],
  AW: ["AA", "UH", 0.55],
  OW: ["AOo", "UW", 0.5],
};

const BILABIAL = new Set(["P", "B", "M"]);
const LABIODENTAL = new Set(["F", "V"]);
const VOICELESS = new Set(["P", "T", "K", "F", "TH", "S", "SH", "CH", "HH", "Q", "QAF", "KHA"]);
const LIP_CH = [WIDE, ROUND, PROT, CORNER, TONGUE, TUCK];

function loudOf(cls: Cls, emph: number): number {
  switch (cls) {
    case "VLONG":
    case "VDIPH":
      return 0.9 + 0.1 * emph;
    case "VSHORT":
      return 0.78;
    case "VSCHWA":
      return 0.55;
    case "PHAR":
      return 0.6;
    case "NAS":
    case "LAT":
    case "RHO":
    case "GLIDE":
    case "TAP":
      return 0.5;
    case "FRICS":
      return 0.34;
    case "FRICN":
      return 0.28;
    case "SIL":
      return 0;
    default:
      return 0.25;
  }
}

type SegInit = {
  sym: string;
  cls: Cls;
  t0: number;
  dur: number;
  target: Chan;
  alphaScale: number;
  emph: number;
  stress: 0 | 1 | 2;
  nucleus: boolean;
  freeze: boolean;
  voiced: 0 | 1;
  loud: number;
  closure: 0 | 1 | 2;
  pauseBefore: number;
  word: number;
  phrase: number;
};

function makeSeg(o: SegInit): Seg {
  const alpha = new Float32Array(NCH);
  alphaOf(o.sym, infoOf(o.sym).place, alpha);
  if (o.alphaScale !== 1) for (let c = 0; c < NCH; c++) alpha[c] = alpha[c]! * o.alphaScale;
  const wa = new Float32Array(NCH);
  const wc = new Float32Array(NCH);
  widthsOf(o.sym, o.dur, wa, wc);
  const t1 = o.t0 + o.dur;
  return {
    sym: o.sym,
    cls: o.cls,
    t0: o.t0,
    t1,
    dur: o.dur,
    target: o.target,
    alpha,
    wa,
    wc,
    closure: o.closure,
    cloT0: o.t0,
    cloT1: t1,
    duty: 1,
    freeze: o.freeze,
    nucleus: o.nucleus,
    stress: o.stress,
    emph: o.emph,
    loud: o.loud,
    voiced: o.voiced,
    pauseBefore: o.pauseBefore,
    word: o.word,
    phrase: o.phrase,
  };
}

/** Base target, then reduction, then emphatic backing — one resolved vector per segment. */
function resolveTarget(sym: string, reduce: number, emphF: number): Chan {
  const t = Float32Array.from(targetOf(sym));
  if (reduce > 0) {
    const ax = TARGET["AX"]!;
    for (let c = 0; c < NCH; c++) t[c] = lerp(t[c]!, ax[c]!, reduce);
  }
  if (emphF > 0) emphShift(t, emphF);
  return t;
}

/**
 * The animator's pass, and the thing that makes this read as cartoon lip sync
 * rather than a phonetic simulation.
 *
 * Preston Blair's rule: you do not animate every phoneme, you animate the shapes
 * you can *see* and hold each for at least two frames. Implemented with
 * dominance weights instead of deletion, so continuity survives — and the jaw is
 * untouched, so the rhythm stays dense while the shapes get sparse. That
 * contrast is precisely what a TV cartoon mouth looks like.
 */
function reduceKeys(segs: Seg[], speedFactor: number) {
  if (!segs.length) return;
  const bucket = clamp(0.085 / speedFactor, 0.055, 0.11);
  let b0 = segs[0]!.t0;
  let i = 0;
  while (i < segs.length) {
    const b1 = b0 + bucket;
    let j = i,
      best = -1,
      bestScore = -1;
    while (j < segs.length && segs[j]!.t0 < b1) {
      const s = segs[j]!;
      const score =
        (SALIENCE[baseSym(s.sym)] ?? 0.3) * (0.6 + 0.4 * s.emph) * Math.min(1, s.dur / 0.07);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
      j++;
    }
    if (best >= 0) {
      for (let k = i; k < j; k++) {
        const s = segs[k]!;
        const key = k === best;
        // LIP channels only — the jaw keeps every syllable, and that IS the rhythm.
        const up = key ? 1 : 0;
        s.alpha[WIDE] = s.alpha[WIDE]! * (up ? 1.6 : 0.35);
        s.alpha[ROUND] = s.alpha[ROUND]! * (up ? 1.6 : 0.35);
        s.alpha[PROT] = s.alpha[PROT]! * (up ? 1.6 : 0.35);
        s.alpha[CORNER] = s.alpha[CORNER]! * (up ? 1.5 : 0.4);
        s.alpha[TONGUE] = s.alpha[TONGUE]! * (up ? 1.4 : 0.45);
        s.alpha[TUCK] = s.alpha[TUCK]! * (up ? 1.5 : 0.45);
        // A closure already has a modelled hold and a post-filter guarantee;
        // stretching its plateau too would keep the lips shut through the vowel
        // that follows it.
        if (key && s.closure !== 1) {
          // Never behind its predecessor: `Blender.seek` binary-searches `segs`
          // on `t0` and `gather` scans forward from there, so the order is load
          // bearing. Re-sorting is not an option — `Word.seg0/segN` index this
          // array.
          s.t0 = Math.max(Math.min(s.t0, b0 + 0.008), k > 0 ? segs[k - 1]!.t0 : 0);
          s.t1 = Math.max(s.t1, b1 - 0.008);
        }
      }
      i = j;
    } else i++;
    b0 = b1;
  }
  // A closure is never demoted: bilabials always win their bucket.
  for (const s of segs) if (s.closure) s.alpha[PRESS] = Math.max(s.alpha[PRESS]!, 2.2);
}

/**
 * If closures would occupy more than 45 % of any one-second window the mouth
 * chatters, so scale them back rather than let "lamppost" machine-gun the lips.
 */
function dutyGuard(segs: Seg[]) {
  const clo: Seg[] = [];
  for (const s of segs) if (s.closure) clo.push(s);
  for (const s of clo) {
    const mid = (s.cloT0 + s.cloT1) * 0.5;
    let sum = 0;
    for (const o of clo) {
      const c = (o.cloT0 + o.cloT1) * 0.5;
      if (Math.abs(c - mid) <= 0.5) sum += o.cloT1 - o.cloT0;
    }
    s.duty = sum > 0.45 ? 0.45 / sum : 1;
  }
}

/**
 * Nothing compiled — pure punctuation, an unhandled script, or a rule-table
 * bug. A syllable-rate oscillator sized from the character count is visually
 * indistinguishable from v1's *best* case, so the floor never drops below what
 * shipped before.
 */
function babble(chars: number, rate: number, lang: Lang, ttsText: string): Score {
  const segs: Seg[] = [];
  const per = 1 / (SYLL_RATE[lang] * Math.max(0.4, rate));
  const n = Math.max(1, Math.round((chars / (lang === "ar" ? 3.1 : 3.4)) | 0));
  let t = 0;
  for (let i = 0; i < n; i++) {
    const open = i % 2 === 0;
    const sym = open ? (hash1(i) < 0.5 ? "AA" : "EH") : "M";
    const dur = per * (open ? 0.62 : 0.38);
    segs.push(
      makeSeg({
        sym,
        cls: infoOf(sym).cls,
        t0: t,
        dur,
        target: resolveTarget(sym, 0, 0),
        alphaScale: 1,
        emph: open ? 0.3 : 0.1,
        stress: open ? 2 : 0,
        nucleus: open,
        freeze: false,
        voiced: 1,
        loud: open ? 0.8 : 0.1,
        closure: open ? 0 : 1,
        pauseBefore: 0,
        word: 0,
        phrase: 0,
      }),
    );
    t += dur;
  }
  const words: Word[] = [
    {
      c0: 0,
      c1: ttsText.length,
      t0: 0,
      t1: t,
      seg0: 0,
      segN: segs.length,
      syl: n,
      func: false,
      nuclear: true,
      emph: 0.3,
      phrase: 0,
    },
  ];
  const phrases: Phrase[] = [
    { w0: 0, w1: 1, t0: 0, t1: t, tone: -1, pauseAfter: 0, turn: 0, tilt: 1 },
  ];
  const { events, kicks } = schedule(segs, words, phrases, t);
  return {
    lang,
    segs,
    words,
    phrases,
    events,
    kicks,
    total: t,
    nSyll: n,
    speedFactor: 1,
    ttsText,
    charMap: new Int32Array(0),
    fallback: true,
  };
}

/**
 * A token neither G2P can read — a script we have no letter table for. The
 * voice still says it, so it still has to cost time: a neutral CV skeleton
 * sized from the token keeps the timeline honest and keeps `findWord` a landing
 * site, where dropping the word would leave the mouth ahead of the voice for
 * the whole rest of the reply. Coronal onset and open nucleus, so the jaw gets
 * the rhythm without the lips asserting a shape we have no evidence for.
 */
function fillerPlan(word: string, a0: number, a1: number): WordPlan {
  const n = clamp(Math.round(word.length / 2.6), 1, 8);
  const phones: Phone[] = [];
  const syls: Syl[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = phones.length;
    const nuc = hash1(word.length * 31 + i) < 0.5 ? "AA" : "EH";
    for (const sym of ["N", nuc]) {
      const info = infoOf(sym);
      phones.push({
        sym,
        cls: info.cls,
        vowel: info.cls.startsWith("V"),
        gem: false,
        emph: false,
        emphF: 0,
        freeze: false,
        long: info.cls === "VLONG",
        stress: 0,
        reduce: 0,
        a0,
        a1,
        word: 0,
        syl: i,
      });
    }
    const stress: 0 | 1 | 2 = i === 0 ? 2 : 0;
    phones[p0 + 1]!.stress = stress;
    syls.push({ p0, p1: p0 + 2, nuc: p0 + 1, stress, weight: "L", emph: 0, onset: 1 });
  }
  return { phones, syls, func: false };
}

export type BuildOpts = { rate: number; lang: Lang; priorK: number };

export function buildScore(raw: string, opts: BuildOpts): Score {
  const { rate, lang, priorK } = opts;
  const norm = normalize(raw, lang);
  const toks = tokenize(norm.text);
  const reg = lang === "ar" ? arRegister(norm.text) : "eg";

  // ── 1. G2P, word by word ────────────────────────────────────────────────
  const items: Item[] = [];
  const wbs: WB[] = [];
  let prevVowel = false;
  for (const t of toks) {
    if (!t.w) {
      items.push({ k: "p", punct: t.s, brk: PHRASE_BREAK.has(t.s) });
      prevVowel = false;
      continue;
    }
    // A token in the other script is still spoken, so read it with the other
    // G2P rather than drop it. Only English lower-cases its analysis text, so an
    // ASCII token inside Arabic still carries its capitals here.
    let plan = lang === "ar" ? arWord(t.s, reg, prevVowel, t.a0, t.a1) : enWord(t.s, t.a0, t.a1);
    if (!plan.phones.length)
      plan =
        lang === "ar"
          ? enWord(t.s.toLowerCase(), t.a0, t.a1)
          : arWord(t.s, reg, prevVowel, t.a0, t.a1);
    if (!plan.phones.length) plan = fillerPlan(t.s, t.a0, t.a1);
    prevVowel = endsInVowel(plan.phones);
    const rawText = raw.slice(norm.map[t.a0] ?? 0, (norm.map[t.a1 - 1] ?? 0) + 1);
    const rawStart = norm.map[t.a0] ?? 0;
    const wrapped = spanWrapped(norm.emphSpans, rawStart);
    const wb: WB = {
      plan,
      text: t.s,
      c0: norm.aToTts[t.a0] ?? 0,
      c1: norm.aToTts[t.a1] ?? 0,
      meta: {
        allCaps: /^[A-Z]{2,}$/.test(rawText) && !/^[A-Z]{2,3}$/.test(rawText),
        wrapped,
        contrastive: false,
        chars: t.s.length,
        exclaim: false,
      },
      emph: wrapped ? 0.45 : 0,
      nuclear: false,
      phrase: 0,
    };
    items.push({ k: "w", wb });
    wbs.push(wb);
  }
  if (!wbs.length) return babble(norm.tts.length, rate, lang, norm.tts);

  // ── 2. phrases ──────────────────────────────────────────────────────────
  type PB = { w0: number; w1: number; punct: string; pauseAfter: number };
  const pbs: PB[] = [];
  let w0 = 0,
    wi = 0;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (it.k === "w") {
      it.wb.phrase = pbs.length;
      wi++;
      continue;
    }
    if (!it.brk) continue;
    if (wi > w0) {
      // Consecutive marks merge; the strongest one sets the break.
      let punct = it.punct;
      let n = k + 1;
      while (n < items.length && items[n]!.k === "p") {
        const p = items[n] as { k: "p"; punct: string; brk: boolean };
        if ((PAUSE_MS[p.punct] ?? 0) > (PAUSE_MS[punct] ?? 0)) punct = p.punct;
        n++;
      }
      pbs.push({ w0, w1: wi, punct, pauseAfter: 0 });
      w0 = wi;
    }
  }
  // Trailing words with no closing mark still land like a sentence.
  if (wi > w0) pbs.push({ w0, w1: wi, punct: ".", pauseAfter: 0 });
  if (!pbs.length) pbs.push({ w0: 0, w1: wbs.length, punct: ".", pauseAfter: 0 });
  for (const wb of wbs) wb.phrase = Math.min(wb.phrase, pbs.length - 1);

  // ── 3. nuclear stress, the single biggest performance win ───────────────
  let prevWords = new Set<string>();
  for (let pi = 0; pi < pbs.length; pi++) {
    const p = pbs[pi]!;
    const exclaim = p.punct === "!";
    const here = new Set<string>();
    for (let i = p.w0; i < p.w1; i++) {
      const wb = wbs[i]!;
      wb.meta.exclaim = exclaim;
      wb.meta.contrastive = prevWords.has(wb.text);
      here.add(wb.text);
    }
    for (let i = p.w1 - 1; i >= p.w0; i--) {
      const wb = wbs[i]!;
      if (wb.plan.func) continue;
      wb.nuclear = true;
      wb.emph += 0.35;
      break;
    }
    prevWords = here;
  }

  // ── 4. per-syllable emphasis, then English reduction ────────────────────
  let nSyll = 0;
  for (let i = 0; i < wbs.length; i++) {
    const wb = wbs[i]!;
    const p = pbs[wb.phrase]!;
    const stub: Word = {
      c0: wb.c0,
      c1: wb.c1,
      t0: 0,
      t1: 0,
      seg0: 0,
      segN: 0,
      syl: wb.plan.syls.length,
      func: wb.plan.func,
      nuclear: wb.nuclear,
      emph: 0,
      phrase: wb.phrase,
    };
    let top = 0;
    for (const s of wb.plan.syls) {
      let emphatic = false;
      for (let k = s.p0; k < s.p1; k++) if (wb.plan.phones[k]!.emphF > 0.5) emphatic = true;
      const e = clamp(emphasisOf(s, stub, wb.meta, lang, emphatic) + wb.emph * 0.5, 0, 1);
      s.emph = e;
      if (e > top) top = e;
    }
    wb.emph = top;
    nSyll += wb.plan.syls.length;
    // Egyptian has no vowel reduction — the stress multiplier does all the work,
    // and that is exactly why Arabic reads as more evenly articulated.
    if (lang === "en") markReduction(wb.plan.phones, wb.plan.syls, top, i === p.w1 - 1);
  }

  // ── 5. durations ────────────────────────────────────────────────────────
  const durs: number[][] = [];
  let rawTotal = 0;
  let syllCounter = 0;
  for (let i = 0; i < wbs.length; i++) {
    const wb = wbs[i]!;
    const p = pbs[wb.phrase]!;
    const ph = wb.plan.phones;
    const syls = wb.plan.syls;
    const pw = pauseWeightOf(i === p.w1 - 1 ? p.punct : "");
    const d: number[] = new Array(ph.length).fill(0);
    for (let si = 0; si < syls.length; si++) {
      const s = syls[si]!;
      const coda = s.p1 - s.nuc - 1;
      const codaPh = coda > 0 ? ph[s.nuc + 1]! : null;
      const isLast = si === syls.length - 1;
      const finalWord = i === p.w1 - 1;
      const ctx: Ctx = {
        funcWord: wb.plan.func,
        prevGem: s.nuc > 0 ? ph[s.nuc - 1]!.gem : false,
        openSyll: coda === 0,
        voicedCoda: codaPh ? !VOICELESS.has(baseSym(codaPh.sym)) : false,
        voicelessCoda: codaPh ? VOICELESS.has(baseSym(codaPh.sym)) : false,
        wordSyll: syls.length,
        emph: s.emph,
        clusterIdx: 0,
        phraseInitial: i === p.w0 && si === 0,
        coda: false,
        inFinalRime: false,
        inPreFinalRime: finalWord && si === syls.length - 2,
        wordFinalSyll: isLast,
        pauseWeight: pw,
        syllIdx: syllCounter,
      };
      for (let k = s.p0; k < s.p1; k++) {
        const phone = ph[k]!;
        ctx.clusterIdx = k < s.nuc ? s.nuc - k - 1 : k - s.nuc - 1;
        ctx.coda = k > s.nuc;
        // The rime, not the whole syllable: the onset of a phrase-final word is
        // not what lengthens, the vowel and its coda are.
        ctx.inFinalRime = finalWord && isLast && k >= s.nuc;
        const one = durationOf(phone, ctx, rate);
        d[k] = one;
        rawTotal += one;
      }
      syllCounter++;
    }
    durs.push(d);
  }

  // ── 6. pauses, then the global anchor ───────────────────────────────────
  let pauseTotal = 0;
  const pauseAt = new Map<number, number>();
  for (let pi = 0; pi < pbs.length; pi++) {
    const p = pbs[pi]!;
    const d = pi === pbs.length - 1 ? 0 : pauseSeconds(p.punct, rate);
    p.pauseAfter = d;
    if (d > 0) pauseAt.set(p.w1 - 1, d);
    pauseTotal += d;
  }
  const targetTotal = nSyll / (SYLL_RATE[lang] * Math.pow(Math.max(0.3, rate), 0.92)) + pauseTotal;
  const anchor = clamp(targetTotal / Math.max(0.05, rawTotal + pauseTotal), 0.72, 1.42) * priorK;

  // ── 7. lay out the segments ─────────────────────────────────────────────
  const segs: Seg[] = [];
  const words: Word[] = [];
  let t = 0;
  let pauseAcc = 0;

  for (let i = 0; i < wbs.length; i++) {
    const wb = wbs[i]!;
    const ph = wb.plan.phones;
    const seg0 = segs.length;
    const wt0 = t;
    for (let k = 0; k < ph.length; k++) {
      const p = ph[k]!;
      const dur = (durs[i]![k] ?? 0.05) * anchor;
      const info = infoOf(p.sym);
      const syl = wb.plan.syls[p.syl];
      const emph = syl?.emph ?? 0;
      const voiced: 0 | 1 = VOICELESS.has(baseSym(p.sym)) || p.cls === "SIL" ? 0 : 1;
      const base: Omit<
        SegInit,
        "sym" | "cls" | "t0" | "dur" | "target" | "alphaScale" | "closure"
      > = {
        emph,
        stress: p.stress,
        nucleus: false,
        freeze: p.freeze,
        voiced,
        loud: loudOf(p.cls, emph),
        pauseBefore: pauseAcc,
        word: i,
        phrase: wb.phrase,
      };

      const diph = DIPH[p.sym];
      if (diph) {
        const [a, b, frac] = diph;
        const d0 = dur * frac;
        segs.push(
          makeSeg({
            ...base,
            sym: a,
            cls: "VDIPH",
            t0: t,
            dur: d0,
            target: resolveTarget(a, p.reduce, p.emphF),
            alphaScale: 1,
            closure: 0,
            nucleus: true,
          }),
        );
        segs.push(
          makeSeg({
            ...base,
            sym: b,
            cls: "VDIPH",
            t0: t + d0,
            dur: dur - d0,
            target: resolveTarget(b, p.reduce, p.emphF),
            alphaScale: 0.9,
            closure: 0,
            stress: 0,
          }),
        );
        t += dur;
        continue;
      }

      if (info.clo > 0 && !p.vowel) {
        // A plosive is not one gesture. Only the closure is visible, and giving
        // it a real hold is the whole reason M/B/P read at all.
        const gemK = p.gem ? 1.35 : 1;
        const dClo = Math.min(dur * 0.92, dur * info.clo * gemK);
        const dRel = dur - dClo;
        const kind: 0 | 1 | 2 = BILABIAL.has(baseSym(p.sym)) ? 1 : 0;
        const clo = makeSeg({
          ...base,
          sym: p.sym,
          cls: p.cls,
          t0: t,
          dur: dClo,
          target: resolveTarget(p.sym, 0, p.emphF),
          alphaScale: 1,
          closure: kind,
          loud: 0.05,
        });
        segs.push(clo);
        if (dRel > 0.004) {
          const next = ph[k + 1];
          const rel = resolveTarget(p.sym, 0, p.emphF);
          if (next) {
            const nt = resolveTarget(next.sym, next.reduce, next.emphF);
            for (let c = 0; c < NCH; c++) rel[c] = lerp(rel[c]!, nt[c]!, 0.35);
          }
          rel[PRESS] = rel[PRESS]! * 0.35;
          segs.push(
            makeSeg({
              ...base,
              sym: p.sym,
              cls: p.cls,
              t0: t + dClo,
              dur: dRel,
              target: rel,
              alphaScale: 0.5,
              closure: 0,
              loud: 0.3,
            }),
          );
        }
        t += dur;
        continue;
      }

      const kind: 0 | 1 | 2 = LABIODENTAL.has(baseSym(p.sym)) ? 2 : 0;
      const s = makeSeg({
        ...base,
        sym: p.sym,
        cls: p.cls,
        t0: t,
        dur,
        target: resolveTarget(p.sym, p.reduce, p.emphF),
        alphaScale: 1,
        closure: kind,
        nucleus: p.vowel && syl != null && syl.nuc === k,
      });
      if (p.reduce > 0) {
        // Lowering the *authority* is the important half of reduction: the vowel
        // then gets overrun by its neighbours instead of stepping to a schwa.
        for (const c of LIP_CH) s.alpha[c] = s.alpha[c]! * (1 - 0.45 * p.reduce);
        s.alpha[JAW] = s.alpha[JAW]! * (1 - 0.2 * p.reduce);
      }
      if (kind === 2) {
        s.cloT0 = t + dur * 0.15;
        s.cloT1 = t + dur * 0.85;
      }
      segs.push(s);
      t += dur;
    }

    words.push({
      c0: wb.c0,
      c1: wb.c1,
      t0: wt0,
      t1: t,
      seg0,
      segN: segs.length - seg0,
      syl: wb.plan.syls.length,
      func: wb.plan.func,
      nuclear: wb.nuclear,
      emph: wb.emph,
      phrase: wb.phrase,
    });

    const pd = (pauseAt.get(i) ?? 0) * anchor;
    if (pd > 0) {
      t = layoutPause(segs, t, pd, pauseAcc, i, wb.phrase);
      pauseAcc += pd;
    } else if (i + 1 < wbs.length) {
      t += 0.012 * anchor; // the inter-word join: short, but not zero
    }
  }

  if (!segs.length) return babble(norm.tts.length, rate, lang, norm.tts);

  const total = t;
  const speedFactor = clamp(Math.sqrt(nSyll / Math.max(0.2, total) / 4.6), 0.88, 1.35);
  reduceKeys(segs, speedFactor);
  for (const s of segs)
    if (s.closure === 1) {
      s.cloT0 = s.t0;
      s.cloT1 = s.t1;
    }
  dutyGuard(segs);

  const phrases: Phrase[] = pbs.map((p, pi) => {
    const first = words[p.w0];
    const last = words[p.w1 - 1];
    return {
      w0: p.w0,
      w1: p.w1,
      t0: first?.t0 ?? 0,
      t1: last?.t1 ?? total,
      tone: toneOf(p.punct, wbs[p.w0]?.text ?? "", lang) as Tone,
      pauseAfter: p.pauseAfter * anchor,
      turn: (hash1(pi * 131 + 5) < 0.5 ? -1 : 1) * (0.25 + 0.25 * hash1(pi * 977 + 3)),
      tilt: pi % 2 ? -1 : 1,
    };
  });

  const { events, kicks } = schedule(segs, words, phrases, total);

  return {
    lang,
    segs,
    words,
    phrases,
    events,
    kicks,
    total,
    nSyll,
    speedFactor,
    ttsText: norm.tts,
    charMap: norm.ttsMap,
    fallback: false,
  };
}

/**
 * A pause is a real gesture, not a gap. The mouth genuinely closes at a comma —
 * a mouth that drifts half-open between phrases is the classic amateur tell —
 * and a long enough pause gets a visible inhale before the next phrase.
 */
function layoutPause(
  segs: Seg[],
  t0: number,
  d: number,
  pauseAcc: number,
  word: number,
  phrase: number,
): number {
  const mk = (sym: string, at: number, dur: number, target: Chan, before: number) =>
    segs.push(
      makeSeg({
        sym,
        cls: "SIL",
        t0: at,
        dur,
        target,
        alphaScale: 1,
        emph: 0,
        stress: 0,
        nucleus: false,
        freeze: false,
        voiced: 0,
        loud: 0,
        closure: 0,
        pauseBefore: before,
        word,
        phrase,
      }),
    );

  if (d < 0.2) {
    mk("SIL", t0, d, Float32Array.from(TARGET["SIL"]!), pauseAcc);
    return t0 + d;
  }
  const shut = new Float32Array(NCH);
  shut[PRESS] = 0.8;
  shut[JAW] = 0.02;
  mk("SIL", t0, d * 0.4, shut, pauseAcc);

  if (d >= 0.32) {
    const inhale = new Float32Array(NCH);
    inhale[JAW] = 0.13;
    inhale[ROUND] = 0.12;
    inhale[PROT] = 0.1;
    mk("SIL", t0 + d * 0.45, d * 0.55, inhale, pauseAcc + d);
  } else {
    mk("SIL", t0 + d * 0.4, d * 0.6, Float32Array.from(TARGET["SIL"]!), pauseAcc + d);
  }
  return t0 + d;
}

const spanWrapped = (spans: number[], at: number) => {
  for (let i = 0; i + 1 < spans.length; i += 2)
    if (at >= spans[i]! && at < spans[i + 1]!) return true;
  return false;
};

/** The floor. Used when the G2P throws, so a rule-table bug never stills the mouth. */
export const fallbackScore = (text: string, rate: number, lang: Lang): Score =>
  babble(text.length, rate, lang, text);

/** Kept for the dev harness and for any caller that wants the plan without the clock. */
export const textToScore = (text: string, lang: Lang, rate = 1) =>
  buildScore(text, { rate, lang, priorK: 1 });
