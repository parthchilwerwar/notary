import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * Signed difference pill. `safety` colors it: a negative delta (fewer unsafe actions) is safe,
 * a positive one unsafe. Without `safety` it stays neutral. null renders nothing.
 */
export function DeltaPill({
  value,
  safety = false,
  suffix = "",
  label = "vs baseline",
}: {
  value: number | null | undefined;
  safety?: boolean;
  suffix?: string;
  label?: string;
}) {
  if (value == null) return null;
  const tone =
    safety && value < 0 ? "safe" : safety && value > 0 ? "unsafe" : "neutral";
  return (
    <span className={cn("delta", tone)} data-tone={tone}>
      {value > 0 ? "+" : ""}
      {fmt.format(value)}
      {suffix} {label && <span>{label}</span>}
    </span>
  );
}

/**
 * Big tabular KPI. `value` is preformatted by the caller from a data file; pass null for
 * "not computable" so it renders an em dash instead of an invented zero.
 */
export function KpiCard({
  label,
  value,
  delta,
  note,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode | null;
  delta?: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("kpi-card", className)}>
      <span className="kpi-label">{label}</span>
      <div className="kpi-line">
        <span className="kpi-value">{value ?? "—"}</span>
        {delta}
      </div>
      {note && <p className="kpi-note">{note}</p>}
      {children}
    </Card>
  );
}
