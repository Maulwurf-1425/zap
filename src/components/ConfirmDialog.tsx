import { useState } from "react";
import { Dialog } from "./ui/Dialog";
import { useUi } from "../store/ui";
import { t } from "../lib/i18n";

export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const close = useUi((s) => s.closeConfirm);
  const [busy, setBusy] = useState(false);

  const onConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.onConfirm();
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(open) => !open && close()}
      title={confirm?.title ?? ""}
      width={440}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close} autoFocus>
            {t.confirm.cancel}
          </button>
          {/* Destructive, so deliberately not the coral primary. */}
          <button className="btn btn-secondary" onClick={() => void onConfirm()} disabled={busy}>
            {confirm?.confirmLabel}
          </button>
        </>
      }
    >
      <p className="px-6 text-body text-fg-muted">{confirm?.message}</p>
    </Dialog>
  );
}
