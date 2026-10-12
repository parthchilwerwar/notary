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
  const at = [t.read, t.test, t.challenge, t.certify, t.rule];
  const preview = (i: number) => p(frame, CARD.content + 14 + i * 9, 12);
  const dock = p(frame, t.read - 16, 22, CAMERA);
  const big = { x: 160, y: 470, w: 1600, font: 54, bar: 10 };
  const small = { x: 560, y: 44, w: 1240, font: 22, bar: 6 };
  const g = { x: mix(dock, big.x, small.x), y: mix(dock, big.y, small.y), w: mix(dock, big.w, small.w), font: mix(dock, big.font, small.font), bar: mix(dock, big.bar, small.bar) };
  const gap = mix(dock, 36, 18);
  const w = (g.w - gap * 4) / 5;
  return (
    <>
      <div style={{ position: "absolute", left: 160, top: 270, opacity: 1 - dock, transform: `translateY(${-dock * 40}px)` }}>
        <Kinetic id="notary" phrase="won't touch money until it has proven how its tools behave." size={76} emphasis={["proven"]} at={CARD.content} lineBreakAfter={[4]} />
      </div>
      {STEPS.map((label, i) => {
        const started = frame >= at[i]!;
        const next = at[i + 1] ?? section("notary").dur + 30;
        const fill = dock < 1 ? preview(i) * (1 - dock) : p(frame, at[i]!, Math.max(8, next - at[i]!), LINE);
        const done = dock >= 1 && frame >= next;
        const active = dock >= 1 && started && !done;
        const pop = active ? Math.sin(Math.PI * p(frame, at[i]!, 12)) : 0;
        return (
          <div key={label} style={{ position: "absolute", left: g.x + i * (w + gap), top: g.y, width: w, opacity: p(frame, CARD.content + 6 + i * 3, 12), transform: `translateY(${-pop * 4}px)` }}>
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
  const [transcript, adversary, grid] = P.notary.shots;
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

      {frame >= t.rule - 6 && <GuardRule />}
    </SceneShell>
  );
}

/**
 * The rule as a diagram: a money action → the Guard asks for a certificate → none → held for a
 * person. Illustrative (no records, no numbers); every stage lights on its word.
 */
function GuardRule() {
  const frame = useCurrentFrame();
  const t = P.notary;
  const inA = p(frame, t.rule - 6, 14);
  const n1 = p(frame, t.rule + 6, 14);
  const c1 = p(frame, t.enforce - 4, 16, LINE);
  const n2 = p(frame, t.enforce + 4, 14);
  const check = p(frame, t.moves, 12);
  const c2 = p(frame, t.guard - 6, 16, LINE);
  const n3 = p(frame, t.guard + 4, 14);
  const c3 = p(frame, t.person - 10, 14, LINE);
  const n4 = p(frame, t.person, 14);
  // A token travels the path with the action.
  const tok1 = p(frame, t.enforce - 2, 22, CAMERA);
  const tok2 = p(frame, t.guard - 4, 22, CAMERA);
  const tok3 = p(frame, t.person - 8, 18, CAMERA);
  const Y = 640;
  const nodes = { a: { x: 300, y: Y }, g: { x: 860, y: Y }, h: { x: 1330, y: Y + 120 }, ok: { x: 1330, y: Y - 150 }, person: { x: 1700, y: Y + 120 } };
  const seg = (x1: number, y1: number, x2: number, y2: number, k: number, color: string, dashed = false) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={5} strokeLinecap="round" strokeDasharray={dashed ? "2 14" : len} strokeDashoffset={dashed ? 0 : len * (1 - k)} opacity={dashed ? k : 1} />;
  };
  // The token rides the connectors (edge to edge), never over a node's text.
  const tok = tok3 > 0 ? { x: mix(tok3, nodes.h.x + 175, nodes.person.x - 115), y: nodes.h.y } : tok2 > 0 ? { x: mix(tok2, nodes.g.x + 150, nodes.h.x - 175), y: mix(tok2, Y + 30, nodes.h.y) } : { x: mix(tok1, nodes.a.x + 195, nodes.g.x - 165), y: Y };
  const out = p(frame, section("notary").dur, 8, IN);
  return (
    <div style={{ position: "absolute", inset: 0, background: C.page, opacity: inA * (1 - out) }}>
      <div style={{ position: "absolute", left: 160, top: 150 }}>
        <div style={{ fontFamily: SANS, fontSize: 24, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted, opacity: p(frame, t.rule - 4, 12) }}>The rule</div>
        <Kinetic id="notary" phrase="No certificate, no money moves." size={120} emphasis={["certificate", "moves"]} at={t.enforce} style={{ marginTop: 10 }} />
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
        {seg(nodes.a.x + 190, Y, nodes.g.x - 170, Y, c1, C.accent)}
        {seg(nodes.g.x + 150, Y - 30, nodes.ok.x - 170, nodes.ok.y, n2 * (1 - check * 0.6), C.certified, true)}
        {seg(nodes.g.x + 150, Y + 30, nodes.h.x - 170, nodes.h.y, c2, C.held)}
        {seg(nodes.h.x + 170, nodes.h.y, nodes.person.x - 110, nodes.person.y, c3, C.held)}
      </svg>
      <DiagramNode x={nodes.a.x} y={Y} k={n1} w={380} title="A money action" sub="refund · credit · plan change" tone="accent" />
      <DiagramNode x={nodes.g.x} y={Y} k={n2} w={320} title="Guard" sub="a certificate for this?" tone="neutral" mark={check > 0 ? { k: check, ok: false } : undefined} />
      <DiagramNode x={nodes.ok.x} y={nodes.ok.y} k={n2 * (1 - check * 0.55)} w={340} title="Certified" sub="runs as proven" tone="safe" />
      <DiagramNode x={nodes.h.x} y={nodes.h.y} k={n3} w={340} title="No certificate" sub="held — nothing moves" tone="held" />
      <DiagramNode x={nodes.person.x} y={nodes.person.y} k={n4} w={220} title="A person" sub="reviews it" tone="held" person />
      {tok1 > 0 && tok1 < 1 || tok2 > 0 && tok2 < 1 || tok3 > 0 && tok3 < 1 ? (
        <div style={{ position: "absolute", left: tok.x - 14, top: tok.y - 14, width: 28, height: 28, borderRadius: 14, background: tok2 > 0 ? C.held : C.accent, boxShadow: `0 0 0 8px ${tok2 > 0 ? "rgb(217 119 6 / 0.18)" : "rgb(47 106 235 / 0.18)"}` }} />
      ) : null}
      <div style={{ position: "absolute", left: 0, right: 0, top: 930, textAlign: "center", fontFamily: SANS, fontSize: 18, color: C.faint, opacity: n1 }}>Illustration of the Guard's rule</div>
    </div>
  );
}

function DiagramNode({ x, y, k, w, title, sub, tone, mark, person }: { x: number; y: number; k: number; w: number; title: string; sub: string; tone: "accent" | "neutral" | "safe" | "held"; mark?: { k: number; ok: boolean }; person?: boolean }) {
  if (k <= 0) return null;
  const colors = { accent: [C.accentSoft, C.accentText, "#C9DAFB"], neutral: [C.page, C.text, C.hairline], safe: [C.certifiedBg, C.certifiedText, "#BBF7D0"], held: [C.heldBg, C.heldText, "#FDE2B3"] }[tone];
  return (
    <div style={{ position: "absolute", left: x - w / 2, top: y - 70, width: w, opacity: Math.min(1, k * 1.4), transform: `translateY(${(1 - k) * 30}px) scale(${mix(k, 0.85, 1)})` }}>
      <Panel style={{ background: colors[0], borderColor: colors[2], padding: "22px 24px", textAlign: "center", position: "relative" }}>
        {person && (
          <svg width={44} height={44} viewBox="0 0 24 24" style={{ display: "block", margin: "0 auto 6px" }} aria-hidden="true">
            <circle cx="12" cy="8" r="4" fill="none" stroke={colors[1]} strokeWidth="1.8" />
            <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke={colors[1]} strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
        <div style={{ ...display, fontSize: 44, color: colors[1] }}>{title}</div>
        <div style={{ fontFamily: SANS, fontSize: 22, color: C.strongMuted, marginTop: 6 }}>{sub}</div>
        {mark && (
          <div style={{ position: "absolute", right: -22, top: -22, width: 52, height: 52, borderRadius: 26, background: mark.ok ? C.certified : C.unsafe, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: SANS, fontSize: 30, fontWeight: 700, transform: `scale(${mix(mark.k, 0.3, 1) + Math.sin(Math.PI * mark.k) * 0.2})`, opacity: mark.k }}>
            {mark.ok ? "✓" : "✕"}
          </div>
        )}
      </Panel>
    </div>
  );
}

