// 06 · Entire, 07 · cfo.ai, 08 · what Notary proved. Entire's checkpoints and the real `notary guards
// coverage --backend entire` output; the economics recording (camera on the cost figures) and the
// cfo.ai export; the real results as kinetic type with count-ups, then the closing sky.
import { useCurrentFrame } from "remotion";
import { C, CAMERA, IN, MONO, SANS, display, mix, p } from "../../theme";
import { ClipShot, Kinetic, Panel, Pill, SceneShell } from "../kit";
import { closeStats, P } from "../plan";
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
  const body = Math.max(1, lines.length - 2);
  const streamed = frame >= t.zero - 2 ? 1 : (p(frame, t.graph + 32, Math.max(20, t.zero - t.graph - 40), (x) => x) * body) / lines.length;
  const zero = p(frame, t.zero, 14);
  const zeroLine = lines.find((l) => /unguarded_call_sites = 0/.test(l));
  return (
    <SceneShell id="entire" dur={s.dur}>
      <div style={{ position: "absolute", left: mix(toSide, 410, 120), top: mix(toSide, 150, 190), transformOrigin: "0 0", transform: `scale(${mix(toSide, 1, 0.62)}) rotateY(${toSide * 6}deg)`, opacity: mix(toSide, 1, 0.5) }}>
        <CheckpointList checkpoints={e.checkpoints} reveal={p(frame, t.seven - 4, 30)} source={e.source.replace(/^packages\/showreel\//, "")} />
      </div>
      {term > 0 && (
        <div style={{ position: "absolute", left: 640, top: 128, opacity: term, transform: `translateY(${(1 - term) * 50}px) scale(${mix(term, 0.96, 1)})` }}>
          {cov && <Terminal title={`entire ${e.cliVersion ?? ""} · code graph`.trim()} command={COVERAGE_COMMAND} lines={lines} typed={typed} streamed={streamed} highlight={isZeroLine} rows={22} width={1180} />}
        </div>
      )}
      {zero > 0 && zeroLine && (
        <div style={{ position: "absolute", right: 130, bottom: 210, opacity: zero, transform: `scale(${mix(zero, 1.4, 1)}) rotate(${mix(zero, -8, -2)}deg)`, transformOrigin: "50% 50%" }}>
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
  const exp = p(frame, t.exports - 4, 18, CAMERA);
  // The export, as columns of the real file (run, stage, spend, tokens, credits, beliefs).
  const head = e.exportHead.map((l) => l.split(","));
  const cols = ["run_id", "stage", "model_usd", "tokens", "crustdata_credits", "notarized_beliefs"];
  const idx = cols.map((c) => head[0]?.indexOf(c) ?? -1);
  const rows = head.slice(1).map((r) => idx.map((i) => (i >= 0 ? (r[i] ?? "") : "")));
  const figures = [
    { label: "per run", usd: e.costPerRun.usd, credits: e.costPerRun.credits, at: t.cents },
    { label: "per certificate", usd: e.costPerCertificate.usd, credits: e.costPerCertificate.credits, at: t.credits + 24 },
  ];
  return (
    <SceneShell id="cfo" dur={s.dur}>
      <div style={{ position: "absolute", inset: 0, opacity: 1 - exp, transform: `translateY(${-exp * 200}px) scale(${mix(exp, 1, 0.8)})`, transformOrigin: "50% 0" }}>
        <div style={{ position: "absolute", left: 160, top: 170 }}>
          <Kinetic id="cfo" phrase="measures what certainty costs:" size={84} emphasis={["certainty"]} at={30} />
        </div>
        <div style={{ position: "absolute", left: 160, top: 340, display: "flex", gap: 40 }}>
          {figures.map((f) => {
            const a = p(frame, f.at - 6, 14);
            return (
              <div key={f.label} style={{ opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
                <Panel style={{ width: 760, padding: "34px 40px" }}>
                  <div style={{ fontFamily: SANS, fontSize: 26, fontWeight: 600, color: C.muted }}>Cost {f.label}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 6 }}>
                    <CountUp value={f.usd} decimals={4} prefix="$" at={f.at - 2} size={150} />
                    <span style={{ ...display, fontSize: 54, color: C.strongMuted }}>model spend</span>
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 30, color: C.text, marginTop: 10, opacity: p(frame, f.at + 14, 12) }}>+ {credits(f.credits)} on Crustdata</div>
                </Panel>
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", left: 160, top: 760, fontFamily: SANS, fontSize: 20, color: C.faint, opacity: p(frame, t.cents, 12) }}>
          Averaged over the {e.liveRuns} runs that spent; read from {e.source.replace(/^packages\/showreel\/explainer\/data\//, "")}
        </div>
      </div>
      {exp > 0 && (
        <div style={{ position: "absolute", left: 160, top: 200, width: 1600, opacity: exp, transform: `translateY(${(1 - exp) * 120}px)` }}>
          <Panel style={{ padding: "32px 38px", boxShadow: "0 30px 80px rgb(11 15 25 / 0.18)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
              <span style={{ ...display, fontSize: 64 }}>Exported for cfo.ai</span>
              <span style={{ fontFamily: MONO, fontSize: 28, color: C.accentText }}>{e.exportPath}</span>
            </div>
            <div style={{ marginTop: 22, borderRadius: 14, background: "#0E1422", padding: "18px 24px", fontFamily: MONO, fontSize: 21, lineHeight: "40px", color: "#C9D2E3" }}>
              <div style={{ display: "grid", gridTemplateColumns: "520px 200px 150px 110px 250px 1fr", color: "#7DD3FC" }}>
                {cols.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              {rows.map((r, i) => {
                const k = p(frame, t.exports + 8 + i * 5, 10);
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "520px 200px 150px 110px 250px 1fr", opacity: k, transform: `translateX(${(1 - k) * 20}px)` }}>
                    {r.map((v, j) => (
                      <span key={j} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
                    ))}
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 20, color: C.muted, marginTop: 14 }}>Columns from the file: one row per run, the numbers straight from the run bundles.</div>
          </Panel>
        </div>
      )}
    </SceneShell>
  );
}

/** A number that counts up to its value (eased), with a pop when it lands. */
function CountUp({ value, decimals, prefix, at, size }: { value: number; decimals: number; prefix: string; at: number; size: number }) {
  const frame = useCurrentFrame();
  const k = p(frame, at, 20, (x) => 1 - (1 - x) ** 3);
  const land = Math.sin(Math.PI * p(frame, at + 18, 12));
  const shown = value * k;
  return (
    <span style={{ ...display, fontSize: size, lineHeight: 1, color: C.accentText, display: "inline-block", whiteSpace: "nowrap", minWidth: size * 0.7, transform: `scale(${1 + land * 0.08})`, transformOrigin: "100% 80%", fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {decimals ? shown.toFixed(decimals) : Math.round(shown)}
    </span>
  );
}

export function CloseScene() {
  const frame = useCurrentFrame();
  const s = section("close");
  const t = P.close;
  const stats = closeStats();
  const out = p(frame, t.sky + 6, 18, IN);
  return (
    <>
      <SceneShell id="close" dur={s.dur}>
        <div style={{ position: "absolute", inset: 0, opacity: 1 - out, transform: `scale(${1 + out * 0.05})` }}>
          <div style={{ position: "absolute", left: 160, top: 150 }}>
            <Kinetic id="close" phrase="So here is what Notary proved." size={84} emphasis={["proved"]} at={30} />
          </div>
          {stats.map((st, i) => {
            const a = p(frame, st.at - 6, 14);
            const dim = stats[i + 1] ? p(frame, stats[i + 1]!.at - 4, 12) * 0.35 : 0;
            if (a <= 0) return null;
            return (
              <div key={st.key} style={{ position: "absolute", left: 160, top: 280 + i * 150, display: "flex", alignItems: "baseline", gap: 34, whiteSpace: "nowrap", opacity: a * (1 - dim), transform: `translateX(${(1 - a) * -50}px)` }}>
                <div style={{ width: 400, textAlign: "right" }}>
                  <CountUp value={st.value} decimals={st.decimals} prefix={st.prefix} at={st.at - 2} size={130} />
                </div>
                <div style={{ ...display, fontSize: 60, color: C.text }}>{st.text}</div>
              </div>
            );
          })}
          <div style={{ position: "absolute", left: 0, right: 0, top: 980, textAlign: "center", fontFamily: SANS, fontSize: 16, color: C.faint, opacity: p(frame, t.three, 12) }}>
            From the runs' incidents, certificates, coverage output and economics.json
          </div>
        </div>
      </SceneShell>
      <CloseSky github={A.data.github} credit="Voice: ElevenLabs" />
    </>
  );
}

