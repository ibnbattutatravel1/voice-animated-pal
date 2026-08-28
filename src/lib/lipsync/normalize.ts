/**
 * Text normalisation, and the map back to what `speechSynthesis` is reading.
 *
 * `boundary.charIndex` indexes the string we hand the synthesiser, so every
 * transform that changes a length has to record where each character came from.
 * Two strings come out of here: the *analysis* string the score is compiled
 * from (lower-cased for English, tashkeel intact for Arabic) and the *spoken*
 * string (original case, tashkeel stripped, because some voices mishandle it).
 */

import type { Lang } from "./types";

export type Norm = {
  /** What the G2P reads. */
  text: string;
  /** Analysis index → original index. */
  map: Int32Array;
  /** What `speechSynthesis` reads. */
  tts: string;
  /** Analysis index → TTS index. Length is `text.length + 1`. */
  aToTts: Int32Array;
  /** TTS index → original index. */
  ttsMap: Int32Array;
  /** Flat `[start, end, …]` original-text spans wrapped in emphasis markup. */
  emphSpans: number[];
};

const LIGATURES: Record<string, string> = { ﻻ: "لا", ﻷ: "لأ", ﻹ: "لإ", ﻵ: "لآ" };

const QUOTES: Record<string, string> = {
  "“": '"',
  "”": '"',
  "«": '"',
  "»": '"',
  "‘": "'",
  "’": "'",
  "′": "'",
};

/** Tashkeel: kept for analysis, stripped for the voice. */
export const isTashkeel = (c: string) => {
  const k = c.charCodeAt(0);
  return (k >= 0x064b && k <= 0x0652) || k === 0x0670 || k === 0x0653 || k === 0x0654;
};

export const stripTashkeel = (s: string) => {
  let out = "";
  for (const c of s) if (!isTashkeel(c)) out += c;
  return out;
};

function isEmojiOrSymbol(cp: number) {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2190 && cp <= 0x21ff) ||
    cp === 0xfe0f ||
    cp === 0x200d ||
    cp === 0x20e3
  );
}

const EN_ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const EN_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const AR_ONES = [
  "صفر",
  "واحد",
  "اتنين",
  "تلاتة",
  "اربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "تمانية",
  "تسعة",
  "عشرة",
  "حداشر",
  "اتناشر",
  "تلاتاشر",
  "اربعتاشر",
  "خمستاشر",
  "ستاشر",
  "سبعتاشر",
  "تمنتاشر",
  "تسعتاشر",
];
const AR_TENS = ["", "", "عشرين", "تلاتين", "اربعين", "خمسين", "ستين", "سبعين", "تمانين", "تسعين"];

function enNumber(n: number): string {
  if (n < 20) return EN_ONES[n] ?? String(n);
  if (n < 100) {
    const t = EN_TENS[Math.floor(n / 10)] ?? "";
    const r = n % 10;
    return r ? `${t} ${EN_ONES[r]}` : t;
  }
  if (n < 1000) {
    const h = `${EN_ONES[Math.floor(n / 100)]} hundred`;
    const r = n % 100;
    return r ? `${h} ${enNumber(r)}` : h;
  }
  if (n < 1000000) {
    const th = `${enNumber(Math.floor(n / 1000))} thousand`;
    const r = n % 1000;
    return r ? `${th} ${enNumber(r)}` : th;
  }
  if (n < 1000000000) {
    const mi = `${enNumber(Math.floor(n / 1000000))} million`;
    const r = n % 1000000;
    return r ? `${mi} ${enNumber(r)}` : mi;
  }
  // No digit may survive: the G2P skips every glyph outside a–z, so a raw
  // number would cost the timeline its whole duration.
  const bi = `${enNumber(Math.floor(n / 1000000000))} billion`;
  const r = n % 1000000000;
  return r ? `${bi} ${enNumber(r)}` : bi;
}

/** Egyptian says the ones first: 25 → "خمسة وعشرين". */
function arNumber(n: number): string {
  if (n < 20) return AR_ONES[n] ?? String(n);
  if (n < 100) {
    const t = AR_TENS[Math.floor(n / 10)] ?? "";
    const r = n % 10;
    return r ? `${AR_ONES[r]} و${t}` : t;
  }
  if (n < 1000) {
    const hu = Math.floor(n / 100);
    const h = hu === 1 ? "مية" : hu === 2 ? "ميتين" : `${AR_ONES[hu]} مية`;
    const r = n % 100;
    return r ? `${h} و${arNumber(r)}` : h;
  }
  if (n < 1000000) {
    const k = Math.floor(n / 1000);
    const th = k === 1 ? "الف" : k === 2 ? "الفين" : `${arNumber(k)} الاف`;
    const r = n % 1000;
    return r ? `${th} و${arNumber(r)}` : th;
  }
  if (n < 1000000000) {
    const m = Math.floor(n / 1000000);
    const mi = m === 1 ? "مليون" : m === 2 ? "مليونين" : `${arNumber(m)} ملايين`;
    const r = n % 1000000;
    return r ? `${mi} و${arNumber(r)}` : mi;
  }
  const g = Math.floor(n / 1000000000);
  const bi = g === 1 ? "مليار" : g === 2 ? "مليارين" : `${arNumber(g)} مليارات`;
  const r = n % 1000000000;
  return r ? `${bi} و${arNumber(r)}` : bi;
}

const spell = (n: number, lang: Lang) => (lang === "ar" ? arNumber(n) : enNumber(n));

/** Past this the value is no longer exact in a double, and nobody reads it as one. */
const SPELL_MAX_DIGITS = 12;

/**
 * A run is either a quantity or a label. A leading zero or a length past the
 * word table means a label — a phone number, an account, an ID — which is read
 * digit by digit, and that is also the only reading that keeps every digit.
 */
function spellRun(run: string, lang: Lang): string {
  if (run.length <= SPELL_MAX_DIGITS && !(run.length > 1 && run[0] === "0"))
    return spell(+run, lang);
  let out = "";
  for (const d of run) out += `${out ? " " : ""}${spell(+d, lang)}`;
  return out;
}

/** `3:47:12` reads as three forty seven twelve; `3:05` as three oh five. */
function spellTime(h: number, m: number, s: number | null, lang: Lang) {
  const oh = lang === "ar" ? "و" : "oh";
  const min = m === 0 ? "" : m < 10 ? `${oh} ${spell(m, lang)}` : spell(m, lang);
  const sec = s == null ? "" : s === 0 ? "" : s < 10 ? `${oh} ${spell(s, lang)}` : spell(s, lang);
  return [spell(h, lang), min, sec].filter(Boolean).join(" ");
}

// Both sides padded: the pieces are concatenated with no separator, so a
// one-sided pad fuses the replacement onto whatever it touches.
const SYMBOLS_EN: Record<string, string> = {
  "%": " percent ",
  $: " dollars ",
  "&": " and ",
  "@": " at ",
  "+": " plus ",
  "=": " equals ",
};
const SYMBOLS_AR: Record<string, string> = {
  "%": " بالمية ",
  $: " دولار ",
  "&": " و ",
  "@": " أت ",
  "+": " زائد ",
  "=": " يساوي ",
};

/** Written before the number, spoken after it, in both languages. */
const CURRENCY = new Set(["$"]);

type Piece = { a: string; s: string; at: number };

/**
 * Number expansion is load-bearing, not a nicety. `٢٥ دقيقة` and
 * `toLocaleTimeString()` both appear in Nova's own replies; unexpanded, `25` is
 * two characters and ~700 ms of speech, a 5× local timing error that the tempo
 * learner would then generalise across the whole utterance.
 */
function expandNumbers(pieces: Piece[], lang: Lang) {
  const out: Piece[] = [];
  const digits = pieces.map((p) => (p.a.length === 1 && p.a >= "0" && p.a <= "9" ? p.a : ""));
  let i = 0;
  while (i < pieces.length) {
    if (!digits[i]) {
      const p = pieces[i]!;
      const sym = (lang === "ar" ? SYMBOLS_AR : SYMBOLS_EN)[p.a];
      out.push(sym ? { a: sym, s: sym, at: p.at } : p);
      i++;
      continue;
    }
    let j = i;
    while (j < pieces.length && digits[j]) j++;
    const at = pieces[i]!.at;
    const head = digits.slice(i, j).join("");

    // A clock time is one unit: 3:47:12 must not become "three colon forty seven".
    let words: string | null = null;
    let consumed = j;
    if (head.length <= 2 && pieces[j]?.a === ":" && j + 1 < pieces.length) {
      let k = j + 1;
      const mm: string[] = [];
      while (k < pieces.length && digits[k] && mm.length < 2) mm.push(digits[k++]!);
      if (mm.length === 2) {
        const ss: string[] = [];
        let k2 = k;
        if (pieces[k2]?.a === ":") {
          k2++;
          while (k2 < pieces.length && digits[k2] && ss.length < 2) ss.push(digits[k2++]!);
        }
        const useSec = ss.length === 2;
        words = spellTime(+head, +mm.join(""), useSec ? +ss.join("") : null, lang);
        consumed = useSec ? k2 : k;
      }
    }
    if (words == null) words = spellRun(head, lang);

    // `$50` is one unit: the symbol was emitted before the run, so move it after.
    const cur = i > 0 && CURRENCY.has(pieces[i - 1]!.a) ? out.pop() : undefined;
    out.push({ a: words, s: words, at });
    if (cur) out.push(cur);
    i = consumed;
  }
  return out;
}

/** `*word*`, `_word_`, `**word**` — stripped, and the span is marked emphatic. */
const MARKUP_RE = /\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|_([^_\s][^_\n]*)_/g;

function findMarkup(s: string) {
  const drop = new Set<number>();
  const spans: number[] = [];
  MARKUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKUP_RE.exec(s))) {
    const w = m[0]!.startsWith("**") ? 2 : 1;
    const a = m.index + w;
    const b = m.index + m[0]!.length - w;
    for (let i = m.index; i < a; i++) drop.add(i);
    for (let i = b; i < m.index + m[0]!.length; i++) drop.add(i);
    spans.push(a, b);
  }
  return { drop, spans };
}

export function normalize(raw: string, lang: Lang): Norm {
  const s = raw.normalize("NFC");
  const { drop, spans } = findMarkup(s);

  // One walk, two streams. `a` is what the G2P reads, `s` is what the voice reads.
  const pieces: Piece[] = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i)!;
    const wide = cp > 0xffff ? 2 : 1;
    const c = s.slice(i, i + wide);
    const at = i;
    i += wide;

    if (drop.has(at)) continue;
    if (c === "ـ") continue; // tatweel
    if (cp >= 0x0616 && cp <= 0x061a) continue; // Quranic marks
    if (cp >= 0x0660 && cp <= 0x0669) {
      pieces.push({ a: String(cp - 0x0660), s: String(cp - 0x0660), at });
      continue;
    }
    if (cp >= 0x06f0 && cp <= 0x06f9) {
      pieces.push({ a: String(cp - 0x06f0), s: String(cp - 0x06f0), at });
      continue;
    }
    if (LIGATURES[c]) {
      pieces.push({ a: LIGATURES[c]!, s: LIGATURES[c]!, at });
      continue;
    }
    if (QUOTES[c]) {
      pieces.push({ a: QUOTES[c]!, s: QUOTES[c]!, at });
      continue;
    }
    // An emoji becomes a space in both streams: the char span survives, so a
    // boundary landing on it still resolves, and no voice tries to read it.
    if (isEmojiOrSymbol(cp)) {
      pieces.push({ a: " ", s: " ", at });
      continue;
    }
    if (isTashkeel(c)) {
      pieces.push({ a: c, s: "", at });
      continue;
    }
    pieces.push({ a: lang === "en" ? c.toLowerCase() : c, s: c, at });
  }

  const expanded = expandNumbers(pieces, lang);

  let text = "";
  let tts = "";
  const map: number[] = [];
  const ttsMap: number[] = [];
  const aToTts: number[] = [];
  for (const p of expanded) {
    // An expanded piece ("twenty five") is many characters in BOTH streams, so
    // the map has to walk it; collapsing it would give every word in the number
    // the same span and `findWord` could not tell them apart.
    const base = tts.length;
    for (let k = 0; k < p.a.length; k++) {
      aToTts.push(p.s.length ? base + Math.min(k, p.s.length) : base);
      text += p.a[k];
      map.push(p.at);
    }
    for (const ch of p.s) {
      tts += ch;
      ttsMap.push(p.at);
    }
  }
  // A stripped character resolves to whatever the voice reads next, so a
  // boundary landing on it still finds the right word.
  aToTts.push(tts.length);
  for (let i = aToTts.length - 2; i >= 0; i--)
    if (aToTts[i]! > aToTts[i + 1]!) aToTts[i] = aToTts[i + 1]!;

  return {
    text,
    map: Int32Array.from(map),
    tts,
    aToTts: Int32Array.from(aToTts),
    ttsMap: Int32Array.from(ttsMap),
    emphSpans: spans,
  };
}
