import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** Optional shortcut shown in the tooltip, e.g. "Ctrl+K". */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

/** 36 × 36 ghost icon button with an accessible label and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, side = "top", className = "", children, ...rest },
  ref,
) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button ref={ref} type="button" aria-label={label} className={`btn btn-icon ${className}`} {...rest}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          className="popover anim-pop z-[70] flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-caption"
        >
          {label}
          {shortcut && <span className="kbd">{shortcut}</span>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
});
