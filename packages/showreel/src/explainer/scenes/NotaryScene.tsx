// 03 · What Notary does. The five-step bar (Read · Test · Challenge · Certify · Enforce) as a motion
// graphic, docking to the top as the recordings cut in on the words: the committed prediction, the
// Adversary's review, the certificates. The rule itself ("no certificate, no money moves") is a
// diagram — a money action, the Guard's check, held for a person — with no numbers on it.
import { useCurrentFrame } from "remotion";
import { C, CAMERA, IN, LINE, MONO, SANS, display, mix, p } from "../../theme";
import { CARD, ClipShot, Kinetic, Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { CertTile, DataFrame, IncidentRow } from "./records";

const STEPS = ["Read", "Test", "Challenge", "Certify", "Enforce"] as const;
const WIDTH = 1360;

function StepBar() {
  const frame = useCurrentFrame();
  const t = P.notary;
  const at = [t.read, t.test, t.challenge, t.certify, t.enforce];
  const preview = (i: number) => p(frame, 14 + i * 9, 12);
  const dock = p(frame, t.read - 16, 22, CAMERA);
  const big = { x: 160, y: 470, w: 1600, font: 54, bar: 10 };
  const small = { x: 560, y: 44, w: 1240, font: 22, bar: 6 };
  const g = { x: mix(dock, big.x, small.x), y: mix(dock, big.y, small.y), w: mix(dock, big.w, small.w), font: mix(dock, big.font, small.font), bar: mix(dock, big.bar, small.bar) };
  const gap = mix(dock, 36, 18);
  const w = (g.w - gap * 4) / 5;
  return (
    <>
      <div style={{ position: "absolute", left: 160, top: 270, opacity: 1 - dock, transform: `translateY(${-dock * 40}px)` }}>
        <Kinetic id="notary" phrase="won't touch money until it has proven how its tools behave." size={76} emphasis={["proven"]} at={20} lineBreakAfter={[4]} />
      </div>
      {STEPS.map((label, i) => {
        const started = frame >= at[i]!;
        const next = at[i + 1] ?? section("notary").dur + 30;
        const fill = dock < 1 ? preview(i) * (1 - dock) : p(frame, at[i]!, Math.max(8, next - at[i]!), LINE);
        const done = dock >= 1 && frame >= next;
        const active = dock >= 1 && started && !done;
        const pop = active ? Math.sin(Math.PI * p(frame, at[i]!, 12)) : 0;
        return (
          <div key={label} style={{ position: "absolute", left: g.x + i * (w + gap), top: g.y, width: w, opacity: p(frame, 6 + i * 3, 12), transform: `translateY(${-pop * 4}px)` }}>
            <div style={{ fontFamily: SANS, fontSize: g.font, color: active || done || dock < 1 ? C.text : C.muted, fontWeight: active ? 650 : 500, display: "flex", alignItems: "baseline", gap: g.font * 0.35 }}>
              <span style={{ fontSize: g.font * 0.55, color: active ? C.accent : C.faint, fontWeight: 600 }}>{i + 1}</span>
              {label}
            </div>
            <div style={{ position: "relative", marginTop: g.font * 0.32, height: g.bar, borderRadius: g.bar / 2, background: C.hairline, overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, background: done ? C.strongMuted : C.accent, transformOrigin: "0 50%", transform: `scaleX(${done ? 1 : fill})` }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export function NotaryScene() {
  const frame = useCurrentFrame();
  const s = section("notary");
  const t = P.notary;
  const [transcript, adversary, grid, held] = P.notary.shots;
  const crust = A.data.traces.find((x) => x.runId?.startsWith("notarize-crustdata"));
  const probe = crust?.probes.find((x) => x.id.endsWith("p001"));
  const wallet = A.data.certificates.find((c) => c.claimId === "dodo.wallet.credit-amount-minor-units");
  const walletInc = A.data.incidents.find((i) => i.claimId === wallet?.claimId);
  const top = 128;
  return (
    <SceneShell id="notary" dur={s.dur}>
      <StepBar />

      <ClipShot
        shot={transcript!}
        width={WIDTH}
        frameStyle={{ top }}
        fallback={
          probe && (
            <DataFrame width={WIDTH} title={`Probe ${probe.id.split("-").at(-1)} · ${probe.claimId}`} source="Rendered from the run bundle">
              <div style={{ padding: "40px 48px", fontFamily: MONO, fontSize: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                <span>Prediction committed {probe.committedAt.slice(11, 23)} UTC</span>
                <span>sha256 {probe.predictionHash}</span>
                <span>Call ran {probe.ranAt?.slice(11, 23)} UTC</span>
              </div>
            </DataFrame>
          )
        }
      />
      <ClipShot
        shot={adversary!}
        width={WIDTH}
        frameStyle={{ top }}
        fallback={
          wallet && (
            <DataFrame width={WIDTH} title={`Certificate ${wallet.id}`} source="Rendered from the certificates">
              <div style={{ padding: "36px 44px", display: "grid", gridTemplateColumns: "520px 1fr", gap: 30 }}>
                <CertTile c={wallet} appear={1} />
                {walletInc && <IncidentRow incident={walletInc} />}
              </div>
            </DataFrame>
          )
        }
      />
      <ClipShot
        shot={grid!}
        width={WIDTH}
        frameStyle={{ top }}
        fallback={
          <DataFrame width={WIDTH} title={`Certificates · ${A.data.certificates.length} certified`} source="Rendered from the certificates">
            <div style={{ padding: "28px 34px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
              {A.data.certificates.map((c) => (
                <CertTile key={c.id} c={c} appear={1} />
              ))}
            </div>
          </DataFrame>
        }
      />

      <ClipShot shot={held!} width={WIDTH} frameStyle={{ top }} fallback={null} />
    </SceneShell>
  );
}

