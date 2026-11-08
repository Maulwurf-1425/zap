import { ArrowUpRight, Code, Lightbulb, Mail, type LucideIcon } from "lucide-react";
import { DotBolt } from "./Brand";
import { t } from "../lib/i18n";

const ICONS: LucideIcon[] = [Lightbulb, Mail, Code];

/** Dot grid faded with a radial mask (design.md §2.2). Decorative. */
export function DotField() {
  return <div className="dot-field" aria-hidden="true" />;
}

/** Empty state (design.md §6.9): coral-dot bolt, "Los geht's.", three
 *  suggestion cards over the dot grid. */
export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 pb-6">
      <DotField />
      <div className="relative w-full max-w-[var(--content-w)] text-center motion-safe:animate-[fade-in_260ms_var(--ease-enter)]">
        <div className="mb-6 flex justify-center">
          <DotBolt size={88} />
        </div>
        <h1 className="text-display">{t.empty.title}</h1>
        <p className="mt-4 text-body text-fg-muted">{t.empty.subline}</p>

        {/* Same height, left-aligned rows: icon tile, label, hover arrow. */}
        <div className="mt-12 grid auto-rows-fr grid-cols-3 gap-3">
          {t.empty.suggestions.map(({ title, prompt }, i) => {
            const Icon = ICONS[i] ?? Lightbulb;
            return (
              <button
                key={title}
                className="glass group flex h-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-ui transition-[transform,border-color,background-color] duration-[var(--dur-hover)] ease-[var(--ease-state)] hover:-translate-y-0.5 hover:border-border-strong hover:bg-glass-strong motion-reduce:hover:translate-y-0"
                onClick={() => onPick(prompt)}
              >
                <span className="flex size-9 flex-none items-center justify-center rounded-md bg-surface-2 text-fg-muted transition-colors group-hover:text-fg">
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 leading-5">{title}</span>
                <ArrowUpRight
                  size={16}
                  strokeWidth={1.75}
                  className="flex-none text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
