import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sfx, unlockAudio } from "@/lib/audio-fx";
import { createSignal, type Mood, type PalSignal } from "@/lib/pal-signal";
import { isArabicText, LipSync } from "@/lib/viseme";

export type Msg = { id: string; role: "user" | "assistant"; text: string };
export type { Mood };

const uid = () => Math.random().toString(36).slice(2);

function reply(input: string): { text: string; wave?: boolean } {
  const t = input.trim();
  const ar = isArabicText(t);
  const low = t.toLowerCase();
  if (/^(hi|hello|hey)\b/.test(low) || /مرحب|سلام|اهلا|أهلا/.test(t))
    return {
      text: ar
        ? "أهلاً بيك! أنا سامعك، قول لي إيه اللي في بالك."
        : "Hey there! I'm listening — tell me what's on your mind.",
      wave: true,
    };
  if (/(time|clock)/.test(low) || /الساعة|الوقت/.test(t))
    return { text: (ar ? "الساعة دلوقتي " : "It's currently ") + new Date().toLocaleTimeString() };
  if (/(focus|pomodoro)/.test(low) || /تركيز|مذاكرة/.test(t))
    return {
      text: ar
        ? "يلا نبدأ جلسة تركيز: ٢٥ دقيقة شغل، وبعدها ٥ دقايق راحة. جاهز؟"
        : "Let's start a focus block: 25 minutes of deep work, then a 5 minute break. Ready?",
    };
  if (/(who are you|your name)/.test(low) || /مين انت|اسمك/.test(t))
    return {
      text: ar
        ? "أنا نوفا، رفيقك الصغير للتركيز والكلام."
        : "I'm Nova, your little companion for focus and daily flow.",
      wave: true,
    };
  if (/(thank|thanks)/.test(low) || /شكرا|شكراً/.test(t))
    return { text: ar ? "دايماً في خدمتك 💜" : "Anytime, I'm right here 💜", wave: true };
  return {
    text: ar
      ? `سمعتك بتقول: «${t}». حكيلي أكتر وأنا معاك.`
      : `I heard you say: “${t}”. Tell me more and I'll follow along.`,
  };
}

/** Prefer a natural-sounding voice in the right language. */
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  if (!voices.length) return null;
  const base = lang.slice(0, 2);
  const matching = voices.filter((v) => v.lang?.toLowerCase().startsWith(base));
  if (!matching.length) return null;
  const nice =
    matching.find((v) => /natural|neural|google|premium|enhanced/i.test(v.name)) ??
    matching.find((v) => /female|samantha|zira|hoda|salma/i.test(v.name));
  return nice ?? matching[0] ?? null;
}

export function useVoiceSession() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [mood, setMoodState] = useState<Mood>("idle");
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Everything the renderer reads at 60 fps lives here, outside React. */
  const signal = useMemo<PalSignal>(() => createSignal(), []);
  const lip = useMemo(() => new LipSync(), []);

  const recRef = useRef<SpeechRecognition | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const wantListenRef = useRef(false);

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
    // Voice lists load asynchronously in most browsers.
    window.speechSynthesis?.getVoices?.();
  }, [signal]);

  // ---------------------------------------------------------------- the pump
  // One loop feeds the character: microphone amplitude while listening, and the
  // lip-sync timeline while speaking.
  useEffect(() => {
    const loop = () => {
      const a = analyserRef.current;
      if (a) {
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
        signal.level += (rms - signal.level) * 0.25;
        signal.peak = Math.max(signal.peak * 0.9, rms);
      } else if (signal.speaking) {
        // No analysable audio from speechSynthesis — the jaw already carries the
        // performance, so mirror it into `level` for the aura and glow.
        const target = 0.25 + signal.mouth.jaw * 0.6;
        signal.level += (target - signal.level) * 0.2;
        signal.peak = Math.max(signal.peak * 0.9, target);
      } else {
        signal.level *= 0.9;
        signal.peak *= 0.88;
      }

      if (lip.isActive) {
        const m = lip.sample();
        signal.mouth.jaw = m.jaw;
        signal.mouth.wide = m.wide;
        signal.mouth.round = m.round;
        signal.mouth.press = m.press;
        signal.accent = lip.accent();
      } else {
        signal.mouth.jaw *= 0.8;
        signal.mouth.wide *= 0.8;
        signal.mouth.round *= 0.8;
        signal.mouth.press *= 0.8;
        signal.accent *= 0.8;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [signal, lip]);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const lang = isArabicText(text) ? "ar-EG" : "en-US";
      u.lang = lang;
      const voice = pickVoice(lang);
      if (voice) u.voice = voice;
      u.rate = 1;
      u.pitch = 1.22;

      u.onstart = () => {
        signal.speaking = true;
        lip.start(text, u.rate);
        setMood("speaking");
      };
      u.onboundary = (e) => lip.boundary(e.charIndex);
      const finish = () => {
        signal.speaking = false;
        lip.stop();
        setMood(wantListenRef.current ? "listening" : "idle");
      };
      u.onend = finish;
      u.onerror = finish;

      window.speechSynthesis.speak(u);
      // Some engines never fire `start` if the tab was backgrounded; make sure
      // the mouth still runs.
      window.setTimeout(() => {
        if (!signal.speaking && window.speechSynthesis.speaking) {
          signal.speaking = true;
          lip.start(text, u.rate);
          setMood("speaking");
        }
      }, 260);
    },
    [lip, setMood, signal],
  );

  const send = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setMessages((m) => [...m, { id: uid(), role: "user", text: clean }]);
      sfx.message();
      setMood("thinking");
      window.setTimeout(() => {
        const answer = reply(clean);
        setMessages((m) => [...m, { id: uid(), role: "assistant", text: answer.text }]);
        if (answer.wave) signal.waveRequest = 1;
        speak(answer.text);
      }, 550);
    },
    [setMood, signal, speak],
  );

  const stopMic = useCallback(() => {
    wantListenRef.current = false;
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
    unlockAudio();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) throw new Error("no audio context");
      const ac = new AC();
      audioCtxRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      src.connect(analyser);
      analyserRef.current = analyser;
    } catch {
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
      rec.onerror = () => setInterim("");
      rec.onend = () => {
        if (wantListenRef.current) {
          try {
            rec.start();
          } catch {
            /* restart races are normal here */
          }
        }
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        /* already running */
      }
    }

    wantListenRef.current = true;
    setListening(true);
    signal.listening = true;
    if (!signal.speaking) setMood("listening");
    signal.waveRequest = 1;
    sfx.start();
  }, [send, setMood, signal]);

  const toggleMic = useCallback(() => {
    if (listening) {
      sfx.stop();
      stopMic();
    } else {
      void startMic();
    }
  }, [listening, startMic, stopMic]);

  const endSession = useCallback(() => {
    window.speechSynthesis?.cancel();
    signal.speaking = false;
    lip.stop();
    stopMic();
    setMessages([]);
    sfx.stop();
  }, [lip, signal, stopMic]);

  useEffect(() => () => stopMic(), [stopMic]);

  return {
    supported,
    listening,
    mood,
    interim,
    messages,
    error,
    signal,
    send,
    speak,
    toggleMic,
    endSession,
  };
}
