import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sfx, unlockAudio } from "@/lib/audio-fx";
import { isArabicText, type Lang, type SpeechFrame } from "@/lib/lipsync/types";
import { createSignal, type Mood, type PalSignal } from "@/lib/pal-signal";
import type { DeliveryHint } from "@/lib/speech/prosody";
import { Speaker } from "@/lib/speech/speaker";
import { MIC_DUCK_RELEASE_MS, softsat } from "@/lib/speech/units";
import { LipSync } from "@/lib/viseme";

export type Msg = { id: string; role: "user" | "assistant"; text: string };
export type { Mood };

const uid = () => Math.random().toString(36).slice(2);

/**
 * The half of the lip-sync engine this session drives.
 *
 * The engine itself lives in `src/lib/lipsync/`. Naming the surface here means a
 * change to it shows up as a type error at the `new` below rather than as a
 * mouth that silently stops moving.
 */
type LipEngine = {
  prepare(text: string, opts?: { rate?: number; lang?: Lang; voiceKey?: string }): unknown;
  readonly ttsText: string;
  armIfIdle(now?: number): void;
  hold(on: boolean, now?: number): void;
  boundary(
    charIndex: number,
    now?: number,
    charLength?: number,
    name?: string,
    elapsed?: number,
  ): void;
  end(now?: number, actualSec?: number): void;
  stop(): void;
  sample(now?: number): SpeechFrame;
  /** What the resting face should be doing between replies. */
  idleMood: "idle" | "listening" | "thinking";
  micLevel: number;
  reduced: boolean;
};

type Reply = { text: string; hint?: DeliveryHint; wave?: boolean };

/**
 * The canned brain. Every answer carries a delivery hint: an author-side
 * emotion beats the classifier every time and costs one property. The Arabic
 * answers also carry a hand-written Latin twin — on a machine with no Arabic
 * voice installed those short Cairene phrases come out startlingly intelligible
 * through an English voice, precisely *because* a human wrote the phonetics.
 */
function reply(input: string): Reply {
  const t = input.trim();
  const ar = isArabicText(t);
  const low = t.toLowerCase();

  if (/^(hi|hello|hey)\b/.test(low) || /مرحب|سلام|اهلا|أهلا/.test(t))
    return {
      text: ar
        ? "أهلاً بيك! أنا سامعك، قول لي إيه اللي في بالك."
        : "Hey there! I'm listening — tell me what's on your mind.",
      hint: {
        emotion: "cheerful",
        latin: "Ahlan beek! Ana samaak, ool li eh elli fi balak.",
      },
      wave: true,
    };

  if (/(time|clock)/.test(low) || /الساعة|الوقت/.test(t)) {
    // Seconds are eleven spoken characters of nothing, and they used to leave
    // the mouth finishing three seconds before the voice did.
    const clock = new Date().toLocaleTimeString(ar ? "ar-EG" : "en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return {
      text: (ar ? "الساعة دلوقتي " : "It's currently ") + clock,
      hint: { emotion: "warm", latin: `El saa-a dilwati ${clock}` },
    };
  }

  if (/(focus|pomodoro)/.test(low) || /تركيز|مذاكرة/.test(t))
    return {
      text: ar
        ? "يلا نبدأ جلسة تركيز: ٢٥ دقيقة شغل، وبعدها ٥ دقايق راحة. جاهز؟"
        : "Let's start a *focus block*: 25 minutes of deep work, then a 5 minute break. Ready?",
      hint: {
        emotion: "excited",
        latin: "Yalla nebda gelset tarkeez: 25 deqeeqa shoghl, we baadaha 5 daqayeq raha. Gahez?",
      },
    };

  if (/(who are you|your name)/.test(low) || /مين انت|اسمك/.test(t))
    return {
      text: ar
        ? "أنا نوفا، رفيقك الصغير للتركيز والكلام."
        : "I'm Nova, your little companion for focus and daily flow.",
      hint: {
        emotion: "playful",
        latin: "Ana Nova, rafeeak el soghayar lel tarkeez wel kalam.",
      },
      wave: true,
    };

  if (/(thank|thanks)/.test(low) || /شكرا|شكراً/.test(t))
    return {
      text: ar ? "دايماً في خدمتك 💜" : "Anytime, I'm right here 💜",
      hint: { emotion: "gentle", latin: "Dayman fi khedmetak." },
      wave: true,
    };

  return {
    text: ar ? `سمعتك بتقول: "${t}". حكيلي أكتر وأنا معاك.` : `I heard you say: "${t}". Tell me more and I'll follow along.`, // prettier-ignore
    hint: { emotion: "curious" },
  };
}

export function useVoiceSession() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [mood, setMoodState] = useState<Mood>("idle");
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** One quiet line for things the user can act on, like a missing voice pack. */
  const [notice, setNotice] = useState<string | null>(null);

  /** Everything the renderer reads at 60 fps lives here, outside React. */
  const signal = useMemo<PalSignal>(() => createSignal(), []);
  const lip = useMemo<LipEngine>(() => new LipSync(), []);
  const speaker = useMemo(() => new Speaker(), []);

  const recRef = useRef<SpeechRecognition | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const wantListenRef = useRef(false);
  /** Bumped by every stop. A device that opens into a stale epoch belongs to a
   *  session nobody wants any more, and has to be handed straight back. */
  const micEpoch = useRef(0);
  /** The epoch of a start still inside its `await`, or 0. */
  const micStarting = useRef(0);
  /** The last recogniser error code, read once by its `onend`. */
  const recError = useRef("");
  /** Consecutive failed recogniser starts — the backoff exponent. */
  const recFails = useRef(0);
  const recRestart = useRef(0);
  /** The layer that cannot race: ignore anything the mic hears until this. */
  const echoUntil = useRef(0);
  /** Prosodic jaw gain for the segment currently sounding. */
  const jawGain = useRef(1);
  const thinkTimer = useRef(0);
  const lastHmm = useRef(-Infinity);
  /** An answer is compiled but not yet spoken — the mood belongs to thinking. */
  const pendingReply = useRef(false);

  const setMood = useCallback(
    (m: Mood) => {
      signal.mood = m;
      setMoodState(m);
    },
    [signal],
  );

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSupported(Boolean(SR));
    signal.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    speaker.setReduced(signal.reduced);
    lip.reduced = signal.reduced;
    void speaker.ready();
  }, [signal, speaker, lip]);

  // ------------------------------------------------------------ speaker wiring
  useEffect(() => {
    // React tears this effect down and re-runs it once on mount, so the guards
    // the cleanup below removes have to be put back every time the body runs.
    speaker.arm();

    const startRecogniser = () => {
      if (!wantListenRef.current || signal.speaking) return;
      try {
        recRef.current?.start();
      } catch {
        /* restart races are normal here */
      }
    };

    // One reply is ONE lip-sync timeline and N utterances. `prepare` runs at
    // plan time, not at `onstart`: every engine has 100-400 ms of start latency,
    // and that latency is exactly where the anticipatory breath belongs.
    speaker.hooks.onPrepare = (text, lang, rate, voiceKey) => {
      lip.prepare(text, { rate, lang, voiceKey });
      return lip.ttsText;
    };
    speaker.hooks.onStart = () => {
      signal.speaking = true;
      setMood("speaking");
      // Duck the microphone before the first sound, not after it: otherwise the
      // recogniser transcribes Nova, calls send(), and she answers herself.
      echoUntil.current = Number.POSITIVE_INFINITY;
      try {
        recRef.current?.abort();
      } catch {
        /* not running */
      }
    };
    speaker.hooks.onSegmentStart = (seg, _i, _cps, startAt) => {
      jawGain.current = seg.jawGain;
      // A spanless segment is an interjection the planner added after the
      // timeline was compiled. It has no place on that timeline, so the mouth
      // stays in its pre-roll inhale through it — which is what "Ooh!" looks
      // like anyway — and the clock binds to the first word that is really there.
      if (seg.srcStart < 0) return;
      // `startAt` is in the FUTURE: the mouth leaves the hold and takes its
      // breath before the audio arrives, which is the whole anticipation trick.
      lip.hold(false, startAt);
      lip.armIfIdle(startAt);
    };
    speaker.hooks.onWord = (charIndex, charLength, name) => {
      lip.boundary(charIndex, performance.now(), charLength, name, undefined);
    };
    speaker.hooks.onSegmentEnd = (seg, _i, pauseMs) => {
      // A real gap, not a slam shut: the engine freezes its clock and glides to
      // a continuant rest for a comma, a full closure for a sentence break.
      if (pauseMs > 0 && seg.srcStart >= 0) lip.hold(true, performance.now());
    };
    speaker.hooks.onEnd = (reason, actualSec) => {
      signal.speaking = false;
      jawGain.current = 1;
      if (reason === "cancelled") lip.stop();
      // A duration of zero means no audio ever started; do not teach the prior
      // that this voice reads a whole reply instantly.
      else if (actualSec > 0) lip.end(performance.now(), actualSec);
      else lip.end(performance.now());
      echoUntil.current = performance.now() + MIC_DUCK_RELEASE_MS;
      // The "Hmm…" ending is not the end of the turn; the answer is still coming.
      setMood(pendingReply.current ? "thinking" : wantListenRef.current ? "listening" : "idle");
      // Give the speakers time to fall silent before the mic opens again.
      window.setTimeout(startRecogniser, MIC_DUCK_RELEASE_MS);
    };
    return () => {
      speaker.dispose();
    };
  }, [speaker, lip, signal, setMood]);

  // ---------------------------------------------------------------- the pump
  // One loop feeds the character. `lip.sample()` integrates state, so it is
  // called exactly once per frame — and it returns a live idle frame when
  // nothing is speaking, which is why there is no decay branch for the mouth.
  useEffect(() => {
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(1 / 20, Math.max(0, (now - last) / 1000));
      last = now;

      // Between replies the mouth is still a face: it parts, swallows, and
      // twitches on what the microphone is picking up.
      lip.micLevel = signal.level;
      lip.idleMood =
        signal.mood === "thinking"
          ? "thinking"
          : signal.mood === "listening"
            ? "listening"
            : "idle";

      const f = lip.sample(now);
      const s = f.mouth;
      // Loud, high segments open wider. It is applied to the frame itself, not
      // to the mirror below: the rig reads `signal.speech.mouth`, so gaining
      // only the mirror would compute the prosodic jaw and then throw it away.
      // `softsat` guarantees the shader's `uMouth.x` still lands inside the
      // range its aperture was calibrated for.
      const g = jawGain.current;
      s.jaw = softsat(s.jaw * g, 0.85);
      s.wide = softsat(s.wide * (0.5 + 0.5 * g), 0.85);
      const m = signal.mouth;
      m.jaw = s.jaw;
      m.wide = s.wide;
      m.round = s.round;
      m.press = s.press;
      m.protrude = s.protrude;
      m.tuck = s.tuck;
      m.tongue = s.tongue;
      m.corner = s.corner;
      signal.speech = f;
      signal.accent = f.accent;

      // `f.active` spans the pre-roll and the outro too, so the aura follows the
      // whole performance rather than snapping off with the last utterance.
      const a = analyserRef.current;
      if (a && !f.active) {
        let buf = bufRef.current;
        if (!buf || buf.length !== a.frequencyBinCount) {
          buf = new Uint8Array(a.frequencyBinCount);
          bufRef.current = buf;
        }
        a.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = ((buf[i] ?? 128) - 128) / 128;
          sum += v * v;
        }
        const rms = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        signal.level += (rms - signal.level) * (1 - Math.exp(-16 * dt));
        signal.peak = Math.max(signal.peak * Math.exp(-6 * dt), rms);
      } else if (f.active) {
        // While Nova talks, the analyser is Nova hearing herself through the
        // speakers. The performance already knows how loud she is.
        signal.level += (f.energy - signal.level) * (1 - Math.exp(-14 * dt));
        signal.peak = Math.max(signal.peak * Math.exp(-3.1 * dt), f.energy);
      } else {
        signal.level *= Math.exp(-2.2 * dt);
        signal.peak *= Math.exp(-3.1 * dt);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [signal, lip]);

  const speak = useCallback(
    (text: string, hint?: DeliveryHint) => {
      speaker.say(text, hint);
      setNotice(speaker.dialectCompromise ? DIALECT_NOTE : null);
    },
    [speaker],
  );

  const send = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setMessages((m) => [...m, { id: uid(), role: "user", text: clean }]);
      sfx.message();
      setMood("thinking");
      // "Hmm…" is not decoration: it covers the 300-800 ms a network voice takes
      // to produce its first segment, so the pause reads as thought.
      const now = performance.now();
      if (now - lastHmm.current > 8000) {
        lastHmm.current = now;
        speaker.interject("hmm");
      }
      window.clearTimeout(thinkTimer.current);
      pendingReply.current = true;
      thinkTimer.current = window.setTimeout(() => {
        pendingReply.current = false;
        const answer = reply(clean);
        setMessages((m) => [...m, { id: uid(), role: "assistant", text: answer.text }]);
        if (answer.wave) signal.waveRequest = 1;
        speak(answer.text, answer.hint);
      }, 730);
    },
    [setMood, signal, speak, speaker],
  );

  const stopMic = useCallback(() => {
    wantListenRef.current = false;
    // Invalidates any start still waiting on the device, and any restart the
    // recogniser's keep-alive has on a timer.
    micEpoch.current++;
    micStarting.current = 0;
    window.clearTimeout(recRestart.current);
    recFails.current = 0;
    recError.current = "";
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    bufRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setListening(false);
    signal.listening = false;
    setInterim("");
    setMood(signal.speaking ? "speaking" : "idle");
  }, [setMood, signal]);

  const startMic = useCallback(async () => {
    // The button reads `listening`, which is not true until the await below has
    // resolved, so without this a second tap opens a second device.
    if (micStarting.current) return;
    unlockAudio();
    setError(null);
    const my = ++micEpoch.current;
    micStarting.current = my;
    let stream: MediaStream | null = null;
    let ac: AudioContext | null = null;
    const release = () => {
      stream?.getTracks().forEach((t) => t.stop());
      void ac?.close().catch(() => undefined);
      if (micStarting.current === my) micStarting.current = 0;
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Belt and braces with the echo gate below: the browser's own canceller
        // removes most of Nova's voice before it ever reaches the recogniser.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // The device can open after the user has already pressed End, or after the
      // view is gone. Everything past here installs a live session, so a stale
      // epoch gives the microphone back instead — nothing else ever would.
      if (micEpoch.current !== my) return release();
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) throw new Error("no audio context");
      ac = new AC();
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      src.connect(analyser);
      // Published only once the whole chain stands up: a half-built session is
      // invisible to `stopMic`, which is what leaks the recording indicator.
      streamRef.current = stream;
      audioCtxRef.current = ac;
      analyserRef.current = analyser;
    } catch {
      release();
      setError("Microphone access was blocked. You can still chat by typing.");
      sfx.error();
      return;
    }

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (SR) {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language?.startsWith("ar") ? "ar-EG" : "en-US";
      rec.onresult = (e) => {
        // The echo gate. Without it the recogniser transcribes Nova, send()
        // answers, and the two of them talk to each other until the tab closes.
        if (signal.speaking || performance.now() < echoUntil.current) return;
        // Anything the recogniser hears is proof the chain works.
        recFails.current = 0;
        let live = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const alt = r?.[0];
          if (!r || !alt) continue;
          if (r.isFinal) send(alt.transcript);
          else live += alt.transcript;
        }
        setInterim(live);
      };
      rec.onerror = (e) => {
        setInterim("");
        recError.current = e.error;
      };
      rec.onend = () => {
        const why = recError.current;
        recError.current = "";
        if (!wantListenRef.current || signal.speaking) return;
        // Chrome fires `error` then `end` within a few milliseconds, so a
        // keep-alive that does not read the reason is an unbounded hot loop.
        if (why === "not-allowed" || why === "service-not-allowed") {
          stopMic();
          setError("Microphone permission was withdrawn. You can still chat by typing.");
          sfx.error();
          return;
        }
        // `no-speech` is the silence timeout this keep-alive exists for, and
        // `aborted` is our own duck: both mean the recogniser was working.
        const worked = why === "" || why === "no-speech" || why === "aborted";
        if (worked) recFails.current = 0;
        // `network` and `audio-capture` can be transient — an unplugged headset
        // comes back — so retry, but slower every time until one result lands.
        const wait = worked ? 0 : Math.min(8000, 300 * 2 ** recFails.current++);
        window.clearTimeout(recRestart.current);
        recRestart.current = window.setTimeout(() => {
          if (recRef.current !== rec || !wantListenRef.current || signal.speaking) return;
          try {
            rec.start();
          } catch {
            /* restart races are normal here */
          }
        }, wait);
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        /* already running */
      }
    }

    micStarting.current = 0;
    wantListenRef.current = true;
    setListening(true);
    signal.listening = true;
    if (!signal.speaking) setMood("listening");
    signal.waveRequest = 1;
    sfx.start();
  }, [send, setMood, signal, stopMic]);

  const toggleMic = useCallback(() => {
    // `listening` is still false while the device is opening; a tap there means
    // "cancel", not "start again".
    if (listening || micStarting.current) {
      sfx.stop();
      stopMic();
    } else {
      void startMic();
    }
  }, [listening, startMic, stopMic]);

  const endSession = useCallback(() => {
    window.clearTimeout(thinkTimer.current);
    pendingReply.current = false;
    speaker.stop();
    signal.speaking = false;
    lip.stop();
    stopMic();
    setMessages([]);
    setNotice(null);
    sfx.stop();
  }, [lip, signal, speaker, stopMic]);

  // The 730 ms think timer outlives the view otherwise, and its reply would
  // reach `speechSynthesis` with nothing left on the page able to cancel it.
  useEffect(
    () => () => {
      window.clearTimeout(thinkTimer.current);
      pendingReply.current = false;
      stopMic();
    },
    [stopMic],
  );

  // Dev handle: __nova.audit() ranks every installed voice, __nova.plan(text)
  // prints the score you are about to hear.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    Object.defineProperty(window, "__nova", {
      configurable: true,
      value: {
        speaker,
        audit: (lang?: "en-US" | "ar-EG") => speaker.audit(lang ?? "en-US"),
        plan: (t: string, hint?: DeliveryHint) => speaker.plan(t, hint).segments,
        say: (t: string, hint?: DeliveryHint) => speaker.say(t, hint),
        tele: () => speaker.diagnostics(),
      },
    });
  }, [speaker]);

  return {
    supported,
    listening,
    mood,
    interim,
    messages,
    error,
    notice,
    signal,
    send,
    speak,
    toggleMic,
    endSession,
  };
}

const DIALECT_NOTE = "Egyptian voice not installed — using Modern Standard Arabic.";
