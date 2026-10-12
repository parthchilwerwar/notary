// 01 · The problem. A short typographic open (agents move money, they learn from docs, docs and APIs
// disagree), then the real Crustdata run: the recording of its checker anomalies, with the three
// mismatches called out as the voice names them. Every status code is read from the run's records.
import { useCurrentFrame } from "remotion";
import { C, IN, MONO, SANS, display, p } from "../../theme";
import { ClipShot, Kicker, Panel, Pill, SceneShell } from "../kit";
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
  const chipAt = [t.live, t.three, t.separate];
  const introOut = p(frame, t.clipIn - 10, 12, IN);
  const sentence2 = p(frame, t.docs - 4, 14);
  return (
    <SceneShell dur={s.dur} fadeIn={false}>
      <Kicker n="1" label="The problem" at={4} />

      {/* Typographic open. */}
      {introOut < 1 && (
        <div style={{ position: "absolute", inset: 0, opacity: 1 - introOut }}>
          <div style={{ position: "absolute", left: 160, top: 210, width: 1600, ...display, fontSize: 92, color: C.text, opacity: p(frame, 2, 14) * (1 - sentence2 * 0.65) }}>
            AI agents are starting to move <span style={{ fontStyle: "italic" }}>real money</span>.
          </div>
          <div style={{ position: "absolute", left: 160, top: 340, display: "flex", gap: 18 }}>
            {[
              ["Refunds", t.refunds],
              ["Plan changes", t.plan],
              ["Credits", t.credits],
            ].map(([label, at]) => {
              const k = p(frame, (at as number) - 3, 12);
              return (
                <div key={label as string} style={{ opacity: k * (1 - sentence2 * 0.65), transform: `translateY(${(1 - k) * 16}px) scale(${0.94 + 0.06 * k})` }}>
                  <Pill tone="accent" size={30}>
                    {label as string}
                  </Pill>
                </div>
              );
            })}
          </div>
          {/* Docs vs live API: two cards and the sign between them. */}
          <div style={{ position: "absolute", left: 160, top: 480, width: 1600, height: 380, opacity: sentence2, transform: `translateY(${(1 - sentence2) * 30}px)` }}>
            <DocVsLive disagree={p(frame, t.disagree - 2, 12)} />
          </div>
        </div>
      )}

      <ClipShot
        shot={t.shots[0]!}
        fallback={
          <DataFrame title="Run · notarize-crustdata-20261012T011404Z" source={`Rendered from ${A.data.incidentsSource.split(", ")[0]}`}>
            <div style={{ padding: "26px 34px", fontFamily: SANS }}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted }}>Checker anomalies · live run</div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                {ordered.map((i) => (
                  <IncidentRow key={i.id} incident={i} />
                ))}
              </div>
            </div>
          </DataFrame>
        }
        overlay={
          <div style={{ position: "absolute", right: -40, bottom: -22, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
            {ordered.map((i, k) => {
              const a = p(frame, chipAt[k]! - 2, 12);
              if (a <= 0) return null;
              return (
                <div key={i.id} style={{ opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
                  <Panel style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                    <span style={{ fontFamily: MONO, fontSize: 19, color: C.strongMuted }}>{shortClaim(i.claimId!)}</span>
                    <Pill tone="neutral" size={20}>
                      Docs: {i.expected}
                    </Pill>
                    <Pill tone="unsafe" size={20}>
                      Live: {i.observed}
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

/** Two generic cards — what the docs promise, what the live API does — and ≠ between them. Decorative: no data. */
function DocVsLive({ disagree }: { disagree: number }) {
  const lines = (n: number, color: string) =>
    Array.from({ length: n }, (_, i) => <div key={i} style={{ height: 14, borderRadius: 7, background: color, width: `${[86, 64, 78, 52, 70][i % 5]}%`, marginTop: 18 }} />);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 60 }}>
      <Panel style={{ width: 640, height: 300, padding: "30px 36px" }}>
        <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: C.text }}>API docs</div>
        <div style={{ fontFamily: SANS, fontSize: 22, color: C.muted, marginTop: 6 }}>What the agent learns</div>
        {lines(4, C.mutedSurface)}
      </Panel>
      <div style={{ width: 120, textAlign: "center", ...display, fontSize: 150, color: C.unsafe, opacity: disagree, transform: `scale(${0.6 + 0.4 * disagree})` }}>≠</div>
      <Panel style={{ width: 640, height: 300, padding: "30px 36px", background: "#0E1422", borderColor: "#0E1422" }}>
        <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: "#FFFFFF" }}>Live API</div>
        <div style={{ fontFamily: SANS, fontSize: 22, color: "#9AA6BD", marginTop: 6 }}>What actually happens</div>
        {lines(4, "#243049")}
      </Panel>
    </div>
  );
}

