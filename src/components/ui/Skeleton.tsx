import type { CSSProperties } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** Placeholder rows for the chat list while it loads. */
export function ChatListSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-1 pt-2" aria-hidden="true">
      {[72, 56, 84, 64, 48].map((w, i) => (
        <Skeleton key={i} className="h-[var(--chat-item-h)] rounded-md" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/** Placeholder conversation while messages load. */
export function MessagesSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[var(--content-w)] flex-col gap-8 px-6 pt-8" aria-hidden="true">
      <Skeleton className="ml-auto h-11 w-[45%] rounded-lg" />
      <div className="flex gap-3">
        <Skeleton className="size-6 flex-none rounded-full" />
        <div className="flex flex-1 flex-col gap-2.5">
          <Skeleton className="h-4 w-[92%]" />
          <Skeleton className="h-4 w-[84%]" />
          <Skeleton className="h-4 w-[60%]" />
        </div>
      </div>
      <Skeleton className="ml-auto h-11 w-[30%] rounded-lg" />
    </div>
  );
}
