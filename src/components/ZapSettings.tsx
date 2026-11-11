import { TriangleAlert } from "lucide-react";
import { Field, Section, Switch } from "./ui/Controls";
import { Select } from "./ui/Select";
import { useSettings } from "../store/settings";
import { t } from "../lib/i18n";

type BoolKey = "zaps_in_chat" | "close_to_tray" | "autostart" | "zap_notifications";

/** Labeled switch in a card (one setting). */
function SwitchRow({ id, field, label, hint }: { id: string; field: BoolKey; label: string; hint: string }) {
  const checked = useSettings((s) => s.settings[field]);
  const update = useSettings((s) => s.update);
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
      <div>
        <label htmlFor={id} className="text-ui">
          {label}
        </label>
        <p className="text-caption text-fg-muted">{hint}</p>
      </div>
      <Switch id={id} label={label} checked={checked} onChange={(on) => void update({ [field]: on })} />
    </div>
  );
}

/** Minutes of the "unload idle models" choices. */
const IDLE_CHOICES = [1, 5, 15, 30, 60, 120];

/** Settings → Models: how long engines keep an unused model in memory. */
export function IdleModelsField() {
  const value = useSettings((s) => s.settings.model_idle_minutes);
  const update = useSettings((s) => s.update);
  const z = t.zaps.settings;
  return (
    <Field label={z.idle} htmlFor="model-idle" hint={z.idleHint}>
      <Select
        id="model-idle"
        value={String(value ?? "")}
        onChange={(v) => void update({ model_idle_minutes: v ? Number(v) : null })}
        options={[
          { value: "", label: z.idleDefault },
          ...IDLE_CHOICES.map((m) => ({ value: String(m), label: z.idleAfter(t.zaps.duration(m)) })),
        ]}
      />
    </Field>
  );
}

/** Settings → ZAPs: permission for commands and apps, chat control. */
export function ZapsTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const z = t.zaps.settings;
  const modes: { value: "ask" | "full"; label: string; hint: string }[] = [
    { value: "ask", label: z.ask, hint: z.askHint },
    { value: "full", label: z.full, hint: z.fullHint },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Section title={t.zaps.title}>
        <p className="text-ui font-normal text-fg-muted">{z.intro}</p>
        <SwitchRow id="zaps-in-chat" field="zaps_in_chat" label={z.chat} hint={z.chatHint} />
      </Section>

      <Section title={z.background}>
        <SwitchRow id="zaps-tray" field="close_to_tray" label={z.closeToTray} hint={z.closeToTrayHint} />
        <SwitchRow id="zaps-autostart" field="autostart" label={z.autostart} hint={z.autostartHint} />
        <SwitchRow id="zaps-notify" field="zap_notifications" label={z.notifications} hint={z.notificationsHint} />
      </Section>

      <Section title={z.permission}>
        <div role="radiogroup" aria-label={z.permission} className="flex flex-col gap-2">
          {modes.map((m) => {
            const checked = settings.zap_permission === m.value;
            const danger = m.value === "full";
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => void update({ zap_permission: m.value })}
                className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                  checked
                    ? danger
                      ? "border-[var(--danger)] bg-surface-2"
                      : "border-[var(--coral-ring)] bg-surface-2"
                    : "border-border bg-surface-1 hover:bg-surface-2"
                }`}
              >
                <span
                  className={`mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border ${
                    checked ? "border-coral" : "border-border-strong"
                  }`}
                  aria-hidden="true"
                >
                  {checked && <span className="size-2 rounded-full bg-coral" />}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-ui">
                    {danger && (
                      <TriangleAlert size={14} strokeWidth={1.75} className="text-danger" aria-hidden="true" />
                    )}
                    {m.label}
                  </span>
                  <span className="text-caption text-fg-muted">{m.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-caption text-fg-muted">{z.safety}</p>
      </Section>
    </div>
  );
}
