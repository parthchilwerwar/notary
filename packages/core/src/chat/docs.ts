// fetch_doc for Notary Chat: read one documentation page from an allowlist of the docs sites Notary
// already relies on, and return its readable text.
//
// Allowlist (exact hosts, https only, default port, no credentials in the URL):
//   - derived from the contracts: the host of every claim's docUrl in src/contracts/* (today
//     docs.crustdata.com and docs.dodopayments.com)
//   - listed explicitly: the docs of the other services Notary uses — neatlogs (tracing), Entire
//     (code graph), cfo.ai (business plan) — see EXTRA_DOC_HOSTS
// Anything else is refused before any I/O. Redirects are followed by hand (max DOC_MAX_REDIRECTS),
// each hop re-checked against the allowlist: a redirect off the allowlist is never followed. Every
// fetch has a time limit (DOC_TIMEOUT_MS, combined with the caller's AbortSignal so Stop cancels it)
// and a size limit (DOC_MAX_BYTES read; DOC_TEXT_CHARS of text kept). HTML is reduced to text by
// code: scripts, styles and other non-content elements dropped, tags stripped, entities decoded,
// whitespace collapsed. Nothing here is a model.
import { allContracts } from "../contracts/index.js";

/** Docs hosts of the other services Notary uses, listed explicitly (not derivable from a contract). */
export const EXTRA_DOC_HOSTS: readonly string[] = ["docs.neatlogs.com", "docs.entire.io", "docs.cfo.ai"];

/** Hosts of the contracts' documentation URLs (claim.docUrl), lowercased and sorted. */
export function contractDocHosts(): string[] {
  const hosts = new Set<string>();
  for (const e of allContracts) {
    try {
      const u = new URL(e.claim.docUrl);
      if (u.protocol === "https:") hosts.add(u.hostname.toLowerCase());
    } catch {
      // a claim without a parseable docUrl adds nothing
    }
  }
  return [...hosts].sort();
}

/** The full fetch_doc allowlist. */
export const DOC_HOSTS: readonly string[] = [...new Set([...contractDocHosts(), ...EXTRA_DOC_HOSTS])].sort();

export const DOC_TIMEOUT_MS = 10_000;
export const DOC_MAX_BYTES = 2_000_000;
export const DOC_TEXT_CHARS = 12_000;
export const DOC_MAX_REDIRECTS = 3;

export type DocCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Is this URL allowed? (https, allowlisted exact host, default port, no user info.) */
export function checkDocUrl(raw: string, hosts: readonly string[] = DOC_HOSTS): DocCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${JSON.stringify(raw.slice(0, 200))}` };
  }
  if (u.protocol !== "https:") return { ok: false, reason: `only https:// URLs are fetched (got ${u.protocol}//)` };
  if (u.username || u.password) return { ok: false, reason: "URLs with credentials are refused" };
  if (u.port && u.port !== "443") return { ok: false, reason: `non-default port ${u.port} refused` };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!hosts.includes(host)) return { ok: false, reason: `${host} is not on the docs allowlist (${hosts.join(", ")})` };
  u.hash = "";
  return { ok: true, url: u };
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, body: string) => {
    const b = body.toLowerCase();
    if (b in NAMED_ENTITIES) return NAMED_ENTITIES[b]!;
    const cp = b.startsWith("#x") ? Number.parseInt(b.slice(2), 16) : b.startsWith("#") ? Number.parseInt(b.slice(1), 10) : NaN;
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Readable text of an HTML page (title first when present). Plain text and markdown pass through collapsed. */
export function extractText(body: string, contentType: string): { title?: string; text: string } {
  if (!/html|xml/i.test(contentType) && !/^\s*<(!doctype|html)/i.test(body)) {
    return { text: body.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : undefined;
  const text = decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ...(title ? { title } : {}), text };
}

export type DocResult =
  | { ok: true; url: string; finalUrl: string; title?: string; text: string; truncated: boolean; bytes: number; status: number }
  | { ok: false; kind: "refused" | "error"; url: string; reason: string };

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; capped: boolean }> {
  if (!res.body) return { text: "", bytes: 0, capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      capped = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(all), bytes, capped };
}

export interface FetchDocOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  hosts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
}

/** Fetch one allowlisted docs page and extract its text. Never throws except when `signal` aborts. */
export async function fetchDoc(raw: string, opts: FetchDocOptions = {}): Promise<DocResult> {
  const hosts = opts.hosts ?? DOC_HOSTS;
  const first = checkDocUrl(raw, hosts);
  if (!first.ok) return { ok: false, kind: "refused", url: raw, reason: first.reason };
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DOC_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let url = first.url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "text/html, text/markdown, text/plain;q=0.9, */*;q=0.1", "user-agent": "notary-chat/1 (+fetch_doc)" },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, kind: "error", url: raw, reason: `HTTP ${res.status} redirect without a Location header` };
        if (hop >= DOC_MAX_REDIRECTS) return { ok: false, kind: "error", url: raw, reason: `more than ${DOC_MAX_REDIRECTS} redirects` };
        let next: string;
        try {
          next = new URL(loc, url).toString();
        } catch {
          return { ok: false, kind: "error", url: raw, reason: `HTTP ${res.status} redirect to an invalid Location` };
        }
        const hopCheck = checkDocUrl(next, hosts);
        if (!hopCheck.ok) return { ok: false, kind: "refused", url: raw, reason: `redirected off the allowlist, not followed: ${hopCheck.reason}` };
        url = hopCheck.url;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, kind: "error", url: raw, reason: `HTTP ${res.status} from ${url.hostname}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType && !/text\/|json|xml|markdown/i.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, kind: "error", url: raw, reason: `not a text page (content-type ${contentType.split(";")[0]})` };
      }
      const body = await readCapped(res, opts.maxBytes ?? DOC_MAX_BYTES);
      const { title, text } = extractText(body.text, contentType);
      const max = opts.maxChars ?? DOC_TEXT_CHARS;
      const truncated = body.capped || text.length > max;
      return {
        ok: true,
        url: raw,
        finalUrl: url.toString(),
        ...(title ? { title } : {}),
        text: text.length > max ? `${text.slice(0, max)}…` : text,
        truncated,
        bytes: body.bytes,
        status: res.status,
      };
    }
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException("The operation was aborted", "AbortError");
    if (timeout.aborted) return { ok: false, kind: "error", url: raw, reason: `timed out after ${Math.round((opts.timeoutMs ?? DOC_TIMEOUT_MS) / 1000)} s` };
    return { ok: false, kind: "error", url: raw, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
