import { memo, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlight, highlightSync, resolveLang } from "../lib/highlight";
import { copyText } from "../lib/format";
import { t } from "../lib/i18n";

/** Code block: language label, "Copy" with check feedback, horizontal
 *  scroll. Colors come from the theme's --shiki-* tokens (Dark and Light). */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(() => highlightSync(code, lang));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!resolveLang(lang)) {
      setHtml(null);
      return;
    }
    const sync = highlightSync(code, lang);
    if (sync !== null) {
      setHtml(sync);
      return;
    }
    let alive = true;
    void highlight(code, lang)
      .then((out) => alive && setHtml(out))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="code-block overflow-hidden rounded-md border border-border bg-code">
      <div
        className="flex h-9 items-center justify-between pr-1.5 pl-4 text-caption text-fg-muted"
        style={{ background: "var(--code-header)" }}
      >
        <span className="font-mono lowercase">{lang || "text"}</span>
        <button
          className="btn btn-ghost h-7 gap-1.5 rounded-sm px-2 text-caption"
          onClick={async () => setCopied(await copyText(code))}
          aria-label={copied ? t.code.copied : t.code.copyLabel}
        >
          {copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
          <span aria-live="polite">{copied ? t.code.copied : t.code.copy}</span>
        </button>
      </div>
      {html ? (
        <div className="selectable" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="selectable">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});
