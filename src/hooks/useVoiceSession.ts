import { useCallback, useEffect, useRef, useState } from "react";
import { sfx, unlockAudio } from "@/lib/audio-fx";

export type Msg = { id: string; role: "user" | "assistant"; text: string };
export type Mood = "idle" | "listening" | "thinking" | "speaking";

const uid = () => Math.random().toString(36).slice(2);

function isArabic(text: string) {
  return /[\u0600-\u06FF]/.test(text);
}

function reply(input: string): string {
  const t = input.trim();
  const ar = isArabic(t);
  const low = t.toLowerCase();
  if (/^(hi|hello|hey)\b/.test(low) || /مرحب|سلام|اهلا|أهلا/.test(t))
    return ar ? "أهلاً بيك! أنا سامعك، قول لي إيه اللي في بالك." : "Hey there! I'm listening — tell me what's on your mind.";
  if (/(time|clock)/.test(low) || /الساعة|الوقت/.test(t))
    return (ar ? "الساعة دلوقتي " : "It's currently ") + new Date().toLocaleTimeString();
  if (/(focus|pomodoro)/.test(low) || /تركيز|مذاكرة/.test(t))
    return ar
      ? "يلا نبدأ جلسة تركيز: ٢٥ دقيقة شغل، وبعدها ٥ دقايق راحة. جاهز؟"
      : "Let's start a focus block: 25 minutes of deep work, then a 5 minute break. Ready?";
  if (/(who are you|your name)/.test(low) || /مين انت|اسمك/.test(t))
    return ar ? "أنا نوفا، رفيقك الصغير للتركيز والكلام." : "I'm Nova, your little companion for focus and daily flow.";
  if (/(thank|thanks)/.test(low) || /شكرا|شكراً/.test(t))
    return ar ? "دايماً في خدمتك 💜" : "Anytime, I'm right here 💜";
  return ar
    ? `سمعتك بتقول: «${t}». حكيلي أكتر وأنا معاك.`
    : `I heard you say: “${t}”. Tell me more and I'll follow along.`;
}

export function useVoiceSession() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const wantListenRef = useRef(false);

  useEffect(() => {
    const SR =
      typeof window !== "undefined" &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    setSupported(Boolean(SR));
  }, []);

  const loop = useCallback(() => {
    const a = analyserRef.current;
    if (a) {
      const buf = new Uint8Array(a.frequencyBinCount);
      a.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      setLevel((p) => p + (Math.min(1, rms * 4) - p) * 0.25);
    } else if (speakingRef.current) {
      const t = performance.now() / 120;
      const v = 0.35 + 0.35 * Math.abs(Math.sin(t)) + 0.15 * Math.abs(Math.sin(t * 2.7));
      setLevel((p) => p + (v - p) * 0.3);
    } else {
      setLevel((p) => p * 0.88);
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [loop]);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = isArabic(text) ? "ar-EG" : "en-US";
    u.rate = 1;
    u.pitch = 1.25;
    u.onstart = () => {
      speakingRef.current = true;
      setMood("speaking");
    };
    u.onend = () => {
      speakingRef.current = false;
      setMood(wantListenRef.current ? "listening" : "idle");
    };
    window.speechSynthesis.speak(u);
  }, []);

  const send = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setMessages((m) => [...m, { id: uid(), role: "user", text: clean }]);
      sfx.message();
      setMood("thinking");
      window.setTimeout(() => {
        const answer = reply(clean);
        setMessages((m) => [...m, { id: uid(), role: "assistant", text: answer }]);
        speak(answer);
      }, 550);
    },
    [speak],
  );

  const stopMic = useCallback(() => {
    wantListenRef.current = false;
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setListening(false);
    setInterim("");
    setMood((m) => (m === "speaking" ? m : "idle"));
  }, []);

  const startMic = useCallback(async () => {
    unlockAudio();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ac = new AC();
      audioCtxRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyserRef.current = analyser;
    } catch {
      setError("Microphone access was blocked. You can still chat by typing.");
      sfx.error();
      return;
    }

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language?.startsWith("ar") ? "ar-EG" : "en-US";
      rec.onresult = (e: any) => {
        let live = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) send(r[0].transcript);
          else live += r[0].transcript;
        }
        setInterim(live);
      };
      rec.onerror = () => setInterim("");
      rec.onend = () => {
        if (wantListenRef.current) {
          try {
            rec.start();
          } catch {
            /* noop */
          }
        }
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        /* noop */
      }
    }

    wantListenRef.current = true;
    setListening(true);
    setMood("listening");
    sfx.start();
  }, [send]);

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
    speakingRef.current = false;
    stopMic();
    setMessages([]);
    sfx.stop();
  }, [stopMic]);

  useEffect(() => () => stopMic(), [stopMic]);

  return {
    supported,
    listening,
    mood,
    level,
    interim,
    messages,
    error,
    send,
    speak,
    toggleMic,
    endSession,
  };
}
