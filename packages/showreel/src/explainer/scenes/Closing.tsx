// 04 · Entire, 05 · cfo.ai, 06 · the close. Entire's checkpoints and the real `notary guards
// coverage --backend entire` output; the economics recording with the per-run cost and the cfo.ai
// export; the evaluation-suite result (labelled) and the closing sky.
import { useCurrentFrame } from "remotion";
import { C, CAMERA, IN, MONO, SANS, display, mix, p } from "../../theme";
import { ClipShot, Kicker, Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { CheckpointList, DataFrame, Terminal } from "./records";
import { CloseSky } from "./Sky";

const COVERAGE_COMMAND = "pnpm notary guards coverage --backend entire";
const isZeroLine = (l: string) => /\b0 UNGUARDED\b|unguarded_call_sites = 0/.test(l);

export function EntireScene() {
  const frame = useCurrentFrame();
  const s = section("entire");
  const t = P.entire;
  const e = A.data.entire;
  const cov = A.data.coverage;
  const toSide = p(frame, t.graph - 6, 22, CAMERA);
  const term = p(frame, t.graph - 2, 18);
  const lines = cov?.lines ?? [];
  const typed = p(frame, t.graph + 8, 22);
  // All but the two total lines stream before the voice says "zero"; the totals land on it.
  const body = Math.max(1, lines.length - 2);
  const streamed = frame >= t.zero - 2 ? 1 : (p(frame, t.graph + 32, Math.max(20, t.zero - t.graph - 40), (x) => x) * body) / lines.length;
  const zero = p(frame, t.zero, 14);
  const zeroLine = lines.find((l) => /unguarded_call_sites = 0/.test(l));
  return (
    <SceneShell dur={s.dur}>
      <Kicker n="4" label="Entire" />
      <div style={{ position: "absolute", left: mix(toSide, 410, 120), top: mix(toSide, 150, 190), transformOrigin: "0 0", transform: `scale(${mix(toSide, 1, 0.62)})`, opacity: mix(toSide, 1, 0.55) }}>
        <CheckpointList checkpoints={e.checkpoints} reveal={p(frame, t.seven - 4, 30)} source={e.source.replace(/^packages\/showreel\//, "")} />
      </div>
      {term > 0 && (
        <div style={{ position: "absolute", left: 640, top: 128, opacity: term, transform: `translateY(${(1 - term) * 40}px)` }}>
          {cov ? (
            <Terminal title={`entire ${e.cliVersion ?? ""} · code graph`.trim()} command={COVERAGE_COMMAND} lines={lines} typed={typed} streamed={streamed} highlight={isZeroLine} rows={22} width={1180} />
          ) : (
            e.coverage && (
              <Panel style={{ width: 1100, padding: 40 }}>
                <div style={{ ...display, fontSize: 48 }}>Guard coverage (Entire code graph)</div>
                <div style={{ fontFamily: SANS, fontSize: 24, marginTop: 16, color: C.strongMuted }}>
                  {e.coverage.sites} call sites · {e.coverage.guarded} guarded · {e.coverage.rawByDesign} raw by design · {e.coverage.unguardedCallSites} unguarded
                </div>
                <div style={{ fontFamily: SANS, fontSize: 16, marginTop: 10, color: C.muted }}>From {e.source} (commit {e.coverage.commit.slice(0, 7)})</div>
              </Panel>
            )
          )}
        </div>
      )}
      {zero > 0 && zeroLine && (
        <div style={{ position: "absolute", right: 130, bottom: 210, opacity: zero, transform: `scale(${mix(zero, 1.25, 1)}) rotate(${mix(zero, -6, -2)}deg)`, transformOrigin: "50% 50%" }}>
          <Panel style={{ padding: "18px 28px", border: `2px solid ${C.certified}`, background: C.certifiedBg, display: "flex", alignItems: "baseline", gap: 16 }}>
            <span style={{ ...display, fontSize: 92, color: C.certifiedText, lineHeight: 1 }}>0</span>
            <span style={{ fontFamily: SANS, fontSize: 28, fontWeight: 600, color: C.certifiedText }}>unguarded call sites</span>
          </Panel>
        </div>
      )}
    </SceneShell>
  );
}

const usd = (v: number) => `$${v.toFixed(4)}`;
const credits = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} credits`;

export function CfoScene() {
  const frame = useCurrentFrame();
  const s = section("cfo");
  const t = P.cfo;
  const e = A.data.economics;
  const shot = P.cfo.shots[0]!;
  const exp = p(frame, t.exports - 4, 18);
  const chips = [
    { at: t.cents, label: "per live run", value: `${usd(e.costPerRun.usd)} + ${credits(e.costPerRun.credits)}` },
    { at: t.credits + 18, label: "per certificate", value: `${usd(e.costPerCertificate.usd)} + ${credits(e.costPerCertificate.credits)}` },
  ];
  return (
    <SceneShell dur={s.dur}>
      <Kicker n="5" label="cfo.ai" />
      <div style={{ position: "absolute", inset: 0, opacity: 1 - exp * 0.75, transform: `translateX(${-exp * 260}px) scale(${mix(exp, 1, 0.86)})`, transformOrigin: "0 50%" }}>
        <ClipShot
          shot={shot}
          fallback={
            <DataFrame title="Business · unit economics" source={`Rendered from ${e.source.replace(/^packages\/showreel\//, "")}`}>
              <div style={{ padding: "50px 60px", fontFamily: SANS, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                {[
                  ["Cost per live run", `${usd(e.costPerRun.usd)}`, `+ ${credits(e.costPerRun.credits)} · ${e.liveRuns} live runs`],
                  ["Cost per certificate", `${usd(e.costPerCertificate.usd)}`, `+ ${credits(e.costPerCertificate.credits)} · ${e.certified.reduce((n, c) => n + c.certified, 0)} certificates`],
                ].map(([k, v, n]) => (
                  <Panel key={k} style={{ padding: "26px 30px" }}>
                    <div style={{ fontSize: 18, color: C.muted, fontWeight: 600 }}>{k}</div>
                    <div style={{ ...display, fontSize: 72, marginTop: 6 }}>{v}</div>
                    <div style={{ fontSize: 18, color: C.strongMuted }}>{n}</div>
                  </Panel>
                ))}
              </div>
            </DataFrame>
          }
          overlay={
            <div style={{ position: "absolute", right: -40, bottom: -22, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
              {chips.map((c) => {
                const a = p(frame, c.at - 2, 12);
                if (a <= 0) return null;
                return (
                  <div key={c.label} style={{ opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
                    <Panel style={{ padding: "14px 22px", display: "flex", alignItems: "baseline", gap: 14 }}>
                      <span style={{ ...display, fontSize: 40, color: C.text }}>{c.value}</span>
                      <span style={{ fontFamily: SANS, fontSize: 20, color: C.muted, fontWeight: 600 }}>{c.label}</span>
                    </Panel>
                  </div>
                );
              })}
            </div>
          }
        />
      </div>
      {exp > 0 && (
        <div style={{ position: "absolute", left: 700, top: 200, width: 1100, opacity: exp, transform: `translateX(${(1 - exp) * 80}px)` }}>
          <Panel style={{ padding: "30px 34px", boxShadow: "0 30px 80px rgb(11 15 25 / 0.18)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ ...display, fontSize: 52 }}>Exported for cfo.ai</span>
              <span style={{ marginLeft: "auto" }}>
                <Pill tone="accent" size={18}>
                  real runs only
                </Pill>
              </span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 24, color: C.accentText, marginTop: 10 }}>{e.exportPath}</div>
            <div style={{ marginTop: 18, borderRadius: 12, background: "#0E1422", padding: "16px 18px", fontFamily: MONO, fontSize: 14, lineHeight: "24px", color: "#C9D2E3" }}>
              {e.exportHead.map((l, i) => (
                <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: i === 0 ? "#7DD3FC" : undefined, opacity: p(frame, t.exports + 6 + i * 4, 8) }}>
                  {l}
                </div>
              ))}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 17, color: C.muted, marginTop: 14 }}>One row per real run: model USD by role, tokens, Crustdata credits. {e.planImported ? "" : "No cfo.ai plan imported yet."}</div>
          </Panel>
        </div>
      )}
    </SceneShell>
  );
}

export function CloseScene() {
  const frame = useCurrentFrame();
  const s = section("close");
  const t = P.close;
  const ev = A.data.evalSuite;
  const out = p(frame, t.sky + 6, 18, IN);
  const nine = p(frame, t.nine - 2, 14);
  const zero = p(frame, t.zero - 2, 14);
  const held = p(frame, t.held - 2, 14);
  return (
    <>
      <SceneShell dur={s.dur}>
        <Kicker n="6" label="Result" />
        <div style={{ position: "absolute", inset: 0, opacity: 1 - out }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 150, display: "flex", justifyContent: "center", opacity: p(frame, 4, 14) }}>
            <Pill tone="held" size={26}>
              {ev.label}
            </Pill>
          </div>
          <div style={{ position: "absolute", left: 160, right: 160, top: 260, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 36 }}>
            <Stat label="Without Notary" sub="unsafe money moves" value={Math.round(ev.naiveUnsafe * nine)} shown={nine} tone={C.unsafeText} bg={C.unsafeBg} />
            <Stat label="With Notary" sub="unsafe money moves" value={ev.guardedUnsafe} shown={zero} tone={C.certifiedText} bg={C.certifiedBg} />
            <Stat label="With Notary" sub="refunds held for review" value={Math.round(ev.held * held)} shown={held} tone={C.heldText} bg={C.heldBg} />
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 700, textAlign: "center", fontFamily: SANS, fontSize: 19, color: C.muted, opacity: p(frame, 10, 14) }}>
            {ev.queueSize !== null ? `${ev.queueSize} queued requests per run · ` : ""}source: {ev.source}
          </div>
        </div>
      </SceneShell>
      <CloseSky github={A.data.github} credit="Voice: ElevenLabs" />
    </>
  );
}

function Stat({ label, sub, value, shown, tone, bg }: { label: string; sub: string; value: number; shown: number; tone: string; bg: string }) {
  return (
    <Panel style={{ padding: "30px 34px", background: shown > 0 ? bg : C.page, opacity: mix(shown, 0.35, 1), transform: `translateY(${(1 - shown) * 16}px)` }}>
      <div style={{ fontFamily: SANS, fontSize: 26, fontWeight: 600, color: C.strongMuted }}>{label}</div>
      <div style={{ ...display, fontSize: 220, lineHeight: 1, color: tone, marginTop: 8 }}>{shown > 0 ? value : "–"}</div>
      <div style={{ fontFamily: SANS, fontSize: 24, color: C.strongMuted, marginTop: 6 }}>{sub}</div>
    </Panel>
  );
}
