import { useChartPart } from "./chart-context";

export function YAxis({
  ticks,
  tickFormatter,
  tickCount = 4,
  tickMargin = 8,
}: {
  ticks?: number[];
  tickFormatter?: (value: number) => string;
  tickCount?: number;
  tickMargin?: number;
}) {
  const ctx = useChartPart("YAxis");
  if (!ctx.ready) return null;

  return (
    <g className="fill-current font-mono text-[10px] text-muted-foreground">
      {(ticks ?? ctx.y.ticks(tickCount)).map((t) => (
        <text
          key={t}
          x={-tickMargin}
          y={ctx.y(t)}
          textAnchor="end"
          dominantBaseline="central"
          fill="currentColor"
        >
          {tickFormatter ? tickFormatter(t) : t}
        </text>
      ))}
    </g>
  );
}
