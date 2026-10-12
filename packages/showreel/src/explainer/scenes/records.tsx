// Records rendered straight from assets.json: the trace waterfall (neatlogs spans), incident rows,
// Entire checkpoints, the coverage terminal, certificates and the economics card. These draw only
// what the data holds; each view names the file it was read from.
import type { CSSProperties, ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { BrowserFrame, Seal } from "@web/ui";
import { C, MONO, SANS, display, mix, p } from "../../theme";
import type { Incident, Span, Trace } from "../schema";
import { Panel, Pill, type Tone } from "../kit";

/** A rendered (not recorded) view in the same BrowserFrame as the clips, its source on the tag. */
export function DataFrame({ title, source, children, width = 1440 }: { title: string; source: string; children: ReactNode; width?: number }) {
  return (
    <div style={{ width: 1280, transform: `scale(${width / 1280})`, transformOrigin: "0 0" }}>
      <BrowserFrame title={title} tag={source}>
        <div style={{ position: "relative", width: 1280, height: 720, overflow: "hidden", background: C.subtle }}>{children}</div>
      </BrowserFrame>
    </div>
  );
}

const resolutionTone = (i: Incident): Tone => (i.resolution.status === "resolved" ? "safe" : i.resolution.action === "belief_abstained" ? "held" : "neutral");
// The dashboard's own wording (Incidents page).
const resolutionLabel = (i: Incident) =>
  i.resolution.status === "resolved" ? "Resolved — Certified only within the narrowed scope" : i.resolution.action === "belief_abstained" ? "Open — Not certified (too little evidence)" : "Open — No action yet";

export function IncidentRow({ incident: i, compact = false }: { incident: Incident; compact?: boolean }) {
  return (
    <div style={{ background: C.page, border: `1px solid ${C.hairline}`, borderRadius: 14, padding: compact ? "12px 16px" : "16px 20px", fontFamily: SANS }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Pill tone={i.kind === "checker_anomaly" ? "unsafe" : "accent"} size={13}>
          {i.kind === "checker_anomaly" ? "Checker anomaly" : "Adversary narrowed"}
        </Pill>
        <span style={{ fontFamily: MONO, fontSize: 14, color: C.text }}>{i.claimId}</span>
        {i.expected !== null && i.observed !== null && (
          <span style={{ fontSize: 14, color: C.muted }}>
            docs {i.expected} · API <b style={{ color: C.unsafeText }}>{i.observed}</b>
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          <Pill tone={resolutionTone(i)} size={13}>
            {resolutionLabel(i)}
          </Pill>
        </span>
      </div>
      {!compact && <div style={{ marginTop: 8, fontSize: 14, color: C.strongMuted, lineHeight: 1.45 }}>{i.resolution.summary}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------- trace waterfall

type Row = { kind: "span"; span: Span; depth: number } | { kind: "group"; name: string; count: number; depth: number; startMs: number; endMs: number; note: string };

/** Spans in tree order (children by start time); `collapse` names fold into one "× n" row each. */
export function traceRows(trace: Trace, collapse: string[]): Row[] {
  const byParent = new Map<string | null, Span[]>();
  const ids = new Set(trace.spans.map((s) => s.id));
  const root = trace.spans.find((s) => s.parentId === null && s.origin === "api") ?? trace.spans[0]!;
  for (const s of trace.spans) {
    if (s === root) continue;
    // A receipt-only span whose parent the API lacks hangs under the root (drawn, labelled "receipt").
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : root.id;
    byParent.set(parent, [...(byParent.get(parent) ?? []), s]);
  }
  const rows: Row[] = [{ kind: "span", span: root, depth: 0 }];
  const subtreeCount = (s: Span): number => 1 + (byParent.get(s.id) ?? []).reduce((n, c) => n + subtreeCount(c), 0);
  const walk = (id: string, depth: number) => {
    const kids = (byParent.get(id) ?? []).sort((a, b) => a.startMs - b.startMs);
    const done = new Set<string>();
    for (const k of kids) {
      if (collapse.includes(k.name)) {
        if (done.has(k.name)) continue;
        done.add(k.name);
        const same = kids.filter((x) => x.name === k.name);
        const inner = same.reduce((n, x) => n + subtreeCount(x) - 1, 0);
        rows.push({ kind: "group", name: k.name, count: same.length, depth, startMs: Math.min(...same.map((x) => x.startMs)), endMs: Math.max(...same.map((x) => x.endMs)), note: inner ? `+ ${inner} child spans` : "" });
        continue;
      }
      rows.push({ kind: "span", span: k, depth });
      walk(k.id, depth + 1);
    }
  };
  walk(root.id, 1);
  return rows;
}

const kindColor = (k: string | null, name: string) => {
  const kind = (k ?? "").toLowerCase();
  if (kind === "workflow") return "#C3CAD8";
  if (kind === "tool_call" || kind === "tool" || name === "notary.probe") return C.accent;
  if (kind === "evaluator" || name === "notary.adversary") return "#7C5CD6";
  if (kind === "llm" || kind === "chain") return "#A78BFA";
  return "#98A1B3";
};

export function TraceView({
  trace,
  collapse,
  highlight = [],
  dim = 0,
  reveal = 1,
  style,
  title,
}: {
  trace: Trace;
  collapse: string[];
  highlight?: string[];
  dim?: number;
  reveal?: number;
  style?: CSSProperties;
  title: string;
}) {
  const rows = traceRows(trace, collapse);
  const t1 = Math.max(...trace.spans.filter((s) => s.origin === "api").map((s) => s.endMs));
  const t0 = Math.min(...trace.spans.map((s) => s.startMs));
  const rowH = Math.min(46, Math.floor(640 / rows.length));
  const NAME_W = 600;
  const BAR_W = 760;
  const x = (ms: number) => ((ms - t0) / (t1 - t0)) * BAR_W;
  const m = trace.meta;
  return (
    <Panel style={{ position: "absolute", left: 120, top: 112, width: 1680, height: 820, overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 18, padding: "22px 30px 14px", borderBottom: `1px solid ${C.hairline}` }}>
        <span style={{ ...display, fontSize: 40, color: C.text }}>{title}</span>
        <span style={{ fontFamily: MONO, fontSize: 19, color: C.muted }}>{trace.traceId.slice(0, 8)}…</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          {m.spanCount !== null && <Pill size={16}>{m.spanCount} spans</Pill>}
          {m.errorCount !== null && <Pill size={16} tone={m.errorCount ? "unsafe" : "safe"}>{m.errorCount} errors</Pill>}
          {m.detections !== null && <Pill size={16}>{m.detections} detections</Pill>}
        </span>
      </div>
      <div style={{ padding: "6px 30px 0", fontFamily: SANS, fontSize: 15, color: C.muted }}>Rendered from {trace.source}</div>
      <div style={{ position: "relative", padding: "10px 30px 0" }}>
        {rows.map((r, i) => {
          const shown = p(reveal * rows.length, i, 1.2);
          const id = r.kind === "span" ? r.span.id : `group-${r.name}`;
          const hi = highlight.includes(id);
          const name = r.kind === "span" ? r.span.name : `${r.name} × ${r.count}`;
          const start = r.kind === "span" ? r.span.startMs : r.startMs;
          const end = r.kind === "span" ? r.span.endMs : r.endMs;
          const color = r.kind === "span" ? kindColor(r.span.kind, r.span.name) : kindColor(null, r.name);
          const isLog = r.kind === "span" && (r.span.kind ?? "").toLowerCase() === "log";
          const receipt = r.kind === "span" && r.span.origin === "receipt";
          return (
            <div
              key={id}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                height: rowH,
                opacity: shown * (hi || !dim ? 1 : mix(dim, 1, 0.32)),
                background: hi ? C.accentSoft : "transparent",
                borderRadius: 10,
                outline: hi ? `2px solid ${C.accent}` : "none",
                margin: "0 -10px",
                padding: "0 10px",
              }}
            >
              <div style={{ width: NAME_W, display: "flex", alignItems: "center", gap: 10, paddingLeft: r.depth * 22, fontFamily: MONO, fontSize: 18, color: receipt ? C.muted : C.text, whiteSpace: "nowrap", overflow: "hidden" }}>
                <span style={{ width: 9, height: 9, borderRadius: isLog ? 1 : 3, transform: isLog ? "rotate(45deg)" : undefined, background: color, flexShrink: 0 }} />
                <span>{name}</span>
                {r.kind === "group" && r.note && <span style={{ fontFamily: SANS, fontSize: 14, color: C.faint }}>{r.note}</span>}
                {r.kind === "span" && r.span.agent && (
                  <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, padding: "2px 9px", borderRadius: 999, border: `1px solid ${C.hairline}`, background: C.subtle, color: C.strongMuted }}>{r.span.agent}</span>
                )}
                {r.kind === "span" && r.span.kind?.toLowerCase() === "llm" && r.span.model && r.span.name !== r.span.model && <span style={{ fontFamily: SANS, fontSize: 14, color: C.muted }}>{r.span.model}</span>}
                {receipt && <Pill size={12} tone="held">local receipt · not in API</Pill>}
              </div>
              <div style={{ position: "relative", width: BAR_W, height: rowH }}>
                {isLog ? (
                  <div style={{ position: "absolute", left: x(start) - 7, top: rowH / 2 - 7, width: 14, height: 14, transform: "rotate(45deg)", background: color, borderRadius: 2 }} />
                ) : (
                  <div style={{ position: "absolute", left: x(start), top: rowH / 2 - 7, width: Math.max(4, x(end) - x(start)), height: 14, borderRadius: 4, background: color, opacity: receipt ? 0.55 : 0.9, border: receipt ? `1.5px dashed ${C.heldText}` : undefined }} />
                )}
              </div>
              <div style={{ width: 150, textAlign: "right", fontFamily: SANS, fontSize: 14, fontWeight: 600, color: receipt ? C.heldText : C.certifiedText, letterSpacing: "0.04em" }}>
                {r.kind === "span" ? (receipt ? (r.span.status ?? "").toUpperCase() : (r.span.status ?? "").toUpperCase()) : "SUCCESS ×" + r.count}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------- Entire + terminal

export function CheckpointList({ checkpoints, reveal, source }: { checkpoints: { id: string; at: string; agent: string; model: string | null; commit: string; message: string }[]; reveal: number; source: string }) {
  return (
    <Panel style={{ width: 1100, padding: "26px 32px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
        <span style={{ ...display, fontSize: 44, color: C.text }}>Entire checkpoints</span>
        <Pill size={16} tone="accent">
          {checkpoints.length} checkpoints
        </Pill>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 15, color: C.muted, marginTop: 4 }}>Read from {source}</div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {checkpoints.map((c, i) => {
          const k = p(reveal * checkpoints.length, i, 1.4);
          return (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "150px 140px 110px 1fr", alignItems: "center", gap: 14, padding: "10px 14px", borderRadius: 12, background: C.subtle, opacity: k, transform: `translateY(${(1 - k) * 12}px)`, fontFamily: SANS, fontSize: 17 }}>
              <span style={{ fontFamily: MONO, fontSize: 15, color: C.muted }}>{c.at.slice(5, 16).replace("T", " ")} UTC</span>
              <span style={{ fontWeight: 600, color: C.text }}>{c.agent}</span>
              <span style={{ fontFamily: MONO, fontSize: 15, color: C.accentText }}>{c.commit.slice(0, 7)}</span>
              <span style={{ color: C.strongMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.message}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** A terminal that types `command`, then streams `lines`; the view follows the newest line. */
export function Terminal({ command, lines, typed, streamed, highlight, rows = 20, width = 1180, title }: { command: string; lines: string[]; typed: number; streamed: number; highlight?: (l: string) => boolean; rows?: number; width?: number; title: string }) {
  const frame = useCurrentFrame();
  const shownCmd = command.slice(0, Math.round(typed * command.length));
  const n = Math.round(streamed * lines.length);
  const visible = lines.slice(0, n);
  const tail = visible.slice(Math.max(0, visible.length - rows));
  return (
    <div style={{ width, borderRadius: 18, background: "#0E1422", boxShadow: "0 30px 80px rgb(11 15 25 / 0.35)", overflow: "hidden", border: "1px solid #1C2538" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px", background: "#151D2E" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <span style={{ marginLeft: 12, fontFamily: SANS, fontSize: 15, color: "#8A96AD" }}>{title}</span>
      </div>
      <div style={{ padding: "16px 22px 20px", fontFamily: MONO, fontSize: 16, lineHeight: "25px", color: "#D5DCEA", height: rows * 25 + 60 }}>
        <div style={{ whiteSpace: "pre", overflow: "hidden" }}>
          <span style={{ color: "#6EE7B7" }}>$ </span>
          {shownCmd}
          {streamed === 0 && Math.floor(frame / 15) % 2 === 0 && <span style={{ background: "#D5DCEA" }}> </span>}
        </div>
        {tail.map((l, i) => {
          const hi = highlight?.(l);
          return (
            <div key={visible.length - tail.length + i} style={{ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", color: hi ? "#6EE7B7" : /^\S/.test(l) ? "#FFFFFF" : "#AEB8CC", fontWeight: hi ? 700 : 400, background: hi ? "rgb(110 231 183 / 0.12)" : "transparent" }}>
              {l || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- certificates

export function CertTile({ c, appear }: { c: { id: string; tool: string; claimId: string; status: string; verdict: string; scope: string; evidence: number; sha256: string; adversaryVerdict: string | null }; appear: number }) {
  return (
    <div style={{ opacity: appear, transform: `translateY(${(1 - appear) * 18}px) scale(${mix(appear, 0.96, 1)})` }}>
      <div style={{ background: C.page, border: `1px solid ${C.hairline}`, borderRadius: 16, padding: "16px 18px", height: 220, fontFamily: SANS, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted }}>{c.tool} certificate</span>
          <span style={{ marginLeft: "auto" }}>
            <Pill tone={c.status === "active" ? "safe" : "neutral"} size={12}>
              {c.status === "active" ? "Certified" : c.status}
            </Pill>
          </span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 14, color: C.text, wordBreak: "break-all" }}>{c.claimId}</div>
        <div style={{ fontSize: 13, color: C.strongMuted, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>{c.scope}</div>
        <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: C.muted }}>
          <Seal sha256={c.sha256} />
          <span>{c.evidence} cited probes</span>
          {c.adversaryVerdict && <Pill size={12} tone="accent">Adversary: {c.adversaryVerdict}</Pill>}
        </div>
      </div>
    </div>
  );
}
