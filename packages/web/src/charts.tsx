import { BarChart } from "./components/dither-kit/bar-chart";
import { Bar } from "./components/dither-kit/bar";
import { LineChart } from "./components/dither-kit/area-chart";
import { Line } from "./components/dither-kit/area";
import { XAxis } from "./components/dither-kit/x-axis";
import { YAxis } from "./components/dither-kit/y-axis";
import { Grid } from "./components/dither-kit/grid";
import { useChart } from "./components/dither-kit/chart-context";
import { number, percent, usd } from "./data";

type BarRow = {
  name: string;
  value: number | null;
  comparison?: number | null;
  drop?: number | null;
};
const format = (value: number | null | undefined, unit: string) =>
  value == null
    ? "Not computable"
    : unit === "USD"
      ? usd(value)
      : unit === "ratio"
        ? percent(value)
        : number(value);
function ReceiptTooltip({
  unit = "",
  funnel = false,
}: {
  unit?: string;
  funnel?: boolean;
}) {
  const chart = useChart();
  if (chart.hoverIndex == null) return null;
  const row = chart.data[chart.hoverIndex] as BarRow;
  return (
    <div className="chart-tooltip dither-receipt-tooltip">
      <strong>{row.name}</strong>
      {chart.configKeys.map((key) => (
        <p key={key}>
          {chart.config[key].label}:{" "}
          {format(row[key as keyof BarRow] as number | null | undefined, unit)}
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
}
ReceiptTooltip.chartLayer = "dom" as const;
function RecordedStepStroke() {
  const chart = useChart();
  if (!chart.ready) return null;
  const points = chart.data.map((row, index) => ({
    x: chart.xCenter(index),
    y: chart.y(Number(row.value)),
  }));
  const path = points
    .map((point, index) =>
      index ? `H ${point.x} V ${point.y}` : `M ${point.x} ${point.y}`,
    )
    .join(" ");
  return (
    <g aria-hidden="true">
      <path d={path} stroke="var(--blue)" strokeWidth={2} fill="none" />
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={3}
          fill="var(--blue)"
        />
      ))}
    </g>
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
  data: BarRow[];
  comparison?: boolean;
  focusName?: string;
  comparisonName?: string;
  unit?: string;
  funnel?: boolean;
}) {
  const positive = data.some(
    (row) => (row.value ?? 0) > 0 || (comparison && (row.comparison ?? 0) > 0),
  );
  const ticks = [
    ...new Set(
      data
        .flatMap((row) => [row.value, comparison ? row.comparison : null])
        .filter((v): v is number => v != null),
    ),
  ].sort((a, b) => a - b);
  return (
    <div
      className="dither-chart-group"
      role="img"
      aria-label={data
        .map(
          (row) =>
            `${row.name}: ${format(row.value, unit)}${comparison ? `; baseline: ${format(row.comparison, unit)}` : ""}`,
        )
        .join(". ")}
    >
      {positive && (
        <div className="bar-chart dither-bars">
          <BarChart
            data={data}
            config={{
              value: { label: focusName, color: "blue" },
              ...(comparison
                ? {
                    comparison: {
                      label: comparisonName,
                      color: "grey" as const,
                    },
                  }
                : {}),
            }}
            animate={false}
            bloom="off"
            margins={{ left: 40, right: 12, top: 12, bottom: 28 }}
          >
            <XAxis dataKey="name" />
            <YAxis
              ticks={
                ticks.length > 2 ? [ticks[0], ticks[ticks.length - 1]] : ticks
              }
              tickFormatter={(value) => format(value, unit)}
            />
            <ReceiptTooltip unit={unit} funnel={funnel} />
            <Bar dataKey="value" variant="gradient" />
            {comparison && <Bar dataKey="comparison" variant="hatched" />}
          </BarChart>
        </div>
      )}
      <div className="chart-value-list">
        {data.map((row) => (
          <div key={row.name}>
            <span>{row.name}</span>
            <span>
              <i className="value-key" />
              {format(row.value, unit)}
              {comparison && (
                <>
                  <i className="value-key baseline" />
                  {format(row.comparison, unit)}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      {!positive && (
        <p className="chart-note">
          Recorded values · no positive values to plot.
        </p>
      )}
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
        .map((row) => `${row.name}: ${row.value} unsafe actions`)
        .join(". ")}
    >
      <LineChart
        data={data}
        config={{ value: { label: "Unsafe actions", color: "blue" } }}
        animate={false}
        bloom="off"
        margins={{ left: 32, right: 16, top: 20, bottom: 28 }}
      >
        <Grid />
        <XAxis dataKey="name" />
        <YAxis ticks={[...new Set(data.map((row) => row.value))]} />
        <ReceiptTooltip />
        <Line dataKey="value" variant="dotted" />
        <RecordedStepStroke />
      </LineChart>
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
            <span
              style={{ width: max ? `${(row.value / max) * 100}%` : "0%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
