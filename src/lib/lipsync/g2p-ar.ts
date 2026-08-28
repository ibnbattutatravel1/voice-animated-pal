/**
 * Egyptian Arabic (Cairene) grapheme → phone.
 *
 * Arabic is written without its short vowels, so vowel *quality* is
 * unrecoverable — but the syllable *count* is not, and rhythm is most of what a
 * viewer perceives. Hence: emit the consonant skeleton, match a template, then
 * let a repair pass insert exactly the vowels needed to make it legal Egyptian.
 *
 * Cairene, not MSA: gīm is /g/, qāf is a glottal stop, ṯāʾ is /t/ and ḏāl is
 * /z/. The register sniffer in §arRegister switches to the MSA values when the
 * text is clearly not colloquial.
 */

import { isTashkeel, stripTashkeel } from "./normalize";
import { infoOf, PH } from "./phones";
import type { Phone, Syl, WordPlan } from "./model";

export type Reg = "eg" | "msa";

const MSA_MARKERS = /(ال[أ-ي]{2,}\s+ال|إنّ|ذلك|الذي|التي|هذه|هذا|سوف|لقد|قد\s|القرآن)/;

export const arRegister = (text: string): Reg => (MSA_MARKERS.test(text) ? "msa" : "eg");

// ────────────────────────────────────────────────────────────── the lexicon

/**
 * Function words are ~40 % of Egyptian tokens and are exactly what a
 * constraint engine gets wrong most often, so this table earns more per byte
 * than anything else in the file. The app-vocabulary block matches `reply()`
 * verbatim — those are the only Arabic strings Nova speaks today.
 */
const AR_LEX: Record<string, string> = {
  // pronouns / deixis / interrogatives
  أنا: "Q a n a",
  انا: "Q a n a",
  إنت: "Q i n t a",
  انت: "Q i n t a",
  انتي: "Q i n t i",
  هو: "HH u w w a",
  هي: "HH i j j a",
  احنا: "Q i HH n a",
  إحنا: "Q i HH n a",
  هما: "HH u m m a",
  ده: "d a",
  دي: "d i",
  دول: "d O: l",
  ايه: "Q E: HH",
  إيه: "Q E: HH",
  مين: "m I: n",
  فين: "f E: n",
  امتى: "Q i m t a",
  ازاي: "Q i z z A: j",
  إزاي: "Q i z z A: j",
  ليه: "l E: HH",
  كام: "k A: m",
  كده: "k i d a",
  كدة: "k i d a",
  ازيك: "Q i z z a j j a k",
  إزيك: "Q i z z a j j a k",
  // prepositions / particles
  في: "f i",
  من: "m i n",
  على: "AIN a l a",
  عن: "AIN a n",
  مع: "m a AIN a",
  عند: "AIN a n d",
  زي: "z a j j",
  بعد: "b a AIN d",
  قبل: "Q a b l",
  بين: "b E: n",
  مش: "m i SH",
  ما: "m a",
  بس: "b a s s",
  كمان: "k a m A: n",
  برضه: "b a r d* u",
  يعني: "j a AIN n i",
  علشان: "AIN a l a SH A: n",
  عشان: "AIN a SH A: n",
  طبعا: "T* a b AIN a n",
  خلاص: "KHA a l A: S*",
  يلا: "j a l l a",
  ماشي: "m A: SH i",
  طيب: "T* a j j i b",
  // time
  دلوقتي: "d i l w a Q t i",
  النهارده: "Q i n n a h A: r d a",
  الساعة: "Q i s s A: AIN a",
  الوقت: "Q i l w a Q t",
  دقيقة: "d i Q I: Q a",
  دقايق: "d a Q A: j i Q",
  ساعة: "s A: AIN a",
  // courtesy
  شكرا: "SH u k r a n",
  أهلا: "Q a h l a n",
  اهلا: "Q a h l a n",
  مرحبا: "m a r HH a b a",
  سلام: "s a l A: m",
  تمام: "t a m A: m",
  معلش: "m a AIN l E: SH",
  الخير: "Q i l KHA E: r",
  صباح: "S* a b A: HH",
  // app vocabulary — matches reply() in useVoiceSession.ts verbatim
  بيك: "b I: k",
  سامعك: "s A: m AIN a k",
  قول: "Q U: l",
  لي: "l i",
  اللي: "Q i l l i",
  بالك: "b A: l a k",
  نبدأ: "n i b d a Q",
  جلسة: "g i l s a",
  تركيز: "t a r k I: z",
  شغل: "SH u GHA l",
  وبعدها: "w i b a AIN d a h a",
  راحة: "r A: HH a",
  جاهز: "g A: h i z",
  نوفا: "n O: f a",
  رفيقك: "r a f I: Q a k",
  الصغير: "Q i s* s* u GHA a j j a r",
  والكلام: "w i l k a l A: m",
  دايما: "d A: j m a n",
  خدمتك: "KHA i d m i t a k",
  سمعتك: "s i m i AIN t a k",
  بتقول: "b i t Q U: l",
  حكيلي: "HH k I: l i",
  أكتر: "Q a k t a r",
  اكتر: "Q a k t a r",
  وأنا: "w a Q a n a",
  معاك: "m a AIN A: k",
  مذاكرة: "m u z a k r a",
  الله: "Q a l l A: h",
};

/** Egyptian has no reduction, so a function word is only marked for duration. */
const AR_FUNC = new Set([
  "في",
  "من",
  "على",
  "عن",
  "مع",
  "عند",
  "زي",
  "بعد",
  "قبل",
  "بين",
  "مش",
  "ما",
  "بس",
  "لي",
  "لك",
  "ده",
  "دي",
  "اللي",
  "و",
  "يا",
  "ان",
  "إن",
  "أنا",
  "انا",
  "هو",
  "هي",
]);

// ────────────────────────────────────────────────────── letters and marks

const LET_EG: Record<string, string> = {
  ب: "B",
  ت: "T",
  ث: "T",
  ج: "G",
  ح: "HAA",
  خ: "KHA",
  د: "D",
  ذ: "Z",
  ر: "RT",
  ز: "Z",
  س: "S",
  ش: "SH",
  ص: "S*",
  ض: "D*",
  ط: "T*",
  ظ: "Z*",
  ع: "AIN",
  غ: "GHA",
  ف: "F",
  ق: "Q",
  ك: "K",
  ل: "L",
  م: "M",
  ن: "N",
  ه: "HH",
  پ: "P",
  ڤ: "V",
  گ: "G",
  چ: "SH",
};

/** MSA differs in exactly the four letters Cairo is famous for. */
const LET_MSA: Record<string, string> = { ث: "TH", ج: "JH", ذ: "DH", ق: "QAF" };

const SUN = new Set("تثدذرزسشصضطظلن");
const LABIAL = new Set(["B", "M", "F", "W", "P", "V"]);
/**
 * Which consonants back the vowels around them — both the epenthetic colour and
 * the tafkhīm spread. ق is a *glottal stop* in Cairene and ر is a tap, so
 * including either would round and darken most of the language.
 */
const AR_EMPHATIC = new Set(["S*", "D*", "T*", "Z*", "QAF", "AIN", "HAA", "KHA", "GHA"]);

const FATHA = "َ",
  DAMMA = "ُ",
  KASRA = "ِ",
  SUKUN = "ْ",
  SHADDA = "ّ",
  TAN_A = "ً",
  TAN_U = "ٌ",
  TAN_I = "ٍ",
  DAGGER = "ٰ";

type Unit = { c: string; m: string };

function toUnits(w: string): Unit[] {
  const u: Unit[] = [];
  for (const ch of w) {
    if (isTashkeel(ch)) {
      const last = u[u.length - 1];
      if (last) last.m += ch;
    } else u.push({ c: ch, m: "" });
  }
  return u;
}

const markVowel = (m: string) =>
  m.includes(FATHA) ? "a" : m.includes(DAMMA) ? "u" : m.includes(KASRA) ? "i" : "";

// ──────────────────────────────────────────────────────────── phone helpers

type PhoneOpts = { gem?: boolean; freeze?: boolean };

function mk(sym: string, a0: number, a1: number, opts?: PhoneOpts): Phone {
  const info = infoOf(sym);
  return {
    sym,
    cls: info.cls,
    vowel: info.cls.startsWith("V"),
    gem: opts?.gem ?? false,
    emph: sym.endsWith("*"),
    emphF: 0,
    freeze: opts?.freeze ?? false,
    long: info.cls === "VLONG" || info.cls === "VDIPH",
    stress: 0,
    reduce: 0,
    a0,
    a1,
    word: 0,
    syl: 0,
  };
}

/** The lexicon is written in a light transcription; this is its only reader. */
function parseLex(s: string, a0: number, a1: number): Phone[] {
  const out: Phone[] = [];
  for (const raw of s.split(" ")) {
    if (!raw) continue;
    let sym = raw;
    if (sym !== "a" && sym !== "i" && sym !== "u") {
      sym = sym.toUpperCase();
      if (sym === "J") sym = "Y";
      else if (sym === "H") sym = "HH";
      else if (sym === "R") sym = "RT";
    }
    if (!PH[sym.endsWith("*") ? sym.slice(0, -1) : sym]) continue;
    const prev = out[out.length - 1];
    // A doubled symbol is a shadda: one phone that genuinely holds longer.
    if (prev && prev.sym === sym && !prev.vowel) {
      prev.gem = true;
      continue;
    }
    out.push(mk(sym, a0, a1, sym === "Q" ? { freeze: true } : undefined));
  }
  return out;
}

// ───────────────────────────────────────────────────────────── the templates

type Tpl = { pat: string[]; out: string[] };

/** `1 2 3` are the pattern's Nth `C` slot; anything else is a literal phone. */
const AR_TPL: Tpl[] = [
  { pat: ["ا", "س", "ت", "C", "C", "ا", "C"], out: ["Q", "i", "S", "T", "i", "1", "2", "A:", "3"] },
  { pat: ["م", "C", "ا", "C", "ي", "C"], out: ["M", "a", "1", "A:", "2", "I:", "3"] },
  { pat: ["م", "C", "ا", "C", "C"], out: ["M", "a", "1", "A:", "2", "i", "3"] },
  { pat: ["م", "C", "C", "و", "C"], out: ["M", "a", "1", "2", "U:", "3"] },
  { pat: ["ت", "C", "C", "ي", "C"], out: ["T", "a", "1", "2", "I:", "3"] },
  { pat: ["م", "C", "C", "C"], out: ["M", "a", "1", "2", "a", "3"] },
  { pat: ["ا", "C", "C", "C"], out: ["Q", "a", "1", "2", "a", "3"] },
  { pat: ["C", "C", "ا", "ي", "C"], out: ["1", "a", "2", "A:", "Y", "i", "3"] },
  { pat: ["C", "ا", "C", "C"], out: ["1", "A:", "2", "i", "3"] },
  { pat: ["C", "C", "ي", "C"], out: ["1", "i", "2", "I:", "3"] },
  { pat: ["C", "C", "ا", "C"], out: ["1", "i", "2", "A:", "3"] },
  { pat: ["C", "C", "و", "C"], out: ["1", "u", "2", "U:", "3"] },
  { pat: ["C", "C", "C"], out: ["1", "a", "2", "a", "3"] },
];

const NOT_C = new Set(["ا", "و", "ي", "ة", "ى", "آ", "ء"]);

function matchTemplate(units: Unit[], let2ph: Record<string, string>): string[] | null {
  const letters = units.map((u) => (u.c === "أ" || u.c === "إ" || u.c === "آ" ? "ا" : u.c));
  for (const t of AR_TPL) {
    if (t.pat.length !== letters.length) continue;
    const slots: string[] = [];
    let ok = true;
    for (let i = 0; i < t.pat.length; i++) {
      const p = t.pat[i]!,
        l = letters[i]!;
      if (p === "C") {
        const ph = let2ph[l];
        if (!ph || NOT_C.has(l)) {
          ok = false;
          break;
        }
        slots.push(ph);
      } else if (p !== l) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const out: string[] = [];
    for (const tok of t.out) {
      const n = +tok;
      out.push(n >= 1 && n <= slots.length ? slots[n - 1]! : tok);
    }
    // The template pins the syllable shape; the epenthetic *colour* still comes
    // from the neighbours: mudiːr after a labial, ṣalaːḥ next to an emphatic.
    for (let i = 1; i < out.length; i++)
      if (out[i] === "i") out[i] = colour(out[i - 1]!, out[i + 1] ?? "");
    return out;
  }
  return null;
}

// ─────────────────────────────────────── skeleton, glides and vowel repair

function colour(prev: string, next: string): string {
  if (AR_EMPHATIC.has(prev) || AR_EMPHATIC.has(next)) return "a";
  if (prev === "W" || LABIAL.has(prev)) return "u";
  return "i"; // the Cairene default epenthetic
}

function shortVowel(prev: string, next: string): string {
  if (AR_EMPHATIC.has(prev) || AR_EMPHATIC.has(next)) return "a";
  if (prev === "W" || next === "W" || LABIAL.has(prev) || LABIAL.has(next)) return "u";
  return "i";
}

/**
 * The repair pass, and the whole reason this file is not the old engine.
 *
 * v1 inserted a schwa between *every* consonant pair, which roughly doubled the
 * syllable count of every Arabic word. Egyptian licenses CV, CVː, CVC, plus a
 * word-final CVCC — so a vowel is only needed where a third consonant would
 * otherwise stack up, and nowhere else.
 */
function repair(ph: Phone[], a0: number, a1: number): Phone[] {
  if (!ph.length) return ph;
  // A bare skeleton is framed as a whole, not patched pair by pair: ʕ-n-b-r is
  // ʕam.bar, and inserting on the *third* consonant would give ʕa.nub.r.
  const src = ph.some((p) => p.vowel) ? ph : frameNoVowel(ph, a0, a1);

  const out: Phone[] = [];
  // Egyptian has no onset clusters, so the word-initial pair is fixed first —
  // otherwise the run scan below inserts a second, unnecessary vowel.
  if (!src[0]!.vowel && src[1] && !src[1]!.vowel)
    out.push(src[0]!, mk(shortVowel(src[0]!.sym, src[1]!.sym), a0, a1));

  let run = 0;
  for (let i = out.length ? 1 : 0; i < src.length; i++) {
    const p = src[i]!;
    const atEnd = i === src.length - 1;
    if (p.vowel) {
      out.push(p);
      run = 0;
      continue;
    }
    // Cairene licenses at most CC, except word-finally (ʔalb, bint).
    if (run === 2 && !atEnd) {
      out.push(mk(shortVowel(out[out.length - 1]!.sym, p.sym), a0, a1));
      run = 0;
    }
    out.push(p);
    run++;
  }
  // No vowel-initial syllables either: the glottal onset is real and audible.
  if (out[0]!.vowel) out.unshift(mk("Q", a0, a1, { freeze: true }));
  return out;
}

function frameNoVowel(c: Phone[], a0: number, a1: number): Phone[] {
  const V = (i: number) => mk(colour(c[i]!.sym, c[i + 1]?.sym ?? ""), a0, a1);
  if (c.length === 1) return [c[0]!, V(0)];
  if (c.length === 2) return [c[0]!, V(0), c[1]!];
  if (c.length === 3) return [c[0]!, mk("a", a0, a1), c[1]!, mk("a", a0, a1), c[2]!]; // katab
  // CVC.CVC and onward: a vowel after every other consonant leaves exactly one
  // consonant to serve as each following syllable's onset. The vowel is /a/
  // because that is what the templatic frames it stands in for actually use —
  // maktab, daftar, ʕambar — not the epenthetic /i/.
  const out: Phone[] = [];
  for (let i = 0; i < c.length; i++) {
    out.push(c[i]!);
    if (i % 2 === 0 && i < c.length - 1) out.push(mk("a", a0, a1));
  }
  return out;
}

/**
 * و and ي carry three different sounds, and telling them apart is the single
 * largest visual win on the Arabic side: `E:` and `O:` are shapes v1 could not
 * produce at all — it mapped every و to a round OO and every ي to a wide EE.
 *
 * The short-word cut is deliberate: Egyptian collapses MSA `ay`/`aw` to `eː`/`oː`
 * in exactly the short, frequent, native words — bayt, yawm, lawn, fayn, layh.
 */
function glide(u: Unit[], i: number, isWaw: boolean): { sym: string; gem: boolean } {
  const self = u[i]!;
  const G = isWaw ? "W" : "Y";
  const mono = isWaw ? "O:" : "E:";
  const long = isWaw ? "U:" : "I:";
  const R = (sym: string, gem = false) => ({ sym, gem });

  if (self.m.includes(SHADDA)) return R(G, true);
  if (markVowel(self.m)) return R(G); // it carries a vowel, so it is a consonant
  const n = u.length;
  if (i === 0) return R(G);

  const prev = u[i - 1]!;
  const next = u[i + 1];
  const prevMark = markVowel(prev.m);

  // Vocalised text settles it outright: َو is the aw → oː monophthong, ُو is a long uː.
  if (prevMark === "a") return R(mono);
  if (isWaw && prevMark === "u") return R(long);
  if (!isWaw && prevMark === "i") return R(long);
  if (prevMark) return R(G);
  if (prev.c === "ا" || prev.c === "آ") return R(G); // جاي, نساء
  if (isWaw && next?.c === "ا" && i === n - 2) return R(long); // كتبوا plural
  if (next && (next.c === "ا" || markVowel(next.m))) return R(G); // جواب
  if (!next) return R(long); // word-final after a consonant
  return n <= 4 ? R(mono) : R(long);
}

function skeleton(u: Unit[], let2ph: Record<string, string>, a0: number, a1: number): Phone[] {
  const out: Phone[] = [];
  const push = (sym: string, opts?: PhoneOpts) => out.push(mk(sym, a0, a1, opts));

  for (let i = 0; i < u.length; i++) {
    const { c, m } = u[i]!;
    const gem = m.includes(SHADDA);
    const vow = markVowel(m);
    const last = i === u.length - 1;

    if (c === "ا" || c === "آ" || c === "ى") {
      // The alif carrying a tanwīn is silent; the tanwīn itself is the syllable.
      if (m.includes(TAN_A)) {
        push("a");
        push("N");
        continue;
      }
      if (i === 0) {
        push("Q", { freeze: true });
        push(c === "آ" ? "A:" : vow || "a");
        if (c === "آ" && u.length > 1) push("A:");
        continue;
      }
      push("A:");
      continue;
    }
    if (c === "و" || c === "ي") {
      const g = glide(u, i, c === "و");
      push(g.sym, g.gem ? { gem: true } : undefined);
      if (vow) push(vow);
      continue;
    }
    if (c === "ة") {
      const prev = out[out.length - 1];
      if (prev && prev.sym === "I:") push("Y");
      push("a");
      if (m.includes(TAN_A)) push("N");
      continue;
    }
    if (c === "ء" || c === "أ" || c === "إ" || c === "ؤ" || c === "ئ") {
      push("Q", { freeze: true });
      const seat = c === "إ" ? "i" : c === "ؤ" ? "u" : c === "ئ" ? "i" : "a";
      if (vow) push(vow);
      else if (i === 0 || !last) push(seat);
      continue;
    }

    const sym = let2ph[c];
    if (!sym) continue;
    push(sym, gem ? { gem: true } : undefined);
    if (vow) push(vow);
    else if (m.includes(TAN_A)) {
      push("a");
      push("N");
    } else if (m.includes(TAN_U)) {
      push("u");
      push("N");
    } else if (m.includes(TAN_I)) {
      push("i");
      push("N");
    } else if (m.includes(DAGGER)) push("A:");
  }
  return out;
}

// ────────────────────────────────────────────────────── clitics and ال

type Peel = { prefix: Phone[]; stem: string; gemFirst: boolean };

/**
 * Elision is visible: `fi-l-beːt` has no glottal hold, `ʔil-beːt` does — which
 * is why `prevEndsVowel` has to be tracked across the phrase, not the word.
 */
function peel(w: string, prevEndsVowel: boolean, a0: number, a1: number): Peel {
  const P = (sym: string, opts?: PhoneOpts) => mk(sym, a0, a1, opts);
  const bare = stripTashkeel(w);
  const none: Peel = { prefix: [], stem: w, gemFirst: false };

  const article = (rest: string, lead: Phone[]): Peel | null => {
    if (rest.length < 2) return null;
    const first = rest[0]!;
    if (SUN.has(first)) return { prefix: lead, stem: rest, gemFirst: true };
    return { prefix: [...lead, P("L")], stem: rest, gemFirst: false };
  };

  if (bare.startsWith("ال") && bare.length >= 4) {
    const lead = prevEndsVowel ? [P("i")] : [P("Q", { freeze: true }), P("i")];
    return article(bare.slice(2), lead) ?? none;
  }
  if (bare.length >= 5 && "وفبكل".includes(bare[0]!) && bare.slice(1).startsWith("ال")) {
    const lead = [P(bare[0] === "و" ? "W" : (LET_EG[bare[0]!] ?? "L")), P("i")];
    return article(bare.slice(3), lead) ?? none;
  }
  if (bare.startsWith("لل") && bare.length >= 5) {
    return article(bare.slice(2), [P("L"), P("i")]) ?? none;
  }
  return none;
}

// ────────────────────────────────────────────────── assimilation and spread

/** عنبر → ʕambar: the lips genuinely close. Two lines, and highly visible. */
function assimilate(ph: Phone[]) {
  for (let i = 0; i + 1 < ph.length; i++) {
    const a = ph[i]!,
      b = ph[i + 1]!;
    if (a.sym === "N" && (b.sym === "B" || b.sym === "M")) {
      a.sym = "M";
      a.cls = "NAS";
    }
  }
}

function postProcess(ph: Phone[]) {
  // tafkhīm: an emphatic backs the vowels around it, decaying with distance.
  const src: number[] = [];
  for (let i = 0; i < ph.length; i++) if (AR_EMPHATIC.has(ph[i]!.sym)) src.push(i);
  if (!src.length) return;
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i]!;
    if (!p.vowel) continue;
    let best = 0;
    for (const s of src) {
      const d = Math.abs(s - i);
      const f = d <= 1 ? 1 : d === 2 ? 0.6 : d === 3 ? 0.25 : 0;
      if (f > best) best = f;
    }
    p.emphF = best;
  }
}

// ─────────────────────────────────────────────── syllables and Cairene stress

/** Egyptian onsets are exactly one consonant — never a cluster, never empty. */
export function arSyllabify(phones: Phone[]): Syl[] {
  const nuclei: number[] = [];
  for (let i = 0; i < phones.length; i++) if (phones[i]!.vowel) nuclei.push(i);
  if (!nuclei.length)
    return phones.length
      ? [{ p0: 0, p1: phones.length, nuc: 0, stress: 0, weight: "H", emph: 0, onset: 0 }]
      : [];

  const syls: Syl[] = [];
  for (let k = 0; k < nuclei.length; k++) {
    const nuc = nuclei[k]!;
    const floor = k === 0 ? 0 : nuclei[k - 1]! + 1;
    const p0 = k === 0 ? 0 : Math.max(floor, nuc - 1);
    syls.push({ p0, p1: phones.length, nuc, stress: 0, weight: "L", emph: 0, onset: nuc - p0 });
  }
  for (let k = 0; k < syls.length - 1; k++) syls[k]!.p1 = syls[k + 1]!.p0;
  for (const s of syls) {
    const nucPh = phones[s.nuc]!;
    const coda = s.p1 - s.nuc - 1;
    s.weight = nucPh.long ? (coda > 0 ? "S" : "H") : coda > 1 ? "S" : coda === 1 ? "H" : "L";
  }
  return syls;
}

/** Cairene stress is nearly deterministic, so this is free accuracy. */
export function arStress(syls: Syl[]) {
  const n = syls.length;
  if (!n) return;
  const w = syls.map((s) => s.weight);
  let p: number;
  if (w[n - 1] === "S") p = n - 1;
  else if (n >= 2 && w[n - 2] !== "L") p = n - 2;
  else if (n >= 3) {
    let anchor = -1;
    for (let i = n - 3; i >= 0; i--)
      if (w[i] !== "L") {
        anchor = i;
        break;
      }
    p = (n - 2 - (anchor + 1)) % 2 === 0 ? n - 2 : n - 3;
  } else p = 0;
  p = Math.max(0, Math.min(n - 1, p));
  syls.forEach((s, i) => (s.stress = i === p ? 2 : 0));
}

// ───────────────────────────────────────────────────────────────── the entry

export function arWord(
  word: string,
  reg: Reg,
  prevEndsVowel: boolean,
  a0: number,
  a1: number,
): WordPlan {
  const let2ph = reg === "msa" ? { ...LET_EG, ...LET_MSA } : LET_EG;
  const bare = stripTashkeel(word);
  let phones: Phone[] | null = null;

  const lex = AR_LEX[word] ?? AR_LEX[bare];
  if (lex) phones = parseLex(lex, a0, a1);

  if (!phones) {
    const pl = peel(word, prevEndsVowel, a0, a1);
    const stemLex = AR_LEX[pl.stem];
    const stemU = toUnits(pl.stem);
    let body: Phone[] | null = stemLex ? parseLex(stemLex, a0, a1) : null;
    if (!body) {
      // Vocalised text — or a shadda, which pins a syllable boundary — beats any
      // template guess, so only an unmarked skeleton goes through the patterns.
      const marked = stemU.some(
        (u) => markVowel(u.m) || u.m.includes(SUKUN) || u.m.includes(SHADDA),
      );
      const tpl = marked ? null : matchTemplate(stemU, let2ph);
      if (tpl) body = tpl.map((s) => mk(s, a0, a1, s === "Q" ? { freeze: true } : undefined));
      else {
        const skel = skeleton(stemU, let2ph, a0, a1);
        assimilate(skel);
        body = repair(skel, a0, a1);
      }
    }
    if (pl.gemFirst && body[0]) body[0].gem = true;
    phones = [...pl.prefix, ...body];
  }

  if (!phones.length) return { phones: [], syls: [], func: AR_FUNC.has(bare) };

  assimilate(phones);
  postProcess(phones);
  const syls = arSyllabify(phones);
  arStress(syls);
  for (let i = 0; i < syls.length; i++) {
    const s = syls[i]!;
    for (let p = s.p0; p < s.p1; p++) phones[p]!.syl = i;
    phones[s.nuc]!.stress = s.stress;
  }
  return { phones, syls, func: AR_FUNC.has(bare) };
}

/** Does this word end in a vowel? The next word's ال depends on it. */
export const endsInVowel = (phones: Phone[]) => {
  const last = phones[phones.length - 1];
  return Boolean(last?.vowel);
};
