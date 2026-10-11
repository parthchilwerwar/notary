// Dates in the viewer's own locale and time zone (Intl, never a hardcoded zone).
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Oct 11, 2026, 4:05 PM" in the viewer's locale and zone; the raw value when it is not a date. */
export function dateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatter.format(d);
}
