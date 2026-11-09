import { Sparkles } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Markdown } from "./Markdown";
import { useUpdates } from "../store/updates";
import { notesFor } from "../lib/changelog";
import { getLanguage, t } from "../lib/i18n";

/** Release notes: before installing an update, and once after updating. */
export function WhatsNewDialog() {
  const whatsNew = useUpdates((s) => s.whatsNew);
  const close = useUpdates((s) => s.closeWhatsNew);
  const install = useUpdates((s) => s.install);
  const downloading = useUpdates((s) => s.status === "downloading");
  const u = t.updates;
  const notes = whatsNew?.notes;
  const text = notes ? notesFor(notes, getLanguage()) : "";

  return (
    <Dialog
      open={whatsNew !== null}
      onOpenChange={(open) => !open && close()}
      title={whatsNew?.pending ? u.whatsNewIn(notes?.version ?? "") : u.newIn(notes?.version ?? "")}
      width={560}
      footer={
        whatsNew?.pending ? (
          <>
            <button className="btn btn-ghost" onClick={close}>
              {u.later}
            </button>
            <button className="btn btn-primary" disabled={downloading} onClick={() => void install()} autoFocus>
              {u.install}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={close} autoFocus>
            {u.gotIt}
          </button>
        )
      }
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-2">
        {notes?.name && (
          <div className="flex items-center gap-2 text-coral">
            <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-ui font-medium">{notes.name}</span>
          </div>
        )}
        <div className="markdown">
          <Markdown content={text || u.noNotes} />
        </div>
      </div>
    </Dialog>
  );
}
