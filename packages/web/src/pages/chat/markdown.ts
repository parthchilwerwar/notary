// A small, safe markdown parser for chat answers: paragraphs, headings, bullet and numbered lists,
// fenced code, block quotes, inline code, bold, italic, links and [n] citation markers. It returns
// a tree that Markdown.tsx renders as React elements — no HTML string is ever produced or
// injected, raw HTML in the source stays literal text, and only http(s) and in-app /app/ links
// become links. No dependency: answers use a handful of constructs, and a parser this size is
// easier to audit than a general one. Streaming-safe: re-parsing a partial answer never throws (an
// unclosed fence is a code block to the end, an unclosed ** stays literal).

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "cite"; n: number };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "code"; lang?: string; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

/** An href that may be rendered: absolute http(s), or an in-app path under /app/. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(h)) return h;
  if (/^\/app(\/|\?|$)/.test(h) && !h.includes("//")) return h;
  return undefined;
}

// Earliest-match inline tokenizer. Order inside the alternation only breaks ties at one index.
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\[(\d{1,3})\](?!\()|\[([^\]\n]+)\]\(([^)\s]+)\)|(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  for (let guard = 0; rest && guard < 10_000; guard++) {
    const m = INLINE.exec(rest);
    if (!m) {
      text(rest);
      break;
    }
    let start = m.index;
    let token: Inline;
    if (m[1] !== undefined) token = { t: "code", v: m[2]!.replace(/^ (.*) $/, "$1") };
    else if (m[3] !== undefined) token = { t: "strong", c: parseInline(m[3]) };
    else if (m[4] !== undefined) token = { t: "cite", n: Number(m[4]) };
    else if (m[5] !== undefined) {
      const href = safeHref(m[6]!);
      token = href ? { t: "link", href, c: parseInline(m[5]) } : { t: "text", v: m[5] };
    } else if (m[8] !== undefined) {
      start += m[7]!.length;
      token = { t: "em", c: parseInline(m[8]) };
    } else {
      start += m[9]!.length;
      token = { t: "em", c: parseInline(m[10]!) };
    }
    text(rest.slice(0, start));
    if (token.t === "text") text(token.v);
    else out.push(token);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const UL = /^\s{0,3}[-*+]\s+(.*)$/;
const OL = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s{0,3}${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: "code", ...(fence[2] ? { lang: fence[2] } : {}), v: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: "h", level: heading[1]!.length as 1 | 2 | 3, c: parseInline(heading[2]!) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ t: "quote", c: parseInline(body.join("\n")) });
      continue;
    }
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul || ol) {
      flush();
      const re = ul ? UL : OL;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (m) items.push(ul ? m[1]! : m[2]!);
        else if (items.length && /^\s{2,}\S/.test(lines[i]!)) items[items.length - 1] += `\n${lines[i]!.trim()}`;
        else break;
        i++;
      }
      i--;
      const parsed = items.map((s) => parseInline(s));
      blocks.push(ul ? { t: "ul", items: parsed } : { t: "ol", start: Number(ol![1]), items: parsed });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Plain text of an answer (citation markers kept as [n]), for Copy. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "cite" ? `[${n.n}]` : inlineText(n.c)))
    .join("");
}
