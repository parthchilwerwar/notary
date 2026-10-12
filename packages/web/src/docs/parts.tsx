// Small building blocks for the /docs page: code blocks with a copy button, notes, and the
// reference tables (stacked into cards under 900px by docs.css).
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Lines that are only a shell comment (shown, muted; left out of what Copy puts on the clipboard). */
const isComment = (line: string) => /^\s*#/.test(line);

/** The text Copy writes: every non-empty, non-comment line. */
export function copyText(code: string): string {
  return code
    .split("\n")
    .filter((line) => line.trim() !== "" && !isComment(line))
    .join("\n");
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(code));
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  return (
    <div className="docs-code">
      <div className="docs-code-bar">
        <span className="docs-code-label">{label ?? "Terminal"}</span>
        <button type="button" className="docs-copy" onClick={copy} aria-label={label ? `Copy ${label}` : "Copy commands"}>
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </button>
        <span className="docs-sr" aria-live="polite">
          {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy" : ""}
        </span>
      </div>
      <pre>
        <code>
          {code.split("\n").map((line, i) => (
            <span key={i} className={isComment(line) ? "docs-code-comment" : undefined}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function Note({ title, children, tone = "info" }: { title: string; children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <aside className={`docs-note docs-note-${tone}`}>
      <p className="docs-note-title">{title}</p>
      <div>{children}</div>
    </aside>
  );
}

/** Inline code. */
export const C = ({ children }: { children: ReactNode }) => <code className="docs-inline">{children}</code>;

export type Column<Row> = { header: string; cell: (row: Row) => ReactNode; className?: string };

/** A reference table; each cell carries its header so the stacked phone layout can label it. */
export function RefTable<Row>({ caption, columns, rows, rowKey }: { caption: string; columns: Column<Row>[]; rows: Row[]; rowKey: (row: Row) => string }) {
  return (
    <table className="docs-table">
      <caption className="docs-sr">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.header} scope="col" className={c.className}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td key={c.header} data-label={c.header} className={c.className}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
