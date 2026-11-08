import type { ReactNode } from "react";
import * as RSlider from "@radix-ui/react-slider";
import * as RSwitch from "@radix-ui/react-switch";

/** Labeled settings row. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-ui">
        {label}
      </label>
      {children}
      {hint && <p className="text-caption text-fg-muted">{hint}</p>}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-caption font-medium tracking-[0.04em] text-fg-subtle uppercase">{title}</h3>
      {children}
    </section>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}

/** Radio group styled as a segmented control (arrow keys move the choice). */
export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-1 rounded-md border border-border bg-surface-1 p-1"
      onKeyDown={(e) => {
        const dir =
          e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const next = options[(idx + dir + options.length) % options.length];
        if (next) {
          onChange(next.value);
          const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
          buttons[(idx + dir + options.length) % options.length]?.focus();
        }
      }}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`btn h-9 gap-2 rounded-sm px-4 ${checked ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

export function Slider({ label, value, min, max, step, valueText, onChange, onCommit }: SliderProps) {
  return (
    <RSlider.Root
      className="relative flex h-9 w-full touch-none items-center select-none"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => v !== undefined && onChange(v)}
      onValueCommit={([v]) => v !== undefined && onCommit?.(v)}
    >
      <RSlider.Track className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <RSlider.Range className="absolute h-full rounded-full bg-coral" />
      </RSlider.Track>
      <RSlider.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-5 rounded-full border-2 border-coral bg-snow shadow-card transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]"
      />
    </RSlider.Root>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-6 w-11 flex-none rounded-full border border-border bg-surface-3 transition-colors data-[state=checked]:border-coral data-[state=checked]:bg-coral"
    >
      <RSwitch.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-snow shadow-card transition-transform duration-[var(--dur-hover)] data-[state=checked]:translate-x-[22px]" />
    </RSwitch.Root>
  );
}
