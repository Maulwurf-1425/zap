import { useState } from "react";
import * as RD from "@radix-ui/react-dialog";
import { CircleCheck } from "lucide-react";
import { DotBolt } from "./Brand";
import { EngineCard } from "./EngineCard";
import { PullRow } from "./PullRow";
import { focusComposer } from "../lib/actions";
import { useProviders } from "../store/providers";
import { CURATED_MODELS, hasOllamaModel, useModels } from "../store/models";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { formatBytes } from "../lib/format";
import { t } from "../lib/i18n";
import { PROVIDERS } from "../lib/ipc";

const STEPS = 3;
const STARTER_MODELS = ["llama3.2:3b", "gemma2:2b", "qwen2.5:7b"];

/** First-run onboarding: 1) engines (Ollama / LM Studio), 2) starter model,
 *  3) done. Skippable, and reachable again from Settings → General. */
export function Onboarding() {
  const open = useUi((s) => s.onboardingOpen);
  const setOpen = useUi((s) => s.setOnboardingOpen);
  const update = useSettings((s) => s.update);
  const [step, setStep] = useState(0);

  const finish = () => {
    setOpen(false);
    setStep(0);
    void update({ onboarding_done: true });
    focusComposer();
  };

  return (
    <RD.Root open={open} onOpenChange={(o) => !o && finish()}>
      <RD.Portal>
        <RD.Overlay
          className="anim-fade fixed inset-0 z-50 backdrop-blur-[6px]"
          style={{ background: "var(--scrim)" }}
        />
        <RD.Content
          className="glass anim-dialog fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-48px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 rounded-xl p-8"
          style={{ background: "var(--surface-popover)" }}
          aria-label={t.onboarding.label}
        >
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-muted">{t.onboarding.step(step + 1, STEPS)}</span>
            <button className="btn btn-ghost h-9" onClick={finish}>
              {t.onboarding.skip}
            </button>
          </div>

          <div className="min-h-[260px]">
            {step === 0 && <EngineStep />}
            {step === 1 && <ModelStep />}
            {step === 2 && (
              <div className="flex flex-col items-center gap-5 pt-4 text-center">
                <DotBolt size={72} />
                <RD.Title className="text-h1">{t.onboarding.doneTitle}</RD.Title>
                <RD.Description className="text-body text-fg-muted">{t.onboarding.doneBody}</RD.Description>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex gap-1.5" aria-hidden="true">
              {Array.from({ length: STEPS }, (_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-[var(--dur-pop)] ${i === step ? "w-6 bg-coral" : "w-1.5 bg-surface-3"}`}
                />
              ))}
            </div>
            <div className="flex gap-3">
              {step > 0 && (
                <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>
                  {t.onboarding.back}
                </button>
              )}
              {step < STEPS - 1 ? (
                <button className="btn btn-secondary h-11 px-5" onClick={() => setStep(step + 1)} autoFocus>
                  {t.onboarding.next}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={finish} autoFocus>
                  {t.onboarding.finish}
                </button>
              )}
            </div>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function EngineStep() {
  return (
    <div className="flex flex-col gap-5">
      <RD.Title className="text-h2">{t.onboarding.engineTitle}</RD.Title>
      <RD.Description className="text-ui font-normal text-fg-muted">{t.onboarding.engineIntro}</RD.Description>
      <div className="flex flex-col gap-2">
        {PROVIDERS.map((kind) => (
          <EngineCard key={kind} kind={kind} />
        ))}
      </div>
    </div>
  );
}

function ModelStep() {
  const installed = useModels((s) => s.installed);
  const pulls = useModels((s) => s.pulls);
  const pull = useModels((s) => s.pull);
  const statuses = useProviders((s) => s.statuses);
  const ollamaOn = statuses.ollama !== "disabled";
  const ollamaRunning = statuses.ollama === "running";
  const starters = CURATED_MODELS.filter((m) => STARTER_MODELS.includes(m.name));

  if (!ollamaOn) {
    return (
      <div className="flex flex-col gap-5">
        <RD.Title className="text-h2">{t.onboarding.modelTitle}</RD.Title>
        <RD.Description className="text-ui font-normal text-fg-muted">
          {installed.length > 0 ? t.onboarding.modelInstalled : t.onboarding.modelLmstudioOnly}
        </RD.Description>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <RD.Title className="text-h2">{t.onboarding.modelTitle}</RD.Title>
      <RD.Description className="text-ui font-normal text-fg-muted">
        {installed.length > 0 ? t.onboarding.modelInstalled : t.onboarding.modelIntro}
      </RD.Description>
      <ul className="flex flex-col gap-2">
        {starters.map((m) => {
          const progress = pulls[m.name];
          const isInstalled = hasOllamaModel(installed, m.name);
          const running = ollamaRunning;
          return (
            <li key={m.name} className="rounded-lg border border-border bg-surface-1 px-4 py-3">
              {progress ? (
                <PullRow pull={progress} />
              ) : (
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-ui">{m.name}</span>
                      <span className="rounded-full border border-border px-2 text-caption text-fg-muted">
                        {m.tier === "small" ? t.onboarding.small : t.onboarding.medium}
                      </span>
                    </div>
                    <div className="text-caption text-fg-muted">
                      ~{formatBytes(m.approxBytes)} · {t.models.ramHint(m.ramGb)}
                    </div>
                  </div>
                  {isInstalled ? (
                    <CircleCheck
                      size={20}
                      strokeWidth={1.75}
                      className="text-fg-muted"
                      aria-label={t.models.installed}
                    />
                  ) : (
                    <button className="btn btn-secondary h-9" disabled={!running} onClick={() => void pull(m.name)}>
                      {t.models.load}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
