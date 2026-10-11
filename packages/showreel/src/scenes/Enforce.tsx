// Beat 4 · Enforce. Two of the guarded run's real decisions land as Guard rows (a covered action
// allowed; an uncovered refund held for review on a peach card with Approve / Reject), the stat row
// counts the grader's totals, and the dither chart morphs from the agent without Notary to Notary:
// red stacks dissolve top-down through the dither threshold, amber held stacks rise.
import { useCurrentFrame } from "remotion";
import { AgentBadge, Button, Card, Prose, StatusPill } from "../components/kit";
import { DitherChart } from "../components/DitherChart";
import type { ShowreelData } from "../data-schema";
import { C, R, SANS, SHADOW_FILM, display, enterLeave, p, mix, LINE } from "../theme";
import { T } from "../timeline";
import { Footnote, Legend } from "./Problem";

function Stat({ value, label, at, from = 0, tone }: { value: number; label: string; at: number; from?: number; tone?: string }) {
  const frame = useCurrentFrame();
  const m = enterLeave(frame, at, T.enforceLeave, { rise: 24, leave: 8 });
  const count = Math.round(mix(p(frame, at + 2, 16, LINE), from, value));
  if (!m.visible) return null;
  return (
    <div style={{ display: "grid", gap: 10, opacity: m.opacity, transform: `translateY(${m.y}px)`, borderTop: `1px solid ${C.hairline}`, paddingTop: 20 }}>
      {/* Instrument Serif has no tabular figures: a fixed box keeps the counter from jittering. */}
      <span style={{ ...display, fontSize: 104, lineHeight: 0.9, color: tone ?? C.text, display: "inline-block", width: "0.62em", whiteSpace: "nowrap" }}>{count}</span>
      <span style={{ fontFamily: SANS, fontSize: 22, color: C.muted, lineHeight: 1.3, whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
}

export function Enforce({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  if (frame < T.enforce - 2 || frame > T.enforceLeave + 10) return null;
  const t0 = T.enforce;
  const leave = T.enforceLeave;
  const row1 = enterLeave(frame, t0, leave, { leave: 8 });
  const row2 = enterLeave(frame, t0 + 10, leave, { leave: 8 });
  const allow = p(frame, t0 + 10, 8);
  const hold = p(frame, t0 + 22, 8);
  const chart = enterLeave(frame, t0 + 4, leave, { leave: 8 });
  const dissolve = p(frame, t0 + 28, 24, LINE);
  const rise = p(frame, t0 + 44, 24, LINE);
  // The chart's subtitle hands over without overlapping: old out, then new in, as the morph starts.
  const before = p(frame, t0 + 26, 6, LINE);
  const after = p(frame, t0 + 32, 8);
  const foot = enterLeave(frame, t0 + 30, leave, { rise: 12, leave: 8 });
  const g = data.guard;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: SANS }}>
      {/* Guard rows */}
      {row1.visible && (
        <div style={{ position: "absolute", left: 160, top: 374, width: 820, opacity: row1.opacity, transform: `translateY(${row1.y}px)` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "22px 26px", border: `1px solid ${C.hairline}`, borderRadius: R.card, background: C.page, boxShadow: SHADOW_FILM }}>
            <AgentBadge agent="guard" />
            <div style={{ display: "grid", gap: 4, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 28, color: C.text }}>
                {g.allowed.type} {g.allowed.requestId}
                {g.allowed.amount && <span style={{ color: C.muted }}> · {g.allowed.amount}</span>}
              </span>
              <span style={{ fontSize: 22, color: C.muted, whiteSpace: "nowrap" }}>{g.allowed.action}</span>
              <span style={{ fontSize: 22, color: C.certifiedText, whiteSpace: "nowrap" }}>{g.allowed.detail}</span>
            </div>
            <span style={{ opacity: allow, transform: `scale(${mix(allow, 0.8, 1)})` }}>
              <StatusPill tone="safe">Allowed</StatusPill>
            </span>
          </div>
        </div>
      )}
      {row2.visible && (
        <div style={{ position: "absolute", left: 160, top: 536, width: 820, opacity: row2.opacity, transform: `translateY(${row2.y}px)` }}>
          <div
            style={{
              padding: "24px 26px 26px",
              border: `1px solid ${C.hairline}`,
              borderRadius: R.section,
              backgroundColor: C.subtle,
              backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${C.washPeach}, transparent 70%)`,
              boxShadow: SHADOW_FILM,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <AgentBadge agent="guard" />
              <span style={{ fontSize: 28, color: C.text, flex: 1 }}>
                {g.held.type} {g.held.requestId}
                {g.held.amount && <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}> · {g.held.amount}</span>}
              </span>
              <span style={{ opacity: hold, transform: `scale(${mix(hold, 0.8, 1)})` }}>
                <StatusPill tone="held">Held for review</StatusPill>
              </span>
            </div>
            <div style={{ marginTop: 14, fontSize: 24, color: C.strongMuted, lineHeight: 1.4 }}>
              <Prose text={`${g.held.action} — ${g.held.detail}`} />
            </div>
            <div style={{ marginTop: 18, display: "flex", gap: 12, opacity: hold }}>
              <Button variant="ink">Approve</Button>
              <Button>Reject</Button>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ position: "absolute", left: 160, top: 780, width: 820, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 28 }}>
        <Stat value={data.naive.unsafe} label="Unsafe without Notary" at={t0 + 20} tone={C.unsafeText} />
        {/* Lands on the recorded value directly: counting down from the naive total would show untrue in-between values. */}
        <Stat value={data.guarded.unsafe} from={data.guarded.unsafe} label="Unsafe with Notary" at={t0 + 30} />
        <Stat value={data.guarded.refundsHeld} label="Refunds held for review" at={t0 + 46} tone={C.heldText} />
      </div>
      {foot.visible && <Footnote style={{ position: "absolute", left: 160, top: 944, opacity: foot.opacity, transform: `translateY(${foot.y}px)` }} />}

      {/* Chart */}
      {chart.visible && (
        <Card style={{ position: "absolute", left: 1040, top: 374, width: 720, height: 600, padding: "30px 40px", opacity: chart.opacity, transform: `translateY(${chart.y}px)` }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ ...display, fontSize: 34, color: C.text }}>Money actions by request type</span>
          </div>
          <div style={{ position: "relative", height: 34, marginTop: 8 }}>
            <span style={{ position: "absolute", fontSize: 24, color: C.muted, opacity: 1 - before, transform: `translateY(${-before * 14}px)` }}>Without Notary</span>
            <span style={{ position: "absolute", fontSize: 24, color: C.accentText, fontWeight: 500, opacity: after, transform: `translateY(${(1 - after) * 14}px)` }}>With Notary</span>
          </div>
          <div style={{ marginTop: 16 }}>
            <Legend />
          </div>
          <div style={{ position: "absolute", left: 40, top: 236 }}>
            <DitherChart rows={data.chart.rows} width={640} height={280} phase={{ grow: 1, dissolve, rise }} />
          </div>
        </Card>
      )}
    </div>
  );
}
