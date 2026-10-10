/**
 * neatlogs trace links (DECISIONS #69): a trace id becomes a clickable neatlogs URL only when a
 * template derived from a REAL trace URL exists. Nothing here ever invents a URL format.
 *
 * Template source, first match wins:
 *   1. env NEATLOGS_TRACE_URL_TEMPLATE
 *   2. packages/core/config/neatlogs.json {traceUrlTemplate, derivedFrom: {exampleTraceId, derivedAt}},
 *      written by `notary trace-link --example <url> --trace-id <id>`
 *   3. none: no links; bundles keep trace ids / local spans.jsonl receipts.
 *
 * A template holds exactly one token: `{traceId}` (32 lowercase hex) or `{traceIdDashed}` (the same
 * id as 8-4-4-4-12), whichever form the example URL used. Even with a template, a trace id is linked
 * only if its span was exported to neatlogs (this process opened it through the SDK, or a
 * runs/<runId>/spans.jsonl record says `exported: true`): locally generated ids never reached
 * neatlogs, so a link to them would be invented.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exportedTraceIdsInProcess } from "./index.js";

export const TRACE_TEMPLATE_ENV = "NEATLOGS_TRACE_URL_TEMPLATE";
export const NEATLOGS_CONFIG_PATH = fileURLToPath(new URL("../../config/neatlogs.json", import.meta.url));

const TOKENS = ["{traceId}", "{traceIdDashed}"] as const;
type Token = (typeof TOKENS)[number];

export const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
/** Query parameter name parts that may carry credentials; a template must never store one. */
const SECRET_PARAM_PARTS = new Set(["token", "key", "secret", "sig", "signature", "auth", "authorization", "password", "passwd", "session", "credential", "credentials", "cookie", "jwt", "code"]);

function mayCarryCredential(name: string): boolean {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return parts.some((p) => SECRET_PARAM_PARTS.has(p));
}

function dashed(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Indexes of `needle` in `hay` (case-insensitive) not glued to more hex digits on either side. */
function occurrences(hay: string, needle: string): number[] {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const out: number[] = [];
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + 1)) out.push(i);
  return out;
}

function isHex(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9a-f]/i.test(ch);
}

function checkUrlShape(url: URL, what: string): void {
  if (url.protocol !== "https:") throw new Error(`${what} must be an https URL`);
  if (url.username || url.password) throw new Error(`${what} must not contain credentials`);
  for (const name of url.searchParams.keys()) {
    if (mayCarryCredential(name)) throw new Error(`${what} has a query parameter that may carry a credential (${name}); remove it and try again`);
  }
}

/**
 * Turn a trace URL copied from the neatlogs UI into a template by locating `traceId` in it.
 * Refuses when the id is not a 32-hex trace id, is absent, or appears more than once. Everything
 * else in the URL (path, other query parameters, fragment) is kept verbatim.
 */
export function deriveTraceLinkTemplate(exampleUrl: string, traceId: string): string {
  const id = traceId.trim().toLowerCase();
  if (!TRACE_ID_RE.test(id)) throw new Error(`trace id must be 32 hex characters, got ${JSON.stringify(traceId)}`);
  const raw = exampleUrl.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`example is not a URL: ${JSON.stringify(exampleUrl)}`);
  }
  checkUrlShape(url, "example URL");

  const plain = occurrences(raw, id).map((at) => ({ at, len: id.length, token: "{traceId}" as Token }));
  const withDashes = occurrences(raw, dashed(id)).map((at) => ({ at, len: 36, token: "{traceIdDashed}" as Token }));
  const hits = [...plain, ...withDashes];
  if (hits.length === 0) throw new Error(`trace id ${id} does not appear in the example URL; copy the URL of that exact trace`);
  if (hits.length > 1) throw new Error(`trace id ${id} appears ${hits.length} times in the example URL; cannot tell which one to template`);
  const hit = hits[0]!;
  if (isHex(raw[hit.at - 1]) || isHex(raw[hit.at + hit.len])) {
    throw new Error(`trace id ${id} is part of a longer hex string in the example URL; cannot template it`);
  }
  const template = raw.slice(0, hit.at) + hit.token + raw.slice(hit.at + hit.len);
  return validateTraceLinkTemplate(template);
}

/** Throws unless `template` is an https URL with exactly one trace-id token and no other braces. */
export function validateTraceLinkTemplate(template: string): string {
  const t = template.trim();
  const count = TOKENS.reduce((n, tok) => n + t.split(tok).length - 1, 0);
  if (count !== 1) throw new Error(`trace link template must contain exactly one of ${TOKENS.join(" / ")} (found ${count})`);
  const filled = fill(t, "0".repeat(32));
  if (/[{}]/.test(filled)) throw new Error("trace link template has an unknown {placeholder}");
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    throw new Error(`trace link template is not a URL: ${JSON.stringify(template)}`);
  }
  checkUrlShape(url, "trace link template");
  return t;
}

function fill(template: string, id: string): string {
  return template.replace("{traceIdDashed}", dashed(id)).replace("{traceId}", id);
}

/** The neatlogs URL of `traceId`, or undefined with no template or a non-trace id. Never guesses. */
export function traceLinkFor(traceId: string, template?: string): string | undefined {
  if (!template) return undefined;
  const id = traceId.trim().toLowerCase();
  if (!TRACE_ID_RE.test(id)) return undefined;
  return fill(template, id);
}

// ------------------------------------------------------------------ config

export const NeatlogsConfigSchema = z
  .object({
    traceUrlTemplate: z.string().refine((t) => {
      try {
        validateTraceLinkTemplate(t);
        return true;
      } catch {
        return false;
      }
    }, "invalid trace link template"),
    derivedFrom: z.object({ exampleTraceId: z.string().regex(TRACE_ID_RE), derivedAt: z.iso.datetime() }).strict(),
  })
  .strict();
export type NeatlogsConfig = z.infer<typeof NeatlogsConfigSchema>;

export type TemplateSource = { template?: string; source: "env" | "config" | "none"; problem?: string; derivedAt?: string };

/**
 * Resolve the trace link template: env, then the committed config file, else none. An invalid
 * template is reported in `problem` and treated as none (no links), never "fixed up".
 */
export function resolveTraceLinkTemplate(opts: { env?: NodeJS.ProcessEnv; configPath?: string } = {}): TemplateSource {
  const env = opts.env ?? process.env;
  const fromEnv = (env[TRACE_TEMPLATE_ENV] ?? "").trim();
  if (fromEnv) {
    try {
      return { template: validateTraceLinkTemplate(fromEnv), source: "env" };
    } catch (err) {
      return { source: "none", problem: `${TRACE_TEMPLATE_ENV}: ${(err as Error).message}` };
    }
  }
  const path = opts.configPath ?? NEATLOGS_CONFIG_PATH;
  if (!existsSync(path)) return { source: "none" };
  try {
    const cfg = NeatlogsConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return { template: cfg.traceUrlTemplate, source: "config", derivedAt: cfg.derivedFrom.derivedAt };
  } catch (err) {
    return { source: "none", problem: `${path}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

/** `notary trace-link`: derive the template from a real trace URL and write config/neatlogs.json. */
export function writeNeatlogsConfig(
  exampleUrl: string,
  traceId: string,
  opts: { configPath?: string; now?: () => Date } = {},
): { config: NeatlogsConfig; path: string } {
  const traceUrlTemplate = deriveTraceLinkTemplate(exampleUrl, traceId);
  const config = NeatlogsConfigSchema.parse({
    traceUrlTemplate,
    derivedFrom: { exampleTraceId: traceId.trim().toLowerCase(), derivedAt: (opts.now ?? (() => new Date()))().toISOString() },
  });
  const path = opts.configPath ?? NEATLOGS_CONFIG_PATH;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, path };
}

// ------------------------------------------------------------------ exported traces

/** Trace ids known to have reached neatlogs: opened through the SDK in this process, or marked exported in runs/<id>/spans.jsonl. */
export function exportedTraceIds(runsDir?: string): Set<string> {
  const out = new Set(exportedTraceIdsInProcess());
  if (!runsDir || !existsSync(runsDir)) return out;
  let dirs: string[];
  try {
    dirs = readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const path = join(runsDir, d, "spans.jsonl");
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"exported":true')) continue;
      try {
        const rec = JSON.parse(line) as { traceId?: unknown; exported?: unknown };
        if (rec.exported === true && typeof rec.traceId === "string") out.add(rec.traceId.toLowerCase());
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

/**
 * A bundle's `traceLinks`: for each trace id, its neatlogs URL when a template exists AND the trace
 * was exported; otherwise the existing fallback value (e.g. a local spans.jsonl receipt), if any.
 * With no template the result is exactly `fallback` (current behavior).
 */
export function bundleTraceLinks(opts: {
  traceIds?: Iterable<string>;
  fallback?: Record<string, string>;
  runsDir?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  template?: TemplateSource;
}): Record<string, string> {
  const fallback = opts.fallback ?? {};
  const { template } = opts.template ?? resolveTraceLinkTemplate({ ...(opts.env ? { env: opts.env } : {}), ...(opts.configPath ? { configPath: opts.configPath } : {}) });
  if (!template) return { ...fallback };
  const exported = exportedTraceIds(opts.runsDir);
  const out: Record<string, string> = {};
  const ids = [...new Set([...Object.keys(fallback), ...(opts.traceIds ?? [])])].filter(Boolean).sort();
  for (const id of ids) {
    const url = exported.has(id.toLowerCase()) ? traceLinkFor(id, template) : undefined;
    const value = url ?? fallback[id];
    if (value !== undefined) out[id] = value;
  }
  return out;
}
