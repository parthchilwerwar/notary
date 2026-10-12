// Display formatters and the receipt-link allow-list (moved from src/data.ts). Pure, no I/O.

export function safeLink(value?: string): string | undefined {
  if (!value) return;
  if (/^https?:\/\//i.test(value)) return value;
  // Local receipts are links exactly as recorded, never invented neatlogs URLs.
  if (/^(?:\.?\/?runs\/|\/runs\/)/.test(value) && !value.includes("..")) return value;
}

export const label = (value: string) => value.replaceAll("_", " ");

export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);

export const percent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);

// UTC, labelled "UTC" on screen (the same convention as lib/time.ts and the Run transcript), so a
// date never silently changes with the viewer's zone (AUDIT H-44: the zone is always stated).
const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
export const date = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : `${utc.format(d)} UTC`;
};

export const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
