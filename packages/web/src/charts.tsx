import { useId } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { number, usd } from "./data";

export function Hatch({ id }: { id: string }) {
  return (
    <pattern
      id={id}
      width="8"
      height="8"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(35)"
    >
      <rect width="8" height="8" fill="var(--hatch-bg)" />
      <line
        x1="0"
        y1="0"
        x2="0"
        y2="8"
        stroke="var(--hatch-line)"
        strokeWidth="2"
      />
    </pattern>
  );
}

export function Bars({
  data,
  comparison = false,
  focusName = "Selected run",
  comparisonName = "Comparison",
  unit = "",
  funnel = false,
}: {
  data: {
    name: string;
    value: number | null;
    comparison?: number | null;
    drop?: number | null;
  }[];
  comparison?: boolean;
  focusName?: string;
  comparisonName?: string;
  unit?: string;
  funnel?: boolean;
}) {
  const pattern = useId().replaceAll(":", "");
  if (data.every((row) => !row.value && (!comparison || !row.comparison))) {
    return (
      <div className="zero-chart-list">
        {data.map((row) => (
          <div key={row.name}>
            <span>{row.name}</span>
            <span>
              {row.value == null
                ? "Not computable"
                : unit === "USD"
                  ? usd(row.value)
                  : number(row.value)}
              {comparison && (
                <>
                  {" "}
                  /{" "}
                  {row.comparison == null
                    ? "Not computable"
                    : unit === "USD"
                      ? usd(row.comparison)
                      : number(row.comparison)}
                </>
              )}
            </span>
          </div>
        ))}
        <p className="chart-note">
          {comparison ? "Focus / baseline" : "Recorded values"} · no positive
          values to plot.
        </p>
      </div>
    );
  }
  return (
    <div
      className="bar-chart"
      style={{ height: Math.max(180, data.length * (comparison ? 68 : 48)) }}
      role="img"
      aria-label={data
        .map(
          (d) =>
            `${d.name}: ${d.value ?? "not computable"} ${unit}${comparison ? `; ${comparisonName}: ${d.comparison ?? "not computable"}` : ""}`,
        )
        .join(". ")}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 48, bottom: 8, left: 0 }}
          barCategoryGap="24%"
        >
          <defs>
            <Hatch id={pattern} />
          </defs>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            dataKey="name"
            type="category"
            width={92}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: "var(--hover)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as (typeof data)[number];
              return (
                <div className="chart-tooltip">
                  <strong>{row.name}</strong>
                  {payload.map((item) => (
                    <p key={String(item.dataKey)}>
                      {item.dataKey === "comparison"
                        ? comparisonName
                        : focusName}
                      : {number(Number(item.value))} {unit}
                    </p>
                  ))}
                  {funnel && row.drop != null && (
                    <p>
                      Drop vs previous bar: {number(row.drop)}
                      <small>Terminal outcomes are separate branches.</small>
                    </p>
                  )}
                </div>
              );
            }}
          />
          <Bar
            name={focusName}
            dataKey="value"
            fill={funnel ? `url(#${pattern})` : "var(--blue)"}
            radius={[0, 8, 8, 0]}
            isAnimationActive={false}
            maxBarSize={24}
          >
            {data.map((row, index) => (
              <Cell
                key={row.name}
                fill={
                  funnel && index === 0
                    ? "var(--blue)"
                    : funnel
                      ? `url(#${pattern})`
                      : "var(--blue)"
                }
              />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              fill="var(--muted)"
              fontSize={11}
              formatter={(value) =>
                value == null
                  ? ""
                  : unit === "USD"
                    ? usd(Number(value))
                    : number(Number(value))
              }
            />
          </Bar>
          {comparison && (
            <Bar
              name={comparisonName}
              dataKey="comparison"
              fill={`url(#${pattern})`}
              radius={[0, 8, 8, 0]}
              isAnimationActive={false}
              maxBarSize={24}
            >
              <LabelList
                dataKey="comparison"
                position="right"
                fill="var(--muted)"
                fontSize={11}
                formatter={(value) =>
                  value == null
                    ? ""
                    : unit === "USD"
                      ? usd(Number(value))
                      : number(Number(value))
                }
              />
            </Bar>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StepTrend({
  data,
}: {
  data: { name: string; value: number }[];
}) {
  return (
    <div
      className="trend-chart"
      role="img"
      aria-label={data
        .map((d) => `${d.name}: ${d.value} unsafe actions`)
        .join(". ")}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 16, right: 20, left: -24, bottom: 0 }}
        >
          <CartesianGrid
            vertical={false}
            stroke="var(--line)"
            strokeDasharray="3 6"
          />
          <XAxis
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
          />
          <YAxis
            domain={[0, "dataMax"]}
            ticks={[...new Set(data.map((d) => d.value))]}
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              color: "var(--fg)",
            }}
          />
          <Line
            dataKey="value"
            name="Unsafe actions"
            type="stepAfter"
            stroke="var(--blue)"
            strokeWidth={2}
            dot={{
              r: 4,
              fill: "var(--blue)",
              stroke: "var(--surface)",
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Segments({
  rows,
}: {
  rows: { name: string; value: number }[];
}) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  return (
    <div className="segmented-list">
      {rows.map((row) => (
        <div className="segmented-row" key={row.name}>
          <div>
            <span>{row.name}</span>
            <strong>{number(row.value)}</strong>
          </div>
          <div
            className="segmented-track"
            aria-label={`${row.name}: ${row.value}`}
          >
            <span style={{ width: max ? `${(row.value / max) * 100}%` : "0%" }}>
              {Array.from({ length: row.value }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
