// 02 · The problem. Kinetic type (agents move money, they learn from docs, docs and APIs disagree),
// then the real Crustdata run: the recording of its checker anomalies with callouts drawn onto the
// recorded responses, and the three mismatches stacked as the voice names them. Every status code is
// read from the run's records.
import { useCurrentFrame } from "remotion";
import { C, IN, MONO, SANS, display, p } from "../../theme";
import { ClipShot, Kinetic, Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { DataFrame, IncidentRow } from "./records";

const shortClaim = (id: string) => id.replace(/^crustdata\./, "").replace(/-/g, " ").replace(/\.(\w)/g, " · $1");

export function Problem() {
  const frame = useCurrentFrame();
  const s = section("problem");
  const t = P.problem;
  const anomalies = A.data.incidents.filter((i) => i.kind === "checker_anomaly" && i.runId.startsWith("notarize-crustdata"));
  // Spoken order: the two "no match" lookups (docs 200), then the invalid-fields one.
  const ordered = [...anomalies].sort((a, b) => (a.expected === 200 ? 0 : 1) - (b.expected === 200 ? 0 : 1) || a.claimId!.localeCompare(b.claimId!));
  const chipAt = [t.three, t.three + 8, t.three + 16];
  const introOut = p(frame, t.clipIn - 10, 12, IN);
  const sentence2 = p(frame, t.docs - 4, 14);
  return (
    <SceneShell id="problem" dur={s.dur}>
      {introOut < 1 && (
        <div style={{ position: "absolute", inset: 0, opacity: 1 - introOut, transform: `scale(${1 + introOut * 0.06})`, transformOrigin: "50% 60%" }}>
          <div style={{ position: "absolute", left: 160, top: 200, width: 1600, opacity: 1 - sentence2 * 0.6, transform: `translateY(${-sentence2 * 40}px) scale(${1 - sentence2 * 0.12})`, transformOrigin: "0 0" }}>
            <Kinetic id="problem" phrase="AI agents are starting to move real money:" size={100} emphasis={["real", "money"]} at={30} />
          </div>
          <div style={{ position: "absolute", left: 160, top: 350, display: "flex", gap: 18, opacity: 1 - sentence2 * 0.6, transform: `translateY(${-sentence2 * 60}px)` }}>
            {[
              ["Refunds", t.refunds],
              ["Plan changes", t.plan],
              ["Credits", t.credits],
            ].map(([label, at]) => {
              const k = p(frame, (at as number) - 3, 12);
              return (
                <div key={label as string} style={{ opacity: k, transform: `translateY(${(1 - k) * 22}px) scale(${0.9 + 0.1 * k})` }}>
                  <Pill tone="accent" size={32}>
                    {label as string}
                  </Pill>
                </div>
              );
            })}
          </div>
          <div style={{ position: "absolute", left: 160, top: 470, width: 1600, opacity: sentence2, transform: `translateY(${(1 - sentence2) * 40}px)` }}>
            <DocVsApi frame={frame} docs={t.docs} disagree={t.disagree} />
          </div>
        </div>
      )}

      <ClipShot
        shot={t.shots[0]!}
        fallback={
          <DataFrame title="Run · notarize-crustdata-20261012T011404Z" source={`Rendered from ${A.data.incidentsSource.split(", ")[0]}`}>
            <div style={{ padding: "26px 34px", fontFamily: SANS, display: "flex", flexDirection: "column", gap: 12 }}>
              {ordered.map((i) => (
                <IncidentRow key={i.id} incident={i} />
              ))}
            </div>
          </DataFrame>
        }
        overlay={
          <div style={{ position: "absolute", right: -60, bottom: -30, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
            {ordered.map((i, k) => {
              const a = p(frame, chipAt[k]! - 2, 12);
              if (a <= 0) return null;
              return (
                <div key={i.id} style={{ opacity: a, transform: `translateX(${(1 - a) * 60}px)` }}>
                  <Panel style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                    <span style={{ fontFamily: MONO, fontSize: 18, color: C.strongMuted }}>{shortClaim(i.claimId!)}</span>
                    <Pill tone="neutral" size={19}>
                      Docs: {i.expected}
                    </Pill>
                    <Pill tone="unsafe" size={19}>
                      API: {i.observed}
                    </Pill>
                  </Panel>
                </div>
              );
            })}
          </div>
        }
      />
    </SceneShell>
  );
}

/** Two generic cards — what the docs promise, what the API does — and ≠ drawn between them. Decorative: no data. */
function DocVsApi({ frame, docs, disagree }: { frame: number; docs: number; disagree: number }) {
  const a = p(frame, docs - 2, 14);
  const b = p(frame, docs + 10, 14);
  const ne = p(frame, disagree - 2, 12);
  const lines = (n: number, color: string, at: number) =>
    Array.from({ length: n }, (_, i) => <div key={i} style={{ height: 14, borderRadius: 7, background: color, width: `${[86, 64, 78, 52, 70][i % 5]! * p(frame, at + i * 3, 12)}%`, marginTop: 18 }} />);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 60 }}>
      <div style={{ opacity: a, transform: `translateX(${(1 - a) * -60}px) rotate(${(1 - ne) * -1}deg)` }}>
        <Panel style={{ width: 640, height: 300, padding: "30px 36px" }}>
          <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: C.text }}>API docs</div>
          <div style={{ fontFamily: SANS, fontSize: 22, color: C.muted, marginTop: 6 }}>What the agent learns</div>
          {lines(4, C.mutedSurface, docs)}
        </Panel>
      </div>
      <div style={{ width: 120, textAlign: "center", ...display, fontSize: 160, color: C.unsafe, opacity: ne, transform: `scale(${0.4 + 0.6 * ne}) rotate(${(1 - ne) * -30}deg)` }}>≠</div>
      <div style={{ opacity: b, transform: `translateX(${(1 - b) * 60}px) rotate(${(1 - ne) * 1}deg)` }}>
        <Panel style={{ width: 640, height: 300, padding: "30px 36px", background: "#0E1422", borderColor: "#0E1422" }}>
          <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: "#FFFFFF" }}>The real API</div>
          <div style={{ fontFamily: SANS, fontSize: 22, color: "#9AA6BD", marginTop: 6 }}>What actually happens</div>
          {lines(4, "#243049", docs + 10)}
        </Panel>
      </div>
    </div>
  );
}
