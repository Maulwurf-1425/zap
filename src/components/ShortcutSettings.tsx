import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Section, Segmented } from "./ui/Controls";
import { IconButton } from "./ui/IconButton";
import { t } from "../lib/i18n";
import { api } from "../lib/ipc";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  comboFromEvent,
  comboProblem,
  conflictOf,
  formatCombo,
  globalComboProblem,
  setRecordingShortcut,
  shortcutFor,
  type SendKey,
  type ShortcutAction,
} from "../lib/shortcuts";
import { DEFAULT_SETTINGS, useSettings } from "../store/settings";

/** Shortcut list with a recorder per row, plus which Enter sends. */
export function ShortcutsSection() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const g = t.settings.general;
  const names = t.shortcuts;

  const setCombo = (action: ShortcutAction, combo: string | null): string | null => {
    if (combo) {
      const problem = comboProblem(combo);
      if (problem) return g.problems[problem] ?? null;
      const other = conflictOf(settings, action, combo);
      if (other) return g.conflict(names[other]);
    }
    const next = { ...settings.shortcuts };
    if (!combo || combo === DEFAULT_SHORTCUTS[action]) delete next[action];
    else next[action] = combo;
    void update({ shortcuts: next });
    return null;
  };

  // The quick ask shortcut is registered with Windows; roll back if it refuses.
  const setQuick = async (combo: string): Promise<string | null> => {
    const problem = globalComboProblem(combo);
    if (problem) return g.problems[problem] ?? null;
    const previous = settings.quick_ask_shortcut;
    await update({ quick_ask_shortcut: combo });
    const error = await api.quickApplyShortcut().catch(() => "shortcut_taken");
    if (!error) return null;
    await update({ quick_ask_shortcut: previous });
    await api.quickApplyShortcut().catch(() => null);
    return t.quick.errors[error] ?? t.errors.generic;
  };

  const changed =
    Object.keys(settings.shortcuts ?? {}).length > 0 ||
    settings.quick_ask_shortcut !== DEFAULT_SETTINGS.quick_ask_shortcut;
  const resetAll = async () => {
    await update({ shortcuts: {}, quick_ask_shortcut: DEFAULT_SETTINGS.quick_ask_shortcut });
    const error = await api.quickApplyShortcut().catch(() => "shortcut_taken");
    if (error) toast(t.quick.errors[error] ?? t.errors.generic);
  };

  return (
    <Section title={g.shortcuts}>
      <div className="flex flex-col items-start gap-2">
        <span className="text-ui">{g.sendKey}</span>
        <Segmented<SendKey>
          label={g.sendKey}
          value={settings.send_key ?? "enter"}
          onChange={(send_key) => void update({ send_key })}
          options={[
            { value: "enter", label: "Enter" },
            { value: "shift_enter", label: "Shift+Enter" },
          ]}
        />
        <p className="text-caption text-fg-muted">
          {settings.send_key === "shift_enter" ? g.sendShiftEnter : g.sendEnter}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-fg-muted">{g.shortcutsHint}</p>
        <button className="btn btn-ghost flex-none text-fg-muted" disabled={!changed} onClick={() => void resetAll()}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
          {g.resetAll}
        </button>
      </div>
      <dl className="flex flex-col">
        {SHORTCUT_ACTIONS.map((action) => (
          <ShortcutRow
            key={action}
            label={names[action]}
            combo={shortcutFor(settings, action)}
            isDefault={shortcutFor(settings, action) === DEFAULT_SHORTCUTS[action]}
            onRecord={(combo) => setCombo(action, combo)}
            onReset={() => setCombo(action, null)}
          />
        ))}
        <ShortcutRow
          label={names.quickAsk}
          combo={settings.quick_ask_shortcut}
          isDefault={settings.quick_ask_shortcut === DEFAULT_SETTINGS.quick_ask_shortcut}
          onRecord={setQuick}
          onReset={() => setQuick(DEFAULT_SETTINGS.quick_ask_shortcut)}
        />
        <div className="flex h-11 items-center justify-between border-b border-border last:border-0">
          <dt className="text-ui font-normal">{names.stop}</dt>
          <dd title={g.fixed}>
            <kbd className="kbd">Esc</kbd>
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function ShortcutRow({
  label,
  combo,
  isDefault,
  onRecord,
  onReset,
}: {
  label: string;
  combo: string;
  isDefault: boolean;
  /** Returns an error text when the combo can't be used. */
  onRecord: (combo: string) => string | null | Promise<string | null>;
  onReset: () => unknown;
}) {
  const g = t.settings.general;
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    setRecordingShortcut(true);
    // Capture phase on window: runs before the app's shortcuts and the dialog's Esc.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false);
        return;
      }
      const next = comboFromEvent(e);
      if (!next) return; // only modifiers so far
      setRecording(false);
      void Promise.resolve(onRecord(next)).then(setError);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setRecordingShortcut(false);
    };
  }, [recording, onRecord]);

  return (
    <div className="flex flex-col border-b border-border py-1.5 last:border-0">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <dt className="text-ui font-normal">{label}</dt>
        <dd className="flex items-center gap-1">
          {!isDefault && (
            <IconButton
              label={g.reset}
              className="size-8"
              onClick={() => void Promise.resolve(onReset()).then(() => setError(null))}
            >
              <RotateCcw size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          <button
            type="button"
            aria-label={g.change(label)}
            aria-pressed={recording}
            className={`kbd h-8 min-w-24 cursor-pointer justify-center px-3 hover:bg-surface-2 ${
              recording ? "border-[var(--coral-ring)] text-coral" : ""
            }`}
            onClick={() => {
              setError(null);
              setRecording((r) => !r);
            }}
            onBlur={() => setRecording(false)}
          >
            {recording ? g.record : formatCombo(combo, t.keys)}
          </button>
        </dd>
      </div>
      {error && (
        <p role="alert" className="pb-1 text-right text-caption text-coral">
          {error}
        </p>
      )}
    </div>
  );
}
