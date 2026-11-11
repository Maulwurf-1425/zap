import { useEffect } from "react";
import { Check, Download, Lock, Mic, Square, Trash2, Volume2 } from "lucide-react";
import { Section, Slider, Switch } from "./ui/Controls";
import { Select } from "./ui/Select";
import { IconButton } from "./ui/IconButton";
import { VoiceDownload } from "./Voice";
import { useSettings } from "../store/settings";
import { installSize, useVoice } from "../store/voice";
import { formatBytes } from "../lib/format";
import { micLevel, SPEECH_PEAK } from "../lib/speech";
import type { Settings, VoiceInfo } from "../lib/ipc";
import { t } from "../lib/i18n";

/** Settings → Voice: dictation model, language and microphone; voices with
 *  preview, download and choice per language; speed and auto-read. */
export function VoiceTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const status = useVoice((s) => s.status);
  const install = useVoice((s) => s.install);
  const refresh = useVoice((s) => s.refresh);
  const v = t.voice.settings;

  // Microphones and downloads may have changed since the app started.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Older versions stored the microphone's name instead of its id.
  const mics = status?.microphones ?? [];
  const stored = settings.mic_device ?? "";
  const selectedMic = mics.some((m) => m.id === stored) ? stored : (mics.find((m) => m.name === stored)?.id ?? "");

  const models = [
    { id: "base" as const, label: v.fast, hint: v.fastHint },
    { id: "small" as const, label: v.accurate, hint: v.accurateHint },
  ];

  return (
    <div className="flex flex-col gap-8">
      <p className="flex items-center gap-2 text-ui font-normal text-fg-muted">
        <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
        {v.privacy}
      </p>

      <Section title={v.dictation}>
        <p className="text-ui font-normal text-fg-muted">{v.dictationHint}</p>
        <div role="radiogroup" aria-label={v.model} className="flex flex-col gap-2">
          {models.map((m) => {
            const info = status?.models.find((x) => x.id === m.id);
            const item = `dictation:${m.id}`;
            const checked = settings.voice_model === m.id;
            return (
              <div
                key={m.id}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  checked ? "border-[var(--coral-ring)] bg-surface-2" : "border-border bg-surface-1"
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => void update({ voice_model: m.id })}
                >
                  <span
                    className={`flex size-4 flex-none items-center justify-center rounded-full border ${
                      checked ? "border-coral" : "border-border-strong"
                    }`}
                    aria-hidden="true"
                  >
                    {checked && <span className="size-2 rounded-full bg-coral" />}
                  </span>
                  <span className="min-w-0">
                    <span className="text-ui">{m.label}</span>
                    <span className="block text-caption text-fg-muted">
                      {m.hint} · {formatBytes(info?.size ?? 0)}
                    </span>
                  </span>
                </button>
                <InstallControls
                  installed={Boolean(info?.installed && status?.whisper)}
                  busy={install !== null}
                  size={installSize(status, item)}
                  item={item}
                />
              </div>
            );
          })}
        </div>
        {install?.item.startsWith("dictation:") && <VoiceDownload />}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2">
            <span className="text-ui">{v.language}</span>
            <Select
              label={v.language}
              value={settings.voice_language}
              onChange={(value) => void update({ voice_language: value as Settings["voice_language"] })}
              options={[
                { value: "auto", label: v.auto },
                { value: "de", label: v.german },
                { value: "en", label: v.english },
              ]}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-ui">{v.microphone}</span>
            <Select
              label={v.microphone}
              value={selectedMic}
              onChange={(value) => void update({ mic_device: value || null })}
              options={[
                { value: "", label: v.defaultMic },
                ...(status?.microphones ?? []).map((mic) => ({
                  value: mic.id,
                  label: mic.is_default ? `${mic.name} · ${v.windowsDefault}` : mic.name,
                })),
              ]}
            />
          </label>
        </div>
        <MicTest />
      </Section>

      <Section title={v.reading}>
        <p className="text-ui font-normal text-fg-muted">{v.readingHint}</p>
        {(["de", "en"] as const).map((lang) => (
          <div key={lang} className="flex flex-col gap-2">
            <h4 className="text-caption text-fg-subtle">{lang === "de" ? v.voicesDe : v.voicesEn}</h4>
            {status?.voices
              .filter((voice) => voice.lang === lang)
              .map((voice) => (
                <VoiceRow key={voice.id} voice={voice} />
              ))}
          </div>
        ))}
        {install?.item.startsWith("voice:") && <VoiceDownload />}

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-ui">{v.speed}</span>
            <span className="text-caption text-fg-muted tabular-nums">{settings.speech_rate.toFixed(2)}×</span>
          </div>
          <Slider
            label={v.speed}
            min={0.5}
            max={2}
            step={0.05}
            value={settings.speech_rate}
            valueText={`${settings.speech_rate.toFixed(2)}×`}
            onChange={(r) => void update({ speech_rate: Math.round(r * 100) / 100 }, false)}
            onCommit={(r) => void update({ speech_rate: Math.round(r * 100) / 100 })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div>
            <label htmlFor="auto-read" className="text-ui">
              {v.autoRead}
            </label>
            <p className="text-caption text-fg-muted">{v.autoReadHint}</p>
          </div>
          <Switch
            id="auto-read"
            label={v.autoRead}
            checked={settings.auto_read}
            onChange={(on) => void update({ auto_read: on })}
          />
        </div>
      </Section>
    </div>
  );
}

/** Records 5 s without transcribing and shows the level live, then whether
 *  the microphone heard anything. */
function MicTest() {
  const testing = useVoice((s) => s.testing);
  const level = useVoice((s) => (s.testing ? (s.recording?.level ?? 0) : 0));
  const peak = useVoice((s) => s.testPeak);
  const busy = useVoice((s) => s.recording !== null || s.transcribing);
  const testMic = useVoice((s) => s.testMic);
  const v = t.voice.settings;
  const verdict =
    testing || peak === null ? null : peak === 0 ? v.micSilent : peak < SPEECH_PEAK ? v.micQuiet : v.micOk;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-3">
      <div className="flex items-center gap-3">
        <button className="btn btn-secondary h-8 flex-none text-caption" disabled={busy} onClick={() => void testMic()}>
          <Mic size={14} strokeWidth={1.75} aria-hidden="true" />
          {testing ? v.testing : v.testMic}
        </button>
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3"
          role="meter"
          aria-label={v.micLevel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(micLevel(level) * 100)}
        >
          <div
            className="h-full rounded-full bg-coral transition-[width] duration-100"
            style={{ width: `${Math.round(micLevel(level) * 100)}%` }}
          />
        </div>
      </div>
      <p
        className={`text-caption ${verdict === v.micOk ? "text-[var(--success)]" : "text-fg-muted"}`}
        aria-live="polite"
      >
        {testing ? v.testHint : (verdict ?? v.testHint)}
      </p>
    </div>
  );
}

function VoiceRow({ voice }: { voice: VoiceInfo }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const status = useVoice((s) => s.status);
  const install = useVoice((s) => s.install);
  const previewing = useVoice((s) => s.speakingId === `preview:${voice.id}`);
  const preview = useVoice((s) => s.preview);
  const v = t.voice.settings;
  const key = voice.lang === "de" ? "voice_de" : "voice_en";
  const inUse = settings[key] === voice.id;
  const installed = voice.installed && Boolean(status?.piper);
  const item = `voice:${voice.id}`;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${
        inUse ? "border-[var(--coral-ring)] bg-surface-2" : "border-border bg-surface-1"
      }`}
    >
      <IconButton
        label={previewing ? t.voice.stopReading : v.listen}
        className={`size-9 flex-none ${previewing ? "text-coral" : ""}`}
        disabled={install !== null && !installed}
        onClick={() => void preview(voice.id)}
      >
        {previewing ? (
          <Square size={13} strokeWidth={1.75} fill="currentColor" />
        ) : (
          <Volume2 size={16} strokeWidth={1.75} />
        )}
      </IconButton>
      <div className="min-w-0 flex-1">
        <div className="text-ui">{voice.name}</div>
        <div className="text-caption text-fg-muted">
          {voice.gender === "female" ? v.female : v.male} · {formatBytes(voice.size)}
        </div>
      </div>
      {inUse ? (
        <span className="flex items-center gap-1 text-caption text-coral">
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          {v.inUse}
        </span>
      ) : (
        <button
          className="btn btn-ghost h-8 text-caption text-fg-muted"
          onClick={() => void update({ [key]: voice.id })}
        >
          {v.useFor(voice.lang === "de" ? v.german : v.english)}
        </button>
      )}
      <InstallControls installed={installed} busy={install !== null} size={installSize(status, item)} item={item} />
    </div>
  );
}

function InstallControls({
  installed,
  busy,
  size,
  item,
}: {
  installed: boolean;
  busy: boolean;
  size: number;
  item: string;
}) {
  const installItem = useVoice((s) => s.installItem);
  const removeItem = useVoice((s) => s.removeItem);
  if (installed) {
    return (
      <IconButton label={t.voice.remove} className="size-8 flex-none" onClick={() => void removeItem(item)}>
        <Trash2 size={15} strokeWidth={1.75} />
      </IconButton>
    );
  }
  return (
    <button
      className="btn btn-secondary h-8 flex-none text-caption"
      disabled={busy}
      onClick={() => void installItem(item)}
    >
      <Download size={14} strokeWidth={1.75} aria-hidden="true" />
      {t.voice.download} · {formatBytes(size)}
    </button>
  );
}
