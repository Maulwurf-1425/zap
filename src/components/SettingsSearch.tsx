import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { t } from "../lib/i18n";
import { searchSettings, type SettingsEntry } from "../lib/settingsIndex";

/** Start page of the settings: one search box, results jump to the setting. */
export function SettingsSearch({
  tabLabel,
  onPick,
}: {
  tabLabel: (tab: SettingsEntry["tab"]) => string;
  onPick: (entry: SettingsEntry) => void;
}) {
  const s = t.settings.search;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchSettings(query, tabLabel).slice(0, 12), [query, tabLabel]);

  // The dialog focuses its first button on open; the search box should win.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="mx-auto flex max-w-[520px] flex-col gap-4 pt-6">
      <div className="composer flex h-12 items-center gap-3 rounded-xl border border-border bg-[var(--bg)] px-4">
        <Search size={18} strokeWidth={1.75} className="flex-none text-fg-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={s.label}
          placeholder={s.placeholder}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="settings-results"
          aria-activedescendant={results.length ? `settings-result-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-subtle"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (results.length)
                setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
            } else if (e.key === "Enter") {
              const hit = results[active];
              if (hit) onPick(hit);
            }
          }}
        />
      </div>

      {!query.trim() ? (
        <p className="px-1 text-center text-caption text-fg-muted">{s.hint}</p>
      ) : results.length === 0 ? (
        <p className="px-1 text-center text-caption text-fg-muted">{s.none(query.trim())}</p>
      ) : (
        <ul id="settings-results" role="listbox" aria-label={s.label} className="flex flex-col gap-0.5">
          {results.map((r, i) => (
            <li
              key={`${r.tab}|${r.label}`}
              id={`settings-result-${i}`}
              role="option"
              aria-selected={i === active}
              className={`menu-item h-auto cursor-pointer flex-col items-start gap-0 py-2 ${i === active ? "bg-surface-2" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(r)}
            >
              <span className="text-ui text-fg">{r.label}</span>
              <span className="flex items-center gap-1 text-caption text-fg-muted">
                {tabLabel(r.tab)}
                {r.section && r.section !== tabLabel(r.tab) && (
                  <>
                    <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
                    {r.section}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
