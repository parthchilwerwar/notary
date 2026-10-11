// Renders the markdown tree from ./markdown.ts as React elements (no HTML injection). Citation
// markers are rendered by the caller (`renderCite`), so chips can scroll to their step.
import { Fragment, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { parseMarkdown, type Block, type Inline } from "./markdown";

type Props = { text: string; renderCite: (n: number, key: string) => ReactNode; className?: string };

function inlines(nodes: readonly Inline[], renderCite: Props["renderCite"], prefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}.${i}`;
    switch (n.t) {
      case "text":
        return <Fragment key={key}>{n.v}</Fragment>;
      case "code":
        return (
          <code key={key} translate="no">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={key}>{inlines(n.c, renderCite, key)}</strong>;
      case "em":
        return <em key={key}>{inlines(n.c, renderCite, key)}</em>;
      case "cite":
        return renderCite(n.n, key);
      case "link":
        return n.href.startsWith("/app") ? (
          <Link key={key} to={n.href}>
            {inlines(n.c, renderCite, key)}
          </Link>
        ) : (
          <a key={key} href={n.href} target="_blank" rel="noreferrer noopener">
            {inlines(n.c, renderCite, key)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
    }
  });
}

function block(b: Block, i: number, renderCite: Props["renderCite"]): ReactNode {
  const key = `b${i}`;
  switch (b.t) {
    case "p":
      return <p key={key}>{inlines(b.c, renderCite, key)}</p>;
    case "h": {
      // Answers sit under the page's h1 and the message: their headings start at h3.
      const Tag = (["h3", "h4", "h5"] as const)[b.level - 1]!;
      return <Tag key={key}>{inlines(b.c, renderCite, key)}</Tag>;
    }
    case "ul":
      return (
        <ul key={key}>
          {b.items.map((item, j) => (
            <li key={j}>{inlines(item, renderCite, `${key}.${j}`)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} start={b.start}>
          {b.items.map((item, j) => (
            <li key={j}>{inlines(item, renderCite, `${key}.${j}`)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre key={key} tabIndex={0} aria-label={b.lang ? `${b.lang} code` : "Code"}>
          <code translate="no">{b.v}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{inlines(b.c, renderCite, key)}</blockquote>;
    case "hr":
      return <hr key={key} />;
  }
}

export function Markdown({ text, renderCite, className }: Props) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={className}>{blocks.map((b, i) => block(b, i, renderCite))}</div>;
}
