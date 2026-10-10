// "Not connected" at the point of use: what one integration's status means, from the
// HealthResponse of a live `notary serve`. Never a number, never a guessed status.
import type { HealthResponse, IntegrationName, IntegrationStatus } from "../../../core/src/schema";
import type { DataMode } from "./types";

export type IntegrationView = {
  name: IntegrationName;
  /** "unknown" = not checked (replay mode, or the server did not report it). */
  state: IntegrationStatus["state"] | "unknown";
  /** True only for a real, successful check ("connected"). */
  connected: boolean;
  /** One line for the UI, e.g. "Not connected — set DODO_PAYMENTS_API_KEY in .env". */
  message: string;
  /** The exact fix from the server, when it gave one. */
  fix?: string;
  status: IntegrationStatus | null;
};

export function integrationView(
  health: HealthResponse | null,
  name: IntegrationName,
  mode: DataMode,
): IntegrationView {
  const unknown = (message: string): IntegrationView => ({ name, state: "unknown", connected: false, message, status: null });
  if (mode === "replay" || !health)
    return unknown("Not checked — replay mode has no live integrations; start `pnpm notary serve`");
  const status = health.integrations.find((i) => i.name === name);
  if (!status) return unknown(`Not reported by notary serve`);
  const base = { name, state: status.state, status, fix: status.fix };
  switch (status.state) {
    case "connected":
      return { ...base, connected: true, message: "Connected" };
    case "configured":
      return { ...base, connected: false, message: "Configured — not verified (no zero-cost check exists)" };
    case "missing":
      return {
        ...base,
        connected: false,
        message: status.variable
          ? `Not connected — set ${status.variable} in .env`
          : `Not connected — ${status.label}`,
      };
    case "error":
      return { ...base, connected: false, message: `Error — ${status.detail ?? status.label.replace(/^error\s*/, "")}` };
  }
}
