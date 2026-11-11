import { useEffect, useState, type FormEvent } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { toast } from "sonner";
import {
  ChartColumn,
  Check,
  Database,
  ExternalLink,
  FolderSearch,
  Globe,
  Info,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Package,
  Play,
  Palette,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  SlidersHorizontal,
  Sun,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Field, Section, Segmented, Slider, Switch } from "./ui/Controls";
import { Select } from "./ui/Select";
import { IconButton } from "./ui/IconButton";
import { Skeleton } from "./ui/Skeleton";
import { PullRow } from "./PullRow";
import { Markdown } from "./Markdown";
import { BLUEPRINT_ICONS, FALLBACK_ICON, MAX_BLUEPRINTS, defaultBlueprints } from "../lib/blueprints";
import { DEFAULT_SETTINGS, TYPOGRAPHY_KEYS, useSettings } from "../store/settings";
import { releaseLabel, useUpdates } from "../store/updates";
import { VoiceTab } from "./VoiceSettings";
import { IdleModelsField, ZapsTab } from "./ZapSettings";
import { useAvatarCredits } from "../lib/avatars";
import { useDiscord } from "../store/discord";
import { CURATED_MODELS, curatedDescription, hasOllamaModel, MODEL_NAME, useModels } from "../store/models";
import { useProviders } from "../store/providers";
import { EngineCard } from "./EngineCard";
import { useChats } from "../store/chats";
import { useUi, type SettingsTab } from "../store/ui";
import {
  api,
  modelLabel,
  modelProvider,
  toAppError,
  type AppInfo,
  type ModelDetails,
  type ModelUsage,
  type SearchProviderName,
  type IndexStatus,
  type SearchStatus,
  type ThemeMode,
  type Blueprint,
  type ContainerState,
  type ToolVersion,
  type FontFamily,
  type Settings,
} from "../lib/ipc";
import type { Language } from "../lib/i18n";
import {
  FONT_MAX,
  FONT_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  PARAGRAPH_MAX,
  PARAGRAPH_MIN,
  resolveTheme,
} from "../lib/theme";
import { buildTokens, CUSTOM_PALETTE, isHexColor, PALETTES } from "../lib/palettes";
import { formatBytes, formatTokens, openExternal } from "../lib/format";
import { engineName, errorMessage, t } from "../lib/i18n";

// A function, not a constant: labels must follow the active language.
const tabs = (): { id: SettingsTab; label: string; icon: typeof Palette }[] => [
  { id: "general", label: t.settings.tabs.general, icon: SlidersHorizontal },
  { id: "appearance", label: t.settings.tabs.appearance, icon: Palette },
  { id: "models", label: t.settings.tabs.models, icon: Package },
  { id: "chat", label: t.settings.tabs.chat, icon: MessageSquare },
  { id: "voice", label: t.voice.tab, icon: Mic },
  { id: "zaps", label: t.zaps.tab, icon: Zap },
  { id: "usage", label: t.settings.tabs.usage, icon: ChartColumn },
  { id: "web", label: t.settings.tabs.web, icon: Globe },
  { id: "files", label: t.settings.tabs.files, icon: FolderSearch },
  { id: "data", label: t.settings.tabs.data, icon: Database },
  { id: "about", label: t.settings.tabs.about, icon: Info },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  const close = useUi((s) => s.closeSettings);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={t.settings.title} width={820} height={600}>
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as SettingsTab)}
        orientation="vertical"
        className="flex min-h-0 flex-1 gap-2 px-3 pb-3"
      >
        <Tabs.List aria-label={t.settings.title} className="flex w-48 flex-none flex-col gap-0.5 pt-1">
          {tabs().map(({ id, label, icon: Icon }) => (
            <Tabs.Trigger
              key={id}
              value={id}
              className="menu-item h-10 text-fg-muted data-[state=active]:bg-surface-3 data-[state=active]:text-fg"
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {/* The outer box clips to the rounded corners, so the scrollbar of
            the inner one never pokes out over them. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-surface-1">
          <div className="h-full overflow-y-auto px-6 py-5">
            <Tabs.Content value="general" className="outline-none">
              <GeneralTab />
            </Tabs.Content>
            <Tabs.Content value="appearance" className="outline-none">
              <AppearanceTab />
            </Tabs.Content>
            <Tabs.Content value="models" className="outline-none">
              <ModelsTab />
            </Tabs.Content>
            <Tabs.Content value="chat" className="outline-none">
              <ChatTab />
            </Tabs.Content>
            <Tabs.Content value="voice" className="outline-none">
              <VoiceTab />
            </Tabs.Content>
            <Tabs.Content value="zaps" className="outline-none">
              <ZapsTab />
            </Tabs.Content>
            <Tabs.Content value="usage" className="outline-none">
              <UsageTab />
            </Tabs.Content>
            <Tabs.Content value="web" className="outline-none">
              <WebTab />
            </Tabs.Content>
            <Tabs.Content value="files" className="outline-none">
              <FilesTab />
            </Tabs.Content>
            <Tabs.Content value="data" className="outline-none">
              <DataTab />
            </Tabs.Content>
            <Tabs.Content value="about" className="outline-none">
              <AboutTab />
            </Tabs.Content>
          </div>
        </div>
      </Tabs.Root>
    </Dialog>
  );
}

// --- General ----------------------------------------------------------------

function GeneralTab() {
  const close = useUi((s) => s.closeSettings);
  const setOnboardingOpen = useUi((s) => s.setOnboardingOpen);
  const language = useSettings((s) => s.settings.language);
  const update = useSettings((s) => s.update);
  const g = t.settings.general;
  return (
    <div className="flex flex-col gap-8">
      <Section title={g.language}>
        <Segmented<Language>
          label={g.language}
          value={language}
          onChange={(lang) => void update({ language: lang })}
          options={[
            { value: "en", label: g.languages.en },
            { value: "de", label: g.languages.de },
          ]}
        />
      </Section>
      <DiscordSection />
      <Section title={t.settings.general.onboarding}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-ui font-normal text-fg-muted">{t.settings.general.onboardingHint}</p>
          <button
            className="btn btn-secondary flex-none"
            onClick={() => {
              close();
              setOnboardingOpen(true);
            }}
          >
            {t.settings.general.onboardingCta}
          </button>
        </div>
      </Section>
      <Section title={t.settings.general.shortcuts}>
        <dl className="flex flex-col">
          {t.shortcuts.map(({ keys, label }) => (
            <div key={label} className="flex h-10 items-center justify-between border-b border-border last:border-0">
              <dt className="text-ui font-normal">{label}</dt>
              <dd className="flex gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

/** "Playing ZAP" in Discord; hidden in builds without a Discord app id. */
function DiscordSection() {
  const available = useDiscord((s) => s.available);
  const connected = useDiscord((s) => s.connected);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const d = t.discord.settings;
  if (!available) return null;
  return (
    <Section title={d.title}>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="discord-presence" className="text-ui">
              {d.show}
            </label>
            <p className="text-caption text-fg-muted">{d.showHint}</p>
          </div>
          <Switch
            id="discord-presence"
            label={d.show}
            checked={settings.discord_presence}
            onChange={(on) => void update({ discord_presence: on })}
          />
        </div>
        {settings.discord_presence && (
          <>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <label htmlFor="discord-model" className="text-ui font-normal">
                {d.model}
              </label>
              <Switch
                id="discord-model"
                label={d.model}
                checked={settings.discord_show_model}
                onChange={(on) => void update({ discord_show_model: on })}
              />
            </div>
            <p className="flex items-center gap-2 text-caption text-fg-muted" role="status">
              <span
                className="status-dot"
                style={{ background: connected ? "var(--success)" : "var(--warning)" }}
                aria-hidden="true"
              />
              {connected ? d.connected : d.waiting}
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

// --- Appearance ----------------------------------------------------------------

function AppearanceTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const a = t.settings.appearance;
  return (
    <div className="flex flex-col gap-8">
      <Section title={a.theme}>
        <Segmented<ThemeMode>
          label={a.theme}
          value={settings.theme}
          onChange={(theme) => void update({ theme })}
          options={[
            { value: "dark", label: a.dark, icon: <Moon size={16} strokeWidth={1.75} /> },
            { value: "light", label: a.light, icon: <Sun size={16} strokeWidth={1.75} /> },
            { value: "system", label: a.system, icon: <Monitor size={16} strokeWidth={1.75} /> },
          ]}
        />
      </Section>
      <PaletteSection />
      <TypographySection />
      <Section title={a.density}>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="density-switch" className="text-ui font-normal">
            {a.compact}
          </label>
          <Switch
            id="density-switch"
            label={a.compact}
            checked={settings.density === "compact"}
            onChange={(on) => void update({ density: on ? "compact" : "comfortable" })}
          />
        </div>
      </Section>
    </div>
  );
}

function Swatch({ accent, tint, scheme }: { accent: string; tint: string; scheme: "dark" | "light" }) {
  const tokens = buildTokens(accent, tint, scheme);
  return (
    <span
      className="relative flex h-12 w-full items-end gap-1 overflow-hidden rounded-md border border-border p-1.5"
      style={{ background: tokens["--bg-gradient"] }}
      aria-hidden="true"
    >
      <span className="size-3 rounded-full" style={{ background: accent }} />
      <span className="h-1.5 w-6 self-center rounded-full opacity-60" style={{ background: tokens["--azure-300"] }} />
    </span>
  );
}

function PaletteSection() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const a = t.settings.appearance;
  const scheme = resolveTheme(settings.theme);
  const options = [...PALETTES, { id: CUSTOM_PALETTE, accent: settings.custom_accent, tint: settings.custom_tint }];

  return (
    <Section title={a.colors}>
      <div role="radiogroup" aria-label={a.colors} className="grid grid-cols-3 gap-2">
        {options.map((p) => {
          const checked = settings.palette === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => void update({ palette: p.id })}
              className={`flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors ${
                checked ? "border-[var(--coral-ring)] bg-surface-2" : "border-border bg-surface-1 hover:bg-surface-2"
              }`}
            >
              <Swatch accent={p.accent} tint={p.tint} scheme={scheme} />
              <span className="flex items-center justify-between px-1 text-caption">
                {a.palettes[p.id] ?? p.id}
                {checked && <Check size={14} strokeWidth={2} className="text-coral" aria-hidden="true" />}
              </span>
            </button>
          );
        })}
      </div>
      {settings.palette === CUSTOM_PALETTE && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
          <div className="flex flex-wrap gap-6">
            <ColorField
              id="custom-accent"
              label={a.accent}
              value={settings.custom_accent}
              onChange={(custom_accent, persist) => void update({ custom_accent }, persist)}
            />
            <ColorField
              id="custom-tint"
              label={a.tint}
              value={settings.custom_tint}
              onChange={(custom_tint, persist) => void update({ custom_tint }, persist)}
            />
          </div>
          <p className="text-caption text-fg-muted">{a.customHint}</p>
        </div>
      )}
    </Section>
  );
}

/** Native color picker plus a hex field. Picker drags preview live and save on release. */
function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string, persist: boolean) => void;
}) {
  // Only set while the hex field is being edited; otherwise it mirrors `value`.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="color"
        value={isHexColor(value) ? value : "#000000"}
        onInput={(e) => onChange(e.currentTarget.value, false)}
        onChange={(e) => onChange(e.currentTarget.value, true)}
        className="size-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
      />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-ui">
          {label}
        </label>
        <input
          aria-label={`${label} (hex)`}
          value={draft ?? value}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            const full = v.startsWith("#") ? v : `#${v}`;
            if (isHexColor(full)) onChange(full.toLowerCase(), true);
          }}
          onBlur={() => setDraft(null)}
          className="w-24 bg-transparent font-mono text-caption text-fg-muted uppercase outline-none focus:text-fg"
        />
      </div>
    </div>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number, persist: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr_4rem] items-center gap-4">
      <span className="text-ui font-normal">{label}</span>
      <Slider
        label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        valueText={format(value)}
        onChange={(v) => onChange(v, false)}
        onCommit={(v) => onChange(v, true)}
      />
      <span className="text-right text-caption text-fg-muted tabular-nums">{format(value)}</span>
    </div>
  );
}

function TypographySection() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const a = t.settings.appearance;
  const changed = TYPOGRAPHY_KEYS.some((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  const reset = () => {
    const patch: Partial<Settings> = {};
    for (const k of TYPOGRAPHY_KEYS) Object.assign(patch, { [k]: DEFAULT_SETTINGS[k] });
    void update(patch);
  };
  const round = (v: number, digits: number) => Number(v.toFixed(digits));

  return (
    <Section title={a.typography}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<FontFamily>
          label={a.font}
          value={settings.font_family}
          onChange={(font_family) => void update({ font_family })}
          options={(["inter", "system", "serif", "mono"] as const).map((f) => ({ value: f, label: a.fonts[f] }))}
        />
        <button className="btn btn-ghost text-fg-muted" disabled={!changed} onClick={reset}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
          {a.reset}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <SliderRow
          label={a.fontSize}
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          value={settings.font_size}
          format={(v) => `${v} px`}
          onChange={(font_size, persist) => void update({ font_size }, persist)}
        />
        <SliderRow
          label={a.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.05}
          value={settings.line_height}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v, persist) => void update({ line_height: round(v, 3) }, persist)}
        />
        <SliderRow
          label={a.letterSpacing}
          min={LETTER_SPACING_MIN}
          max={LETTER_SPACING_MAX}
          step={0.005}
          value={settings.letter_spacing}
          format={(v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)} %`}
          onChange={(v, persist) => void update({ letter_spacing: round(v, 3) }, persist)}
        />
        <SliderRow
          label={a.paragraphSpacing}
          min={PARAGRAPH_MIN}
          max={PARAGRAPH_MAX}
          step={0.125}
          value={settings.paragraph_spacing}
          format={(v) => `${v.toFixed(2)} em`}
          onChange={(v, persist) => void update({ paragraph_spacing: round(v, 3) }, persist)}
        />
      </div>
      <div className="markdown rounded-md border border-border px-4 py-3">
        <Markdown content={a.preview} />
      </div>
    </Section>
  );
}

// --- Models ----------------------------------------------------------------

function ModelsTab() {
  const installed = useModels((s) => s.installed);
  const loaded = useModels((s) => s.loaded);
  const pulls = useModels((s) => s.pulls);
  const pull = useModels((s) => s.pull);
  const remove = useModels((s) => s.remove);
  const askConfirm = useUi((s) => s.askConfirm);
  const statuses = useProviders((s) => s.statuses);
  const [details, setDetails] = useState<Record<string, ModelDetails>>({});
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const ollamaOn = statuses.ollama !== "disabled";
  const ollamaRunning = statuses.ollama === "running";
  const lmstudioOn = statuses.lmstudio !== "disabled";

  // Size, quantization and context come from Ollama's /api/show.
  useEffect(() => {
    let alive = true;
    for (const m of installed) {
      if (m.provider !== "ollama" || details[m.name]) continue;
      void api
        .showModel(m.name)
        .then((d) => alive && setDetails((prev) => ({ ...prev, [m.name]: d })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // Only refetch when the installed list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed]);

  const custom = Object.values(pulls).filter((p) => !CURATED_MODELS.some((m) => m.name === p.name));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!MODEL_NAME.test(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setName("");
    void pull(value);
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title={t.engines.title}>
        <p className="text-ui font-normal text-fg-muted">{t.engines.hint}</p>
        <EngineCard kind="ollama" />
        <EngineCard kind="lmstudio" showPort />
      </Section>

      <Section title={t.zaps.settings.memory}>
        <IdleModelsField />
      </Section>

      <Section title={t.models.installed}>
        {!loaded ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : installed.length === 0 ? (
          <p className="text-ui font-normal text-fg-muted">{t.models.emptyInstalled}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {installed.map((m) => {
              const d = m.provider === "ollama" ? details[m.name] : undefined;
              const meta = [
                m.size_bytes > 0 ? formatBytes(m.size_bytes) : null,
                d?.parameter_size,
                d?.quantization,
                d?.context_length ? t.models.contextMax(d.context_length) : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={m.id} className="flex min-h-12 items-center gap-3 rounded-md bg-surface-1 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ui">{m.name}</span>
                      <span className="flex-none rounded-full border border-border px-2 text-caption text-fg-muted">
                        {engineName(m.provider)}
                      </span>
                    </div>
                    {meta && <div className="truncate text-caption text-fg-muted">{meta}</div>}
                  </div>
                  {/* LM Studio manages its own models. */}
                  {m.provider === "ollama" && (
                    <IconButton
                      label={t.models.deleteLabel(m.name)}
                      onClick={() =>
                        askConfirm({
                          title: t.models.deleteTitle,
                          message: t.models.deleteBody(m.name),
                          confirmLabel: t.sidebar.deleteConfirm,
                          onConfirm: () => remove(m.name),
                        })
                      }
                    >
                      <Trash2 size={16} strokeWidth={1.75} />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {lmstudioOn && <p className="text-caption text-fg-muted">{t.engines.lmstudioModels}</p>}
      </Section>

      {ollamaOn && (
        <Section title={t.models.more.replace(" …", "")}>
          <p className="text-ui font-normal text-fg-muted">{t.models.intro}</p>
          <ul className="flex flex-col gap-1">
            {CURATED_MODELS.map((m) => {
              const isInstalled = hasOllamaModel(installed, m.name);
              const progress = pulls[m.name];
              return (
                <li key={m.name} className="rounded-md bg-surface-1 px-4 py-2">
                  {progress ? (
                    <PullRow pull={progress} />
                  ) : (
                    <div className="flex min-h-10 items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-ui">{m.name}</div>
                        <div className="truncate text-caption text-fg-muted">
                          {curatedDescription(m.name)} · ~{formatBytes(m.approxBytes)} · {t.models.ramHint(m.ramGb)}
                        </div>
                      </div>
                      {isInstalled ? (
                        <span className="flex items-center gap-1.5 text-caption text-fg-muted">
                          <Check size={16} strokeWidth={1.75} aria-hidden="true" /> {t.models.installed}
                        </span>
                      ) : (
                        <button
                          className="btn btn-secondary h-8 px-3"
                          disabled={!ollamaRunning}
                          onClick={() => void pull(m.name)}
                        >
                          {t.models.load}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {custom.length > 0 && (
            <div className="rounded-md bg-surface-1 px-4 py-1">
              {custom.map((p) => (
                <PullRow key={p.name} pull={p} />
              ))}
            </div>
          )}

          <form onSubmit={submit}>
            <Field
              label={t.models.other}
              htmlFor="model-name"
              hint={invalid ? t.models.otherInvalid : t.models.otherHint}
            >
              <div className="flex gap-3">
                <input
                  id="model-name"
                  className="input"
                  placeholder={t.models.otherPlaceholder}
                  value={name}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={invalid}
                  onChange={(e) => {
                    setName(e.target.value);
                    setInvalid(false);
                  }}
                />
                <button type="submit" className="btn btn-primary" disabled={!name.trim() || !ollamaRunning}>
                  {t.models.loadCta}
                </button>
              </div>
            </Field>
          </form>
        </Section>
      )}
    </div>
  );
}

// --- Chat ----------------------------------------------------------------

const CONTEXT_STEPS = [0, 2048, 4096, 8192, 16384, 32768];

function ChatTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const installed = useModels((s) => s.installed);
  const c = t.settings.chat;

  const ctxIndex = Math.max(0, CONTEXT_STEPS.indexOf(settings.context_length ?? 0));
  const ctxLabel = ctxIndex === 0 ? c.contextAuto : `${(CONTEXT_STEPS[ctxIndex] ?? 0).toLocaleString("de-DE")} Tokens`;
  const tempLabel = settings.temperature.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  return (
    <div className="flex flex-col gap-8">
      {/* Remounts when the stored prompt changes, so the draft never goes stale. */}
      <SystemPromptField key={settings.system_prompt} saved={settings.system_prompt} />

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-ui">{c.temperature}</span>
          <span className="text-caption text-fg-muted tabular-nums">{tempLabel}</span>
        </div>
        <Slider
          label={c.temperature}
          min={0}
          max={2}
          step={0.1}
          value={settings.temperature}
          valueText={tempLabel}
          onChange={(temperature) => void update({ temperature: Math.round(temperature * 10) / 10 }, false)}
          onCommit={(temperature) => void update({ temperature: Math.round(temperature * 10) / 10 })}
        />
        <div className="flex justify-between text-caption text-fg-muted">
          <span>{c.precise}</span>
          <span>{c.creative}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-ui">{c.contextLength}</span>
          <span className="text-caption text-fg-muted tabular-nums">{ctxLabel}</span>
        </div>
        <Slider
          label={c.contextLength}
          min={0}
          max={CONTEXT_STEPS.length - 1}
          step={1}
          value={ctxIndex}
          valueText={ctxLabel}
          onChange={(i) => void update({ context_length: CONTEXT_STEPS[i] || null }, false)}
          onCommit={(i) => void update({ context_length: CONTEXT_STEPS[i] || null })}
        />
        <p className="text-caption text-fg-muted">{c.contextHint}</p>
      </div>

      <Field label={c.defaultModel} htmlFor="default-model">
        <Select
          id="default-model"
          value={settings.default_model ?? ""}
          onChange={(value) => void update({ default_model: value || null })}
          options={[
            { value: "", label: c.defaultModelAuto },
            ...installed.map((m) => ({ value: m.name, label: m.name })),
          ]}
        />
      </Field>

      <BlueprintsSection />
    </div>
  );
}

function BlueprintsSection() {
  const saved = useSettings((s) => s.settings.blueprints);
  const update = useSettings((s) => s.update);
  const [open, setOpen] = useState<number | null>(null);
  const b = t.settings.blueprints;
  const list = saved ?? defaultBlueprints();

  const save = (next: Blueprint[], persist = true) => void update({ blueprints: next }, persist);
  const change = (i: number, patch: Partial<Blueprint>, persist = true) =>
    save(
      list.map((bp, j) => (j === i ? { ...bp, ...patch } : bp)),
      persist,
    );
  const move = (i: number, dir: -1 | 1) => {
    const next = [...list];
    const [item] = next.splice(i, 1);
    if (!item) return;
    next.splice(i + dir, 0, item);
    save(next);
    if (open === i) setOpen(i + dir);
  };

  return (
    <Section title={b.title}>
      <p className="text-ui font-normal text-fg-muted">{b.hint}</p>
      <ul className="flex flex-col gap-2">
        {list.map((bp, i) => {
          const Icon = BLUEPRINT_ICONS[bp.icon] ?? FALLBACK_ICON;
          const expanded = open === i;
          return (
            <li key={i} className="rounded-lg border border-border bg-surface-1">
              <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : i)}
                >
                  <span className="flex size-8 flex-none items-center justify-center rounded-md bg-surface-2 text-fg-muted">
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ui">{bp.title || b.untitled}</span>
                  {bp.send && (
                    <Send size={14} strokeWidth={1.75} className="flex-none text-fg-subtle" aria-label={b.send} />
                  )}
                  <ChevronDown
                    size={16}
                    strokeWidth={1.75}
                    className={`flex-none text-fg-subtle transition-transform ${expanded ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </button>
                <IconButton label={b.moveUp} className="size-8" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} strokeWidth={1.75} />
                </IconButton>
                <IconButton
                  label={b.moveDown}
                  className="size-8"
                  disabled={i === list.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={16} strokeWidth={1.75} />
                </IconButton>
                <IconButton
                  label={b.remove}
                  className="size-8"
                  onClick={() => {
                    save(list.filter((_, j) => j !== i));
                    setOpen(null);
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.75} />
                </IconButton>
              </div>
              {expanded && <BlueprintEditor blueprint={bp} onChange={(patch, persist) => change(i, patch, persist)} />}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-secondary"
          disabled={list.length >= MAX_BLUEPRINTS}
          onClick={() => {
            save([...list, { title: "", prompt: "", icon: "sparkles", send: false }]);
            setOpen(list.length);
          }}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          {b.add}
        </button>
        <button
          className="btn btn-ghost text-fg-muted"
          disabled={saved === null}
          onClick={() => {
            void update({ blueprints: null });
            setOpen(null);
          }}
        >
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
          {b.reset}
        </button>
        <span className="ml-auto text-caption text-fg-subtle">{b.limit(MAX_BLUEPRINTS)}</span>
      </div>
    </Section>
  );
}

/** Text fields preview live and save on blur; icon and switch save at once. */
function BlueprintEditor({
  blueprint: bp,
  onChange,
}: {
  blueprint: Blueprint;
  onChange: (patch: Partial<Blueprint>, persist: boolean) => void;
}) {
  const b = t.settings.blueprints;
  return (
    <div className="flex flex-col gap-4 border-t border-border p-4">
      <Field label={b.name} htmlFor="bp-title">
        <input
          id="bp-title"
          className="input"
          value={bp.title}
          maxLength={60}
          placeholder={b.namePlaceholder}
          onChange={(e) => onChange({ title: e.target.value }, false)}
          onBlur={() => onChange({}, true)}
          autoFocus={bp.title === ""}
        />
      </Field>
      <Field label={b.prompt} htmlFor="bp-prompt">
        <textarea
          id="bp-prompt"
          className="input h-auto min-h-[96px] resize-y py-3 leading-[22px]"
          value={bp.prompt}
          placeholder={b.promptPlaceholder}
          onChange={(e) => onChange({ prompt: e.target.value }, false)}
          onBlur={() => onChange({}, true)}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-ui">{b.icon}</span>
        <div role="radiogroup" aria-label={b.icon} className="flex flex-wrap gap-1">
          {Object.entries(BLUEPRINT_ICONS).map(([name, Icon]) => {
            const checked = bp.icon === name;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={name}
                onClick={() => onChange({ icon: name }, true)}
                className={`flex size-9 items-center justify-center rounded-md border transition-colors ${
                  checked
                    ? "border-[var(--coral-ring)] bg-surface-2 text-fg"
                    : "border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <label htmlFor="bp-send" className="text-ui">
            {b.send}
          </label>
          <p className="text-caption text-fg-muted">{b.sendHint}</p>
        </div>
        <Switch id="bp-send" label={b.send} checked={bp.send} onChange={(send) => onChange({ send }, true)} />
      </div>
    </div>
  );
}

function SystemPromptField({ saved }: { saved: string }) {
  const update = useSettings((s) => s.update);
  const [prompt, setPrompt] = useState(saved);
  const c = t.settings.chat;
  return (
    <Field label={c.systemPrompt} htmlFor="system-prompt" hint={c.systemPromptHint}>
      <textarea
        id="system-prompt"
        className="input h-auto min-h-[112px] resize-y py-3 leading-[22px]"
        placeholder={c.systemPromptPlaceholder}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => {
          if (prompt !== saved) void update({ system_prompt: prompt }).then(() => toast(t.settings.saved));
        }}
      />
    </Field>
  );
}

// --- Usage ----------------------------------------------------------------

function UsageTab() {
  const askConfirm = useUi((s) => s.askConfirm);
  const [rows, setRows] = useState<ModelUsage[] | null>(null);
  const u = t.usage;

  const load = () =>
    void api
      .tokenUsage()
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(load, []);

  const sum = (pick: (r: ModelUsage) => number) => (rows ?? []).reduce((acc, r) => acc + pick(r), 0);
  const totals = {
    input: sum((r) => r.prompt_tokens),
    output: sum((r) => r.completion_tokens),
    replies: sum((r) => r.replies),
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title={u.title}>
        <p className="text-ui font-normal text-fg-muted">{u.intro}</p>
        {rows === null ? (
          <Skeleton className="h-20 rounded-lg" />
        ) : (
          <dl className="grid grid-cols-4 gap-2">
            {[
              [u.total, formatTokens(totals.input + totals.output)],
              [u.input, formatTokens(totals.input)],
              [u.output, formatTokens(totals.output)],
              [u.replies, formatTokens(totals.replies)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 rounded-md border border-border bg-surface-1 px-4 py-3">
                <dt className="text-caption text-fg-muted">{label}</dt>
                <dd className="text-h2 tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <Section title={u.byModel}>
        {rows === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 rounded-md" />
            <Skeleton className="h-10 rounded-md" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-ui font-normal text-fg-muted">{u.empty}</p>
        ) : (
          <table className="w-full border-separate border-spacing-y-1 text-ui">
            <thead>
              <tr className="text-caption text-fg-muted">
                <th className="px-3 py-1 text-left font-normal">{u.model}</th>
                <th className="px-3 py-1 text-right font-normal">{u.input}</th>
                <th className="px-3 py-1 text-right font-normal">{u.output}</th>
                <th className="px-3 py-1 text-right font-normal">{u.total}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="bg-surface-1">
                  <td className="max-w-0 rounded-l-sm px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="truncate" title={modelLabel(r.model)}>
                        {modelLabel(r.model)}
                      </span>
                      <span className="flex-none rounded-full border border-border px-2 text-caption text-fg-muted">
                        {engineName(modelProvider(r.model))}
                      </span>
                    </div>
                    <div className="text-caption text-fg-muted">
                      {formatTokens(r.replies)} {u.replies}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-normal tabular-nums">{formatTokens(r.prompt_tokens)}</td>
                  <td className="px-3 py-2 text-right font-normal tabular-nums">{formatTokens(r.completion_tokens)}</td>
                  <td className="rounded-r-sm px-3 py-2 text-right tabular-nums">
                    {formatTokens(r.prompt_tokens + r.completion_tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-caption text-fg-muted">{u.olderNote}</p>
      </Section>

      <div className="flex justify-end">
        <button
          className="btn btn-secondary"
          disabled={!rows || rows.length === 0}
          onClick={() =>
            askConfirm({
              title: u.resetTitle,
              message: u.resetBody,
              confirmLabel: u.resetConfirm,
              onConfirm: async () => {
                await api.resetUsage();
                toast(u.resetDone);
                load();
              },
            })
          }
        >
          {u.reset}
        </button>
      </div>
    </div>
  );
}

// --- Web search ----------------------------------------------------------------

const BRAVE_DASHBOARD = "https://api-dashboard.search.brave.com";

function WebTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const w = t.settings.webSearch;

  const refresh = () =>
    void api
      .searchStatus()
      .then(setStatus)
      .catch(() => undefined);
  useEffect(refresh, [settings.search_provider]);

  const errorText = (err: unknown) => {
    const code = toAppError(err).message;
    return t.web.errors[code] ?? t.errors.generic;
  };

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const n = await api.testSearch();
      setResult({ ok: true, text: w.testOk(n) });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setTesting(false);
      refresh();
    }
  };

  const providers: { value: SearchProviderName; label: string; hint: string }[] = [
    { value: "builtin", label: w.builtin, hint: w.builtinHint },
    { value: "brave", label: w.brave, hint: w.braveHint },
    { value: "searxng", label: w.searxng, hint: w.searxngHint },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Section title={w.title}>
        <p className="text-ui font-normal text-fg-muted">{w.intro}</p>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div>
            <label htmlFor="web-enabled" className="text-ui">
              {w.enable}
            </label>
            <p className="text-caption text-fg-muted">{w.enableHint}</p>
          </div>
          <Switch
            id="web-enabled"
            label={w.enable}
            checked={settings.web_search_enabled}
            onChange={(on) => void update({ web_search_enabled: on })}
          />
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div>
            <label htmlFor="read-links" className="text-ui">
              {w.readLinks}
            </label>
            <p className="text-caption text-fg-muted">{w.readLinksHint}</p>
          </div>
          <Switch
            id="read-links"
            label={w.readLinks}
            checked={settings.read_links}
            onChange={(on) => void update({ read_links: on })}
          />
        </div>
      </Section>

      <Section title={w.provider}>
        <div role="radiogroup" aria-label={w.provider} className="flex flex-col gap-2">
          {providers.map((p) => {
            const checked = settings.search_provider === p.value;
            return (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => {
                  setResult(null);
                  void update({ search_provider: p.value });
                }}
                className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                  checked ? "border-[var(--coral-ring)] bg-surface-2" : "border-border bg-surface-1 hover:bg-surface-2"
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
                  <span className="text-ui">{p.label}</span>
                  <span className="text-caption text-fg-muted">{p.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {settings.search_provider === "brave" && (
          <BraveSettings hasKey={status?.has_brave_key ?? false} onChange={refresh} />
        )}
        {settings.search_provider === "searxng" && <SearxngSettings />}

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? w.testing : w.test}
          </button>
          {result && (
            <span
              className={`flex items-center gap-1.5 text-caption ${result.ok ? "text-fg-muted" : "text-danger"}`}
              role="status"
            >
              {result.ok && <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
              {result.text}
            </span>
          )}
          {status && <span className="ml-auto text-caption text-fg-subtle">{w.month(status.month_count)}</span>}
        </div>
      </Section>
    </div>
  );
}

function BraveSettings({ hasKey, onChange }: { hasKey: boolean; onChange: () => void }) {
  const limit = useSettings((s) => s.settings.search_monthly_limit);
  const update = useSettings((s) => s.update);
  const [key, setKey] = useState("");
  const [limitDraft, setLimitDraft] = useState(String(limit));
  const w = t.settings.webSearch;

  const save = async (value: string | null) => {
    try {
      await api.setBraveKey(value);
      setKey("");
      toast(value ? w.braveSaved : w.braveRemoved);
    } catch {
      toast(t.errors.generic);
    } finally {
      onChange();
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-4">
      <p className="text-caption text-fg-muted">{w.braveSteps}</p>
      <button
        type="button"
        className="btn btn-ghost h-8 self-start px-2 text-caption"
        onClick={() => void openExternal(BRAVE_DASHBOARD)}
      >
        <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
        {w.getKey}
      </button>
      <Field label={w.braveKey} htmlFor="brave-key" hint={hasKey ? w.braveHasKey : undefined}>
        <div className="flex gap-2">
          <input
            id="brave-key"
            type="password"
            className="input h-10"
            placeholder={w.braveKeyPlaceholder}
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void save(key.trim())}
          />
          <button className="btn btn-secondary h-10" disabled={!key.trim()} onClick={() => void save(key.trim())}>
            {w.save}
          </button>
          {hasKey && (
            <button className="btn btn-ghost h-10" onClick={() => void save(null)}>
              {w.remove}
            </button>
          )}
        </div>
      </Field>
      <Field label={w.limit} htmlFor="brave-limit" hint={w.limitHint}>
        <input
          id="brave-limit"
          className="input h-10 w-32 tabular-nums"
          inputMode="numeric"
          value={limitDraft}
          onChange={(e) => setLimitDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onBlur={() => {
            const n = Number(limitDraft);
            if (Number.isInteger(n) && n > 0 && n !== limit) void update({ search_monthly_limit: n });
            else setLimitDraft(String(limit));
          }}
        />
      </Field>
    </div>
  );
}

/** Status of the local SearXNG container with start / stop / restart. */
function SearxngContainer({ settingUp }: { settingUp: boolean }) {
  const [state, setState] = useState<ContainerState | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = t.settings.webSearch.container;

  // Docker can change outside ZAP; check every few seconds while visible.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void api
        .searxngContainer()
        .then((s) => alive && setState(s))
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [settingUp]);

  const run = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    setError(null);
    try {
      setState(await api.searxngControl(action));
    } catch (err) {
      const code = toAppError(err).message;
      setError(t.web.errors[code] ?? t.errors.generic);
      setState(await api.searxngContainer().catch(() => null));
    } finally {
      setBusy(null);
    }
  };

  if (state === null) return null;
  const running = state === "running";
  const canControl = state === "running" || state === "stopped" || state === "docker_stopped";
  const dot = running ? "var(--success)" : canControl ? "var(--warning)" : "var(--fg-subtle)";

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ui" role="status" aria-live="polite">
          <span className={`status-dot ${busy ? "pulse" : ""}`} style={{ background: dot }} aria-hidden="true" />
          {busy ? c.working[busy] : c.state[state]}
        </span>
        {canControl && (
          <div className="flex flex-wrap gap-2">
            {running ? (
              <>
                <button
                  className="btn btn-ghost h-9 text-fg-muted"
                  disabled={busy !== null}
                  onClick={() => void run("restart")}
                >
                  <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" />
                  {c.restart}
                </button>
                <button className="btn btn-secondary h-9" disabled={busy !== null} onClick={() => void run("stop")}>
                  <Square size={13} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
                  {c.stop}
                </button>
              </>
            ) : (
              <button className="btn btn-secondary h-9" disabled={busy !== null} onClick={() => void run("start")}>
                <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                {c.start}
              </button>
            )}
          </div>
        )}
      </div>
      {state === "docker_stopped" && !busy && <p className="text-caption text-fg-muted">{c.dockerStoppedHint}</p>}
      {error && (
        <p className="text-caption text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SearxngSettings() {
  const url = useSettings((s) => s.settings.searxng_url);
  const load = useSettings((s) => s.load);
  const update = useSettings((s) => s.update);
  const [draft, setDraft] = useState(url);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const w = t.settings.webSearch;

  const setup = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const newUrl = await api.searxngSetup();
      setDraft(newUrl);
      await load();
      setMessage({ ok: true, text: w.setupDone });
    } catch (err) {
      const code = toAppError(err).message;
      setMessage({ ok: false, text: t.web.errors[code] ?? t.errors.generic });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-4">
      <SearxngContainer settingUp={busy} />
      <div className="flex flex-col gap-2">
        <button className="btn btn-secondary self-start" disabled={busy} onClick={() => void setup()}>
          {busy ? w.settingUp : w.setup}
        </button>
        <p className="text-caption text-fg-muted" role="status">
          {message ? <span className={message.ok ? "" : "text-danger"}>{message.text}</span> : w.dockerHint}
        </p>
      </div>
      <Field label={w.searxngUrl} htmlFor="searxng-url">
        <input
          id="searxng-url"
          className="input h-10"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && draft.trim() !== url && void update({ searxng_url: draft.trim() })}
        />
      </Field>
    </div>
  );
}

// --- Files -------------------------------------------------------------------

function FilesTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const f = t.settings.files;

  // Poll while the index is being built.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void api
        .indexStatus()
        .then((s) => alive && setIndex(s))
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const modes: { value: "ask" | "full"; label: string; hint: string }[] = [
    { value: "ask", label: f.ask, hint: f.askHint },
    { value: "full", label: f.full, hint: f.fullHint },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Section title={f.title}>
        <p className="text-ui font-normal text-fg-muted">{f.intro}</p>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div>
            <label htmlFor="files-enabled" className="text-ui">
              {f.enable}
            </label>
            <p className="text-caption text-fg-muted">{f.enableHint}</p>
          </div>
          <Switch
            id="files-enabled"
            label={f.enable}
            checked={settings.file_tools_enabled}
            onChange={(on) => void update({ file_tools_enabled: on })}
          />
        </div>
      </Section>

      <Section title={f.permission}>
        <div role="radiogroup" aria-label={f.permission} className="flex flex-col gap-2">
          {modes.map((m) => {
            const checked = settings.file_permission === m.value;
            const danger = m.value === "full";
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => void update({ file_permission: m.value })}
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
        <p className="text-caption text-fg-muted">{f.safety}</p>
      </Section>

      <Section title={f.index}>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div className="min-w-0">
            <div className="text-ui">
              {index === null
                ? "…"
                : index.building
                  ? `${f.indexBuilding} ${formatTokens(index.count)}`
                  : index.built_at
                    ? f.indexCount(formatTokens(index.count))
                    : f.indexNever}
            </div>
            {index && index.roots.length > 0 && (
              <p className="text-caption text-fg-muted">{f.roots(index.roots.join(", "))}</p>
            )}
          </div>
          <button
            className="btn btn-secondary flex-none"
            disabled={index?.building ?? false}
            onClick={() => void api.rebuildIndex().then(() => setIndex((s) => (s ? { ...s, building: true } : s)))}
          >
            {f.rebuild}
          </button>
        </div>
        <p className="text-caption text-fg-muted">{f.skipped}</p>
      </Section>
    </div>
  );
}

// --- Data ----------------------------------------------------------------

function DataTab() {
  const reload = useChats((s) => s.reload);
  const removeAll = useChats((s) => s.removeAll);
  const hasChats = useChats((s) => s.chats.length > 0);
  const askConfirm = useUi((s) => s.askConfirm);
  const [busy, setBusy] = useState(false);
  const d = t.settings.data;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(toAppError(err).code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Row title={d.exportTitle} hint={d.exportHint}>
        <button
          className="btn btn-secondary"
          disabled={busy || !hasChats}
          onClick={() => void run(async () => void ((await api.exportAll()) && toast(d.exported)))}
        >
          {d.exportCta}
        </button>
      </Row>
      <Row title={d.importTitle} hint={d.importHint}>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const count = await api.importAll();
              if (count === null) return;
              await reload();
              toast(d.imported(count));
            })
          }
        >
          {d.importCta}
        </button>
      </Row>
      <div className="h-px bg-border" aria-hidden="true" />
      <Row title={d.deleteTitle} hint={d.deleteHint}>
        <button
          className="btn btn-secondary"
          disabled={!hasChats}
          onClick={() =>
            askConfirm({
              title: d.deleteConfirmTitle,
              message: d.deleteConfirmBody,
              confirmLabel: d.deleteConfirm,
              onConfirm: removeAll,
            })
          }
        >
          {d.deleteCta}
        </button>
      </Row>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-ui">{title}</div>
        <p className="text-caption text-fg-muted">{hint}</p>
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

// --- About ----------------------------------------------------------------

const LICENSES: [string, string][] = [
  ["Tauri", "MIT / Apache-2.0"],
  ["React", "MIT"],
  ["Radix UI", "MIT"],
  ["cmdk", "MIT"],
  ["sonner", "MIT"],
  ["react-virtuoso", "MIT"],
  ["react-markdown, remark-gfm, rehype-sanitize", "MIT"],
  ["shiki", "MIT"],
  ["zustand", "MIT"],
  ["Tailwind CSS", "MIT"],
  ["Lucide", "ISC"],
  ["Inter, JetBrains Mono", "SIL OFL 1.1"],
  ["tokio, reqwest, serde", "MIT / Apache-2.0"],
  ["rusqlite", "MIT"],
  ["SQLite", "Public Domain"],
  ["DiceBear", "MIT"],
];

function UpdatesSection() {
  const { settings, update } = useSettings();
  const { status, available, progress, check, install, showWhatsNew } = useUpdates();
  const u = t.updates;
  const message =
    status === "none"
      ? u.upToDate
      : status === "error"
        ? u.error
        : status === "available" && available
          ? u.available(releaseLabel(available))
          : status === "downloading"
            ? u.downloading
            : null;

  return (
    <Section title={u.title}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="auto-update" className="text-ui">
              {u.auto}
            </label>
            <p className="text-caption text-fg-muted">{u.autoHint}</p>
          </div>
          <Switch
            id="auto-update"
            label={u.auto}
            checked={settings.auto_update}
            onChange={(on) => void update({ auto_update: on })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {status === "available" || status === "downloading" ? (
            <button className="btn btn-primary" disabled={status === "downloading"} onClick={() => void install()}>
              {u.install}
            </button>
          ) : (
            <button className="btn btn-secondary" disabled={status === "checking"} onClick={() => void check()}>
              {status === "checking" ? u.checking : u.check}
            </button>
          )}
          {message && (
            <span className="text-caption text-fg-muted" aria-live="polite">
              {message}
            </span>
          )}
          {/* Notes of the available update, otherwise of this version. */}
          <button
            className="btn btn-ghost ml-auto text-fg-muted"
            onClick={() => void showWhatsNew(status === "available")}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            {status === "available" ? u.whatsNew : u.thisVersion}
          </button>
        </div>
        {status === "downloading" && (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label={u.downloading}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
          >
            <div
              className={`h-full rounded-full bg-coral transition-[width] ${progress === null ? "w-1/3 animate-pulse" : ""}`}
              style={progress === null ? undefined : { width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>
    </Section>
  );
}

/** One helper app on the About page: version, and an update hint with a
 *  button that opens the app (updates are done there). */
function ToolVersionRow({ name, info, loading }: { name: string; info?: ToolVersion; loading: boolean }) {
  const a = t.settings.about;
  const open = () => {
    if (!info) return;
    void api.openTool(info.tool).catch(() => toast(t.errors.generic));
  };
  return (
    <div className="flex flex-col justify-center gap-1 border-b border-border py-2.5">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-ui font-normal text-fg-muted">{name}</dt>
        <dd className="text-ui">
          {loading ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            (info?.installed ?? <span className="text-fg-subtle">{a.notInstalled}</span>)
          )}
        </dd>
      </div>
      {info?.update_available && info.latest && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
          <span className="text-caption">
            <span className="text-coral">{a.updateAvailable(info.latest)}</span>
            <span className="text-fg-muted"> · {a.updateHint(name)}</span>
          </span>
          {info.can_open && (
            <button className="btn btn-secondary h-7 text-caption" onClick={open}>
              <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
              {a.openApp(name)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AboutTab() {
  const avatarCredits = useAvatarCredits();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tools, setTools] = useState<ToolVersion[] | null>(null);
  // Starts true: the first check runs as soon as the tab opens.
  const [checking, setChecking] = useState(true);
  const a = t.settings.about;

  // Installed versions first (fast), then the update check via winget (slow).
  const load = async (refresh: boolean) => {
    try {
      setTools(await api.toolVersions(false));
      setTools(await api.toolVersions(true, refresh));
    } catch {
      // Keep what we have.
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void api
      .appInfo()
      .then(setInfo)
      .catch(() => setInfo({ version: "–", ollama_version: null }));
    let alive = true;
    void api
      .toolVersions(false)
      .then((v) => alive && setTools(v))
      .then(() => api.toolVersions(true))
      .then((v) => alive && setTools(v))
      .catch(() => undefined)
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <dl className="flex flex-col">
        <div className="flex h-10 items-center justify-between border-b border-border">
          <dt className="text-ui font-normal text-fg-muted">{a.version}</dt>
          <dd className="text-ui">{info?.version ?? <Skeleton className="h-4 w-16" />}</dd>
        </div>
        {(["ollama", "lmstudio", "docker"] as const).map((tool) => (
          <ToolVersionRow
            key={tool}
            name={a.tools[tool]}
            info={tools?.find((v) => v.tool === tool)}
            loading={tools === null}
          />
        ))}
      </dl>
      <div className="-mt-5 flex items-center justify-between gap-3">
        <span className="text-caption text-fg-subtle" aria-live="polite">
          {checking ? a.checkingTools : tools?.some((v) => v.latest) ? a.toolsChecked : ""}
        </span>
        <button
          className="btn btn-ghost h-8 text-caption text-fg-muted"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void load(true);
          }}
        >
          <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
          {a.checkTools}
        </button>
      </div>
      <p className="text-ui font-normal text-fg-muted">{a.privacy}</p>
      <UpdatesSection />
      <Section title={a.licenses}>
        <ul className="flex flex-col">
          {LICENSES.map(([name, license]) => (
            <li key={name} className="flex h-9 items-center justify-between text-caption">
              <span>{name}</span>
              <span className="text-fg-muted">{license}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={a.avatarCredits}>
        <ul className="flex flex-col">
          {avatarCredits?.map((c) => (
            <li key={c.title} className="flex min-h-9 items-center justify-between gap-4 py-1 text-caption">
              <span>
                {c.title} <span className="text-fg-muted">· {c.creator}</span>
              </span>
              <span className="flex-none text-fg-muted">{c.license}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
