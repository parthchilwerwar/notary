import { useId, useRef, useState } from "react";
import type { ActionCounts, ActionRow } from "../../landing-data";
import { DitherCanvas, DitherSwatch, type DitherFill } from "../brand/DitherCanvas";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

// Money actions by request type, without vs with Notary, from the two bundles' decisions, drawn
// with ordered (Bayer 8×8) dithering on a canvas. Allowed (executed, graded safe) = solid accent
// blue; Unsafe (executed, graded unsafe) = red dither; Held for review = amber dither; both
// dithers fade from 1.0 at the base to 0.35 at the top. One axis, hairline gridlines, a value on
// each column cap, a hover/focus tooltip with exact counts, an aria summary and a hidden table.

const fmt = new Intl.NumberFormat("en-US");

export const FILLS: Record<"allowed" | "unsafe" | "held", DitherFill> = {
  allowed: { kind: "solid", color: "var(--accent)" },
  unsafe: { kind: "dither", color: "var(--status-unsafe)", base: 1, top: 0.35 },
  held: { kind: "dither", color: "var(--status-held)", base: 1, top: 0.35 },
};

function niceTicks(max: number): number[] {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10 ** Math.floor(Math.log10(max));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

const total = (c: ActionCounts) => c.executed + c.held;
const parts = (c: ActionCounts) => ({ allowed: c.executed - c.unsafe, unsafe: c.unsafe, held: c.held });

type Col = { key: string; label: string; side: "without" | "with"; counts: ActionCounts };

const tip = (c: Col) => {
  const p = parts(c.counts);
  return `${c.label}, ${c.side} Notary: ${fmt.format(p.allowed)} allowed, ${fmt.format(p.unsafe)} unsafe, ${fmt.format(p.held)} held for review`;
};

export function ActionsChart({ rows }: { rows: ActionRow[] }) {
  const root = useRef<HTMLElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [progress, setProgress] = useState(1);
  const [active, setActive] = useState<number | null>(null);

  const cols: Col[] = rows.flatMap((r) => [
    { key: `${r.type}-n`, label: r.label, side: "without" as const, counts: r.naive },
    { key: `${r.type}-g`, label: r.label, side: "with" as const, counts: r.guarded },
  ]);
  const max = Math.max(1, ...cols.map((c) => total(c.counts)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const state = { p: 0 };
        setProgress(0);
        gsap.to(state, {
          p: 1,
          duration: 1.4,
          ease: "power2.out",
          onUpdate: () => setProgress(state.p),
          scrollTrigger: { trigger: root.current, start: "top 75%", once: true },
        });
        return () => setProgress(1);
      });
    },
    { scope: root },
  );

  const summary =
    `Money actions by request type, without and with Notary. ` +
    rows
      .map((r) => {
        const n = parts(r.naive);
        const g = parts(r.guarded);
        return `${r.label}: without Notary ${n.allowed} allowed, ${n.unsafe} unsafe, ${n.held} held; with Notary ${g.allowed} allowed, ${g.unsafe} unsafe, ${g.held} held.`;
      })
      .join(" ");

  return (
    <figure ref={root} className="l-chart">
      <ul className="l-legend" aria-hidden="true">
        <li>
          <DitherSwatch fill={FILLS.allowed} /> Allowed
        </li>
        <li>
          <DitherSwatch fill={FILLS.unsafe} /> Unsafe
        </li>
        <li>
          <DitherSwatch fill={FILLS.held} /> Held for review
        </li>
      </ul>
      <div className="l-chart-plot" ref={plot}>
        <div className="l-chart-grid" aria-hidden="true">
          {ticks.map((t) => (
            <div key={t} className="l-tick" style={{ bottom: `${(t / top) * 100}%` }}>
              <span>{fmt.format(t)}</span>
            </div>
          ))}
        </div>
        <DitherCanvas
          className="l-chart-canvas"
          role="img"
          aria-label={summary}
          deps={[rows, progress, top]}
          draw={(paint, size) => {
            const host = plot.current;
            if (!host) return;
            const base = host.getBoundingClientRect();
            const unit = size.height / top;
            const reveal = size.height * (1 - progress);
            host.querySelectorAll<HTMLElement>(".l-col").forEach((el, i) => {
              const col = cols[i];
              if (!col) return;
              const r = el.getBoundingClientRect();
              const x = r.left - base.left;
              let y = size.height;
              for (const k of ["allowed", "unsafe", "held"] as const) {
                const n = parts(col.counts)[k];
                if (n <= 0) continue;
                const h = n * unit;
                // 2px surface gap between stacked segments.
                const gap = y < size.height ? 2 : 0;
                paint({ x, y: y - h, w: r.width, h: h - gap }, FILLS[k], { revealFromY: reveal });
                y -= h;
              }
            });
          }}
        />
        <div className="l-chart-groups">
          {rows.map((r, gi) => (
            <div key={r.type} className="l-chart-group">
              <div className="l-chart-cols">
                {[0, 1].map((side) => {
                  const i = gi * 2 + side;
                  const col = cols[i]!;
                  const sum = total(col.counts);
                  return (
                    <button
                      key={col.key}
                      type="button"
                      className="l-col"
                      aria-label={tip(col)}
                      aria-describedby={active === i ? tipId : undefined}
                      onMouseEnter={() => setActive(i)}
                      onMouseLeave={() => setActive((a) => (a === i ? null : a))}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive((a) => (a === i ? null : a))}
                    >
                      <span className="l-col-value" aria-hidden="true" style={{ bottom: `${(sum / top) * 100 * progress}%` }}>
                        {fmt.format(sum)}
                      </span>
                      <span className="l-col-side" aria-hidden="true">
                        {col.side === "without" ? "Without" : "With"}
                      </span>
                      {active === i && (
                        <span className="l-tooltip" id={tipId} role="tooltip" style={{ bottom: `calc(${(sum / top) * 100}% + 26px)` }}>
                          <strong>
                            {col.label} · {col.side} Notary
                          </strong>
                          <span>{fmt.format(parts(col.counts).allowed)} allowed</span>
                          <span>{fmt.format(parts(col.counts).unsafe)} unsafe</span>
                          <span>{fmt.format(parts(col.counts).held)} held for review</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <span className="l-chart-cat" aria-hidden="true">
                {r.label}
              </span>
            </div>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>Money actions by request type, without and with Notary</caption>
        <thead>
          <tr>
            <th scope="col">Request type</th>
            <th scope="col">Without Notary: allowed</th>
            <th scope="col">Without Notary: unsafe</th>
            <th scope="col">Without Notary: held</th>
            <th scope="col">With Notary: allowed</th>
            <th scope="col">With Notary: unsafe</th>
            <th scope="col">With Notary: held</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const n = parts(r.naive);
            const g = parts(r.guarded);
            return (
              <tr key={r.type}>
                <th scope="row">{r.label}</th>
                <td>{n.allowed}</td>
                <td>{n.unsafe}</td>
                <td>{n.held}</td>
                <td>{g.allowed}</td>
                <td>{g.unsafe}</td>
                <td>{g.held}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <figcaption className="l-chart-caption">
        Decisions with a money action, by request type: the left column of each pair is the agent without Notary, the
        right one is Notary.
      </figcaption>
    </figure>
  );
}
