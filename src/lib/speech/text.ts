/**
 * Normalisation, and the currency the whole clock is denominated in.
 *
 * **Invariant:** the string handed to the engine and the string handed to the
 * lip-sync engine are byte-identical. Any divergence desynchronises
 * `boundary.charIndex`, which is the only ground truth we ever get about where
 * the voice actually is. So normalisation happens once, up front, and every
 * transform records where each surviving character came from — the chat bubble
 * can still highlight the original display string through `map`.
 *
 * Pure; no browser API. Runs in Node.
 */

import { isArabicText } from "../lipsync/types";

export type Normalised = {
  /** What we speak AND lip-sync. */
  readonly text: string;
  /** map[i] = the index in the display string that produced text[i]. */
  readonly map: Int32Array;
  /** `*word*` / `**word**` spans, as [start, end) into `text`. */
  readonly emphasis: readonly (readonly [number, number])[];
};

/** A URL read aloud is forty seconds of noise. */
const URL_RE = /^(?:https?:\/\/|www\.)\S+/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
/** `10:35:22 AM` → `10:35 AM`; the seconds are eleven spoken characters of nothing. */
const TIME_RE = /^(\d{1,2}):(\d{2}):\d{2}(\s*[AaPp]\.?[Mm]\.?)?/;

const QUOTES = '“”«»‹›„‟"';

/** Emoji, variation selectors and joiners: SAPI reads 💜 as "purple heart". */
function isSymbol(cp: number): boolean {
  return (
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    cp === 0xfe0f ||
    cp === 0x200d
  );
}

/** Tatweel makes some engines spell the word out; the bidi marks are invisible. */
function isInvisible(cp: number): boolean {
  return cp === 0x0640 || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e);
}

export function normaliseForSpeech(src: string): Normalised {
  const out: string[] = [];
  const idx: number[] = [];
  const emphasis: [number, number][] = [];
  const ar = isArabicText(src);

  const push = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) {
      out.push(s.charAt(k));
      idx.push(at);
    }
  };
  const pushSpace = (at: number) => {
    if (out.length > 0 && out[out.length - 1] !== " ") push(" ", at);
  };
  const dropSpace = () => {
    if (out.length > 0 && out[out.length - 1] === " ") {
      out.pop();
      idx.pop();
    }
  };

  /** Open emphasis span, if any: the closing delimiter and where it started. */
  let openEmph: { close: string; at: number } | null = null;

  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const cp = src.codePointAt(i) ?? 0;
    const wide = cp > 0xffff ? 2 : 1;

    if (isSymbol(cp) || isInvisible(cp)) {
      i += wide;
      continue;
    }
    if (/\s/.test(ch)) {
      // A run of newlines is a paragraph break and has to survive as a terminator.
      const run = /^\s+/.exec(src.slice(i))?.[0] ?? ch;
      if (/\n\s*\n/.test(run)) {
        dropSpace();
        push("\n", i);
      } else {
        pushSpace(i);
      }
      i += run.length;
      continue;
    }

    const rest = src.slice(i);

    if (ch === "*") {
      const two = rest.startsWith("**");
      const close = two ? "**" : "*";
      if (openEmph && openEmph.close === close) {
        emphasis.push([openEmph.at, out.length]);
        openEmph = null;
        i += close.length;
        continue;
      }
      if (!openEmph && src.indexOf(close, i + close.length) > i) {
        openEmph = { close, at: out.length };
        i += close.length;
        continue;
      }
      // An unpaired asterisk is punctuation, not markup.
      push("*", i);
      i += 1;
      continue;
    }

    const url = URL_RE.exec(rest)?.[0] ?? EMAIL_RE.exec(rest)?.[0];
    if (url) {
      const kind = url.includes("@") && !url.startsWith("http") ? "email" : "link";
      pushSpace(i);
      push(ar ? (kind === "link" ? "رابط" : "إيميل") : kind === "link" ? "a link" : "an email", i);
      push(" ", i);
      i += url.length;
      continue;
    }

    const time = TIME_RE.exec(rest);
    if (time) {
      push(`${time[1] ?? ""}:${time[2] ?? ""}${time[3] ?? ""}`, i);
      i += time[0].length;
      continue;
    }

    if (rest.startsWith("...")) {
      push("…", i);
      i += 3;
      continue;
    }

    if (QUOTES.includes(ch)) {
      // eSpeak reads “ as "left double quotation mark"; the space keeps the
      // phrase boundary the quote was marking.
      pushSpace(i);
      i += 1;
      continue;
    }
    if (ch === "’") {
      // Between letters it is a contraction and `don’t` must stay one word;
      // anywhere else it is the closing half of a quote.
      const between = /\p{L}/u.test(out[out.length - 1] ?? "") && /\p{L}/u.test(src.charAt(i + 1));
      if (between) push("'", i);
      i += 1;
      continue;
    }
    if (ch === "‘") {
      i += 1;
      continue;
    }
    if (ch === "–" || ch === "—") {
      // Dashes are phrase boundaries. Unhandled, they are read as "dash".
      dropSpace();
      push(",", i);
      push(" ", i);
      i += 1;
      continue;
    }
    if (cp >= 0x0660 && cp <= 0x0669) {
      // Every Arabic engine reads ASCII digits in Arabic; not every one reads ٢٥.
      push(String.fromCharCode(0x30 + cp - 0x0660), i);
      i += 1;
      continue;
    }
    if (cp >= 0x06f0 && cp <= 0x06f9) {
      push(String.fromCharCode(0x30 + cp - 0x06f0), i);
      i += 1;
      continue;
    }

    push(src.slice(i, i + wide), i);
    i += wide;
  }

  // A quote that became a space must not leave one in front of the punctuation
  // it was hugging — `hello ."` reads as two tokens to the sentence splitter.
  for (let k = out.length - 1; k > 0; k--) {
    if (out[k - 1] === " " && /[.,;:!?…،؛؟]/u.test(out[k] ?? "")) {
      out.splice(k - 1, 1);
      idx.splice(k - 1, 1);
    }
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    idx.pop();
  }
  let head = 0;
  while (head < out.length && out[head] === " ") head++;

  const text = out.slice(head).join("");
  const map = Int32Array.from(idx.slice(head));
  const spans = emphasis
    .map((s) => [s[0] - head, s[1] - head] as const)
    .filter((s) => s[0] >= 0 && s[1] > s[0]);
  return { text, map, emphasis: spans };
}

/**
 * The clock currency.
 *
 * Raw `text.length` is a bad clock: "25" is two characters and about eleven
 * spoken ones, a space is not a phoneme, and a comma is silence that already
 * lives in the pause table. Weighting the characters is what keeps the mouth on
 * the voice through numbers and punctuation.
 */
export function weightedChars(t: string): number {
  let w = 0;
  for (let i = 0; i < t.length; i++) w += charWeight(t.charCodeAt(i));
  return w;
}

function charWeight(c: number): number {
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 1;
  if ((c >= 0x0621 && c <= 0x064a) || (c >= 0x0671 && c <= 0x06d3)) return 1;
  if (c >= 0x064b && c <= 0x0652) return 0.15; // a diacritic is a colour, not a beat
  if (c >= 0x30 && c <= 0x39) return 3.2; // "25" is spoken as "twenty five"
  if (c === 0x20 || c === 0x09 || c === 0x0a) return 0.55;
  if (
    c === 0x25 ||
    c === 0x24 ||
    c === 0x26 ||
    c === 0x40 ||
    c === 0x2b ||
    c === 0x3d ||
    c === 0x23 ||
    c === 0xb0
  )
    return 4;
  if (TERMINAL_CODES.has(c)) return 0;
  return 0.2;
}

/** Punctuation whose duration lives in the pause table, not in the clock. */
const TERMINAL_CODES = new Set<number>([
  0x2c, 0x3b, 0x3a, 0x2e, 0x21, 0x3f, 0x2026, 0x060c, 0x061b, 0x061f,
]);

/** Word count, using the same token rule the emphasis carver uses. */
export function countWords(t: string): number {
  return (t.match(WORD_RE) ?? []).length;
}

/** `\p{M}` is load-bearing: without it a carve can split `دايماً` from its tanween. */
export const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'-]*/gu;

/**
 * Rule T's other half: take a phrase's own trailing punctuation off so the role
 * can append the glyph it needs. Leaves punctuation *inside* the phrase alone —
 * that is the engine's business.
 */
export function stripTerminal(t: string): string {
  return t.replace(/[\s.,;:!?…،؛؟۔-]+$/u, "");
}

/**
 * Cairene readings through an English voice — `ج` is a hard g and `ق` a k, which
 * is what an Egyptian actually says. Behind `config.arFallback === "translit"`
 * and capped at a short phrase, because it produces intelligible Cairene for
 * "ezzayak" and mush for a paragraph, and a user hearing garbled pseudo-Arabic
 * concludes the app is broken.
 */
const AR_LATIN: Readonly<Record<string, string>> = {
  ا: "a",
  أ: "a",
  إ: "i",
  آ: "aa",
  ب: "b",
  ت: "t",
  ث: "s",
  ج: "g",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "z",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "k",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ى: "a",
  ة: "a",
  ء: "",
  ئ: "y",
  ؤ: "w",
  "\u064E": "a",
  "\u064F": "u",
  "\u0650": "i",
  "\u064B": "an",
  "\u064C": "un",
  "\u064D": "in",
  "\u0651": "",
  "\u0652": "",
};

export function translitAr(t: string): string {
  let out = "";
  let cluster = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    const mapped = AR_LATIN[ch];
    if (mapped === undefined) {
      out += ch;
      cluster = 0;
      continue;
    }
    // Arabic is written unvocalised; without a slipped-in vowel an English voice
    // spells the consonants out one letter at a time.
    if (mapped && !/[aeiou]/.test(mapped) && cluster >= 2) {
      out += "a";
      cluster = 0;
    }
    out += mapped;
    cluster = mapped && /[aeiou]/.test(mapped) ? 0 : cluster + 1;
  }
  return out.replace(/\s+/g, " ").trim();
}
