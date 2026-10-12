// The dither chart for the Enforce beat, drawn with the web's own DitherCanvas / DitherSwatch and the
// fills the landing chart used when the film was cut (allowed solid accent, unsafe red dither, held
// amber dither, 1.0 → 0.35). One column per request type morphs from the run without Notary to the run
// with it: what Notary does not execute un-reveals row by row from the top (revealFromY), then the
// held stacks rise row by row from the base, each 3-px row on the shared Bayer grid.
import { useCurrentFrame } from "remotion";
import { Card } from "@web/ui";
import { DitherCanvas, DitherSwatch } from "@web/components/brand/DitherCanvas";
import type { DitherFill } from "@web/components/brand/dither";
import type { ShowreelData } from "../data-schema";
import { C, SANS, display, p, mix, IN, LINE, OUT } from "../theme";
import { chartState } from "./chart-state";

const FILLS: Record<"allowed" | "unsafe" | "held", DitherFill> = {
  allowed: { kind: "solid", color: "var(--accent)" },
  unsafe: { kind: "dither", color: "var(--status-unsafe)", base: 1, top: 0.35 },
  held: { kind: "dither", color: "var(--status-held)", base: 1, top: 0.35 },
};

type Row = ShowreelData["chart"]["rows"][number];
type Counts = Row["naive"];
const parts = (c: Counts) => ({ allowed: c.executed - c.unsafe, unsafe: c.unsafe, held: c.held });
const total = (c: Counts) => c.executed + c.held;

function niceTop(max: number) {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : 5;
  return { step, top: Math.max(step, Math.ceil(max / step) * step) };
}

export function ChartCard({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  const { enter, leave, dissolve, rise, withLabel: after } = chartState(frame);
  if (enter <= 0 || leave >= 1) return null;
  const rows = data.chart.rows;
  const { step, top } = niceTop(Math.max(1, ...rows.flatMap((r) => [total(r.naive), total(r.guarded)])));
  const W = 560;
  const H = 300;
  const groupW = W / rows.length;
  const colW = 54;
  const colX = (i: number) => Math.round((groupW * i + (groupW - colW) / 2) / 3) * 3;
  const unit = H / top;
  return (
    <div
      style={{
        position: "absolute",
        left: 1236,
        top: 250,
        width: 660,
        opacity: enter * (1 - leave),
        transform: `perspective(1800px) translate3d(${(1 - enter) * 120 + leave * 160}px, ${(1 - enter) * 20}px, 0) rotateY(${(1 - enter) * -14}deg)`,
        fontFamily: SANS,
      }}
    >
      <Card padding="lg" style={{ boxShadow: "0 2px 4px rgb(11 15 25 / 0.05), 0 30px 70px rgb(47 106 235 / 0.16)" }}>
        <div style={{ ...display, fontSize: 36, color: C.text }}>Money actions by request type</div>
        <div style={{ position: "relative", height: 34, marginTop: 6, fontSize: 24 }}>
          <span style={{ position: "absolute", color: C.muted, opacity: 1 - after }} data-film-label="without">Without Notary</span>
          <span style={{ position: "absolute", color: C.accentText, fontWeight: 500, opacity: after }}>With Notary</span>
        </div>
        <div style={{ display: "flex", gap: 24, margin: "12px 0 26px", color: C.muted, fontSize: 22 }}>
          {(["allowed", "unsafe", "held"] as const).map((k) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <DitherSwatch fill={FILLS[k]} size={18} />
              {k === "allowed" ? "Allowed" : k === "unsafe" ? "Unsafe" : "Held for review"}
            </span>
          ))}
        </div>
        <div style={{ position: "relative", width: W, height: H, marginLeft: 30 }}>
          {Array.from({ length: top / step + 1 }, (_, i) => i * step).map((t) => (
            <div key={t} style={{ position: "absolute", left: 0, right: 0, top: H - t * unit, borderTop: `1px solid ${C.hairline}` }}>
              <span style={{ position: "absolute", left: -32, top: -13, width: 24, textAlign: "right", color: C.muted, fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{t}</span>
            </div>
          ))}
          <DitherCanvas
            style={{ position: "absolute", inset: 0, width: W, height: H }}
            deps={[frame]}
            draw={(paint, size) => {
              rows.forEach((r, i) => {
                const x = colX(i);
                const n = parts(r.naive);
                const g = parts(r.guarded);
                const keep = Math.min(n.allowed, g.allowed) * unit;
                const naiveH = total(r.naive) * unit;
                // Without Notary: the stack un-reveals top-down down to what Notary also executes.
                const cut = size.height - naiveH + (naiveH - keep) * dissolve;
                let y = size.height;
                for (const k of ["allowed", "unsafe", "held"] as const) {
                  const h = n[k] * unit;
                  if (h <= 0) continue;
                  const gap = y < size.height ? 3 : 0;
                  paint({ x, y: y - h, w: colW, h: h - gap }, FILLS[k], { revealFromY: cut });
                  y -= h;
                }
                // With Notary: what it held rises from the kept base, row by row.
                const extra = Math.max(0, g.allowed * unit - keep);
                const stack = [
                  { k: "allowed" as const, h: extra },
                  { k: "held" as const, h: g.held * unit },
                ];
                const riseH = stack.reduce((a, s) => a + s.h, 0);
                const riseTop = size.height - keep - riseH * rise;
                let y2 = size.height - keep;
                for (const s of stack) {
                  if (s.h <= 0) continue;
                  const gap = y2 < size.height ? 3 : 0;
                  paint({ x, y: y2 - s.h, w: colW, h: s.h - gap }, FILLS[s.k], { revealFromY: riseTop });
                  y2 -= s.h;
                }
              });
            }}
          />
          {rows.map((r, i) => {
            const n = total(r.naive);
            const g = total(r.guarded);
            const keep = Math.min(parts(r.naive).allowed, parts(r.guarded).allowed);
            // Values only where a stack stands: the naive total, then Notary's total as it rises.
            const value = rise > 0 ? Math.round(mix(rise, keep, g)) : n;
            const h = rise > 0 ? mix(rise, keep, g) : dissolve > 0 ? mix(dissolve, n, keep) : n;
            const show = dissolve === 0 || rise > 0.05;
            return (
              <div key={r.type}>
                <span style={{ position: "absolute", left: colX(i), width: colW, top: H - h * unit - 30, textAlign: "center", color: C.strongMuted, fontSize: 21, fontWeight: 500, fontVariantNumeric: "tabular-nums", opacity: show ? 1 : 0 }}>
                  {value}
                </span>
                <span style={{ position: "absolute", left: groupW * i - 10, width: groupW + 20, top: H + 12, textAlign: "center", color: C.muted, fontSize: 20, whiteSpace: "nowrap" }}>{r.label}</span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 56, color: C.muted, fontSize: 21 }}>Measured on Notary's evaluation suite</div>
      </Card>
    </div>
  );
}
