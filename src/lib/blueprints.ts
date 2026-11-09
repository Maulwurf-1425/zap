// New-chat blueprints: icon set and the built-in defaults.
import {
  BookOpen,
  Briefcase,
  Bug,
  Calculator,
  Code,
  FileText,
  Globe,
  Languages,
  Lightbulb,
  ListChecks,
  Mail,
  MessageSquare,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { Blueprint } from "./ipc";
import { t } from "./i18n";

/** Icons a blueprint can use, keyed by the name stored in settings. */
export const BLUEPRINT_ICONS: Record<string, LucideIcon> = {
  lightbulb: Lightbulb,
  mail: Mail,
  code: Code,
  file: FileText,
  languages: Languages,
  list: ListChecks,
  pen: PenLine,
  search: Search,
  sparkles: Sparkles,
  bug: Bug,
  calculator: Calculator,
  book: BookOpen,
  briefcase: Briefcase,
  message: MessageSquare,
  terminal: Terminal,
  globe: Globe,
};

export const FALLBACK_ICON: LucideIcon = Lightbulb;
export const MAX_BLUEPRINTS = 6;
const DEFAULT_ICONS = ["lightbulb", "mail", "code"];

/** The built-in suggestions, in the current language. */
export function defaultBlueprints(): Blueprint[] {
  return t.empty.suggestions.map(({ title, prompt }, i) => ({
    title,
    prompt,
    icon: DEFAULT_ICONS[i] ?? "lightbulb",
    send: false,
  }));
}
