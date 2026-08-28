/**
 * English grapheme → phone.
 *
 * Five stages: an exception lexicon (English's most frequent words are its most
 * irregular — the top ~200 types are over half of all tokens, so this table is
 * worth more than fifty rules), a morphology pass, an ordered letter-rule table,
 * fixups, then syllabification and stress.
 *
 * The table is sized around the five distinctions a *viewer* can see — rounding,
 * bilabial closure, labiodental contact, jaw magnitude and spread — which is why
 * it is ~150 rules rather than the NRL set's ~330. Voicing and coronal place can
 * be wrong for free.
 */

import { baseSym, infoOf, PH } from "./phones";
import type { Phone, Syl, WordPlan } from "./model";

// ─────────────────────────────────────────────────────── stage 1: the lexicon

const EN_FUNC_SRC =
  "the a an and of to too in is it are was were as be been am do does did done have has had " +
  "will would could should i you your my me we he she him her they them this that these those " +
  "there their then than what who whose why where when how for from with into on at by but not " +
  "all or its so if can may must up out no yes";

export const EN_FUNC = new Set(EN_FUNC_SRC.split(" "));

const EN_LEX: Record<string, string> = {
  // function words — also the reduction set
  the: "DH AX",
  a: "AX",
  an: "AE N",
  and: "AX N D",
  of: "AH V",
  to: "T AX",
  too: "T UW",
  in: "IH N",
  is: "IH Z",
  it: "IH T",
  are: "AA R",
  was: "W AH Z",
  were: "W ER",
  as: "AE Z",
  be: "B IY",
  been: "B IH N",
  am: "AE M",
  do: "D UW",
  // Alongside `do`/`be` so `going` has a stem to resolve: peeled to `go`, the
  // letter rules see a closed syllable and lose the rounding.
  go: "G OW",
  does: "D AH Z",
  did: "D IH D",
  done: "D AH N",
  have: "HH AE V",
  has: "HH AE Z",
  had: "HH AE D",
  will: "W IH L",
  would: "W UH D",
  could: "K UH D",
  should: "SH UH D",
  i: "AY",
  you: "Y UW",
  your: "Y AO R",
  my: "M AY",
  me: "M IY",
  we: "W IY",
  he: "HH IY",
  she: "SH IY",
  him: "HH IH M",
  her: "HH ER",
  they: "DH EY",
  them: "DH EH M",
  this: "DH IH S",
  that: "DH AE T",
  these: "DH IY Z",
  those: "DH OW Z",
  there: "DH EH R",
  their: "DH EH R",
  then: "DH EH N",
  than: "DH AE N",
  what: "W AH T",
  who: "HH UW",
  whose: "HH UW Z",
  why: "W AY",
  where: "W EH R",
  when: "W EH N",
  how: "HH AW",
  for: "F AO R",
  from: "F R AH M",
  with: "W IH DH",
  into: "IH N T UW",
  on: "AA N",
  at: "AE T",
  by: "B AY",
  but: "B AH T",
  not: "N AA T",
  all: "AO L",
  or: "AO R",
  // frequent irregulars
  one: "W AH N",
  two: "T UW",
  once: "W AH N S",
  said: "S EH D",
  says: "S EH Z",
  come: "K AH M",
  some: "S AH M",
  none: "N AH N",
  love: "L AH V",
  above: "AX B 'AH V",
  move: "M UW V",
  lose: "L UW Z",
  gone: "G AO N",
  women: "W 'IH M IH N",
  woman: "W 'UH M AX N",
  busy: "B 'IH Z IY",
  buy: "B AY",
  eye: "AY",
  measure: "M 'EH ZH ER",
  "i'm": "AY M",
  "i'll": "AY L",
  "i've": "AY V",
  "it's": "IH T S",
  "let's": "L EH T S",
  "what's": "W AH T S",
  "that's": "DH AE T S",
  "don't": "D OW N T",
  "can't": "K AE N T",
  "you're": "Y AO R",
  here: "HH IH R",
  eyes: "AY Z",
  again: "AX G 'EH N",
  against: "AX G 'EH N S T",
  any: "'EH N IY",
  many: "M 'EH N IY",
  give: "G IH V",
  live: "L IH V",
  get: "G EH T",
  girl: "G ER L",
  gift: "G IH F T",
  gear: "G IH R",
  begin: "B IH G 'IH N",
  head: "HH EH D",
  bread: "B R EH D",
  dead: "D EH D",
  ready: "R 'EH D IY",
  great: "G R EY T",
  break: "B R EY K",
  steak: "S T EY K",
  heart: "HH AA R T",
  bear: "B EH R",
  wear: "W EH R",
  earth: "ER TH",
  early: "'ER L IY",
  learn: "L ER N",
  heard: "HH ER D",
  now: "N AW",
  down: "D AW N",
  allow: "AX L 'AW",
  though: "DH OW",
  through: "TH R UW",
  thought: "TH AO T",
  tough: "T AH F",
  rough: "R AH F",
  enough: "IH N 'AH F",
  cough: "K AO F",
  laugh: "L AE F",
  half: "HH AE F",
  food: "F UW D",
  good: "G UH D",
  put: "P UH T",
  push: "P UH SH",
  full: "F UH L",
  pull: "P UH L",
  cost: "K AO S T",
  lost: "L AO S T",
  school: "S K UW L",
  ache: "EY K",
  character: "K 'AE R IH K T ER",
  chemistry: "K 'EH M IH S T R IY",
  machine: "M AX SH 'IY N",
  stomach: "S T 'AH M AX K",
  christmas: "K R 'IH S M AX S",
  sure: "SH UH R",
  sugar: "SH 'UH G ER",
  ocean: "'OW SH AX N",
  people: "P 'IY P AX L",
  little: "L 'IH T AX L",
  friend: "F R EH N D",
  front: "F R AH N T",
  because: "B IH K 'AO Z",
  honest: "'AA N IH S T",
  hour: "AW ER",
  iron: "'AY ER N",
  island: "'AY L AX N D",
  know: "N OW",
  knew: "N UW",
  answer: "'AE N S ER",
  listen: "L 'IH S AX N",
  nothing: "N 'AH TH IH NG",
  water: "W 'AO T ER",
  father: "F 'AA DH ER",
  mother: "M 'AH DH ER",
  brother: "B R 'AH DH ER",
  another: "AX N 'AH DH ER",
  together: "T AX G 'EH DH ER",
  either: "'IY DH ER",
  // app vocabulary — the strings Nova actually speaks are always worth pinning
  nova: "N 'OW V AX",
  hello: "HH AX L 'OW",
  hey: "HH EY",
  hi: "HH AY",
  ok: "OW K 'EY",
  okay: "OW K 'EY",
  yeah: "Y AE",
  companion: "K AX M P 'AE N Y AX N",
  listening: "L 'IH S AX N IH NG",
  minute: "M 'IH N AX T",
  minutes: "M 'IH N AX T S",
  focus: "F 'OW K AX S",
  currently: "K 'ER AX N T L IY",
  anytime: "'EH N IY T AY M",
  daily: "D 'EY L IY",
  deep: "D IY P",
  block: "B L AA K",
  mind: "M AY N D",
  follow: "F 'AA L OW",
  along: "AX L 'AO NG",
  right: "R AY T",
  flow: "F L OW",
  work: "W ER K",
  start: "S T AA R T",
  tell: "T EH L",
  more: "M AO R",
  say: "S EY",
};

/** /ð/ is invisible next to /θ/ — the set exists because it changes duration, not shape. */
const DH_WORDS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "they",
  "them",
  "their",
  "there",
  "then",
  "than",
  "though",
  "thus",
  "thy",
  "thee",
  "either",
  "neither",
  "other",
  "another",
  "mother",
  "father",
  "brother",
  "together",
  "weather",
  "whether",
  "rather",
  "gather",
  "bother",
  "further",
  "northern",
  "southern",
  "clothes",
  "breathe",
  "smooth",
  "with",
]);

// ────────────────────────────────────────────── stage 3: the letter-rule table

type Rule = [left: string, focus: string, right: string, out: string];

const MACRO: Record<string, string> = {
  C: "[bcdfghjklmnpqrstvwxz]",
  V: "[aeiouy]",
  F: "[eiy]", // front vowel: softens c and g
  K: "[aou]", // back vowel: hard c and g
  // magic-e: one consonant, then a vowel suffix or a final e
  M: "(?:[bcdfghjklmnpqrstvwxz](?:e|es|ed|ing|er|est|ely|y|ly)#|" + "[bcdfghjklmnpqrstvwxz][rl]e#)",
  S: "(?:e|es|ed|ing|er|est|ely|s)",
};

const EN_RULES: Rule[] = [
  // ── silent letters and clusters
  ["#", "kn", "", "N"],
  ["#", "gn", "", "N"],
  ["#", "wr", "", "R"],
  ["#", "ps", "", "S"],
  ["#", "pn", "", "N"],
  ["#", "mn", "", "N"],
  ["#", "x", "", "Z"],
  ["#", "gh", "", "G"],
  ["", "mb", "#", "M"],
  ["", "mn", "#", "M"],
  ["", "gh", "t", ""],
  ["", "gh", "#", ""],
  // ── A
  ["", "augh", "t", "AO"],
  ["", "aigh", "", "EY"],
  ["", "eigh", "", "EY"],
  ["", "ai", "", "EY"],
  ["", "ay", "", "EY"],
  ["", "au", "", "AO"],
  ["", "aw", "V", "AX W"],
  ["", "aw", "", "AO"],
  ["", "all", "", "AO L"],
  ["", "al", "[dfkmt]", "AO"],
  ["", "are", "#", "EH R"],
  ["", "air", "", "EH R"],
  ["", "ar", "#", "AA R"],
  ["", "ar", "C", "AA R"],
  ["qu", "a", "C", "AA"],
  ["[wq]", "a", "(?![rw])", "AA"],
  ["", "a", "M", "EY"],
  ["", "a", "tion", "EY"],
  ["", "a", "(?:st#|sk|ss|ft|th|nce#)", "AE"],
  ["", "a", "CC", "AE"],
  ["", "a", "C V", "EY"],
  ["", "a", "#", "AX"],
  ["", "a", "", "AE"],
  // ── B  C  D
  ["", "bb", "", "B"],
  ["", "b", "t#", ""],
  ["", "b", "", "B"],
  ["", "cch", "", "K"],
  ["", "ch", "", "CH"],
  ["", "ck", "", "K"],
  ["", "cc", "F", "K S"],
  ["", "cc", "", "K"],
  ["s", "c", "F", ""],
  ["", "c", "F", "S"],
  ["", "c", "", "K"],
  ["", "dge", "", "JH"],
  ["", "dg", "F", "JH"],
  ["", "dd", "", "D"],
  ["", "d", "", "D"],
  // ── E
  ["", "eau", "", "OW"],
  ["", "ee", "", "IY"],
  ["", "ear", "C", "ER"],
  ["", "ear", "#", "IH R"],
  ["", "ea", "", "IY"],
  ["", "ei", "", "IY"],
  ["", "eu", "", "Y UW"],
  ["[bfhmpv]", "ew", "", "Y UW"],
  ["", "ew", "", "UW"],
  ["", "ere", "#", "IH R"],
  ["", "eer", "", "IH R"],
  ["", "er", "#", "ER"],
  ["", "er", "C", "ER"],
  ["", "ey", "#", "IY"],
  ["", "ey", "", "EY"],
  // `ex` before a vowel voices; it has to precede the catch-all `e`, or it never fires.
  ["", "ex", "V", "IH G Z"],
  ["", "e", "M", "IY"],
  ["", "e", "#", ""],
  ["", "e", "", "EH"],
  // ── F  G  H
  ["", "ff", "", "F"],
  ["", "f", "", "F"],
  ["", "gg", "", "G"],
  ["", "gn", "#", "N"],
  ["", "g", "F", "JH"],
  ["", "g", "", "G"],
  ["V", "h", "#", ""],
  ["", "h", "", "HH"],
  // ── I
  ["", "igh", "", "AY"],
  ["", "ight", "", "AY T"],
  ["", "ign", "#", "AY N"],
  ["", "ind", "#", "AY N D"],
  ["", "ild", "#", "AY L D"],
  ["", "ie", "#", "AY"],
  ["", "ie", "", "IY"],
  ["", "ir", "C", "ER"],
  ["", "ion", "#", "Y AX N"],
  ["", "i", "M", "AY"],
  ["", "i", "nk", "IH"],
  ["", "i", "", "IH"],
  // ── J  K  L  M  N
  ["", "j", "", "JH"],
  ["", "k", "", "K"],
  ["", "ll", "", "L"],
  ["", "l", "", "L"],
  ["", "mm", "", "M"],
  ["", "m", "", "M"],
  ["", "ng", "#", "NG"],
  ["", "ng", "C", "NG"],
  ["", "nn", "", "N"],
  ["", "n", "[kcg]", "NG"],
  ["", "n", "", "N"],
  // ── O
  ["", "ough", "t", "AO"],
  ["", "ough", "#", "OW"],
  ["", "oo", "[kd]", "UH"],
  ["", "oo", "", "UW"],
  ["", "oul", "d#", "UH"],
  ["", "our", "#", "AW ER"],
  ["", "ou", "r C", "AO"],
  ["", "ou", "s#", "AX S"],
  ["", "ou", "", "AW"],
  ["", "ow", "n#", "OW"],
  ["", "ow", "#", "OW"],
  ["", "ow", "C V", "OW"],
  ["", "ow", "C", "AW"],
  ["", "ow", "", "AW"],
  ["", "oi", "", "OY"],
  ["", "oy", "", "OY"],
  ["", "oa", "", "OW"],
  ["", "oe", "#", "OW"],
  ["", "or", "", "AO R"],
  ["", "o", "(?:ld|lt|ll|lk|st#)", "OW"],
  ["", "o", "ng", "AO"],
  ["", "o", "M", "OW"],
  ["", "o", "C V", "OW"],
  ["", "o", "#", "OW"],
  ["w", "o", "", "AH"],
  ["", "o", "", "AA"],
  // ── P  Q  R
  ["", "ph", "", "F"],
  ["", "pp", "", "P"],
  ["", "p", "", "P"],
  ["", "que", "#", "K"],
  ["", "qu", "", "K W"],
  ["", "q", "", "K"],
  ["", "rr", "", "R"],
  ["", "r", "", "R"],
  // ── S
  ["", "sch", "", "S K"],
  ["", "sh", "", "SH"],
  ["", "ssi", "V", "SH"],
  ["V", "si", "V", "ZH"],
  ["", "ss", "", "S"],
  ["V", "s", "V", "Z"],
  ["", "s", "", "S"],
  // ── T
  ["", "tch", "", "CH"],
  ["", "th", "", "TH"],
  ["", "tt", "", "T"],
  ["", "t", "", "T"],
  // ── U
  ["", "ur", "C", "ER"],
  ["[qg]", "u", "V", "W"],
  ["g", "u", "[ei]", ""],
  ["", "ue", "#", "UW"],
  ["", "ui", "", "UW"],
  ["[rljs]", "u", "M", "UW"],
  ["", "u", "M", "Y UW"],
  ["", "u", "C V", "UW"],
  ["", "u", "", "AH"],
  // ── V  W  X  Y  Z
  ["", "v", "", "V"],
  ["", "wh", "", "W"],
  ["", "w", "", "W"],
  ["", "x", "", "K S"],
  ["#", "y", "V", "Y"],
  ["#C?C?", "y", "#", "AY"],
  ["C", "y", "#", "IY"],
  ["", "y", "M", "AY"],
  ["", "y", "", "IH"],
  ["", "zz", "", "Z"],
  ["", "z", "", "Z"],
];

/** `#` is the word's own boundary — words are matched one at a time, so no lookbehind. */
const expand = (p: string) => p.replace(/ /g, "").replace(/[VCFKMS]/g, (m) => MACRO[m]!);

type Compiled = { focus: string; left: RegExp | null; right: RegExp | null; out: string[] };

const BUCKETS: Compiled[][] = Array.from({ length: 26 }, () => []);
const EMPTY: Compiled[] = [];

for (const r of EN_RULES) {
  const code = r[1].charCodeAt(0) - 97;
  if (code < 0 || code >= 26) continue;
  BUCKETS[code]!.push({
    focus: r[1],
    left: r[0] ? new RegExp(`${expand(r[0]).replace(/#/g, "^")}$`) : null,
    right: r[2] ? new RegExp(`^${expand(r[2]).replace(/#/g, "$")}`) : null,
    out: r[3] ? r[3].split(" ") : [],
  });
}

/**
 * `limit` stops the emission at a morpheme boundary while the *contexts* still
 * see the whole word — which is the only reason `nation` gets EY and not the
 * word-final schwa the stem "na" would otherwise earn.
 */
function applyRules(word: string, limit = word.length): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < limit) {
    const code = word.charCodeAt(i) - 97;
    const bucket = code >= 0 && code < 26 ? BUCKETS[code]! : EMPTY;
    let hit = 0;
    for (const r of bucket) {
      // A focus that straddles the boundary belongs to the suffix, not the stem:
      // without this, `year` peeled to `ye` still matches the 3-char `ear`.
      if (i + r.focus.length > limit) continue;
      if (!word.startsWith(r.focus, i)) continue;
      if (r.left && !r.left.test(word.slice(0, i))) continue;
      if (r.right && !r.right.test(word.slice(i + r.focus.length))) continue;
      for (const p of r.out) out.push(p);
      hit = r.focus.length;
      break;
    }
    i += hit || 1; // an unknown glyph is skipped silently
  }
  return out;
}

// ──────────────────────────────────── stage 2: morphology and the suffix pass

type SufKind = "pre" | "self" | "neutral";

/** `keep` is how many leading characters of the match belong to the stem. */
const EN_SUF: [RegExp, string, SufKind, number?][] = [
  [/ationally$/, "EY SH AX N AX L IY", "pre"],
  [/ation$/, "EY SH AX N", "pre"],
  [/itions?$/, "IH SH AX N", "pre"],
  [/tion$/, "SH AX N", "pre"],
  [/ssion$/, "SH AX N", "pre"],
  [/[^aeiou]sion$/, "SH AX N", "pre", 1],
  [/[aeiou]sion$/, "ZH AX N", "pre", 1],
  [/cious$|tious$/, "SH AX S", "pre"],
  [/cial$|tial$/, "SH AX L", "pre"],
  [/ture$/, "CH ER", "neutral"],
  [/sure$/, "ZH ER", "neutral"],
  [/ology$/, "AA L AX JH IY", "pre"],
  [/ography$/, "AA G R AX F IY", "pre"],
  [/ically$/, "IH K L IY", "pre"],
  [/ical$/, "IH K AX L", "pre"],
  [/ity$/, "IH T IY", "pre"],
  [/ious$|eous$/, "IY AX S", "pre"],
  [/ous$/, "AX S", "neutral"],
  [/able$|ible$/, "AX B AX L", "neutral"],
  [/ment$/, "M AX N T", "neutral"],
  [/ness$/, "N AX S", "neutral"],
  [/less$/, "L AX S", "neutral"],
  [/ful$/, "F AX L", "neutral"],
  [/ing$/, "IH NG", "neutral"],
  [/ly$/, "L IY", "neutral"],
  [/age$/, "IH JH", "neutral"],
  [/ee$/, "IY", "self"],
  [/eer$/, "IY R", "self"],
  [/ese$/, "IY Z", "self"],
  [/ette$/, "EH T", "self"],
  [/esque$/, "EH S K", "self"],
  [/oon$/, "UW N", "self"],
  [/ique$/, "IY K", "self"],
  [/ic$/, "IH K", "pre"],
  // Only after a consonant: `teach|er`, `doct|or`, `sug|ar`. A vowel before the
  // `r` is a rime the letter rules already read whole (year, door, clear), and
  // peeling it there invents a second syllable.
  [/[^aeiou]er$|[^aeiou]or$|[^aeiou]ar$/, "ER", "neutral", 1],
];

const ED_SYLLABIC = new Set(["T", "D"]);
const ED_VOICELESS = new Set(["P", "K", "F", "S", "SH", "CH", "TH"]);
const ES_SIBILANT = new Set(["S", "Z", "SH", "ZH", "CH", "JH"]);
const S_VOICELESS = new Set(["P", "T", "K", "F", "TH"]);

/**
 * A stem that only exists because we removed an inflection often wants its
 * silent `e` back — `loved → love`, `moving → move`. Restoring it only when the
 * result is a known word keeps the trick from misfiring on `wanted → wante`.
 */
const restoreE = (stem: string) =>
  // A two-letter remnant is not a stem, and restoring it lands on a function
  // word: `th` + `ing` would otherwise be read as `the` + `ing`.
  stem.length >= 3 && EN_LEX[`${stem}e`] ? `${stem}e` : stem;

const undouble = (stem: string) => (/([bcdfgklmnprstvz])\1$/.test(stem) ? stem.slice(0, -1) : stem);

type Inflection = { stem: string; kind: "ed" | "es" | "s" | "" };

function splitInflection(w: string): Inflection {
  if (w.length > 4 && w.endsWith("ies")) return { stem: `${w.slice(0, -3)}y`, kind: "s" };
  if (w.length > 4 && w.endsWith("ied")) return { stem: `${w.slice(0, -3)}y`, kind: "ed" };
  if (w.length > 3 && w.endsWith("ed") && !/[aeiou]ed$/.test(w))
    return { stem: restoreE(undouble(w.slice(0, -2))), kind: "ed" };
  if (w.length > 3 && w.endsWith("es") && /(?:s|z|x|ch|sh)es$/.test(w))
    return { stem: w.slice(0, -2), kind: "es" };
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us"))
    return { stem: w.slice(0, -1), kind: "s" };
  return { stem: w, kind: "" };
}

function inflectionPhones(kind: Inflection["kind"], last: string): string[] {
  if (kind === "ed") {
    if (ED_SYLLABIC.has(last)) return ["IH", "D"];
    return ED_VOICELESS.has(last) ? ["T"] : ["D"];
  }
  if (kind === "es") return ["IH", "Z"];
  if (kind === "s")
    return ES_SIBILANT.has(last) ? ["IH", "Z"] : S_VOICELESS.has(last) ? ["S"] : ["Z"];
  return [];
}

/** Returns the phone strings plus which syllable the suffix wants stressed. */
function lettersToPhones(word: string): { syms: string[]; suffix: SufKind | null } {
  const lex = EN_LEX[word];
  if (lex) return { syms: lex.split(" "), suffix: null };

  const infl = splitInflection(word);
  let base = infl.stem;
  let suffix: SufKind | null = null;
  let tail: string[] = [];
  let vowelTail = infl.kind !== "";

  if (base.length >= 3) {
    const direct = EN_LEX[base];
    if (direct) {
      const syms = direct.split(" ");
      const last = syms[syms.length - 1]!.replace("'", "");
      return { syms: [...syms, ...inflectionPhones(infl.kind, last)], suffix: null };
    }
    for (const [re, out, kind, keep = 0] of EN_SUF) {
      const m = re.exec(base);
      if (!m || m.index + keep < 2) continue;
      tail = out.split(" ");
      suffix = kind;
      // Only a vowel-initial suffix could have swallowed a silent `e`; without
      // this, `only` loses its `ly`, restores to `one`, and comes out as W AH N.
      vowelTail = /^[aeiou]/.test(m[0].slice(keep));
      base = base.slice(0, m.index + keep);
      break;
    }
  }

  // `-ing` on a magic-e stem: hoping, moving. The letter rules need the `e` back.
  const stem = vowelTail && tail.length && base.length >= 2 ? restoreE(base) : base;
  const src = stem || word;
  const stemSyms =
    EN_LEX[src]?.split(" ") ??
    (word.startsWith(src) ? applyRules(word, src.length) : applyRules(src));
  const syms = [...stemSyms, ...tail];
  const lastCore = (syms[syms.length - 1] ?? "AX").replace("'", "");
  return { syms: [...syms, ...inflectionPhones(infl.kind, lastCore)], suffix };
}

// ───────────────────────────────────────────────────────── stage 4: syllables

const EN_ONSETS = new Set([
  "P",
  "B",
  "T",
  "D",
  "K",
  "G",
  "M",
  "N",
  "F",
  "V",
  "TH",
  "DH",
  "S",
  "Z",
  "SH",
  "ZH",
  "CH",
  "JH",
  "HH",
  "L",
  "R",
  "W",
  "Y",
  "P L",
  "P R",
  "B L",
  "B R",
  "T R",
  "D R",
  "T W",
  "D W",
  "K L",
  "K R",
  "K W",
  "G L",
  "G R",
  "G W",
  "F L",
  "F R",
  "TH R",
  "SH R",
  "S L",
  "S W",
  "S P",
  "S T",
  "S K",
  "S M",
  "S N",
  "S F",
  "HH W",
  "S P L",
  "S P R",
  "S T R",
  "S K R",
  "S K W",
  "P Y",
  "B Y",
  "K Y",
  "G Y",
  "F Y",
  "M Y",
  "V Y",
  "N Y",
  "HH Y",
]);

/**
 * Maximal onset, filtered for legality: for each inter-nucleus consonant run,
 * take the longest suffix that English actually allows word-initially, and the
 * rest is coda. `LL` is the dark allophone and is coda-only by construction.
 */
export function syllabify(phones: Phone[]): Syl[] {
  const nuclei: number[] = [];
  for (let i = 0; i < phones.length; i++) if (phones[i]!.vowel) nuclei.push(i);
  if (!nuclei.length) {
    return phones.length
      ? [{ p0: 0, p1: phones.length, nuc: 0, stress: 0, weight: "H", emph: 0, onset: 0 }]
      : [];
  }

  const syls: Syl[] = [];
  for (let k = 0; k < nuclei.length; k++) {
    const nuc = nuclei[k]!;
    let p0: number;
    if (k === 0) p0 = 0;
    else {
      const prev = nuclei[k - 1]!;
      const run: string[] = [];
      for (let i = prev + 1; i < nuc; i++) run.push(phones[i]!.sym);
      let take = 0;
      for (let n = Math.min(3, run.length); n >= 1; n--) {
        if (EN_ONSETS.has(run.slice(run.length - n).join(" "))) {
          take = n;
          break;
        }
      }
      p0 = nuc - take;
    }
    const p1 = k === nuclei.length - 1 ? phones.length : nuclei[k + 1]!;
    syls.push({ p0, p1, nuc, stress: 0, weight: "L", emph: 0, onset: nuc - p0 });
  }
  // Trim: each syllable ends where the next begins.
  for (let k = 0; k < syls.length - 1; k++) syls[k]!.p1 = syls[k + 1]!.p0;
  for (const s of syls) {
    const nucPh = phones[s.nuc]!;
    const coda = s.p1 - s.nuc - 1;
    s.weight = nucPh.long ? (coda > 0 ? "S" : "H") : coda > 1 ? "S" : coda === 1 ? "H" : "L";
  }
  return syls;
}

const heavy = (s: Syl) => s.weight !== "L";

const PREFIX_EN_RE =
  /^(un|re|de|dis|in|im|en|em|pre|pro|per|mis|over|under|ex|non|be|a|con|com|ad|ab|ob|sub)/;

function enStress(word: string, syls: Syl[], isFunc: boolean, suffix: SufKind | null) {
  const n = syls.length;
  if (!n) return;
  if (isFunc) {
    for (const s of syls) s.stress = 0;
    return;
  }
  if (n === 1) {
    syls[0]!.stress = 2;
    return;
  }
  let p: number;
  if (suffix === "self") p = n - 1;
  else if (suffix === "pre") p = Math.max(0, n - 2);
  else if (/(ate|ize|ise|ary|ory|acy|itude|fy)$/.test(word) && n >= 3) p = n - 3;
  // The prefix test reads the *whole* word, so it only applies when no
  // stress-transparent suffix was peeled off: `return` takes it, `reading` must not.
  else if (n === 2) p = suffix === null && PREFIX_EN_RE.test(word) ? 1 : 0;
  else p = heavy(syls[n - 2]!) ? n - 2 : n - 3;
  p = Math.max(0, Math.min(n - 1, p));
  syls.forEach((s, i) => (s.stress = i === p ? 2 : 0));
  if (n >= 4) syls[p >= 2 ? 0 : n - 1]!.stress = 1;
}

// ──────────────────────────────────────────────────────────────── the entry

const mkPhone = (sym: string, a0: number, a1: number): Phone => {
  const info = infoOf(sym);
  return {
    sym,
    cls: info.cls,
    vowel: info.cls.startsWith("V"),
    gem: false,
    emph: false,
    emphF: 0,
    freeze: false,
    long: info.cls === "VLONG" || info.cls === "VDIPH",
    stress: 0,
    reduce: 0,
    a0,
    a1,
    word: 0,
    syl: 0,
  };
};

export function enWord(word: string, a0: number, a1: number): WordPlan {
  const { syms, suffix } = lettersToPhones(word);
  const phones: Phone[] = [];
  let explicit = -1;
  for (const raw of syms) {
    if (!raw) continue;
    const marked = raw.startsWith("'");
    const sym = marked ? raw.slice(1) : raw;
    if (!PH[baseSym(sym)]) continue;
    if (marked) explicit = phones.length;
    phones.push(mkPhone(sym, a0, a1));
  }
  if (!phones.length) return { phones, syls: [], func: EN_FUNC.has(word) };

  fixups(phones, word);
  const syls = syllabify(phones);
  const func = EN_FUNC.has(word);
  if (explicit >= 0) {
    // A pinned lexicon stress beats the guesser — that is the point of pinning it.
    let hit = 0;
    for (let i = 0; i < syls.length; i++) if (syls[i]!.p0 <= explicit) hit = i;
    syls.forEach((s, i) => (s.stress = i === hit ? 2 : 0));
    if (syls.length >= 4) syls[hit >= 2 ? 0 : syls.length - 1]!.stress = 1;
  } else {
    enStress(word, syls, func, suffix);
  }
  for (let i = 0; i < syls.length; i++) {
    const s = syls[i]!;
    for (let p = s.p0; p < s.p1; p++) phones[p]!.syl = i;
    phones[s.nuc]!.stress = s.stress;
  }
  return { phones, syls, func };
}

/**
 * Post-rule fixups. Dark /l/ is the visible one: coda `l` rounds and retracts,
 * and treating it as the same phone as onset `l` is a shape error you can see.
 */
function fixups(phones: Phone[], word: string) {
  const dh = DH_WORDS.has(word);
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i]!;
    if (p.sym === "TH" && dh) {
      p.sym = "DH";
      p.cls = "FRICN";
    }
    if (p.sym === "L") {
      let vowelLater = false;
      for (let j = i + 1; j < phones.length; j++) if (phones[j]!.vowel) vowelLater = true;
      if (!vowelLater) {
        p.sym = "LL";
        p.cls = "LAT";
      }
    }
    // /ŋdʒ/ is not an English cluster: a `g` after `ng` is always hard, whether
    // the morpheme boundary made it visible (singer) or not (finger).
    const after = phones[i + 1];
    if (p.sym === "NG" && after?.sym === "JH") {
      after.sym = "G";
      after.cls = "STOPV";
    }
    // A doubled letter is one phone; the run merges and holds instead.
    const nx = phones[i + 1];
    if (nx && nx.sym === p.sym && !p.vowel) {
      p.gem = true;
      phones.splice(i + 1, 1);
    }
  }
}

/**
 * Reduction as a *target lerp*, not a schwa substitution. Lowering the
 * authority as well as the target is the important half: a reduced vowel then
 * gets overrun by its neighbours' co-articulation, which is what makes casual
 * speech look casual. A binary substitution creates visible steps; this does not.
 */
export function markReduction(phones: Phone[], syls: Syl[], emph: number, lastSyl: boolean) {
  for (let i = 0; i < syls.length; i++) {
    const s = syls[i]!;
    if (s.stress !== 0) continue;
    if (lastSyl && i === syls.length - 1) continue;
    const nuc = phones[s.nuc]!;
    if (nuc.cls === "VSHORT") nuc.reduce = 0.55 * (1 - 0.6 * emph);
    else if (nuc.cls === "VSCHWA") nuc.reduce = 0.6 * (1 - 0.6 * emph);
  }
}
