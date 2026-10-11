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

// The viewer's own locale and time zone (AUDIT H-44: no hardcoded zone).
export const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
