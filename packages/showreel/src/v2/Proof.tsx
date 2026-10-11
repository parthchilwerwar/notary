// Beat 3: Read → Test → Challenge → Certify, staged with the landing's own "How it works" markup and
// CSS (landing.css .h-*) and the kit's real components (AgentBadge, StatusPill, CertificateCard).
// The pieces are laid out at their web size and the stage is scaled up for the film, so the type is
// the product's own, just closer. Entrances come in with depth (rotateY + translateZ) and settle on
// springs without wobble; stamps (commit, seal) get a small overshoot.
import type { CSSProperties, ReactNode } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { AgentBadge, CertificateCard, StatusPill } from "@web/ui";
import type { ShowreelData } from "../data-schema";
import { C, SANS, display, enterLeave, p, mix, IN, LINE, OUT } from "../theme";
import { STEPS2, V } from "./timeline";

const SCALE = 1.72;

function Depth({ at, leave, children, style, from = "right" }: { at: number; leave: number; children: ReactNode; style?: CSSProperties; from?: "left" | "right" | "below" }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 22, stiffness: 120, mass: 0.9 } });
  const out = p(frame, leave, 9, IN);
  if (s <= 0.001 || out >= 1) return null;
  const rot = from === "below" ? `rotateX(${(1 - s) * 18}deg)` : `rotateY(${(1 - s) * (from === "left" ? 16 : -16)}deg)`;
  return (
    <div
      style={{
        opacity: Math.min(1, s * 1.6) * (1 - out),
        transform: `perspective(1600px) translate3d(${from === "left" ? (s - 1) * 40 : from === "right" ? (1 - s) * 40 : 0}px, ${(1 - s) * 30 - out * 30}px, ${(1 - s) * -120}px) ${rot}`,
        transformOrigin: "50% 50%",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------- step bar

export function StepBar2() {
  const frame = useCurrentFrame();
  const bar = enterLeave(frame, V.bar, V.enforce - 4, { rise: 16, lift: 24, leave: 8 });
  if (!bar.visible) return null;
  const gap = 24;
  const w = (1600 - gap * 4) / 5;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, opacity: bar.opacity, transform: `translateY(${bar.y}px)` }}>
      {STEPS2.map((s, i) => {
        const next = STEPS2[i + 1]?.at ?? V.enforce + 30;
        const fill = p(frame, s.at, Math.max(8, next - s.at), LINE);
        const done = frame >= next;
        const active = frame >= s.at && !done;
        return (
          <div key={s.label} style={{ position: "absolute", left: 160 + i * (w + gap), top: 100, width: w, opacity: p(frame, V.bar + i * 2, 12) }}>
            <div style={{ fontFamily: SANS, fontSize: 24, color: active || done ? C.text : C.muted, fontWeight: active ? 600 : 400 }}>{s.label}</div>
            <div style={{ position: "relative", marginTop: 12, height: 6, borderRadius: 3, background: C.hairline, overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, background: done ? C.strongMuted : C.accent, transformOrigin: "0 50%", transform: `scaleX(${done ? 1 : fill})` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const HEADINGS = [
  { at: V.predict, until: V.challenge, title: "Predict, then test", body: "Every probe commits its prediction before the API is called." },
  { at: V.challenge, until: V.certify, title: "Challenge", body: "The Adversary reads the raw records and tries to knock the belief down." },
  { at: V.certify, until: V.enforce - 2, title: "Certify", body: "Beliefs that survive become sealed certificates." },
] as const;

export function Headings2() {
  const frame = useCurrentFrame();
  return (
    <>
      {HEADINGS.map((h) => {
        const m = enterLeave(frame, h.at, h.until - 8, { rise: 30, lift: 30, enter: 14, leave: 8 });
        if (!m.visible) return null;
        return (
          <div key={h.title} style={{ position: "absolute", left: 160, top: 176, opacity: m.opacity, transform: `translateY(${m.y}px)` }}>
            <div style={{ ...display, fontSize: 76, color: C.text }}>{h.title}</div>
            <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 28, color: C.muted }}>{h.body}</div>
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------------------- the stage

/** Web-size stage scaled for the film, centered under the headings. */
function Stage({ children, top = 360, width = 1000 }: { children: ReactNode; top?: number; width?: number }) {
  return (
    <div style={{ position: "absolute", left: 960 - (width * SCALE) / 2, top, width, transform: `scale(${SCALE})`, transformOrigin: "0 0", transformStyle: "preserve-3d" }}>
      {children}
    </div>
  );
}

function Predict({ d }: { d: ShowreelData["predict"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = V.predict;
  const leave = V.challenge - 9;
  const stamp = spring({ frame: frame - (t0 + 8), fps, config: { damping: 14, stiffness: 240, mass: 0.6 } });
  const line = p(frame, t0 + 10, 12, LINE);
  const glow = p(frame, t0 + 22, 8);
  const mismatch = spring({ frame: frame - (t0 + 24), fps, config: { damping: 14, stiffness: 260, mass: 0.6 } });
  return (
    <Stage>
      <div className="h-predict" style={{ alignItems: "center" }}>
        <Depth at={t0} leave={leave} from="left">
          <article className="h-card h-pred">
            <header className="h-card-head">
              <AgentBadge agent="reflector" />
              <span className="h-stamp" style={{ opacity: Math.min(1, stamp * 1.4), transform: `rotate(-2deg) scale(${mix(Math.min(stamp, 1.2), 1.6, 1)})` }}>
                Committed <time>{d.committedClock}</time>
              </span>
            </header>
            <p className="h-kicker">
              Prediction · {d.probe} · {d.template}
            </p>
            <p className="h-claim">
              <code>{d.claimId}</code>
            </p>
            <p className="h-expect">
              If the docs hold, the call is <strong>{d.expected}</strong>.
            </p>
          </article>
        </Depth>
        <Depth at={t0 + 6} leave={leave} from="below">
          <div className="h-call">
            {d.call && (
              <code className="h-call-text">
                {d.call.op} <span>{d.call.args}</span>
              </code>
            )}
            <span className="h-call-track">
              <span className="h-call-line" style={{ transform: `scaleX(${line})` }} />
            </span>
          </div>
        </Depth>
        <Depth at={t0 + 14} leave={leave} from="right">
          <article className="h-card h-obs">
            <header className="h-card-head">
              <span className="h-kicker">Observation</span>
              <span style={{ display: "inline-block", opacity: Math.min(1, mismatch * 1.5), transform: `scale(${mix(Math.min(mismatch, 1.15), 0.5, 1)})` }}>
                <StatusPill tone="unsafe">Mismatch</StatusPill>
              </span>
            </header>
            <dl className="h-fields">
              {d.observed.map((f) => (
                <div
                  key={f.key}
                  className="h-field"
                  data-mismatch={f.mismatch && glow > 0.4 ? "" : undefined}
                  style={f.mismatch ? { boxShadow: `0 0 0 ${1.5 * glow}px rgb(220 38 38 / ${0.4 * glow}), 0 0 ${18 * glow}px rgb(220 38 38 / ${0.18 * glow})` } : undefined}
                >
                  <dt>{f.key}</dt>
                  <dd>
                    {f.value}
                    {f.mismatch && glow > 0.4 && <span className="h-was"> expected {d.expected}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        </Depth>
      </div>
    </Stage>
  );
}

function Challenge({ d }: { d: ShowreelData["challenge"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = V.challenge;
  const leave = V.certify - 9;
  const link = p(frame, t0 + 6, 8, LINE);
  const verdict = spring({ frame: frame - (t0 + 14), fps, config: { damping: 14, stiffness: 240, mass: 0.6 } });
  const out = p(frame, leave, 9, IN);
  const v =
    d.verdict === "uphold"
      ? { tone: "safe" as const, text: `Survived ${d.survived} of ${d.challenges} ${d.challenges === 1 ? "challenge" : "challenges"}` }
      : d.verdict === "narrow"
        ? { tone: "held" as const, text: "Scope narrowed" }
        : { tone: "unsafe" as const, text: "Downgraded" };
  return (
    <Stage top={350}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 1fr", alignItems: "center" }}>
        <Depth at={t0} leave={leave} from="left">
          <article className="h-card h-hyp" style={{ minHeight: 150 }}>
            <header className="h-card-head">
              <AgentBadge agent="reflector" />
              <span className="h-kicker">Hypothesis</span>
            </header>
            <p className="h-text">{d.hypothesis}</p>
          </article>
        </Depth>
        <svg width={60} height={20} style={{ opacity: 1 - out }} aria-hidden="true">
          <line x1={4} y1={10} x2={4 + 52 * link} y2={10} stroke={C.faint} strokeWidth={1.2} strokeDasharray="3 4" />
          <circle cx={56} cy={10} r={3.5 * link} fill={C.page} stroke={C.faint} strokeWidth={1.2} />
        </svg>
        <Depth at={t0 + 6} leave={leave} from="right">
          <article className="h-card h-adv" style={{ minHeight: 150 }}>
            <header className="h-card-head">
              <AgentBadge agent="adversary" />
              <span className="h-kicker">Counter-test</span>
            </header>
            <p className="h-text">{d.counter}</p>
          </article>
        </Depth>
      </div>
      {verdict > 0.01 && out < 1 && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 26, opacity: Math.min(1, verdict * 1.5) * (1 - out) }}>
          <span style={{ display: "inline-block", transform: `scale(${mix(Math.min(verdict, 1.12), 0.6, 1.25)})` }}>
            <StatusPill tone={v.tone}>{v.text}</StatusPill>
          </span>
        </div>
      )}
    </Stage>
  );
}

const SEAL_TEXT = "NOTARIZED · NOTARY · NOTARIZED · NOTARY · ";

/** HowArt's seal (landing.css .h-seal) with the text ring spun in and the check drawn. */
function StampSeal({ spin, check }: { spin: number; check: number }) {
  return (
    <svg className="h-seal" viewBox="0 0 120 120" style={{ width: 150, height: 150 }} aria-hidden="true">
      <defs>
        <path id="film-seal" d="M 60 60 m -44 0 a 44 44 0 1 1 88 0 a 44 44 0 1 1 -88 0" />
      </defs>
      <circle cx="60" cy="60" r="56" className="h-seal-ring" style={{ fill: C.page }} />
      <circle cx="60" cy="60" r="33" className="h-seal-ring h-seal-inner" />
      <g className="h-seal-text" transform={`rotate(${spin} 60 60)`}>
        <text>
          <textPath href="#film-seal" textLength="276" lengthAdjust="spacing">
            {SEAL_TEXT}
          </textPath>
        </text>
      </g>
      <path className="h-seal-check" d="M47 61l9 9 17-20" strokeDasharray={42} strokeDashoffset={42 * (1 - check)} />
    </svg>
  );
}

/** The certificate card (real CertificateCard); `fly` 0–1 shrinks it toward the run row it covers. */
export function CertifyCard({ d }: { d: ShowreelData["certificate"] }) {
  return (
    <CertificateCard
      tool={d.tool}
      claimId={d.claimId}
      verdict={d.verdict}
      scope={d.scope}
      evidence={`${d.evidence} ${d.evidence === 1 ? "probe" : "probes"}`}
      sha256={d.sha256}
      footer={<span className="chat-cert-id">Issued {d.issued}</span>}
    />
  );
}

function Certify({ d }: { d: ShowreelData["certificate"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t0 = V.certify;
  const spin = mix(p(frame, t0 + 2, 30, OUT), -170, 0);
  const stamp = spring({ frame: frame - (t0 + 10), fps, config: { damping: 12, stiffness: 210, mass: 0.7 } });
  const check = p(frame, t0 + 18, 10, LINE);
  const sealOut = p(frame, V.certFly, 8, IN);
  if (frame < t0 || frame > V.certFly + 10) return null;
  return (
    <Stage top={372} width={900}>
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 28, alignItems: "center" }}>
        <div style={{ opacity: Math.min(1, stamp * 1.5) * (1 - sealOut), transform: `scale(${mix(Math.min(stamp, 1.14), 1.5, 1)}) rotate(${(1 - Math.min(1, stamp)) * -12}deg)` }}>
          <StampSeal spin={spin} check={check} />
        </div>
        {/* The card itself is drawn by Film (it flies into the Enforce row); this keeps its slot. */}
        <div style={{ height: 1 }} />
      </div>
    </Stage>
  );
}

export function Proof2({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  if (frame < V.predict - 2 || frame > V.certFly + 12) return null;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: SANS, perspective: 2000 }}>
      {frame < V.challenge + 2 && <Predict d={data.predict} />}
      {frame >= V.challenge - 2 && frame < V.certify + 2 && <Challenge d={data.challenge} />}
      <Certify d={data.certificate} />
    </div>
  );
}

export const PROOF_SCALE = SCALE;
