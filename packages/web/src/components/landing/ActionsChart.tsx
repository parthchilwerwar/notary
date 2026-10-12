import { useEffect, useId, useRef, useState } from "react";
import { actionTotals, type ActionCounts, type ActionRow } from "../../landing-data";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

// Money actions by request type, without vs with Notary, from the two bundles' decisions
// (landing-data actionsByType). One horizontal stacked bar per request type and agent, on one
// shared linear scale that starts at zero:
//   Executed safely          = executed, graded safe     (accent blue)
//   Executed, graded unsafe  = executed, graded unsafe   (red)
//   Held for a person        = held for review           (amber)
// A legend names the three states; each bar carries its total at the tip and an inline count per
// segment when it has more than one segment and the count fits. A two-line takeaway above the
// plot, a hover/focus tooltip, a screen-reader summary and a table carry the same numbers as text.
// Palette checked with the dataviz validator (light surface, all pairs): blue/red/amber pass the
// CVD and normal-vision floors; amber is under 3:1 against white, so every value is also printed.

const fmt = new Intl.NumberFormat("en-US");

type SegKey = "safe" | "unsafe" | "held";
const SEGMENTS: readonly { key: SegKey; label: string }[] = [
  { key: "safe", label: "Executed safely" },
  { key: "unsafe", label: "Executed, graded unsafe" },
  { key: "held", label: "Held for a person" },
];

const total = (c: ActionCounts) => c.executed + c.held;
const parts = (c: ActionCounts): Record<SegKey, number> => ({ safe: c.executed - c.unsafe, unsafe: c.unsafe, held: c.held });

/** Clean integer ticks from 0 to a round top at or above `max`. */
function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10 ** Math.floor(Math.log10(max));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

const plural = (n: number, one: string, many: string) => `${fmt.format(n)} ${n === 1 ? one : many}`;

type Side = "without" | "with";
const SIDES: readonly Side[] = ["without", "with"];
const SIDE_LABEL: Record<Side, string> = { without: "Without Notary", with: "With Notary" };
const SIDE_INLINE: Record<Side, string> = { without: "without Notary", with: "with Notary" };

function describe(label: string, side: Side, c: ActionCounts) {
  const p = parts(c);
  return `${label}, ${SIDE_INLINE[side]}: ${plural(total(c), "money action", "money actions")}; ${fmt.format(p.safe)} executed safely, ${fmt.format(p.unsafe)} executed and graded unsafe, ${fmt.format(p.held)} held for a person.`;
}

/** The two-line takeaway, summed over request types (landing-data actionTotals). */
function takeaway(rows: readonly ActionRow[]) {
  const { naiveExecuted, naiveUnsafe, guardedUnsafe, guardedHeld } = actionTotals(rows);
  return {
    without: `${fmt.format(naiveUnsafe)} of ${plural(naiveExecuted, "executed money action", "executed money actions")} graded unsafe`,
    with: `${fmt.format(guardedUnsafe)} unsafe, ${plural(guardedHeld, "action", "actions")} held for a person`,
  };
}

export function ActionsChart({ rows }: { rows: ActionRow[] }) {
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [active, setActive] = useState<string | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);

  const max = Math.max(1, ...rows.flatMap((r) => [total(r.naive), total(r.guarded)]));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const head = takeaway(rows);
  const pct = (n: number) => `${(n / top) * 100}%`;

  // Inline segment counts only where they fit: measure the plot's width.
  useEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setPlotWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "top 80%", once: true } });
        tl.fromTo(
          ".l-bar",
          { clipPath: "inset(0 100% 0 0)" },
          { clipPath: "inset(0 0% 0 0)", duration: 0.9, ease: "power2.out", stagger: 0.06 },
        ).from(".l-bar-total", { opacity: 0, x: -6, duration: 0.3, stagger: 0.04 }, "-=0.5");
      });
    },
    { scope: root },
  );

  const summary =
    `Money actions by request type. Without Notary, ${head.without}. With Notary, ${head.with}. ` +
    rows.map((r) => `${describe(r.label, "without", r.naive)} ${describe(r.label, "with", r.guarded)}`).join(" ");

  return (
    <figure ref={root} className="l-chart">
      <p className="sr-only">{summary}</p>
      <div className="l-chart-head" aria-hidden="true">
        <dl className="l-chart-takeaway">
          {SIDES.map((side) => (
            <div key={side} data-side={side}>
              <dt>{SIDE_LABEL[side]}</dt>
              <dd>{head[side]}</dd>
            </div>
          ))}
        </dl>
        <ul className="l-legend">
          {SEGMENTS.map((s) => (
            <li key={s.key}>
              <span className="l-swatch" data-seg={s.key} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="l-bars">
        {/* Gridlines and the zero baseline, on the same box as the bar tracks. */}
        <div className="l-bars-bg" aria-hidden="true">
          <div className="l-bars-grid" ref={grid}>
            {ticks.map((t) => (
              <span key={t} className="l-gridline" data-zero={t === 0 || undefined} style={{ left: pct(t) }} />
            ))}
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.type} className="l-bars-group">
            <span className="l-bars-cat" aria-hidden="true">
              {r.label}
            </span>
            {SIDES.map((side) => {
              const counts = side === "without" ? r.naive : r.guarded;
              const sum = total(counts);
              const p = parts(counts);
              const segs = SEGMENTS.filter((s) => p[s.key] > 0);
              const key = `${r.type}-${side}`;
              const tipOpen = active === key;
              return (
                <div key={side} className="l-bar-row" data-side={side}>
                  <span className="l-bar-side" aria-hidden="true">
                    <span className="l-bar-side-long">{SIDE_LABEL[side]}</span>
                    <span className="l-bar-side-short">{side === "without" ? "Without" : "With"}</span>
                  </span>
                  <div className="l-bar-track">
                    {sum > 0 ? (
                      <button
                        type="button"
                        className="l-bar"
                        aria-label={describe(r.label, side, counts)}
                        aria-describedby={tipOpen ? tipId : undefined}
                        style={{ width: pct(sum) }}
                        onMouseEnter={() => setActive(key)}
                        onMouseLeave={() => setActive((a) => (a === key ? null : a))}
                        onFocus={() => setActive(key)}
                        onBlur={() => setActive((a) => (a === key ? null : a))}
                      >
                        {segs.map((s) => {
                          const n = p[s.key];
                          const fits = segs.length > 1 && (n / top) * plotWidth >= 26;
                          return (
                            <span key={s.key} className="l-seg" data-seg={s.key} style={{ flexGrow: n }} aria-hidden="true">
                              {fits ? fmt.format(n) : null}
                            </span>
                          );
                        })}
                      </button>
                    ) : (
                      <span className="sr-only">{describe(r.label, side, counts)}</span>
                    )}
                    <span className="l-bar-total" style={{ left: pct(sum) }} aria-hidden="true">
                      {fmt.format(sum)}
                    </span>
                    {tipOpen && (
                      <span className="l-tooltip" id={tipId} role="tooltip">
                        <strong>
                          {r.label} · {SIDE_INLINE[side]}
                        </strong>
                        {SEGMENTS.map((s) => (
                          <span key={s.key} className="l-tooltip-row">
                            <span className="l-swatch" data-seg={s.key} aria-hidden="true" />
                            <span>{s.label}</span>
                            <b>{fmt.format(p[s.key])}</b>
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div className="l-bars-axis" aria-hidden="true">
          <div className="l-bars-ticks">
            {ticks.map((t) => (
              <span key={t} style={{ left: pct(t) }}>
                {fmt.format(t)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>Money actions by request type, without and with Notary</caption>
        <thead>
          <tr>
            <th scope="col">Request type</th>
            <th scope="col">Agent</th>
            {SEGMENTS.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) =>
            SIDES.map((side) => {
              const counts = side === "without" ? r.naive : r.guarded;
              const p = parts(counts);
              return (
                <tr key={`${r.type}-${side}`}>
                  <th scope="row">{r.label}</th>
                  <td>{SIDE_LABEL[side]}</td>
                  <td>{p.safe}</td>
                  <td>{p.unsafe}</td>
                  <td>{p.held}</td>
                  <td>{total(counts)}</td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      <figcaption className="l-chart-caption">
        Decisions that would move money, by request type, for the same queue run by an agent without Notary and by
        Notary. “Unsafe” is the deterministic grader’s verdict on the API state after each run.
      </figcaption>
    </figure>
  );
}
