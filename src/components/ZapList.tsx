import { CalendarClock, Plus } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { ZapBadge } from "./ZapView";
import { t } from "../lib/i18n";
import { blankZap, scheduleText, useZaps } from "../store/zaps";

/** Sidebar section: the user's ZAPs, with a pulse on running ones. */
export function ZapList({ onNavigate }: { onNavigate: () => void }) {
  const zaps = useZaps((s) => s.zaps);
  const openId = useZaps((s) => s.openId);
  // Ids of ZAPs with a run in progress.
  const runningKey = useZaps((s) =>
    Object.values(s.live)
      .map((l) => l.run.zap_id)
      .sort()
      .join("|"),
  );
  const running = new Set(runningKey.split("|"));
  const { open, edit } = useZaps.getState();

  return (
    <section className="mb-3" aria-label={t.zaps.title}>
      <div className="group/head flex items-center justify-between pr-1 pl-3">
        <h3 className="pt-1 pb-1.5 text-caption text-fg-subtle">{t.zaps.title}</h3>
        <IconButton
          label={t.zaps.add}
          className="size-7 text-fg-subtle opacity-60 group-hover/head:opacity-100 focus-visible:opacity-100"
          onClick={() => edit(blankZap())}
        >
          <Plus size={14} strokeWidth={1.75} />
        </IconButton>
      </div>
      {zaps.length === 0 ? (
        <button
          type="button"
          className="w-full rounded-md px-3 py-1.5 text-left text-caption text-fg-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => edit(blankZap())}
        >
          {t.zaps.empty}
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {zaps.map((zap) => {
            const active = zap.id === openId;
            const busy = running.has(zap.id);
            return (
              <li key={zap.id}>
                <button
                  type="button"
                  className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-ui transition-colors ${
                    active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    open(zap.id);
                    onNavigate();
                  }}
                >
                  <ZapBadge zap={zap} size={22} />
                  <span className="min-w-0 flex-1 truncate">{zap.name}</span>
                  {!busy && zap.schedule.kind !== "off" && (
                    <span title={scheduleText(zap) ?? undefined} className="flex flex-none text-fg-subtle">
                      <CalendarClock size={13} strokeWidth={1.75} aria-label={t.zaps.scheduled} />
                    </span>
                  )}
                  {busy && (
                    <span className="flex flex-none items-center gap-1.5 text-caption text-coral">
                      <span className="size-1.5 animate-pulse rounded-full bg-coral motion-reduce:animate-none" />
                      {t.zaps.running}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
