// 04 · The stack. Text chips (no third-party logos) for each piece, built on the words: Dodo Payments
// and the four real Dodo certificates (public/certificates/dodo.json), Crustdata's role as a diagram,
// the LiteLLM gateway with the models read from the runs' LLM spans, and the AWS deploy kit as it is
// in the repo (deploy/aws/ file names, the deploy doc's title) — nothing implies a running deployment.
import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { C, CAMERA, IN, LINE, MONO, SANS, display, mix, p } from "../../theme";
import { Panel, Pill, SceneShell } from "../kit";
import { P } from "../plan";
import { A, section } from "../timeline";
import { Seal } from "@web/ui";

/** One phase of the scene: slides in from the right, out to the left. */
function Phase({ from, to, children }: { from: number; to: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const a = p(frame, from, 18, CAMERA);
  const b = p(frame, to - 8, 14, IN);
  if (a <= 0 || b >= 1) return null;
  return <div style={{ position: "absolute", inset: 0, opacity: a * (1 - b), transform: `translateX(${(1 - a) * 120 - b * 120}px)` }}>{children}</div>;
}

function Sponsor({ name, role, k, big = false }: { name: string; role: string; k: number; big?: boolean }) {
  return (
    <div style={{ display: "inline-block", opacity: k, transform: `translateY(${(1 - k) * 24}px) scale(${mix(k, 0.9, 1)})`, transformOrigin: "0 50%" }}>
      <div style={{ display: "inline-flex", flexDirection: "column", padding: big ? "22px 34px" : "14px 22px", borderRadius: 22, background: C.text, color: "#FFFFFF", boxShadow: "0 18px 40px rgb(11 15 25 / 0.18)" }}>
        <span style={{ fontFamily: SANS, fontSize: big ? 52 : 32, fontWeight: 650, letterSpacing: "-0.01em" }}>{name}</span>
        <span style={{ fontFamily: SANS, fontSize: big ? 22 : 18, color: "#AEB8CC", marginTop: 4 }}>{role}</span>
      </div>
    </div>
  );
}

function Node({ x, y, w, k, hi, children }: { x: number; y: number; w: number; k: number; hi: number; children: ReactNode }) {
  if (k <= 0) return null;
  return (
    <div style={{ position: "absolute", left: x - w / 2, top: y, width: w, opacity: k, transform: `translateY(${(1 - k) * 26}px) scale(${mix(k, 0.9, 1) + hi * 0.03})` }}>
      <Panel style={{ padding: "22px 24px", textAlign: "center", borderColor: hi > 0 ? C.accent : C.hairline, boxShadow: hi > 0 ? `0 0 0 3px rgb(47 106 235 / ${0.25 * hi}), 0 18px 48px rgb(47 106 235 / 0.12)` : undefined }}>{children}</Panel>
    </div>
  );
}

function Arrow({ x1, x2, y, k }: { x1: number; x2: number; y: number; k: number }) {
  const len = x2 - x1;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} aria-hidden="true">
      <line x1={x1} y1={y} x2={x2 - 12} y2={y} stroke={C.accent} strokeWidth={4} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - k)} />
      <path d={`M ${x2 - 22} ${y - 10} L ${x2 - 6} ${y} L ${x2 - 22} ${y + 10}`} fill="none" stroke={C.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" opacity={k > 0.95 ? 1 : 0} />
    </svg>
  );
}

const nodeTitle = { ...display, fontSize: 40, color: C.text } as const;
const nodeSub = { fontFamily: SANS, fontSize: 20, color: C.muted, marginTop: 6 } as const;

export function StackScene() {
  const frame = useCurrentFrame();
  const s = section("stack");
  const t = P.stack;
  const dodoCerts = A.data.certificates.filter((c) => c.tool === "dodo");
  const reflector = A.data.models.find((m) => m.agent === "Reflector");
  const adversary = A.data.models.find((m) => m.agent === "Adversary");
  const provider = reflector?.provider ?? adversary?.provider;
  const aws = A.data.aws;
  const certHi = (claim: string) =>
    claim.includes("page-size") ? p(frame, t.pages - 4, 10) * (1 - p(frame, t.wallet - 4, 10)) : claim.includes("credit-amount") ? p(frame, t.wallet - 4, 10) * (1 - p(frame, t.idem - 4, 10)) : claim.includes("idempotency") ? p(frame, t.idem - 4, 10) : 0;
  return (
    <SceneShell id="stack" dur={s.dur}>
      {/* Dodo Payments + its four certificates. */}
      <Phase from={0} to={t.crust}>
        <div style={{ position: "absolute", left: 160, top: 170 }}>
          <Sponsor name="Dodo Payments" role="where the money moves" k={p(frame, t.dodo - 4, 14)} big />
          <div style={{ display: "flex", gap: 14, marginTop: 30 }}>
            {[
              ["Refunds", t.refunds],
              ["Credits", t.credits],
              ["Plan changes", t.plan],
            ].map(([l, at]) => {
              const k = p(frame, (at as number) - 3, 12);
              return (
                <span key={l as string} style={{ opacity: k, transform: `translateY(${(1 - k) * 18}px)`, display: "inline-block" }}>
                  <Pill tone="accent" size={26}>
                    {l as string}
                  </Pill>
                </span>
              );
            })}
          </div>
          <div style={{ marginTop: 18, opacity: p(frame, t.test - 3, 12) }}>
            <Pill tone="neutral" size={22}>
              test mode
            </Pill>
          </div>
        </div>
        <div style={{ position: "absolute", left: 760, top: 170, width: 1040 }}>
          <div style={{ fontFamily: SANS, fontSize: 22, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted, opacity: p(frame, t.four - 4, 12) }}>
            {dodoCerts.length} Dodo certificates
          </div>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
            {dodoCerts.map((c, i) => {
              const hi = certHi(c.claimId);
              const k = p(frame, t.four + 4 + i * 6, 14);
              return (
                <div key={c.id} style={{ opacity: k, transform: `translateX(${(1 - k) * 60}px) scale(${1 + hi * 0.015})`, transformOrigin: "0 50%" }}>
                  <Panel style={{ padding: "18px 24px", display: "grid", gridTemplateColumns: "56px 1fr auto", alignItems: "center", gap: 18, borderColor: hi > 0 ? C.accent : C.hairline, boxShadow: hi > 0 ? `0 0 0 3px rgb(47 106 235 / ${0.3 * hi}), 0 18px 40px rgb(47 106 235 / 0.12)` : undefined }}>
                    <Seal sha256={c.sha256} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: MONO, fontSize: 24, color: C.text }}>{c.claimId}</div>
                      <div style={{ fontFamily: SANS, fontSize: 18, color: C.strongMuted, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.scope.replace(/^as probed: /, "")}</div>
                    </div>
                    <span style={{ display: "flex", gap: 8 }}>
                      <Pill tone="safe" size={16}>Certified</Pill>
                      {c.adversaryVerdict && <Pill tone="accent" size={16}>Adversary: {c.adversaryVerdict}</Pill>}
                    </span>
                  </Panel>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 16, color: C.faint, opacity: p(frame, t.four + 30, 12) }}>From packages/web/public/certificates/dodo.json</div>
        </div>
      </Phase>

      {/* Crustdata: who the customer is → the right policy (a diagram). */}
      <Phase from={t.crust - 6} to={t.models}>
        <div style={{ position: "absolute", left: 160, top: 170 }}>
          <Sponsor name="Crustdata" role="who each customer is" k={p(frame, t.crust - 4, 14)} big />
        </div>
        {(() => {
          const y = 560;
          const xs = [330, 760, 1190, 1620];
          const k = [p(frame, t.customer - 6, 14), p(frame, t.customer + 2, 14), p(frame, t.customer + 12, 14), p(frame, t.policy - 4, 14)];
          const arrows = [p(frame, t.customer, 14, LINE), p(frame, t.customer + 10, 14, LINE), p(frame, t.policy - 8, 14, LINE)];
          return (
            <>
              {arrows.map((a, i) => (
                <Arrow key={i} x1={xs[i]! + 170} x2={xs[i + 1]! - 170} y={y + 66} k={a} />
              ))}
              <Node x={xs[0]!} y={y} w={320} k={k[0]!} hi={0}>
                <div style={nodeTitle}>A request</div>
                <div style={nodeSub}>for a customer</div>
              </Node>
              <Node x={xs[1]!} y={y} w={320} k={k[1]!} hi={p(frame, t.customer, 12) * (1 - p(frame, t.policy, 12))}>
                <div style={nodeTitle}>Crustdata</div>
                <div style={nodeSub}>company lookup</div>
              </Node>
              <Node x={xs[2]!} y={y} w={320} k={k[2]!} hi={0}>
                <div style={nodeTitle}>Who they are</div>
                <div style={nodeSub}>size · tier</div>
              </Node>
              <Node x={xs[3]!} y={y} w={320} k={k[3]!} hi={p(frame, t.policy, 12)}>
                <div style={nodeTitle}>The right policy</div>
                <div style={nodeSub}>applies to the action</div>
              </Node>
              <div style={{ position: "absolute", left: 0, right: 0, top: 820, textAlign: "center", fontFamily: SANS, fontSize: 18, color: C.faint, opacity: k[0] }}>Illustration</div>
            </>
          );
        })()}
      </Phase>

      {/* The models: LiteLLM gateway → Reflector / Adversary (from the runs' LLM spans). */}
      <Phase from={t.models - 6} to={t.aws}>
        <div style={{ position: "absolute", left: 160, top: 170 }}>
          <Sponsor name="LiteLLM" role="the model gateway" k={p(frame, t.litellm - 4, 14)} big />
        </div>
        {(() => {
          const gx = 620;
          const gy = 560;
          const r = p(frame, t.reflector - 6, 14);
          const a = p(frame, t.adversary - 6, 14);
          const lineK = (k: number) => k;
          return (
            <>
              <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
                {[
                  [gy + 60, 470, r],
                  [gy + 60, 760, a],
                ].map(([y1, y2, k], i) => {
                  const d = `M ${gx + 200} ${y1} C ${gx + 380} ${y1}, ${gx + 380} ${y2}, ${gx + 560} ${y2}`;
                  return <path key={i} d={d} fill="none" stroke={C.accent} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - lineK(k as number)} />;
                })}
              </svg>
              <Node x={gx} y={gy} w={400} k={p(frame, t.litellm, 14)} hi={0}>
                <div style={nodeTitle}>LiteLLM gateway</div>
                <div style={nodeSub}>{provider ? `llm.provider = ${provider}` : "OpenAI-compatible proxy"}</div>
              </Node>
              <Node x={1420} y={400} w={560} k={r} hi={r * (1 - a)}>
                <div style={nodeTitle}>Reflector</div>
                <div style={{ ...nodeSub, fontFamily: MONO, color: C.accentText }}>{reflector?.model ?? "—"}</div>
                <div style={{ ...nodeSub, fontSize: 18 }}>proposes explanations</div>
              </Node>
              <Node x={1420} y={690} w={560} k={a} hi={a}>
                <div style={nodeTitle}>Adversary</div>
                <div style={{ ...nodeSub, fontFamily: MONO, color: C.accentText }}>{adversary?.model ?? "—"}</div>
                <div style={{ ...nodeSub, fontSize: 18 }}>tries to refute them</div>
              </Node>
              <div style={{ position: "absolute", left: 160, top: 930, fontFamily: SANS, fontSize: 16, color: C.faint, opacity: r }}>Models as recorded on the runs' LLM spans (neatlogs traces and local receipts)</div>
            </>
          );
        })()}
      </Phase>

      {/* AWS: the deploy kit in the repo. */}
      <Phase from={t.aws - 6} to={s.dur + 30}>
        <div style={{ position: "absolute", left: 160, top: 170 }}>
          <Sponsor name="AWS" role="built to run on it" k={p(frame, t.aws - 2, 14)} big />
          <div style={{ marginTop: 34, display: "flex", flexDirection: "column", gap: 16 }}>
            {[
              ["ECS", "a read-only hosted API", t.ecs],
              ["Amazon Bedrock", "a drop-in model provider", t.bedrock],
              ["Your AWS account", "agents and models inside it", t.account],
            ].map(([name, role, at]) => {
              const k = p(frame, (at as number) - 4, 14);
              return (
                <div key={name as string} style={{ opacity: k, transform: `translateX(${(1 - k) * -30}px)`, display: "flex", alignItems: "baseline", gap: 14 }}>
                  <Pill tone="accent" size={26}>
                    {name as string}
                  </Pill>
                  <span style={{ fontFamily: SANS, fontSize: 24, color: C.strongMuted }}>{role as string}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ position: "absolute", left: 1000, top: 170, width: 800, opacity: p(frame, t.scripts - 6, 14), transform: `translateY(${(1 - p(frame, t.scripts - 6, 14)) * 30}px)` }}>
          <div style={{ borderRadius: 18, background: "#0E1422", boxShadow: "0 30px 80px rgb(11 15 25 / 0.3)", overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", background: "#151D2E", fontFamily: SANS, fontSize: 16, color: "#8A96AD" }}>
              {aws.docPath} — {aws.docTitle}
            </div>
            <div style={{ padding: "16px 24px 22px", fontFamily: MONO, fontSize: 21, lineHeight: "34px", color: "#D5DCEA" }}>
              <div style={{ color: "#7DD3FC" }}>{aws.dir}</div>
              {aws.files.map((f, i) => (
                <div key={f} style={{ opacity: p(frame, t.scripts + i * 3, 8), paddingLeft: 24, color: f.endsWith(".sh") ? "#6EE7B7" : undefined }}>
                  {f}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Phase>
    </SceneShell>
  );
}
