// The cfo.ai connection panel on /app/business. Two forms:
//   - live (a local `notary serve`): the connection status from GET /api/cfo/status (workspace,
//     token expiry, last sync) and a "Sync from cfo.ai" button (POST /api/cfo/sync with the session
//     token, like the approvals desk). Not connected: the exact command to run.
//   - replay / hosted: what the published plan says about its source ("Synced from cfo.ai <time>"
//     for an MCP sync), or how to connect. Never calls an API.
// Every value shown comes from the server's status or the verified economics file.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowsClockwise, PlugsConnected, Terminal } from "@phosphor-icons/react";
import type { CfoStatus, CfoSyncResponse, EconomicsFile } from "../../../../core/src/schema";
import { Button, Facts, Note, Section } from "../../ui";
import { LocalApiError, useSessionToken } from "../../data";
import { CFO_CONNECT_COMMAND, CFO_SYNC_COMMAND, fetchCfoStatus, syncFromCfo } from "../../data/cfo";

const when = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="biz-cmd">
      <Terminal size={14} aria-hidden="true" />
      {children}
    </code>
  );
}

/** What the published plan records about where it came from (no API involved). */
export function PublishedSource({ file }: { file: EconomicsFile | null }) {
  const s = file?.plan?.source;
  if (s?.mcp)
    return (
      <>
        <p className="biz-cfo-line" data-state="synced">
          <PlugsConnected size={16} aria-hidden="true" /> Synced from cfo.ai {when(s.importedAt)}
        </p>
        <Facts
          columns={3}
          items={[
            { key: "ws", label: "Workspace", value: s.mcp.orgName ?? s.mcp.orgId },
            { key: "tables", label: s.mcp.tables.length === 1 ? "Table" : "Tables", value: s.mcp.tables.join(", ") },
            { key: "scn", label: "Scenario", value: s.scenario ?? "Not recorded" },
            { key: "payload", label: "MCP payload sha256", value: <code className="biz-hash">{s.fileSha256}</code>, wide: true },
          ]}
        />
      </>
    );
  if (s)
    return (
      <p className="biz-note">
        The plan below was imported from a cfo.ai export file on {when(s.importedAt)}. To read it straight from cfo.ai instead, connect once and sync: <Cmd>{CFO_CONNECT_COMMAND}</Cmd> <Cmd>{CFO_SYNC_COMMAND}</Cmd>
      </p>
    );
  return (
    <p className="biz-note">
      Not synced from cfo.ai yet. Connect once (you sign in to cfo.ai in your own browser), then sync: <Cmd>{CFO_CONNECT_COMMAND}</Cmd> <Cmd>{CFO_SYNC_COMMAND}</Cmd>
    </p>
  );
}

function TokenForm({ setToken, error }: { setToken: (t: string | null) => void; error?: string }) {
  const [draft, setDraft] = useState("");
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) setToken(draft.trim());
    setDraft("");
  };
  return (
    <form className="biz-cfo-token" onSubmit={save}>
      <label htmlFor="cfo-token">
        Session token (printed once by <code>pnpm notary serve</code>) to see the cfo.ai connection and sync
      </label>
      <div className="biz-cfo-token-row">
        <input id="cfo-token" type="password" autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" disabled={!draft.trim()}>
          Use token
        </Button>
      </div>
      {error && (
        <p className="biz-cfo-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

type StatusState = { status: "idle" } | { status: "loading" } | { status: "ready"; data: CfoStatus } | { status: "error"; error: string };
type SyncState = { status: "idle" } | { status: "running" } | { status: "done"; result: CfoSyncResponse } | { status: "error"; error: string };

function LiveConnection({ apiBase, onSynced }: { apiBase: string; onSynced: () => void }) {
  const [token, setToken] = useSessionToken();
  const [state, setState] = useState<StatusState>({ status: "idle" });
  const [sync, setSync] = useState<SyncState>({ status: "idle" });
  const [tokenError, setTokenError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetchCfoStatus(apiBase, { token, signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setTokenError(undefined);
        setState({ status: "ready", data });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof LocalApiError && err.status === 401) {
          setTokenError(message);
          setToken(null);
          return;
        }
        setState({ status: "error", error: message });
      },
    );
    return () => controller.abort();
  }, [apiBase, token, reload, setToken]);

  const runSync = useCallback(() => {
    setSync({ status: "running" });
    syncFromCfo(apiBase, { token }).then(
      (result) => {
        setSync({ status: "done", result });
        setReload((k) => k + 1);
        onSynced();
      },
      (err: unknown) => {
        setSync({ status: "error", error: err instanceof Error ? err.message : String(err) });
        setReload((k) => k + 1);
      },
    );
  }, [apiBase, token, onSynced]);

  if (!token) return <TokenForm setToken={setToken} {...(tokenError ? { error: tokenError } : {})} />;
  if (state.status === "loading" || state.status === "idle") return <p className="biz-note">Checking the cfo.ai connection…</p>;
  if (state.status === "error")
    return (
      <Note tone="warning" role="alert">
        Could not read the cfo.ai connection from the local server: {state.error}
      </Note>
    );
  const s = state.data;
  return (
    <div className="biz-cfo-live">
      {s.connected && s.org ? (
        <>
          <p className="biz-cfo-line" data-state="connected">
            <PlugsConnected size={16} aria-hidden="true" /> Connected to cfo.ai workspace {s.org.name ? `“${s.org.name}”` : s.org.id}
          </p>
          <Facts
            columns={3}
            items={[
              { key: "org", label: "Workspace id", value: <code>{s.org.id}</code> },
              { key: "read", label: "Sync reads", value: `${s.tables.join(", ")} · scenario ${s.scenario}` },
              {
                key: "exp",
                label: "Access token",
                value: s.tokenExpiresAt ? `${s.expired ? "expired" : "expires"} ${when(s.tokenExpiresAt)}${s.refreshable ? " (refreshes on its own)" : ""}` : "Expiry not reported",
              },
              {
                key: "last",
                label: "Last sync",
                value: s.lastSync ? (s.lastSync.ok ? `${when(s.lastSync.at)} · ok` : `${when(s.lastSync.at)} · failed`) : "Never",
                wide: true,
              },
            ]}
          />
          {s.lastSync && !s.lastSync.ok && s.lastSync.error && sync.status !== "error" && <Note tone="warning">Last sync failed: {s.lastSync.error}</Note>}
          <div className="biz-cfo-actions">
            <Button onClick={runSync} disabled={sync.status === "running"}>
              <ArrowsClockwise size={16} aria-hidden="true" /> {sync.status === "running" ? "Syncing from cfo.ai…" : "Sync from cfo.ai"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setToken(null)}>
              Forget token
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="biz-cfo-line" data-state="disconnected">
            Not connected to cfo.ai. {s.reason}
          </p>
          <p className="biz-note">
            Run this in a terminal; it opens cfo.ai's sign-in in your browser (Notary never sees your password): <Cmd>{s.connectCommand}</Cmd>
          </p>
          <div className="biz-cfo-actions">
            <Button variant="secondary" size="sm" onClick={() => setReload((k) => k + 1)}>
              Check again
            </Button>
          </div>
        </>
      )}
      {sync.status === "done" && (
        <Note tone="info" role="status">
          Synced from cfo.ai {when(sync.result.syncedAt)}: {sync.result.tiers} tiers, {sync.result.series} series, {sync.result.figures} figures (payload sha256 {sync.result.payloadSha256.slice(0, 12)}…). The plan below was reloaded.
        </Note>
      )}
      {sync.status === "error" && (
        <Note tone="error" role="alert">
          {sync.error}
        </Note>
      )}
    </div>
  );
}

/** The panel. `live` is set only when a local `notary serve` answered (never on the hosted build). */
export function CfoPanel({ file, live, onSynced }: { file: EconomicsFile | null; live?: { apiBase: string } | null; onSynced?: () => void }) {
  return (
    <Section
      id="cfo-connection"
      label={
        <span className="biz-source" data-kind="cfo">
          <PlugsConnected size={14} aria-hidden="true" /> cfo.ai
        </span>
      }
      title="cfo.ai connection"
      description="cfo.ai has no REST API or API key. Notary reads the plan over cfo.ai's MCP server, signed in through your own browser."
    >
      {live ? <LiveConnection apiBase={live.apiBase} onSynced={onSynced ?? (() => undefined)} /> : null}
      <PublishedSource file={file} />
    </Section>
  );
}
