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
  Monitor,
  Moon,
  Package,
  Palette,
  SlidersHorizontal,
  Sun,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Field, Section, Segmented, Slider, Switch } from "./ui/Controls";
import { IconButton } from "./ui/IconButton";
import { Skeleton } from "./ui/Skeleton";
import { PullRow } from "./PullRow";
import { Markdown } from "./Markdown";
import { useSettings } from "../store/settings";
import { useUpdates } from "../store/updates";
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
} from "../lib/ipc";
import type { Language } from "../lib/i18n";
import { FONT_MAX, FONT_MIN } from "../lib/theme";
import { formatBytes, formatTokens, openExternal } from "../lib/format";
import { engineName, errorMessage, t } from "../lib/i18n";

// A function, not a constant: labels must follow the active language.
const tabs = (): { id: SettingsTab; label: string; icon: typeof Palette }[] => [
  { id: "general", label: t.settings.tabs.general, icon: SlidersHorizontal },
  { id: "appearance", label: t.settings.tabs.appearance, icon: Palette },
  { id: "models", label: t.settings.tabs.models, icon: Package },
  { id: "chat", label: t.settings.tabs.chat, icon: MessageSquare },
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
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg bg-surface-1 px-6 py-5">
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
      <Section title={a.fontSize}>
        <div className="flex items-center gap-4">
          <Slider
            label={a.fontSize}
            min={FONT_MIN}
            max={FONT_MAX}
            step={1}
            value={settings.font_size}
            valueText={`${settings.font_size} px`}
            onChange={(font_size) => void update({ font_size }, false)}
            onCommit={(font_size) => void update({ font_size })}
          />
          <span className="w-12 flex-none text-right text-caption text-fg-muted tabular-nums">
            {settings.font_size} px
          </span>
        </div>
        <div className="markdown rounded-md border border-border px-4 py-3">
          <Markdown content={a.preview} />
        </div>
      </Section>
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
        <select
          id="default-model"
          className="input"
          value={settings.default_model ?? ""}
          onChange={(e) => void update({ default_model: e.target.value || null })}
        >
          <option value="" className="bg-popover">
            {c.defaultModelAuto}
          </option>
          {installed.map((m) => (
            <option key={m.name} value={m.name} className="bg-popover">
              {m.name}
            </option>
          ))}
        </select>
      </Field>
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
];

function UpdatesSection() {
  const { settings, update } = useSettings();
  const { status, version, progress, check, install } = useUpdates();
  const u = t.updates;
  const message =
    status === "none"
      ? u.upToDate
      : status === "error"
        ? u.error
        : status === "available" && version
          ? u.available(version)
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

function AboutTab() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const lmstudio = useProviders((s) => s.statuses.lmstudio);
  const a = t.settings.about;

  useEffect(() => {
    void api
      .appInfo()
      .then(setInfo)
      .catch(() => setInfo({ version: "–", ollama_version: null }));
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <dl className="flex flex-col">
        {[
          [a.version, info?.version],
          [a.ollamaVersion, info ? (info.ollama_version ?? a.unreachable) : undefined],
          [a.lmstudioStatus, t.engines.status[lmstudio]],
        ].map(([label, value]) => (
          <div key={label} className="flex h-10 items-center justify-between border-b border-border">
            <dt className="text-ui font-normal text-fg-muted">{label}</dt>
            <dd className="text-ui">{value ?? <Skeleton className="h-4 w-16" />}</dd>
          </div>
        ))}
      </dl>
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
    </div>
  );
}
