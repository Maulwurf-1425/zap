import { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FileText, Image as ImageIcon, Paperclip, TriangleAlert, X } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { ACCEPT_IMAGES, ACCEPT_TEXT, type Attachment } from "../lib/attachments";
import { formatBytes } from "../lib/format";
import { t } from "../lib/i18n";

/** Paperclip menu: documents work with every model, images only with vision
 *  models (the entry is greyed out otherwise). */
export function AttachMenu({
  vision,
  disabled,
  onFiles,
}: {
  vision: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const docsRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<HTMLInputElement>(null);

  const pick = (input: HTMLInputElement | null) => {
    // Let the menu close first so focus returns before the OS dialog opens.
    window.setTimeout(() => input?.click(), 0);
  };
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) onFiles(files);
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <IconButton label={t.attach.button} className="size-8 rounded-full" disabled={disabled}>
            <Paperclip size={16} strokeWidth={1.75} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={8}
            className="popover anim-pop z-50 w-72 rounded-md p-1"
          >
            <DropdownMenu.Item className="menu-item h-auto py-2" onSelect={() => pick(docsRef.current)}>
              <FileText size={16} strokeWidth={1.75} className="flex-none" />
              <span className="flex flex-col">
                <span>{t.attach.documents}</span>
                <span className="text-caption font-normal text-fg-muted">{t.attach.documentsHint}</span>
              </span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item h-auto py-2"
              disabled={!vision}
              onSelect={() => pick(imagesRef.current)}
            >
              <ImageIcon size={16} strokeWidth={1.75} className="flex-none" />
              <span className="flex flex-col">
                <span>{t.attach.images}</span>
                <span className="text-caption font-normal text-fg-muted">
                  {vision ? t.attach.imagesHint : t.attach.needsVision}
                </span>
              </span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <input ref={docsRef} type="file" multiple accept={ACCEPT_TEXT} className="hidden" onChange={onChange} />
      <input ref={imagesRef} type="file" multiple accept={ACCEPT_IMAGES} className="hidden" onChange={onChange} />
    </>
  );
}

/** One attachment as a chip: thumbnail or file icon, name and size. */
export function AttachmentChip({
  attachment,
  blocked = false,
  onRemove,
}: {
  attachment: Attachment;
  /** An image the selected model can't see. */
  blocked?: boolean;
  onRemove?: () => void;
}) {
  const isImage = attachment.kind === "image";
  return (
    <div
      className={`group/chip relative flex h-12 max-w-[220px] items-center gap-2.5 rounded-md border bg-surface-2 py-1.5 pr-3 pl-1.5 ${
        blocked ? "border-[var(--danger)] opacity-60" : "border-border"
      }`}
      title={blocked ? t.attach.noVision : attachment.name}
    >
      {isImage ? (
        <img src={attachment.data} alt="" className="size-9 flex-none rounded-sm object-cover" draggable={false} />
      ) : (
        <span className="flex size-9 flex-none items-center justify-center rounded-sm bg-surface-3 text-fg-muted">
          <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-caption font-medium">{attachment.name}</span>
        <span className="flex items-center gap-1 text-caption text-fg-muted">
          {blocked && <TriangleAlert size={12} strokeWidth={1.75} className="text-danger" aria-hidden="true" />}
          {formatBytes(attachment.size)}
        </span>
      </span>
      {onRemove && (
        <button
          type="button"
          className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-border bg-popover text-fg-muted opacity-0 shadow-card transition-opacity group-hover/chip:opacity-100 hover:text-fg focus-visible:opacity-100"
          aria-label={t.attach.remove(attachment.name)}
          onClick={onRemove}
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/** Attachments of a sent message: image previews and file chips. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter((a) => a.kind === "image");
  // Pages read from links show as cards on the reply instead.
  const files = attachments.filter((a) => a.kind === "text" && !a.url);
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-2" aria-label={t.attach.label}>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            <img
              key={a.id}
              src={a.data}
              alt={a.name}
              title={a.name}
              className="max-h-56 max-w-[280px] rounded-lg border border-border object-cover"
              draggable={false}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((a) => (
            <AttachmentChip key={a.id} attachment={a} />
          ))}
        </div>
      )}
    </div>
  );
}
