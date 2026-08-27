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
import { Mascot } from "@/components/Mascot";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { sfx, unlockAudio } from "@/lib/audio-fx";

const AuraCanvas = lazy(() =>
  import("@/components/AuraCanvas").then((m) => ({ default: m.AuraCanvas })),
);

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Nova — Live Voice Companion for Focus & Daily Flow" },
      {
        name: "description",
        content:
          "Talk to Nova, an interactive 3D-style voice companion that listens, replies out loud and reacts to your voice in real time.",
      },
      { property: "og:title", content: "Nova — Live Voice Companion" },
      {
        property: "og:description",
        content:
          "An interactive animated companion that listens, speaks and reacts to your voice. Mobile-ready live session.",
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

function LiveSession() {
  const {
    supported,
    listening,
    mood,
    level,
    interim,
    messages,
    error,
    send,
    toggleMic,
    endSession,
  } = useVoiceSession();

  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, showTranscript]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const bubble =
    interim ||
    lastAssistant?.text ||
    (listening ? "I'm all ears…" : "How can I help you today?");

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
            <AudioLines className="size-4 text-primary" />
            <span className="text-xs font-medium text-primary sm:text-sm">
              {statusCopy[mood]}
            </span>
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
              Let&apos;s keep the conversation going. Ask me anything out loud, or type — I
              answer with my own voice.
            </p>

            <div className="glass mt-5 inline-flex max-w-full items-center gap-2 rounded-full px-4 py-2.5">
              <AudioLines className="size-4 shrink-0 text-primary" />
              <span className="truncate text-sm">
                {listening ? interim || "I'm speaking…" : "Tap Unmute to talk"}
              </span>
            </div>

            {!supported && (
              <p className="mt-3 text-xs text-muted-foreground">
                Live speech recognition isn&apos;t available in this browser — typing works
                everywhere.
              </p>
            )}
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          </div>

          {/* character stage */}
          <div className="order-1 relative flex min-h-[46vh] items-center justify-center md:order-2 md:min-h-[60vh]">
            <div className="pointer-events-none absolute inset-0">
              <Suspense fallback={null}>
                <AuraCanvas level={level} />
              </Suspense>
            </div>

            {/* pulse rings */}
            {(listening || mood === "speaking") && (
              <>
                <span className="pointer-events-none absolute size-52 rounded-full border border-primary/30 animate-pulse-ring sm:size-64" />
                <span
                  className="pointer-events-none absolute size-52 rounded-full border border-primary/20 animate-pulse-ring sm:size-64"
                  style={{ animationDelay: "0.9s" }}
                />
              </>
            )}

            <div className="glass absolute left-0 top-2 max-w-[62%] rounded-3xl rounded-bl-md px-4 py-3 text-sm animate-rise sm:left-2 sm:text-base">
              {bubble}
            </div>

            <Mascot level={level} mood={mood} />
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
