// 03 · neatlogs. The two real traces, rendered from the neatlogs API response (explainer/data/
// traces.json): the Crustdata run's probe for the disputed claim — its prediction logged at the start
// of the probe span, before the call returned — and the Dodo run's Adversary spans. Nothing in these
// traces errors (the API reports 0 errors, 0 detections), so nothing is drawn red; the docs-vs-live
// status codes come from the run's own records and say so. Then the dashboard's incidents.
import { OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { BrowserFrame } from "@web/ui";
import { C, IN, MONO, SANS, display, p } from "../../theme";
import { ClipShot, Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { DataFrame, IncidentRow, TraceView } from "./records";

export function Neatlogs() {
  const frame = useCurrentFrame();
  const s = section("neatlogs");
  const t = P.neatlogs;
  const crust = A.data.traces.find((x) => x.runId?.startsWith("notarize-crustdata"))!;
  const dodo = A.data.traces.find((x) => x.runId?.startsWith("notarize-dodo"))!;
  const probe = crust.probes.find((x) => x.id.endsWith("p001"))!;
  const probeSpan = crust.spans.find((x) => x.id === probe.spanId)!;
  const logSpan = crust.spans.find((x) => x.parentId === probe.spanId && x.name === "notary.probe.committed");
  const probeInc = A.data.incidents.find((i) => i.claimId === probe.claimId);
  const openIncs = A.data.incidents.filter((i) => i.runId === crust.runId && i.kind === "checker_anomaly");
  const advSpans = dodo.spans.filter((x) => x.name === "notary.adversary");
  const dodoIncs = A.data.incidents.filter((i) => i.runId === dodo.runId && i.kind === "adversary_downgrade");
  const wallet = advSpans.find((x) => String(x.attrs["notary.claimId"] ?? "").includes("wallet.credit-amount"));
  const walletInc = dodoIncs.find((i) => i.claimId === wallet?.attrs["notary.claimId"]);
  const lead = t.lead;
  const user = A.user.neatlogsIncidents;

  // Phases (relative frames).
  const crustFrom = lead ? lead.to : 0;
  const crustTo = t.open - 6;
  const dodoFrom = t.dodo - 6;
  const agentsHi = frame >= t.agents && frame < t.crust ? crust.spans.filter((x) => x.agent).map((x) => x.id) : [];
  const probeHi = frame >= t.probe ? [probe.spanId, ...(logSpan && frame >= t.prediction ? [logSpan.id] : [])] : [];
  const advHi = frame >= t.narrowing ? (frame >= t.wallet && wallet ? [wallet.id] : advSpans.map((x) => x.id)) : [];
  const fadeCrust = p(frame, crustTo - 8, 10, IN);
  return (
    <SceneShell id="neatlogs" dur={s.dur}>

      {lead && user && frame < lead.to + 12 && (
        <div style={{ position: "absolute", left: 240, top: 112, width: 1440, opacity: 1 - p(frame, lead.to - 4, 12, IN) }}>
          <div style={{ width: 1280, transform: "scale(1.125)", transformOrigin: "0 0" }}>
            <BrowserFrame address="neatlogs · critical incidents" tag="Screen recording">
              <div style={{ position: "relative", width: 1280, height: 720, overflow: "hidden", background: C.page }}>
                <Sequence from={0} durationInFrames={lead.to} layout="none">
                  <OffthreadVideo src={staticFile(user.src)} muted style={{ width: 1280, height: 720, objectFit: "contain" }} />
                </Sequence>
              </div>
            </BrowserFrame>
          </div>
        </div>
      )}

      {frame >= crustFrom && frame < crustTo + 2 && (
        <div style={{ position: "absolute", inset: 0, opacity: p(frame, crustFrom, 12) * (1 - fadeCrust) }}>
          <TraceView
            trace={crust}
            title="neatlogs trace · Crustdata run"
            collapse={["notary.recon"]}
            reveal={p(frame, crustFrom + 2, Math.max(20, t.agents - crustFrom - 6))}
            highlight={[...agentsHi, ...probeHi]}
            dim={p(frame, t.probe - 4, 10)}
          />
          {frame >= t.prediction - 4 && (
            <DetailPanel at={t.prediction - 4} title={`Probe ${probe.id.split("-").at(-1)} · ${probe.claimId}`}>
              {logSpan && (
                <DetailRow at={t.prediction} label="Prediction logged" value={`${String(logSpan.attrs["notary.committedAt"] ?? probe.committedAt).slice(11, 23)} UTC`} note="notary.probe.committed · neatlogs log record" />
              )}
              <DetailRow at={t.hash} label="Hash" value={`${probe.predictionHash.slice(0, 20)}…`} note="sha256 of the prediction" />
              <DetailRow at={t.before} label="Call returned" value={probe.ranAt ? `${probe.ranAt.slice(11, 23)} UTC` : "—"} note={`probe span ${probeSpan.id.slice(0, 8)} · time from the run bundle`} />
              {probeInc && probeInc.expected !== null && (
                <DetailRow at={t.before + 20} label="Docs vs API" value={`docs ${probeInc.expected} · API ${probeInc.observed}`} note="the run's checker record" />
              )}
              <DetailRow at={t.inconclusive} label="Verdict" pill={<Pill tone="held" size={18}>{String(probeSpan.attrs["notary.verdict"] ?? probe.verdict)}</Pill>} note="local receipt of this span" />
              {probeInc && (
                <DetailRow at={t.abstained} label="Resolution" pill={<Pill tone="unsafe" size={18}>Open — Not certified (too little evidence)</Pill>} note={`incident ${probeInc.id}`} />
              )}
            </DetailPanel>
          )}
        </div>
      )}

      <ClipShot
        shot={t.shots[0]!}
        fallback={
          <DataFrame title="Incidents · notarize-crustdata-20261012T011404Z" source={`Rendered from ${A.data.incidentsSource.split(", ")[0]}`}>
            <div style={{ padding: "28px 34px", display: "flex", flexDirection: "column", gap: 14 }}>
              {openIncs.map((i, k) => (
                <div key={i.id} style={{ opacity: p(frame, t.open + k * 6, 12) }}>
                  <IncidentRow incident={i} />
                </div>
              ))}
            </div>
          </DataFrame>
        }
      />

      {frame >= dodoFrom && (
        <div style={{ position: "absolute", inset: 0, opacity: p(frame, dodoFrom, 12) }}>
          <TraceView trace={dodo} title="neatlogs trace · Dodo run" collapse={["notary.recon", "notary.probe"]} reveal={p(frame, dodoFrom + 2, 24)} highlight={advHi} dim={p(frame, t.narrowing - 4, 10)} />
          {frame >= t.narrowing + 10 && (
            <DetailPanel at={t.narrowing + 10} title={frame >= t.resolved ? "Resolution" : "Adversary verdicts"} width={frame >= t.resolved ? 860 : 700}>
              {frame < t.resolved ? (
                <>
                  {advSpans.map((a, k) => (
                    <DetailRow
                      key={a.id}
                      at={t.narrowing + 12 + k * 5}
                      label={String(a.attrs["notary.claimId"] ?? "").replace(/^dodo\./, "")}
                      pill={<Pill tone={wallet && a.id === wallet.id && frame >= t.wallet ? "accent" : "neutral"} size={16}>{String(a.attrs["notary.verdict"] ?? "—")}</Pill>}
                      note={a.origin === "receipt" ? "local receipt only (not in the API response)" : "verdict from the span's local receipt"}
                      mono
                    />
                  ))}
                  {walletInc && frame >= t.wallet && <DetailNote at={t.wallet + 8}>{walletInc.resolution.summary.match(/\(([^)]*)\)/)?.[1] ?? walletInc.resolution.summary}</DetailNote>}
                </>
              ) : (
                dodoIncs.map((i, k) => (
                  <DetailRow key={i.id} at={t.resolved + k * 5} label={(i.claimId ?? "").replace(/^dodo\./, "")} pill={<Pill tone="safe" size={15}>Resolved — Certified only within the narrowed scope</Pill>} note={`incident ${i.id}`} mono />
                ))
              )}
            </DetailPanel>
          )}
        </div>
      )}
    </SceneShell>
  );
}

function DetailPanel({ at, title, children, width = 640 }: { at: number; title: string; children: React.ReactNode; width?: number }) {
  const frame = useCurrentFrame();
  const a = p(frame, at, 14);
  return (
    <div style={{ position: "absolute", right: 96, top: 300, width, opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
      <Panel style={{ padding: "22px 26px", boxShadow: "0 30px 80px rgb(11 15 25 / 0.18)" }}>
        <div style={{ fontFamily: MONO, fontSize: 17, color: C.muted, marginBottom: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
      </Panel>
    </div>
  );
}

function DetailRow({ at, label, value, pill, note, mono }: { at: number; label: string; value?: string; pill?: React.ReactNode; note?: string; mono?: boolean }) {
  const frame = useCurrentFrame();
  const a = p(frame, at - 2, 10);
  if (a <= 0) return null;
  return (
    <div style={{ opacity: a, transform: `translateY(${(1 - a) * 10}px)`, padding: "10px 14px", borderRadius: 12, background: C.subtle }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ fontFamily: mono ? MONO : SANS, fontSize: mono ? 17 : 18, fontWeight: 600, color: C.strongMuted, minWidth: mono ? 0 : 170 }}>{label}</span>
        <span style={{ marginLeft: "auto" }}>{pill ?? <span style={{ fontFamily: MONO, fontSize: 19, color: C.text }}>{value}</span>}</span>
      </div>
      {note && <div style={{ fontFamily: SANS, fontSize: 14, color: C.muted, marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function DetailNote({ at, children }: { at: number; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const a = p(frame, at, 12);
  return <div style={{ opacity: a, ...display, fontSize: 30, color: C.accentText, padding: "8px 4px 0" }}>“{children}”</div>;
}

