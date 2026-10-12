// Dates: one convention everywhere — UTC, always labelled "UTC" — so a timestamp reads the same on
// every page (the Run transcript's clock times are UTC too) and in every viewer's browser. The zone
// is stated on screen, never implied.
const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** "Oct 11, 2026, 4:05 PM UTC"; the raw value when it is not a date. */
export function dateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : `${formatter.format(d)} UTC`;
}
