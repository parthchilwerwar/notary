// Business page charts: hand-drawn SVG/HTML, no chart library. Marks follow the dataviz rules:
// thin bars (≤ 24px) with 4px rounded data ends on one baseline, 2px lines, ≥ 8px end dots with a
// surface ring, hairline solid grid, text in text tokens (never the series color), a hover/focus
// tooltip on every mark, and a table view of every value. Colors are tokens only (business.css).
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Expander, TableFrame } from "../../ui";
import type { Datum } from "./model";

/** Width of an element, measured (a sensible default before layout and in server renders). */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Clean axis ticks from 0 to just above max. */
function ticks(max: number, n = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1]! < max) out.push(Number((out[out.length - 1]! + step).toPrecision(12)));
  return out;
}

/** The table twin of a chart, behind a disclosure (every value reachable without hovering). */
export function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <Expander summary="Show the numbers" className="biz-table">
      <TableFrame>
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row">
                      {c}
                    </th>
                  ) : (
                    <td key={j}>{c}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </Expander>
  );
}

/** Horizontal bars for nominal categories: one color, value at the tip, sorted by the caller. */
export function BarList({ data, label }: { data: Datum[]; label: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  return (
    <ul className="biz-bars" aria-label={label}>
      {data.map((d) => (
        <li key={d.key} className="biz-bar-row" tabIndex={0} aria-label={`${d.label}: ${d.display}${d.sub ? `, ${d.sub}` : ""}`} title={`${d.label}: ${d.display}`}>
          <span className="biz-bar-label">{d.label}</span>
          <span className="biz-bar-track" aria-hidden="true">
            <span className="biz-bar" data-zero={d.value === 0 || undefined} style={{ width: max > 0 ? `${(d.value / max) * 100}%` : "0%" }} />
          </span>
          <span className="biz-bar-value">
            {d.display}
            {d.sub && <span className="biz-bar-sub"> · {d.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Columns over time (one series): crosshair-free, each column is its own hover/focus target. */
export function ColumnChart({ data, label, format, height = 220 }: { data: Datum[]; label: string; format: (n: number) => string; height?: number }) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const pad = { top: 16, right: 8, bottom: 40, left: 52 };
  const max = Math.max(0, ...data.map((d) => d.value));
  const ys = ticks(max);
  const top = ys[ys.length - 1] || 1;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const shown = active !== null ? data[active] : undefined;
  return (
    <div ref={ref} className="biz-chart" onPointerLeave={() => setActive(null)}>
      <svg width={width} height={height} role="img" aria-labelledby={`${id}-t`} className="biz-svg">
        <title id={`${id}-t`}>{label}</title>
        {ys.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="biz-grid" />
            <text x={pad.left - 8} y={y(t)} className="biz-tick" textAnchor="end" dominantBaseline="middle">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.left + band * i + band / 2;
          const h = Math.max(d.value > 0 ? 2 : 0, (d.value / top) * plotH);
          const r = Math.min(4, barW / 2, h);
          const x0 = cx - barW / 2;
          const yb = pad.top + plotH;
          const path = h > 0 ? `M${x0},${yb} V${yb - h + r} Q${x0},${yb - h} ${x0 + r},${yb - h} H${x0 + barW - r} Q${x0 + barW},${yb - h} ${x0 + barW},${yb - h + r} V${yb} Z` : "";
          return (
            <g
              key={d.key}
              tabIndex={0}
              role="img"
              aria-label={`${d.label}: ${d.display}`}
              className="biz-col"
              data-active={active === i || undefined}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <rect x={pad.left + band * i} y={pad.top} width={band} height={plotH} className="biz-hit" />
              {path && <path d={path} className="biz-col-mark" />}
              <text x={cx} y={yb + 18} className="biz-tick" textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} className="biz-axis" />
        <text x={pad.left} y={height - 4} className="biz-tick">
          Runs, oldest first
        </text>
      </svg>
      {shown && active !== null && (
        <div className="biz-tip" role="status" style={{ left: Math.min(width - 180, Math.max(0, pad.left + band * active + band / 2 - 90)), top: Math.max(0, y(shown.value) - 64) }}>
          <strong>{shown.display}</strong>
          <span>{shown.label}</span>
          {shown.sub && <span className="biz-tip-sub">{shown.sub}</span>}
        </div>
      )}
    </div>
  );
}

export type LineSeries = { key: string; label: string; tone: "primary" | "secondary"; values: (number | null)[] };

/** Lines on one axis (same unit) with a crosshair that snaps to the nearest period. */
export function LineChart({ periods, series, label, format, height = 240 }: { periods: string[]; series: LineSeries[]; label: string; format: (n: number) => string; height?: number }) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const pad = { top: 16, right: 16, bottom: 32, left: 56 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const ys = ticks(max - min).map((t) => t + min);
  const lo = min;
  const hi = ys[ys.length - 1]! > lo ? ys[ys.length - 1]! : lo + 1;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (periods.length <= 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const labelEvery = Math.max(1, Math.ceil(periods.length / Math.max(2, Math.floor(plotW / 72))));
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < periods.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setActive(best);
  };
  return (
    <div ref={ref} className="biz-chart">
      <svg
        width={width}
        height={height}
        role="img"
        aria-labelledby={`${id}-t`}
        className="biz-svg"
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? periods.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setActive((a) => Math.min(periods.length - 1, (a ?? -1) + 1));
          if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? periods.length) - 1));
        }}
      >
        <title id={`${id}-t`}>{label}</title>
        {ys.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "biz-axis" : "biz-grid"} />
            <text x={pad.left - 8} y={y(t)} className="biz-tick" textAnchor="end" dominantBaseline="middle">
              {format(t)}
            </text>
          </g>
        ))}
        {periods.map((p, i) =>
          i % labelEvery === 0 || i === periods.length - 1 ? (
            <text key={p} x={x(i)} y={height - 8} className="biz-tick" textAnchor={i === 0 && periods.length > 1 ? "start" : i === periods.length - 1 && periods.length > 1 ? "end" : "middle"}>
              {p}
            </text>
          ) : null,
        )}
        {active !== null && <line x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + plotH} className="biz-crosshair" />}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)));
          const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? "L" : "M"}${p[0]},${p[1]}` : acc), "");
          const lastIdx = s.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).at(-1);
          return (
            <g key={s.key} className="biz-line" data-tone={s.tone}>
              <path d={d} className="biz-line-path" />
              {lastIdx !== undefined && <circle cx={x(lastIdx)} cy={y(s.values[lastIdx]!)} r={4} className="biz-dot" />}
              {active !== null && s.values[active] !== null && <circle cx={x(active)} cy={y(s.values[active]!)} r={4} className="biz-dot" />}
            </g>
          );
        })}
      </svg>
      {active !== null && (
        <div className="biz-tip" role="status" style={{ left: Math.min(width - 190, Math.max(0, x(active) + 12)), top: pad.top }}>
          <span className="biz-tip-sub">{periods[active]}</span>
          {series.map((s) => (
            <span key={s.key} className="biz-tip-row">
              <span className="biz-key" data-tone={s.tone} aria-hidden="true" />
              <strong>{s.values[active] === null ? "—" : format(s.values[active]!)}</strong> {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Legend for ≥ 2 series: a short line key in the series tone, text in text tokens. */
export function Legend({ items }: { items: { key: string; label: string; tone: LineSeries["tone"] }[] }) {
  return (
    <ul className="biz-legend">
      {items.map((it) => (
        <li key={it.key}>
          <span className="biz-key" data-tone={it.tone} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

