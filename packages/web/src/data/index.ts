// The web data layer — the only code that talks to `notary serve` or reads public/ data files.
// Import from "src/data" (this file); see types.ts for the DataSource contract.
import { PublishedFiles, type EvidenceEntry } from "./published";
import type { FixtureIndex } from "../../../core/src/schema";
import type { BundleIndexEntry } from "../../../core/src/schema";
import type { RunEntry } from "./types";

export * from "./types";
export { LiveSource, RunStillRunningError, type EventSourceCtor, type EventSourceLike } from "./live";
export { ReplaySource } from "./replay";
export { LiveChat, readChatStream, CHAT_INVALID_EVENT, CHAT_STREAM_CLOSED, CHAT_MESSAGE_INVALID } from "./chat-live";
export { ReplayChat, REPLAY_UNAVAILABLE, REPLAY_NO_MATCH, sentences, type ReplayChatData, type ReplayChatOptions } from "./chat-replay";
export { routeQuestion, lookupSubject, type Intent, type Route, type RouteContext } from "./chat-route";
export { SseParser, type SseMessage } from "./chat-sse";
export { memoryChatStore, sessionChatStore, REPLAY_CHAT_STORAGE_KEY, type ChatStore, type StoredConversation } from "./chat-store";
export { answerWorld, worldIndex, worldKeyOf, worldLabel, type WorldKey } from "./world";
export {
  PublishedFiles,
  TimelineMissingError,
  PUBLISHED_FILES,
  evidenceFileUrl,
  evidenceSchema,
  type CertificateWorldDetail,
  type EvidenceEntry,
  type PublishedEntry,
  type RunDir,
} from "./published";
export {
  DEFAULT_API_BASE,
  HEALTH_TIMEOUT_MS,
  isHostedBuild,
  probeHealth,
  replaySelection,
  resolveApiBase,
  selectDataSource,
  shouldProbe,
  type HealthProbe,
  type SelectEnv,
  type Selection,
  type SelectOptions,
} from "./select";
export {
  DataSourceProvider,
  useDataSource,
  useHealth,
  useIntegration,
  type DataSourceValue,
} from "./react";
export { integrationView, type IntegrationView } from "./integration";
export { REPLAY_MAX_STEP_MS, REPLAY_MIN_STEP_MS, replayDelays, replayStream, type ReplaySpeed, type Timers } from "./stream";
export {
  approvalId,
  byNewest,
  chooseScenario,
  parseBundleIndex,
  scenarioKey,
  sealOf,
  validateBundle,
  verifyTimelineFile,
  verifyToolFile,
  verifyToolRecords,
} from "./verify";
export { entryOfBundle, toCertificateView, type CertificateView } from "./certificates";
export {
  LocalApiError,
  TOKEN_REQUIRED,
  apiRequest,
  localFetch,
  readToken,
  useSessionToken,
  writeToken,
} from "./local-api";
export { date, label, number, percent, safeLink, usd } from "./format";

/** Legacy catalog origin the current pages branch on: "api" = live mode, "static" = replay. */
export type CatalogOrigin = "api" | "static";

/** Finished runs as plain index entries (drops `state`; running runs have no bundle yet). */
export function finishedEntries(runs: readonly RunEntry[]): BundleIndexEntry[] {
  return runs.flatMap((r) => (r.state === "finished" ? [(({ state: _s, ...e }) => e)(r)] : []));
}

// Published-only content that has no DataSource method (same files in live and replay mode).
const published = new PublishedFiles();

/** public/evidence/evidence.json (tool integration receipts), validated; [] when not published. */
export const loadEvidence = (signal?: AbortSignal): Promise<EvidenceEntry[]> => published.evidence(signal);

/** public/economics.json (the cfo.ai plan), raw; undefined when not published. */
export const loadEconomicsPlan = (signal?: AbortSignal): Promise<unknown | undefined> => published.economics(signal);

/** public/certificates/fixture/index.json, validated; null when not published. */
export const loadFixtureCertificateIndex = (signal?: AbortSignal): Promise<FixtureIndex | null> =>
  published.fixtureCertificateIndex(signal);
