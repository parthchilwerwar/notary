// Beat 2 · the problem. The agent without Notary works the queue: its money actions stream in as
// transcript rows (every row a decision from the naive bundle, amounts as its timeline recorded
// them), a refund goes out twice, red "Unsafe" pills tick up as the grader marked them, the dither
// chart grows to the naive totals and the counter lands on the grader's total.
import { useCurrentFrame } from "remotion";
import { Card, StatusPill } from "../components/kit";
import { DitherChart, Swatch } from "../components/DitherChart";
import type { ShowreelData } from "../data-schema";
import { C, SANS, display, enterLeave, p, OUT, LINE } from "../theme";
import { T } from "../timeline";

const ROW_H = 84;
const VISIBLE = 7;

function Mark({ unsafe }: { unsafe: boolean }) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 32,
        height: 32,
        borderRadius: "50%",
        flexShrink: 0,
        border: `1.5px solid ${unsafe ? "transparent" : C.hairline}`,
        background: unsafe ? C.unsafeBg : C.page,
        color: unsafe ? C.unsafeText : C.muted,
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {unsafe ? (
          <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        ) : (
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

export function Legend({ size = 22 }: { size?: number }) {
  return (
    <div style={{ display: "flex", gap: 28, color: C.muted, fontSize: size, fontFamily: SANS }}>
      {(["allowed", "unsafe", "held"] as const).map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <Swatch kind={k} size={size - 2} />
          {k === "allowed" ? "Allowed" : k === "unsafe" ? "Unsafe" : "Held for review"}
        </span>
      ))}
    </div>
  );
}

export function Footnote({ style }: { style?: React.CSSProperties }) {
  return <div style={{ color: C.muted, fontSize: 22, fontFamily: SANS, ...style }}>Measured on Notary's evaluation suite</div>;
}

export function Problem({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  const rows = data.naive.rows;
  const step = (T.rowsEnd - T.rowsStart) / Math.max(1, rows.length - 1);
  const appear = (i: number) => T.rowsStart + i * step;
  // Continuous count of rows on screen (for the smooth scroll), and whole rows shown.
  const shown = rows.filter((_, i) => frame >= appear(i)).length;
  const scrollRows = Math.max(0, (frame - T.rowsStart) / step + 1 - VISIBLE);
  const scroll = Math.min(Math.max(0, rows.length - VISIBLE), Math.max(0, scrollRows)) * ROW_H;
  // The counter: unsafe rows on screen so far; the last one lands on the grader's total.
  const unsafeShown = rows.slice(0, shown).filter((r) => r.unsafe.length > 0).length;
  const counter = Math.min(unsafeShown, data.naive.unsafe);
  const landed = counter === data.naive.unsafe ? p(frame, T.rowsEnd, 10) : 0;

  const title = enterLeave(frame, T.problemTitle, T.problemLeave, { rise: 28, leave: 8 });
  const left = enterLeave(frame, T.transcript, T.problemLeave, { leave: 8 });
  const right = enterLeave(frame, T.transcript + 4, T.problemLeave + 2, { leave: 8 });
  const grow = p(frame, T.chartGrow, T.chartGrowDur, LINE);
  if (frame > T.problemLeave + 12) return null;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: SANS }}>
      <div style={{ position: "absolute", left: 160, top: 124, color: C.text, ...display, fontSize: 68, opacity: title.opacity, transform: `translateY(${title.y}px)` }}>
        Without Notary, the agent trusts the docs.
      </div>

      {/* Transcript */}
      <Card style={{ position: "absolute", left: 160, top: 250, width: 820, height: 724, padding: 0, overflow: "hidden", opacity: left.opacity, transform: `translateY(${left.y}px)` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18, padding: "28px 36px 20px", borderBottom: `1px solid ${C.hairline}` }}>
          <span style={{ ...display, fontSize: 40, color: C.text }}>Transcript</span>
          <span style={{ color: C.muted, fontSize: 22 }}>Money actions, in queue order</span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 104,
            bottom: 0,
            overflow: "hidden",
            WebkitMaskImage: scroll > 0 ? "linear-gradient(180deg, transparent 0, #000 56px)" : undefined,
            maskImage: scroll > 0 ? "linear-gradient(180deg, transparent 0, #000 56px)" : undefined,
          }}
        >
          <div style={{ transform: `translateY(${-scroll}px)` }}>
            {rows.map((r, i) => {
              const t = p(frame, appear(i), 8, OUT);
              const unsafe = r.unsafe.length > 0;
              const pill = p(frame, appear(i) + 3, 7, OUT);
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 20,
                    height: ROW_H,
                    padding: "0 36px",
                    borderBottom: `1px solid ${C.hairline}`,
                    opacity: t,
                    transform: `translateY(${(1 - t) * 18}px)`,
                  }}
                >
                  <Mark unsafe={unsafe && pill > 0.5} />
                  <div style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 26, color: C.text, whiteSpace: "nowrap" }}>
                      {r.type} {r.requestId}
                      {r.retry ? <span style={{ color: C.unsafeText }}> again</span> : null}
                      {r.amount && <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}> · {r.amount}</span>}
                    </span>
                    <span style={{ fontSize: 22, color: C.muted, whiteSpace: "nowrap" }}>
                      {r.action}
                      {r.retry ? " · sent a second time" : ""}
                    </span>
                  </div>
                  <span style={{ opacity: pill, transform: `scale(${0.85 + 0.15 * pill})`, transformOrigin: "right center" }}>
                    {unsafe ? <StatusPill tone="unsafe">Unsafe · {r.unsafe.join(", ")}</StatusPill> : <StatusPill tone="neutral">Executed</StatusPill>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Counter + chart */}
      <Card style={{ position: "absolute", left: 1040, top: 250, width: 720, height: 724, padding: "28px 40px", opacity: right.opacity, transform: `translateY(${right.y}px)` }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 24 }}>
          <span
            style={{
              ...display,
              fontSize: 168,
              lineHeight: 0.86,
              color: counter > 0 ? C.unsafeText : C.text,
              display: "inline-block",
              minWidth: 100,
              textAlign: "left",
              transform: `translateY(${-6 * Math.sin(landed * Math.PI)}px)`,
            }}
          >
            {counter}
          </span>
          <span style={{ fontSize: 26, color: C.text, paddingBottom: 12, lineHeight: 1.25 }}>
            Unsafe money actions
            <br />
            <span style={{ color: C.muted }}>without Notary</span>
          </span>
        </div>
        <div style={{ marginTop: 30, display: "grid", gap: 16 }}>
          <span style={{ ...display, fontSize: 34, color: C.text }}>Money actions by request type</span>
          <Legend />
        </div>
        <div style={{ position: "absolute", left: 40, top: 352 }}>
          <DitherChart rows={data.chart.rows} width={640} height={262} phase={{ grow, dissolve: 0, rise: 0 }} />
        </div>
        <Footnote style={{ position: "absolute", left: 40, bottom: 26 }} />
      </Card>
    </div>
  );
}
