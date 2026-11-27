import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Cloud, ExternalLink, LoaderCircle, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Field, Section, Switch } from "./ui/Controls";
import { IconButton } from "./ui/IconButton";
import { api, type CloudConnection, type CloudPreset, type CloudTest } from "../lib/ipc";
import { openExternal } from "../lib/format";
import { t } from "../lib/i18n";
import { useModels } from "../store/models";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

const PRESETS: CloudPreset[] = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "custom",
];

/** Where each provider hands out API keys. */
const KEY_PAGES: Partial<Record<CloudPreset, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai",
};

function newId(): string {
  return crypto.randomUUID();
}

function testText(result: CloudTest): string {
  if (result.models !== null) return t.cloud.models(result.models);
  return t.cloud.errors[result.error ?? ""] ?? t.errors.generic;
}

/** Settings → Models: cloud providers with the user's API keys. */
export function CloudSection() {
  const connections = useSettings((s) => s.settings.cloud_providers);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<CloudPreset | null>(null);
  // Bumped after a key is stored, so "Key saved" is read again.
  const [keysVersion, setKeysVersion] = useState(0);
  const keysChanged = () => setKeysVersion((v) => v + 1);
  const c = t.cloud;

  useEffect(() => {
    let alive = true;
    void api
      .cloudKeyStatus()
      .then((list) => alive && setKeys(Object.fromEntries(list.map((k) => [k.id, k.has_key]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connections, keysVersion]);

  return (
    <Section title={c.section}>
      <p className="text-ui font-normal text-fg-muted">{c.intro}</p>
      <p className="flex items-start gap-2 text-caption text-fg-muted">
        <TriangleAlert
          size={14}
          strokeWidth={1.75}
          className="mt-0.5 flex-none text-[var(--warning)]"
          aria-hidden="true"
        />
        {c.privacy}
      </p>

      {connections.length > 0 && (
        <ul className="flex flex-col gap-2">
          {connections.map((conn) => (
            <ConnectionCard key={conn.id} conn={conn} hasKey={keys[conn.id] ?? false} onKeysChanged={keysChanged} />
          ))}
        </ul>
      )}

      {adding ? (
        <AddForm preset={adding} onKeysChanged={keysChanged} onDone={() => setAdding(null)} />
      ) : (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button className="btn btn-secondary w-fit">
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              {c.add}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="popover anim-pop z-[60] w-64 rounded-lg p-1.5"
            >
              {PRESETS.map((preset) => (
                <DropdownMenu.Item key={preset} className="menu-item h-10" onSelect={() => setAdding(preset)}>
                  <Cloud size={14} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
                  {c.presets[preset] ?? preset}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </Section>
  );
}

async function saveConnections(next: CloudConnection[]) {
  await useSettings.getState().update({ cloud_providers: next });
}

/** Saves the key, tests the connection and refreshes the model list. */
async function storeAndTest(id: string, key: string | null): Promise<CloudTest> {
  if (key !== null) await api.cloudSetKey(id, key);
  const result = await api.cloudTest(id);
  void useModels.getState().refresh();
  return result;
}

function AddForm({
  preset,
  onDone,
  onKeysChanged,
}: {
  preset: CloudPreset;
  onDone: () => void;
  onKeysChanged: () => void;
}) {
  const c = t.cloud;
  const custom = preset === "custom";
  const [name, setName] = useState(custom ? "" : (c.presets[preset] ?? preset));
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloudTest | null>(null);
  const keyPage = KEY_PAGES[preset];
  const valid = name.trim() !== "" && (custom ? baseUrl.trim() !== "" : key.trim() !== "");

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const conn: CloudConnection = {
      id: newId(),
      preset,
      name: name.trim(),
      base_url: custom ? baseUrl.trim() : "",
      enabled: true,
    };
    try {
      await saveConnections([...useSettings.getState().settings.cloud_providers, conn]);
      const test = await storeAndTest(conn.id, key.trim() || null);
      onKeysChanged();
      setResult(test);
      if (test.models !== null) {
        toast(`${conn.name}: ${testText(test)}`);
        onDone();
      }
    } catch {
      toast(t.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-[var(--coral-ring)] bg-surface-1 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2 text-ui">
        <Cloud size={16} strokeWidth={1.75} className="text-coral" aria-hidden="true" />
        {c.presets[preset] ?? preset}
      </div>
      {custom && (
        <>
          <Field label={c.name} htmlFor="cloud-name">
            <input
              id="cloud-name"
              className="input"
              value={name}
              maxLength={40}
              placeholder={c.namePlaceholder}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={c.baseUrl} htmlFor="cloud-url" hint={c.baseUrlHint}>
            <input
              id="cloud-url"
              className="input font-mono"
              value={baseUrl}
              placeholder="https://…/v1"
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        </>
      )}
      <Field label={custom ? c.keyOptional : c.key} htmlFor="cloud-key">
        <input
          id="cloud-key"
          type="password"
          className="input font-mono"
          value={key}
          placeholder={c.keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
          autoFocus={!custom}
        />
      </Field>
      {result && result.models === null && (
        <p className="flex items-center gap-2 text-caption text-danger">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          {testText(result)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {busy ? c.testing : c.save}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            // A connection saved by a failed test stays in the list; Cancel only closes the form.
            onDone();
          }}
        >
          {c.cancel}
        </button>
        {keyPage && (
          <button
            type="button"
            className="btn btn-ghost ml-auto text-fg-muted"
            onClick={() => void openExternal(keyPage)}
          >
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
            {c.getKey}
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectionCard({
  conn,
  hasKey,
  onKeysChanged,
}: {
  conn: CloudConnection;
  hasKey: boolean;
  onKeysChanged: () => void;
}) {
  const c = t.cloud;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloudTest | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const askConfirm = useUi((s) => s.askConfirm);

  const patch = async (p: Partial<CloudConnection>) => {
    const all = useSettings.getState().settings.cloud_providers;
    await saveConnections(all.map((x) => (x.id === conn.id ? { ...x, ...p } : x)));
    void useModels.getState().refresh();
  };

  const test = async (newKey: string | null) => {
    setBusy(true);
    try {
      setResult(await storeAndTest(conn.id, newKey));
      if (newKey !== null) {
        onKeysChanged();
        setReplacing(false);
        setKey("");
      }
    } catch {
      toast(t.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    askConfirm({
      title: c.removeTitle,
      message: c.removeBody(conn.name),
      confirmLabel: c.remove,
      onConfirm: async () => {
        await api.cloudSetKey(conn.id, null).catch(() => undefined);
        await saveConnections(useSettings.getState().settings.cloud_providers.filter((x) => x.id !== conn.id));
        void useModels.getState().refresh();
      },
    });

  const ok = result?.models !== null && result !== null;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-3">
        <Cloud size={18} strokeWidth={1.75} className="flex-none text-coral" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui">{conn.name}</div>
          <div className="flex items-center gap-1.5 text-caption text-fg-muted">
            {result ? (
              <span className={`flex items-center gap-1 ${ok ? "text-[var(--success)]" : "text-danger"}`}>
                {ok ? (
                  <Check size={12} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
                )}
                {testText(result)}
              </span>
            ) : (
              <span>{hasKey ? c.keySaved : c.keyMissing}</span>
            )}
            {conn.preset === "custom" && <span className="truncate font-mono">· {conn.base_url}</span>}
          </div>
        </div>
        <Switch label={c.enabled} checked={conn.enabled} onChange={(enabled) => void patch({ enabled })} />
        <IconButton label={c.remove} onClick={remove}>
          <Trash2 size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      {replacing ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void test(key.trim());
          }}
        >
          <input
            type="password"
            className="input h-9 min-w-48 flex-1 font-mono"
            aria-label={c.key}
            value={key}
            placeholder={c.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary h-9" disabled={!key.trim() || busy}>
            {c.save}
          </button>
          <button type="button" className="btn btn-ghost h-9" onClick={() => setReplacing(false)}>
            {c.cancel}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary h-8 px-3 text-caption" disabled={busy} onClick={() => void test(null)}>
            {busy && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
            {busy ? c.testing : c.test}
          </button>
          <button className="btn btn-ghost h-8 px-3 text-caption" onClick={() => setReplacing(true)}>
            {c.replaceKey}
          </button>
        </div>
      )}
    </li>
  );
}
