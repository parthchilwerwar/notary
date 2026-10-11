// Beat 3 · Read → Test → Challenge → Certify, and the chrome beat 4 shares: the slim five-step bar
// (the Run page's stage bar) and the section heading under it. Each step plays its moment from the
// published records: the committed prediction p004 vs what came back, the Reflector's hypothesis vs
// the Adversary's recorded counter-test, and the featured certificate with its seal.
import type { ReactNode } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { AgentBadge, Card, Kicker, StatusPill } from "../components/kit";
import { Seal } from "../components/Seal";
import type { ShowreelData } from "../data-schema";
import { C, SANS, display, enterLeave, p, mix, IN, LINE, OUT } from "../theme";
import { STEPS, T } from "../timeline";

// --------------------------------------------------------------------------------- step bar

export function StepBar() {
  const frame = useCurrentFrame();
  const bar = enterLeave(frame, T.bar, T.enforceLeave, { rise: 16, lift: 24, leave: 8 });
  if (!bar.visible) return null;
  const x0 = 160;
  const gap = 24;
  const w = (1600 - gap * 4) / 5;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, opacity: bar.opacity, transform: `translateY(${bar.y}px)` }}>
      {STEPS.map((s, i) => {
        const next = STEPS[i + 1]?.at ?? T.enforceLeave;
        const fill = p(frame, s.at, Math.max(8, next - s.at), LINE);
        const done = frame >= next;
        const active = frame >= s.at && !done;
        const enter = p(frame, T.bar + i * 2, 14);
        return (
          <div key={s.label} style={{ position: "absolute", left: x0 + i * (w + gap), top: 112, width: w, opacity: enter }}>
            <div style={{ fontFamily: SANS, fontSize: 24, color: active || done ? C.text : C.muted, fontWeight: active ? 500 : 400 }}>{s.label}</div>
            <div style={{ position: "relative", marginTop: 12, height: 4, borderRadius: 2, background: C.hairline, overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, background: done ? C.text : C.accent, transformOrigin: "0 50%", transform: `scaleX(${done ? 1 : fill})` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------------- headings

const HEADINGS = [
  { at: T.predict, until: T.challenge, title: "Predict, then test", body: "Every probe commits its prediction before the API is called." },
  { at: T.challenge, until: T.certify, title: "Challenge", body: "The Adversary reads the raw records and tries to knock the belief down." },
  { at: T.certify, until: T.enforce, title: "Certify", body: "Beliefs that survive become sealed certificates." },
  { at: T.enforce, until: T.enforceLeave + 8, title: "Enforce", body: "The Guard lets covered money actions through and holds the rest." },
] as const;

export function Headings() {
  const frame = useCurrentFrame();
  return (
    <>
      {HEADINGS.map((h) => {
        const m = enterLeave(frame, h.at, h.until - 8, { rise: 30, lift: 30, enter: 14, leave: 8 });
        if (!m.visible) return null;
        return (
          <div key={h.title} style={{ position: "absolute", left: 160, top: 196, opacity: m.opacity, transform: `translateY(${m.y}px)` }}>
            <div style={{ ...display, fontSize: 72, color: C.text }}>{h.title}</div>
            <div style={{ marginTop: 14, fontFamily: SANS, fontSize: 28, color: C.muted }}>{h.body}</div>
          </div>
        );
      })}
    </>
  );
}

// --------------------------------------------------------------------------------- shared

function Rise({ m, children, style }: { m: { opacity: number; y: number; visible: boolean }; children: ReactNode; style?: React.CSSProperties }) {
  if (!m.visible) return null;
  return <div style={{ position: "absolute", opacity: m.opacity, transform: `translateY(${m.y}px)`, ...style }}>{children}</div>;
}

const headRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 };

// --------------------------------------------------------------------------------- predict

function Predict({ d }: { d: ShowreelData["predict"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = T.predict;
  const leave = T.challenge - 8;
  const pred = enterLeave(frame, t0, leave, { leave: 8 });
  const call = enterLeave(frame, t0 + 6, leave, { leave: 8 });
  const obs = enterLeave(frame, t0 + 12, leave, { rise: 0, leave: 8 });
  const obsX = (1 - p(frame, t0 + 12, 14)) * 48;
  // The stamp lands with a short overshoot (no wobble on type).
  const stamp = spring({ frame: frame - (t0 + 6), fps, config: { damping: 15, stiffness: 220, mass: 0.6 } });
  const line = p(frame, t0 + 8, 10, LINE);
  const glow = p(frame, t0 + 18, 8);
  const mismatch = spring({ frame: frame - (t0 + 20), fps, config: { damping: 14, stiffness: 240, mass: 0.6 } });
  return (
    <>
      <Rise m={pred} style={{ left: 160, top: 500 }}>
        <Card style={{ width: 620 }}>
          <div style={headRow}>
            <AgentBadge agent="reflector" />
            <span
              style={{
                display: "inline-flex",
                padding: "6px 14px",
                border: `1.5px dashed ${C.accent}`,
                borderRadius: 8,
                color: C.accentText,
                fontFamily: SANS,
                fontSize: 20,
                fontWeight: 500,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                fontVariantNumeric: "tabular-nums",
                opacity: Math.min(1, stamp * 1.4),
                transform: `rotate(-2deg) scale(${mix(Math.min(stamp, 1.2), 1.5, 1)})`,
              }}
            >
              Committed {d.committedClock}
            </span>
          </div>
          <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
            <Kicker>
              Prediction · {d.probe} · {d.template}
            </Kicker>
            <span style={{ fontSize: 28, color: C.text }}>{d.claimId}</span>
            <span style={{ fontSize: 28, color: C.text, lineHeight: 1.4 }}>
              If the docs hold, the call is <strong style={{ fontWeight: 600 }}>{d.expected}</strong>.
            </span>
          </div>
        </Card>
      </Rise>

      <Rise m={call} style={{ left: 800, top: 618, width: 340 }}>
        <div style={{ display: "grid", justifyItems: "center", gap: 18 }}>
          {d.call && (
            <span style={{ padding: "10px 18px", border: `1px solid ${C.hairline}`, borderRadius: 16, background: C.page, fontFamily: SANS, fontSize: 22, color: C.text, textAlign: "center", lineHeight: 1.35 }}>
              {d.call.op}
              <br />
              <span style={{ color: C.muted }}>{d.call.args}</span>
            </span>
          )}
          <span style={{ position: "relative", width: "100%", height: 3, borderRadius: 2, background: C.hairline, overflow: "hidden" }}>
            <span style={{ position: "absolute", inset: 0, background: C.accent, transformOrigin: "0 50%", transform: `scaleX(${line})` }} />
          </span>
          <span style={{ fontFamily: SANS, fontSize: 22, color: C.muted, opacity: line }}>API call</span>
        </div>
      </Rise>

      <Rise m={obs} style={{ left: 1140 + obsX, top: 500 }}>
        <Card style={{ width: 620 }}>
          <div style={headRow}>
            <Kicker>Observation</Kicker>
            <span style={{ opacity: Math.min(1, mismatch * 1.5), transform: `scale(${mix(Math.min(mismatch, 1.15), 0.6, 1)})` }}>
              <StatusPill tone="unsafe">Mismatch</StatusPill>
            </span>
          </div>
          <div style={{ marginTop: 18, display: "grid", gap: 4 }}>
            {d.observed.map((f) => (
              <div
                key={f.key}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: f.mismatch ? `rgb(254 242 242 / ${glow})` : "transparent",
                  boxShadow: f.mismatch ? `0 0 0 ${1.5 * glow}px rgb(220 38 38 / ${0.35 * glow})` : undefined,
                }}
              >
                <span style={{ fontSize: 24, color: f.mismatch && glow > 0.5 ? C.unsafeText : C.muted, fontWeight: f.mismatch ? 500 : 400 }}>{f.key}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ fontSize: 28, color: f.mismatch && glow > 0.5 ? C.unsafeText : C.text, fontWeight: f.mismatch ? 500 : 400 }}>{f.value}</span>
                  {f.mismatch && (
                    <span style={{ display: "block", fontSize: 22, color: C.unsafeText, opacity: glow }}>expected {d.expected}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </Rise>
    </>
  );
}

// --------------------------------------------------------------------------------- challenge

function Challenge({ d }: { d: ShowreelData["challenge"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = T.challenge;
  const leave = T.certify - 8;
  const hyp = enterLeave(frame, t0, leave, { leave: 8 });
  const link = p(frame, t0 + 4, 10, LINE);
  const linkOut = p(frame, leave, 8, IN);
  const adv = enterLeave(frame, t0 + 6, leave, { leave: 8 });
  const verdict = spring({ frame: frame - (t0 + 14), fps, config: { damping: 14, stiffness: 220, mass: 0.6 } });
  const verdictOut = p(frame, leave, 8, IN);
  const text =
    d.verdict === "uphold"
      ? { tone: "safe" as const, label: `Survived ${d.survived} of ${d.challenges} ${d.challenges === 1 ? "challenge" : "challenges"}` }
      : d.verdict === "narrow"
        ? { tone: "held" as const, label: "Scope narrowed" }
        : { tone: "unsafe" as const, label: "Downgraded" };
  return (
    <>
      <Rise m={hyp} style={{ left: 160, top: 486 }}>
        <Card style={{ width: 700, minHeight: 300 }}>
          <div style={headRow}>
            <AgentBadge agent="reflector" />
            <Kicker>Hypothesis</Kicker>
          </div>
          <p style={{ margin: "22px 0 0", fontSize: 28, lineHeight: 1.45, color: C.text }}>{d.hypothesis}</p>
        </Card>
      </Rise>
      {/* Connector between the two cards. */}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: 1 - linkOut }} aria-hidden="true">
        <line x1={872} y1={636} x2={872 + (1048 - 872) * link} y2={636} stroke={C.faint} strokeWidth={1.5} strokeDasharray="4 7" />
        <circle cx={1048} cy={636} r={6 * link} fill={C.page} stroke={C.faint} strokeWidth={1.5} />
      </svg>
      <Rise m={adv} style={{ left: 1060, top: 486 }}>
        <Card style={{ width: 700, minHeight: 300 }}>
          <div style={headRow}>
            <AgentBadge agent="adversary" />
            <Kicker>Counter-test</Kicker>
          </div>
          <p style={{ margin: "22px 0 0", fontSize: 28, lineHeight: 1.45, color: C.text }}>{d.counter}</p>
        </Card>
      </Rise>
      {verdict > 0.01 && verdictOut < 1 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 872, display: "flex", justifyContent: "center", opacity: Math.min(1, verdict * 1.4) * (1 - verdictOut), transform: `translateY(${-verdictOut * 30}px)` }}>
          <span style={{ transform: `scale(${mix(Math.min(verdict, 1.12), 0.7, 1)})` }}>
            <StatusPill tone={text.tone} size={30}>
              {text.label}
            </StatusPill>
          </span>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------------- certify

function Certify({ d }: { d: ShowreelData["certificate"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = T.certify;
  const leave = T.enforce - 8;
  const card = enterLeave(frame, t0, leave, { leave: 8 });
  const line = (i: number) => p(frame, t0 + 4 + i * 3, 10);
  const lineStyle = (i: number): React.CSSProperties => ({ opacity: line(i), transform: `translateY(${(1 - line(i)) * 14}px)` });
  // Seal: the text ring spins in, then the seal stamps down with a small overshoot.
  const spin = mix(p(frame, t0 + 2, 30, OUT), -160, 0);
  const stamp = spring({ frame: frame - (t0 + 10), fps, config: { damping: 13, stiffness: 200, mass: 0.7 } });
  const sealScale = mix(Math.min(stamp, 1.15), 1.35, 1);
  const check = p(frame, t0 + 18, 10, LINE);
  const facts: [string, ReactNode][] = [
    ["Scope", d.scope],
    ["Evidence", `${d.evidence} ${d.evidence === 1 ? "probe" : "probes"}`],
    ["Issued", d.issued],
    ["Seal", `sha256 ${d.sha256.slice(0, 12)}…`],
  ];
  return (
    <Rise m={card} style={{ left: 330, top: 432 }}>
      <Card large style={{ width: 1260, display: "grid", gridTemplateColumns: "300px 1fr", gap: 56, alignItems: "center", padding: "44px 56px" }}>
        <div style={{ opacity: Math.min(1, stamp * 1.5), transform: `scale(${sealScale})` }}>
          <Seal size={300} spin={spin} check={check} id="seal-path" />
        </div>
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div style={{ ...headRow, ...lineStyle(0) }}>
            <Kicker>{d.tool.charAt(0).toUpperCase() + d.tool.slice(1)} certificate</Kicker>
            <StatusPill tone="safe">Certified</StatusPill>
          </div>
          <span style={{ fontSize: 26, color: C.accentText, fontVariantNumeric: "tabular-nums", ...lineStyle(1) }}>{d.id}</span>
          <span style={{ fontSize: 38, fontWeight: 500, letterSpacing: "-0.01em", color: C.text, ...lineStyle(2) }}>{d.claimId}</span>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 40px" }}>
            {facts.map(([k, v], i) => (
              <div key={k} style={{ display: "grid", gap: 4, gridColumn: i === 0 ? "1 / -1" : undefined, ...lineStyle(3 + i) }}>
                <span style={{ fontSize: 22, color: C.muted }}>{k}</span>
                <span style={{ fontSize: 24, color: C.text, fontVariantNumeric: "tabular-nums" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </Rise>
  );
}

export function Proof({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  if (frame < T.predict - 2 || frame > T.enforce + 2) return null;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: SANS }}>
      <Predict d={data.predict} />
      <Challenge d={data.challenge} />
      <Certify d={data.certificate} />
    </div>
  );
}
