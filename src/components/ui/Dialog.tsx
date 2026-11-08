import type { ReactNode } from "react";
import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { t } from "../../lib/i18n";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Visually hidden title (still announced). */
  hideTitle?: boolean;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Fixed height for tabbed dialogs so switching tabs never jumps. */
  height?: number;
  showClose?: boolean;
}

/** Glass modal (design.md §6.8): scrim + blur, scale 0.96 → 1. Radix handles
 *  focus trap, Esc and restoring focus. */
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  children,
  footer,
  width = 520,
  height,
  showClose = true,
}: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay
          className="anim-fade fixed inset-0 z-50 backdrop-blur-[6px]"
          style={{ background: "var(--scrim)" }}
        />
        <RD.Content
          className="popover anim-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-96px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl"
          style={{ maxWidth: width, height }}
        >
          <div className={`flex items-center justify-between gap-4 px-6 pt-5 pb-3 ${hideTitle ? "sr-only" : ""}`}>
            <RD.Title className="text-h2">{title}</RD.Title>
            {showClose && !hideTitle && (
              <RD.Close className="btn btn-icon -mr-2" aria-label={t.window.close}>
                <X size={20} strokeWidth={1.75} />
              </RD.Close>
            )}
          </div>
          <RD.Description className="sr-only">{description ?? title}</RD.Description>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          {footer && <div className="flex justify-end gap-3 px-6 pt-2 pb-6">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
