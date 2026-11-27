// Models grouped for pickers: local engines first, then one group per cloud
// provider the user added.
import { PROVIDERS, type ModelInfo } from "./ipc";
import { engineName, t } from "./i18n";

export interface ModelGroup {
  key: string;
  label: string;
  cloud: boolean;
  models: ModelInfo[];
}

export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const local: ModelGroup[] = PROVIDERS.map((kind) => ({
    key: kind,
    label: engineName(kind),
    cloud: false,
    models: models.filter((m) => m.provider === kind),
  }));
  const bySource = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (m.provider !== "cloud") continue;
    const source = m.source ?? t.cloud.title;
    bySource.set(source, [...(bySource.get(source) ?? []), m]);
  }
  const cloud: ModelGroup[] = [...bySource].map(([source, list]) => ({
    key: `cloud:${source}`,
    label: `${source} · ${t.cloud.badge}`,
    cloud: true,
    models: list,
  }));
  return [...local, ...cloud].filter((g) => g.models.length > 0);
}
