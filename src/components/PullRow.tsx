import { RotateCcw, TriangleAlert, X } from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { useModels, type PullState } from "../store/models";
import { downloadErrorMessage, pullStatusLabel, t } from "../lib/i18n";
import { formatSpeed, percent } from "../lib/format";

/** Download progress (design.md §6.6): name, 6 px coral bar, % + MB/s, cancel. */
export function PullRow({ pull }: { pull: PullState }) {
  const cancel = useModels((s) => s.cancelPull);
  const retry = useModels((s) => s.pull);
  const dismiss = useModels((s) => s.dismissPull);
  const pct = percent(pull.completed, pull.total);

  if (pull.error) {
    return (
      <div className="flex items-start gap-3 py-2" role="alert">
        <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 flex-none text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui">{pull.name}</div>
          <p className="text-caption text-fg-muted">{downloadErrorMessage(pull.error)}</p>
        </div>
        <IconButton
          label={t.models.retryDownload(pull.name)}
          onClick={() => {
            dismiss(pull.name);
            void retry(pull.name);
          }}
        >
          <RotateCcw size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={t.models.dismiss} onClick={() => dismiss(pull.name)}>
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
    );
  }

  const speed = formatSpeed(pull.speedBps);
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="truncate text-ui">{pull.name}</span>
          <span className="flex-none text-caption text-fg-muted tabular-nums">
            {pull.total > 0 ? `${pct} %` : pullStatusLabel(pull.status)}
            {speed && ` · ${speed}`}
          </span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label={t.models.progressLabel(pull.name)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="progress-fill" style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
      </div>
      <IconButton
        label={t.models.cancelDownload(pull.name)}
        className="flex-none"
        onClick={() => void cancel(pull.name)}
      >
        <X size={16} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}
