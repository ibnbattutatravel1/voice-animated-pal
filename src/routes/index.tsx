import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Mic,
  MicOff,
  MessageSquareText,
  Square,
  Sparkles,
  AudioLines,
  Send,
  Hand,
  X,
} from "lucide-react";

import bgScene from "@/assets/scene-bg.jpg";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { sfx, unlockAudio } from "@/lib/audio-fx";
import type { PalBrain } from "@/lib/pal-brain";
import type { PalSignal } from "@/lib/pal-signal";

const PalStage = lazy(() => import("@/components/PalStage").then((m) => ({ default: m.PalStage })));

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Nova — Live 3D Voice Companion for Focus & Daily Flow" },
      {
        name: "description",
        content:
          "Talk to Nova, an interactive 3D character that lip-syncs to every word, follows you with its eyes, waves back and reacts to your voice in real time.",
      },
      { property: "og:title", content: "Nova — Live 3D Voice Companion" },
      {
        property: "og:description",
        content:
          "An interactive 3D companion that listens, speaks and reacts to your voice. Mobile-ready live session.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LiveSession,
});

const statusCopy: Record<string, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/**
 * Reads the live voice level straight off the signal object and writes to the
 * DOM. Keeping it out of React state means the 3D canvas never re-renders just
 * because the microphone twitched.
 */
function VoiceMeter({ signal }: { signal: PalSignal }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = performance.now() / 1000;
      for (let i = 0; i < bars.current.length; i++) {
        const el = bars.current[i];
        if (!el) continue;
        const wobble = 0.45 + 0.55 * Math.abs(Math.sin(t * 6 + i * 1.1));
        const h = 0.2 + signal.level * wobble * 1.6;
        el.style.transform = `scaleY(${Math.max(0.16, Math.min(1, h))})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [signal]);

  return (
    <span className="flex h-4 items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-4 w-[3px] origin-center rounded-full bg-primary/80 transition-none"
        />
      ))}
    </span>
  );
}

function LiveSession() {
  const {
    supported,
    listening,
    mood,
    interim,
    messages,
    error,
    signal,
    send,
    toggleMic,
    endSession,
  } = useVoiceSession();

  const brainRef = useRef<PalBrain | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, showTranscript]);

  // Dev handle so the rig can be driven straight from the console:
  //   __pal.signal.mouth.jaw = 1        __pal.brain.wave()
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    Object.defineProperty(window, "__pal", {
      configurable: true,
      value: { signal, brain: brainRef },
    });
  }, [signal]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const bubble =
    interim || lastAssistant?.text || (listening ? "I'm all ears…" : "How can I help you today?");

  return (
    <main
      className="relative min-h-[100dvh] overflow-hidden pb-[env(safe-area-inset-bottom)]"
      onPointerDown={unlockAudio}
    >
      {/* ambient scene */}
      <img
        src={bgScene}
        alt=""
        aria-hidden
        width={1536}
        height={1024}
        className="pointer-events-none absolute right-0 top-0 h-full w-full object-cover opacity-30 sm:opacity-45 [mask-image:linear-gradient(to_left,black_10%,transparent_80%)] md:w-[62%]"
      />

      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-6xl flex-col px-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:px-6">
        {/* top bar */}
        <header className="glass flex items-center justify-between gap-3 rounded-[calc(var(--radius)+0.5rem)] px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-full text-primary-foreground"
              style={{ backgroundImage: "var(--gradient-primary)" }}
            >
              <Sparkles className="size-5" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold sm:text-base">Live session</p>
              <p className="text-xs text-muted-foreground">Focus &amp; Daily Flow</p>
            </div>
          </div>
          <div className="glass flex items-center gap-2 rounded-full px-3 py-2">
            <span
              className={`size-2 rounded-full ${mood === "idle" ? "bg-muted-foreground/50" : "bg-success animate-pulse"}`}
            />
            <VoiceMeter signal={signal} />
            <span className="text-xs font-medium text-primary sm:text-sm">{statusCopy[mood]}</span>
          </div>
        </header>

        {/* body */}
        <section className="grid flex-1 items-center gap-6 py-6 md:grid-cols-2 md:gap-4">
          <div className="order-2 animate-rise md:order-1">
            <span className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold tracking-wide text-primary">
              <span className="size-2 rounded-full bg-primary" />
              LIVE NOW
            </span>
            <h1 className="mt-4 text-[clamp(2.2rem,8vw,4rem)] font-extrabold leading-[1.05] tracking-tight">
              Hi there,
              <br />
              <span className="text-primary">I&apos;m listening!</span>{" "}
              <Hand className="inline size-[0.8em] -translate-y-1 animate-float text-primary" />
            </h1>
            <p className="mt-4 max-w-md text-sm text-muted-foreground sm:text-base">
              Talk to me out loud or type — I answer with my own voice, and my mouth, eyes and hands
              move along with every word.
            </p>

            <div className="glass mt-5 inline-flex max-w-full items-center gap-2 rounded-full px-4 py-2.5">
              <AudioLines className="size-4 shrink-0 text-primary" />
              <span className="truncate text-sm">
                {listening ? interim || "I'm all ears…" : "Tap Unmute to talk"}
              </span>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Tip: tap me, or move your cursor — I&apos;ll follow you.
            </p>

            {!supported && (
              <p className="mt-3 text-xs text-muted-foreground">
                Live speech recognition isn&apos;t available in this browser — typing works
                everywhere.
              </p>
            )}
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          </div>

          {/* character stage */}
          <div className="order-1 relative flex min-h-[52vh] items-center justify-center md:order-2 md:min-h-[68vh]">
            <Suspense fallback={null}>
              <PalStage
                signal={signal}
                brainRef={brainRef}
                className="absolute inset-0 cursor-pointer touch-none select-none"
              />
            </Suspense>

            {/* pulse rings */}
            {(listening || mood === "speaking") && (
              <>
                <span className="pointer-events-none absolute bottom-[8%] size-52 rounded-full border border-primary/25 animate-pulse-ring sm:size-64" />
                <span
                  className="pointer-events-none absolute bottom-[8%] size-52 rounded-full border border-primary/15 animate-pulse-ring sm:size-64"
                  style={{ animationDelay: "0.9s" }}
                />
              </>
            )}

            <div className="glass pointer-events-none absolute left-0 top-2 max-w-[62%] rounded-3xl rounded-bl-md px-4 py-3 text-sm animate-rise sm:left-2 sm:text-base">
              {bubble}
            </div>
          </div>
        </section>

        {/* controls */}
        <nav className="sticky bottom-0 z-20 -mx-4 mt-auto bg-gradient-to-t from-background/80 to-transparent px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 sm:mx-0 sm:px-0">
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] sm:justify-start">
            <ControlButton
              primary
              icon={<Keyboard className="size-5" />}
              label="Type"
              hint="Send a message"
              onClick={() => {
                sfx.tap();
                setTyping((v) => !v);
              }}
            />
            <ControlButton
              icon={listening ? <Mic className="size-5" /> : <MicOff className="size-5" />}
              label={listening ? "Mute" : "Unmute"}
              hint={listening ? "Stop listening" : "Enable your mic"}
              active={listening}
              onClick={toggleMic}
            />
            <ControlButton
              icon={<Hand className="size-5" />}
              label="Wave"
              hint="Say hi back"
              onClick={() => {
                sfx.tap();
                brainRef.current?.wave();
              }}
            />
            <ControlButton
              icon={<MessageSquareText className="size-5" />}
              label="Transcript"
              hint="View conversation"
              onClick={() => {
                sfx.tap();
                setShowTranscript(true);
              }}
            />
            <ControlButton
              danger
              icon={<Square className="size-4 fill-current" />}
              label="End"
              hint="Close session"
              onClick={endSession}
            />
          </div>

          {typing && (
            <form
              className="glass mt-2 flex items-center gap-2 rounded-full p-1.5 animate-rise"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
                setDraft("");
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message…"
                className="min-w-0 flex-1 bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                aria-label="Send message"
                className="flex size-10 shrink-0 items-center justify-center rounded-full text-primary-foreground"
                style={{ backgroundImage: "var(--gradient-primary)" }}
              >
                <Send className="size-4" />
              </button>
            </form>
          )}
        </nav>
      </div>

      {/* transcript sheet */}
      {showTranscript && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/25 backdrop-blur-sm"
          onClick={() => setShowTranscript(false)}
        >
          <div
            className="glass max-h-[75dvh] w-full max-w-lg animate-rise overflow-hidden rounded-t-[2rem] p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:mb-6 sm:rounded-[2rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Transcript</h2>
              <button
                aria-label="Close transcript"
                onClick={() => setShowTranscript(false)}
                className="flex size-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div ref={scrollRef} className="max-h-[55dvh] space-y-2 overflow-y-auto pr-1">
              {messages.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nothing yet — say hello to start.
                </p>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    m.role === "user"
                      ? "ml-auto bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground"
                  }`}
                >
                  {m.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ControlButton({
  icon,
  label,
  hint,
  onClick,
  primary,
  danger,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`glass flex shrink-0 items-center gap-3 rounded-full py-2.5 pl-3 pr-5 text-left transition-transform active:scale-95 ${
        primary ? "text-primary-foreground" : ""
      }`}
      style={primary ? { backgroundImage: "var(--gradient-primary)", border: "none" } : undefined}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
          primary
            ? "bg-white/20"
            : danger
              ? "bg-destructive text-destructive-foreground"
              : active
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
        }`}
      >
        {icon}
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold">{label}</span>
        <span
          className={`block text-[11px] ${primary ? "text-primary-foreground/75" : "text-muted-foreground"}`}
        >
          {hint}
        </span>
      </span>
    </button>
  );
}
