import { isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { toast } from "sonner";
import { CodeBlock } from "./CodeBlock";
import { openExternal } from "../lib/format";
import { t } from "../lib/i18n";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

// GitHub-style sanitize schema; keep `language-*` classes for highlighting.
// Raw HTML is never parsed (no rehype-raw), sanitizing is defense in depth.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-[\w+#-]+$/]],
  },
};

const components: Components = {
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    const className = isValidElement(child) ? (child.props.className ?? "") : "";
    const lang = /language-([\w+#-]+)/.exec(className)?.[1] ?? "";
    const code = textOf(isValidElement(child) ? child.props.children : children).replace(/\n$/, "");
    return <CodeBlock code={code} lang={lang} />;
  },
  // Links always open in the default browser, never inside the app.
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        rel="noreferrer"
        onClick={async (e) => {
          e.preventDefault();
          if (!href || !(await openExternal(href))) toast(t.chat.linkFailed);
        }}
      >
        {children}
      </a>
    );
  },
  // No remote images (CSP + local-only promise): show the alt text instead.
  img({ alt }) {
    return <span className="text-fg-muted">{t.chat.image(alt ?? "")}</span>;
  },
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeSanitize, schema] as [typeof rehypeSanitize, typeof schema]];

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});
