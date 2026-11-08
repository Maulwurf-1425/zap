import logoUrl from "../assets/logo.svg";

/** Coral dots of the ZAP bolt on a 19 px grid, taken from src-tauri/icons/icon.svg
 *  (column, row). Used for the empty-state hero. */
// prettier-ignore
const BOLT_DOTS: ReadonlyArray<readonly [number, number]> = [
  [5, 0], [4, 1], [5, 1], [4, 2], [5, 2], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4],
  [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5],
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6],
  [0, 7], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7],
  [4, 8], [5, 8], [6, 8], [4, 9], [5, 9], [3, 10], [4, 10], [5, 10], [3, 11], [4, 11], [3, 12],
];

/** The ZAP bolt built from coral dots (design.md §6.9). Decorative.
 *  `intro`: dots pop in once, row by row (empty state).
 *  `loop`:  the bolt builds up top to bottom, then breaks down, forever
 *           (assistant avatar while ZAP is thinking or writing).
 *  `static`: the finished bolt, no animation (avatar of a finished reply). */
export function DotBolt({ size = 96, variant = "intro" }: { size?: number; variant?: "intro" | "loop" | "static" }) {
  const className = variant === "loop" ? "bolt-dot-loop" : variant === "intro" ? "bolt-dot" : undefined;
  const cols = 9;
  const rows = 13;
  // Loop: rows start 70 ms apart within a 1.8 s cycle (see .bolt-dot-loop).
  const step = variant === "loop" ? 70 : 28;
  return (
    <svg
      width={(size * cols) / rows}
      height={size}
      viewBox={`-0.5 -0.5 ${cols} ${rows}`}
      aria-hidden="true"
      focusable="false"
    >
      {BOLT_DOTS.map(([x, y], i) => (
        <circle
          key={i}
          className={className}
          cx={x}
          cy={y}
          r={0.39}
          fill="var(--coral)"
          style={{ animationDelay: `${y * step}ms` }}
        />
      ))}
    </svg>
  );
}

/** App icon (dot-matrix bolt) as an image. */
export function AppIcon({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`flex-none ${className}`}
    />
  );
}

export function Logo() {
  return (
    // pointer-events-none: the logo sits in a drag region and must not block it.
    <div className="pointer-events-none flex items-center gap-2 select-none">
      <AppIcon size={22} />
      <span className="text-[17px] leading-6 font-semibold tracking-[0.04em]">ZAP</span>
    </div>
  );
}

/** Plain lightning glyph for the send button (the dot icon would vanish on coral). */
export function Bolt({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path d="M13.6 2 5.4 13.2h5.8L9.9 22l8.7-12.2h-5.9L13.6 2Z" fill="currentColor" />
    </svg>
  );
}
