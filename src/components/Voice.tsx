import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Mic, Square, Volume2, X } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { useVoice } from "../store/voice";
import { formatBytes } from "../lib/format";
import { micLevel } from "../lib/speech";
import { t } from "../lib/i18n";

/** Holding the mic longer than this means push-to-talk (release = stop). */
const HOLD_MS = 450;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Mic button: click to start/stop, or hold while speaking. The transcript
 *  is handed to `onText`. */
export function DictationButton({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const recording = useVoice((s) => s.recording !== null);
  const transcribing = useVoice((s) => s.transcribing);
  const start = useVoice((s) => s.startRecording);
  const stop = useVoice((s) => s.stopRecording);
  const pressedAt = useRef<number | null>(null);

  const finish = async () => {
    const text = await stop();
    if (text) onText(text);
  };

  return (
    <IconButton
      label={recording ? t.voice.stopDictation : t.voice.dictate}
      aria-pressed={recording}
      className={`size-8 rounded-full ${recording ? "bg-[var(--coral)] text-[var(--on-accent)]" : ""}`}
      disabled={disabled || transcribing}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (useVoice.getState().recording) {
          void finish();
          return;
        }
        pressedAt.current = Date.now();
        void start();
      }}
      onPointerUp={() => {
        // Push-to-talk: a long press stops on release.
        const at = pressedAt.current;
        pressedAt.current = null;
        if (at !== null && Date.now() - at > HOLD_MS && useVoice.getState().recording) void finish();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (useVoice.getState().recording) void finish();
        else void start();
      }}
    >
      {transcribing ? (
        <LoaderCircle size={16} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Mic size={16} strokeWidth={1.75} />
      )}
    </IconButton>
  );
}

/** Status line above the input: recording with level meter, transcribing,
 *  or a voice download in progress. */
export function VoiceBar({ onText }: { onText: (text: string) => void }) {
  const recording = useVoice((s) => s.recording);
  const transcribing = useVoice((s) => s.transcribing);
  const install = useVoice((s) => s.install);
  const stop = useVoice((s) => s.stopRecording);
  const cancel = useVoice((s) => s.cancelRecording);
  const testing = useVoice((s) => s.testing);
  const [now, setNow] = useState(() => Date.now());
  // Level updates replace `recording` ten times a second; the timer and the
  // Esc handler only depend on whether a recording runs.
  const active = recording !== null && !testing;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active, cancel]);

  if (recording && active) {
    const level = micLevel(recording.level);
    return (
      <div className="flex items-center gap-3 px-1 pb-1" role="status" aria-live="polite">
        <span className="status-dot pulse flex-none bg-[var(--danger)]" aria-hidden="true" />
        <span className="text-ui tabular-nums">{t.voice.recording(clock(now - recording.startedAt))}</span>
        <div className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          <div
            className="h-full rounded-full bg-coral transition-[width] duration-100"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <IconButton label={t.voice.cancel} className="size-7" onClick={cancel}>
          <X size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t.voice.stopDictation}
          className="size-7 text-coral"
          onClick={() =>
            void stop().then((text) => {
              if (text) onText(text);
            })
          }
        >
          <Check size={16} strokeWidth={2} />
        </IconButton>
      </div>
    );
  }
  if (transcribing) {
    return (
      <div className="flex items-center gap-2 px-1 pb-1 text-ui text-fg-muted" role="status" aria-live="polite">
        <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" />
        {t.voice.transcribing}
      </div>
    );
  }
  if (install) return <VoiceDownload />;
  return null;
}

/** Progress of a running voice download (used in the composer and settings). */
export function VoiceDownload() {
  const install = useVoice((s) => s.install);
  if (!install) return null;
  const pct = install.total > 0 ? Math.min(1, install.downloaded / install.total) : null;
  const what = t.voice.parts[install.part] ?? "";
  const amount =
    pct === null
      ? ""
      : `${formatBytes(install.downloaded)} / ${formatBytes(install.total)} · ${Math.round(pct * 100)} %`;
  return (
    <div className="flex flex-col gap-1.5 px-1 pb-1" role="status" aria-live="polite">
      <span className="text-caption text-fg-muted tabular-nums">{t.voice.downloading(what, amount)}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={`h-full rounded-full bg-coral transition-[width] ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Speaker button for an answer: reads it aloud, a second click stops. */
export function ReadAloudButton({ id, content }: { id: string; content: string }) {
  const speaking = useVoice((s) => s.speakingId === id);
  const speak = useVoice((s) => s.speak);
  return (
    <IconButton
      label={speaking ? t.voice.stopReading : t.voice.readAloud}
      aria-pressed={speaking}
      className={speaking ? "text-coral" : ""}
      onClick={() => void speak(id, content)}
    >
      {speaking ? (
        <Square size={13} strokeWidth={1.75} fill="currentColor" />
      ) : (
        <Volume2 size={16} strokeWidth={1.75} />
      )}
    </IconButton>
  );
}
