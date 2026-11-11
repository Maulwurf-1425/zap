import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  /** Muted text on the right, e.g. a size. */
  hint?: string;
}

export interface SelectGroup {
  /** Small heading above the group; omit for none. */
  label?: string;
  options: SelectOption[];
}

interface SelectProps {
  id?: string;
  value: string;
  /** Flat list, or groups with headings (e.g. per engine). */
  options: SelectOption[] | SelectGroup[];
  onChange: (value: string) => void;
  /** Accessible name when no visible <label> points at `id`. */
  label?: string;
  icon?: ReactNode;
}

function isGroups(options: SelectOption[] | SelectGroup[]): options is SelectGroup[] {
  return options.length > 0 && "options" in (options[0] as object);
}

/** Dropdown in the app's look (glass popover, menu items, check mark)
 *  instead of the native, unstyled Windows list. Arrow keys, typeahead,
 *  Enter and Esc come from Radix. */
export function Select({ id, value, options, onChange, label, icon }: SelectProps) {
  const groups: SelectGroup[] = isGroups(options) ? options : [{ options }];
  const current = groups.flatMap((g) => g.options).find((o) => o.value === value);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-label={label}
          className="input flex items-center gap-2 text-left hover:bg-surface-2 data-[state=open]:border-[var(--coral-ring)] data-[state=open]:bg-surface-2"
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
          <ChevronDown
            size={16}
            strokeWidth={1.75}
            className="flex-none text-fg-muted transition-transform in-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="popover anim-pop z-[60] max-h-[min(320px,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 overflow-y-auto rounded-lg p-1.5"
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {groups.map((group, gi) => (
              <DropdownMenu.Group key={group.label ?? gi}>
                {group.label && (
                  <DropdownMenu.Label className="px-3 pt-1.5 pb-1 text-caption text-fg-subtle">
                    {group.label}
                  </DropdownMenu.Label>
                )}
                {group.options.map((o) => (
                  <DropdownMenu.RadioItem key={o.value} value={o.value} className="menu-item h-10">
                    <span className="flex w-4 flex-none justify-center">
                      <DropdownMenu.ItemIndicator>
                        <Check size={16} strokeWidth={1.75} className="text-coral" aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="flex-none text-caption text-fg-muted tabular-nums">{o.hint}</span>}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
