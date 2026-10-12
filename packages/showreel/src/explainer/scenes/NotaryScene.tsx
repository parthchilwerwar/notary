// 02 · What Notary does. The five-step bar (Read · Test · Challenge · Certify · Enforce) as a motion
// graphic, docking to the top as the recordings cut in on the words: the committed prediction, the
// Adversary's review, the certificates, and the held approval (evaluation suite, labelled).
import { useCurrentFrame } from "remotion";
import showreel from "../../data.json";
import { C, CAMERA, LINE, MONO, SANS, display, mix, p } from "../../theme";
import { ClipShot, Kicker, Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { CertTile, DataFrame, IncidentRow } from "./records";

const STEPS = ["Read", "Test", "Challenge", "Certify", "Enforce"] as const;
const WIDTH = 1360;

function StepBar() {
  const frame = useCurrentFrame();
  const t = P.notary;
  const at = [t.read, t.test, t.challenge, t.certify, t.enforce];
  // Intro preview: the steps light up one after another while the first sentence plays.
  const preview = (i: number) => p(frame, 8 + i * 9, 10);
  const dock = p(frame, t.read - 16, 22, CAMERA);
  const big = { x: 160, y: 470, w: 1600, font: 52, bar: 10 };
  const small = { x: 560, y: 44, w: 1240, font: 22, bar: 6 };
  const g = { x: mix(dock, big.x, small.x), y: mix(dock, big.y, small.y), w: mix(dock, big.w, small.w), font: mix(dock, big.font, small.font), bar: mix(dock, big.bar, small.bar) };
  const gap = mix(dock, 36, 18);
  const w = (g.w - gap * 4) / 5;
  return (
    <>
      <div style={{ position: "absolute", left: 160, top: 290, ...display, fontSize: 84, color: C.text, opacity: p(frame, 2, 14) * (1 - dock), transform: `translateY(${-dock * 40}px)` }}>
        Prove it <span style={{ fontStyle: "italic" }}>first</span>.
      </div>
      {STEPS.map((label, i) => {
        const started = frame >= at[i]!;
        const next = at[i + 1] ?? section("notary").dur + 30;
        const fill = dock < 1 ? preview(i) * (1 - dock) : p(frame, at[i]!, Math.max(8, next - at[i]!), LINE);
        const done = dock >= 1 && frame >= next;
        const active = dock >= 1 && started && !done;
        return (
          <div key={label} style={{ position: "absolute", left: g.x + i * (w + gap), top: g.y, width: w, opacity: p(frame, 4 + i * 3, 12) }}>
            <div style={{ fontFamily: SANS, fontSize: g.font, color: active || done || dock < 1 ? C.text : C.muted, fontWeight: active ? 650 : 500, display: "flex", alignItems: "baseline", gap: g.font * 0.35 }}>
              <span style={{ fontSize: g.font * 0.55, color: C.faint, fontWeight: 500 }}>{i + 1}</span>
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
  const s = section("notary");
  const [transcript, adversary, grid, held] = P.notary.shots;
  const crust = A.data.traces.find((t) => t.runId?.startsWith("notarize-crustdata"));
  const probe = crust?.probes.find((x) => x.id.endsWith("p001"));
  const p001inc = A.data.incidents.find((i) => i.claimId === probe?.claimId && i.kind === "checker_anomaly");
  const wallet = A.data.certificates.find((c) => c.claimId === "dodo.wallet.credit-amount-minor-units");
  const walletInc = A.data.incidents.find((i) => i.claimId === wallet?.claimId);
  const top = 128;
  return (
    <SceneShell dur={s.dur}>
      <Kicker n="2" label="What Notary does" />
      <StepBar />

      <ClipShot
        shot={transcript!}
        width={WIDTH}
        frameStyle={{ top }}
        fallback={
          probe && (
            <DataFrame width={WIDTH} title={`Probe ${probe.id.split("-").at(-1)} · ${probe.claimId}`} source="Rendered from the run bundle">
              <div style={{ padding: "40px 48px", fontFamily: SANS, display: "flex", flexDirection: "column", gap: 18 }}>
                <ReceiptLine label="Prediction committed" value={`${probe.committedAt.slice(11, 23)} UTC`} mono />
                <ReceiptLine label="Prediction hash" value={`sha256 ${probe.predictionHash}`} mono />
                <ReceiptLine label="Live call ran" value={probe.ranAt ? `${probe.ranAt.slice(11, 23)} UTC` : "—"} mono />
                {p001inc && <ReceiptLine label="Docs vs live" value={`docs ${p001inc.expected} · live ${p001inc.observed}`} tone="unsafe" />}
                <ReceiptLine label="Verdict" value={probe.verdict} tone="held" />
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
            <DataFrame width={WIDTH} title={`Certificate ${wallet.id}`} source={`Rendered from ${A.data.certificatesSource.split(", ").at(-1)}`}>
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
        fallback={<CertGridFallback from={grid!.from} />}
      />
      <ClipShot
        shot={held!}
        width={WIDTH}
        frameStyle={{ top }}
        fallback={
          <DataFrame width={WIDTH} title="Approvals · held for a person" source={A.data.evalSuite.source.split(" (")[0]!}>
            <div style={{ padding: "60px 70px", fontFamily: SANS }}>
              <Panel style={{ padding: "26px 30px", background: C.heldBg, borderColor: "#FDE2B3" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <Pill tone="held" size={16}>
                    Held
                  </Pill>
                  <span style={{ fontSize: 22, fontWeight: 600 }}>
                    {showreel.guard.held.type} {showreel.guard.held.requestId} · {showreel.guard.held.amount}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 16, color: C.muted }}>{showreel.guard.held.action}</span>
                </div>
                <div style={{ marginTop: 12, fontSize: 18, color: C.strongMuted }}>{showreel.guard.held.detail}</div>
              </Panel>
            </div>
          </DataFrame>
        }
        overlay={<EvalTag at={held!.from} />}
      />
    </SceneShell>
  );
}

/** The on-screen label every evaluation-suite shot carries. */
export function EvalTag({ at }: { at: number }) {
  const frame = useCurrentFrame();
  const a = p(frame, at + 6, 12);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: -24, display: "flex", justifyContent: "center", opacity: a, transform: `translateY(${(1 - a) * -8}px)` }}>
      <Pill tone="held" size={21} style={{ boxShadow: "0 8px 24px rgb(180 83 9 / 0.18)" }}>
        {A.data.evalSuite.label}
      </Pill>
    </div>
  );
}

function ReceiptLine({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: "unsafe" | "held" }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", alignItems: "center", gap: 20, padding: "16px 20px", background: C.page, border: `1px solid ${C.hairline}`, borderRadius: 14 }}>
      <span style={{ fontSize: 17, fontWeight: 600, color: C.muted }}>{label}</span>
      {tone ? (
        <span>
          <Pill tone={tone} size={18}>
            {value}
          </Pill>
        </span>
      ) : (
        <span style={{ fontFamily: mono ? MONO : SANS, fontSize: 18, color: C.text, wordBreak: "break-all" }}>{value}</span>
      )}
    </div>
  );
}

function CertGridFallback({ from }: { from: number }) {
  const frame = useCurrentFrame();
  const certs = A.data.certificates;
  return (
    <DataFrame width={WIDTH} title={`Certificates · ${certs.length} certified`} source={`Rendered from ${A.data.certificatesSource}`}>
      <div style={{ padding: "28px 34px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
        {certs.map((c, i) => (
          <CertTile key={c.id} c={c} appear={p(frame, from + 6 + i * 5, 12)} />
        ))}
      </div>
    </DataFrame>
  );
}
