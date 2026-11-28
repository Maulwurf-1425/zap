import { t } from "./i18n";
import { formatCombo, shortcutFor, type SendKey, type ShortcutAction } from "./shortcuts";
import { useSettings } from "../store/settings";

/** The current combo for an action, ready to show (e.g. "Strg+N"). */
export function useShortcut(action: ShortcutAction): string {
  const combo = useSettings((s) => shortcutFor(s.settings, action));
  return formatCombo(combo, t.keys);
}

export function useSendKey(): SendKey {
  return useSettings((s) => s.settings.send_key) ?? "enter";
}
