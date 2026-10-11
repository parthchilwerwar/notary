// Beat 5 · Notary Chat. One turn of the web's deterministic replay chat engine over the same
// records: the question in an accent-soft bubble, each lookup ticking from spinner to check with
// its one-line result, then the cited answer streaming in word by word with its numbered citation
// chips. The landing's "Built with" credits sit around it on dashed connectors.
import { Fragment } from "react";
import { useCurrentFrame } from "remotion";
import { AgentBadge, StepMark } from "../components/kit";
import type { ShowreelData } from "../data-schema";
import { C, R, SANS, display, enterLeave, p, mix, LINE, OUT } from "../theme";
import { T } from "../timeline";

type Token = { kind: "text" | "code" | "strong" | "cite"; s: string };

/** The answer's light markdown (landing chat-turn tokenize): `code`, **strong**, [n], text. */
function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[(\d+)\]/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ kind: "text", s: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", s: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", s: m[2].replaceAll("`", "") });
    else out.push({ kind: "cite", s: m[3]! });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", s: line.slice(last) });
  return out;
}

/** Tokens → words (a code span or citation stays one unit), each revealed in turn. */
function words(tokens: Token[]): Token[] {
  return tokens.flatMap((t) => (t.kind === "text" || t.kind === "strong" ? t.s.split(/(?<=\s)/).filter(Boolean).map((s) => ({ kind: t.kind, s })) : [t]));
}

function Cite({ n }: { n: string }) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        minWidth: 26,
        height: 26,
        padding: "0 6px",
        margin: "0 2px 0 4px",
        borderRadius: 6,
        background: C.accentSoft,
        color: C.accentText,
        fontSize: 17,
        fontWeight: 600,
        lineHeight: 1,
        verticalAlign: "0.3em",
      }}
    >
      {n}
    </span>
  );
}

// Chip anchors (decorative layout, no data): chips on the left and right, connectors to the window.
const WIN = { x: 520, w: 880, top: 236, h: 724 };
const CHIP_Y = [404, 598, 792];
const WIN_Y = [470, 598, 726];

export function Chat({ data }: { data: ShowreelData }) {
  const frame = useCurrentFrame();
  if (frame < T.chat - 6) return null;
  const t0 = T.chat;
  const title = enterLeave(frame, t0, 999, { rise: 28 });
  const win = enterLeave(frame, t0 + 2, 999, { rise: 90, enter: 22 });
  const q = p(frame, t0 + 8, 10);
  const chat = data.chat;
  const stepAt = (i: number) => t0 + 10 + i * 5;
  const doneAt = (i: number) => stepAt(i) + 6;
  const answerAt = doneAt(chat.steps.length - 1) + 2;
  const lines = chat.answer.split("\n").map((l) => words(tokenize(l)));
  const totalWords = lines.reduce((n, l) => n + l.length, 0);
  const revealed = mix(p(frame, answerAt, 16, LINE), 0, totalWords);
  const sources = p(frame, answerAt + 14, 6);
  const wires = p(frame, t0 + 8, 26, LINE);
  const left = data.builtWith.slice(0, 3);
  const right = data.builtWith.slice(3, 6);
  let w = 0;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: SANS }}>
      {title.visible && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 112, textAlign: "center", opacity: title.opacity, transform: `translateY(${title.y}px)` }}>
          <span style={{ ...display, fontSize: 76, color: C.text }}>Ask why. Get the records.</span>
        </div>
      )}

      {/* Connectors from the credits to the window edges, drawn in. */}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
        {[0, 1, 2].flatMap((i) => {
          const L = `M 392 ${CHIP_Y[i]} C 450 ${CHIP_Y[i]}, 452 ${WIN_Y[i]}, ${WIN.x - 10} ${WIN_Y[i]}`;
          const Rr = `M ${WIN.x + WIN.w + 10} ${WIN_Y[i]} C ${WIN.x + WIN.w + 68} ${WIN_Y[i]}, 1470 ${CHIP_Y[i]}, 1528 ${CHIP_Y[i]}`;
          const t = Math.min(1, Math.max(0, wires * 1.3 - i * 0.12));
          return [L, Rr].map((d, k) => (
            <Fragment key={`${i}${k}`}>
              <path d={d} fill="none" stroke="#C9D1DF" strokeWidth={1.6} strokeDasharray="5 8" mask={`url(#wire-${i}${k})`} />
              <mask id={`wire-${i}${k}`} maskUnits="userSpaceOnUse" x={0} y={0} width={1920} height={1080}>
                <path d={d} fill="none" stroke="#fff" strokeWidth={8} pathLength={1} strokeDasharray={1} strokeDashoffset={k === 0 ? 1 - t : -(1 - t)} />
              </mask>
              <circle cx={k === 0 ? WIN.x - 10 : WIN.x + WIN.w + 10} cy={WIN_Y[i]} r={5 * t} fill={C.page} stroke={C.faint} strokeWidth={1.5} />
            </Fragment>
          ));
        })}
      </svg>

      {/* Credit chips, each on its own slow orbit. */}
      {[...left.map((name, i) => ({ name, i, side: "l" as const })), ...right.map((name, i) => ({ name, i, side: "r" as const }))].map(({ name, i, side }) => {
        const m = enterLeave(frame, t0 + 6 + i * 3 + (side === "r" ? 1 : 0), 999, { rise: 20 });
        const a = (frame / 30) * 0.9 + i * 2.1 + (side === "r" ? 1.3 : 0);
        const ox = Math.cos(a) * 7;
        const oy = Math.sin(a) * 5;
        return (
          <div
            key={name}
            style={{
              position: "absolute",
              top: CHIP_Y[i]! - 26 + oy,
              ...(side === "l" ? { right: 1920 - 392 + ox } : { left: 1528 + ox }),
              opacity: m.opacity,
              transform: `translateY(${m.y}px)`,
            }}
          >
            <span style={{ display: "inline-block", padding: "12px 22px", border: `1px solid ${C.hairline}`, borderRadius: R.pill, background: C.page, boxShadow: "0 1px 2px rgb(11 15 25 / 0.04)", color: C.strongMuted, fontSize: 24, fontWeight: 500, whiteSpace: "nowrap" }}>
              {name}
            </span>
          </div>
        );
      })}

      {/* The chat window */}
      {win.visible && (
        <div
          style={{
            position: "absolute",
            left: WIN.x,
            top: WIN.top,
            width: WIN.w,
            height: WIN.h,
            boxSizing: "border-box",
            overflow: "hidden",
            border: `1px solid ${C.hairline}`,
            borderRadius: 32,
            background: C.page,
            boxShadow: "0 2px 4px rgb(11 15 25 / 0.04), 0 30px 80px rgb(47 106 235 / 0.14)",
            opacity: win.opacity,
            transform: `translateY(${win.y}px)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 28px", borderBottom: `1px solid ${C.hairline}` }}>
            <span style={{ fontSize: 24, fontWeight: 500, color: C.text }}>Ask about your runs</span>
            <AgentBadge agent="chat" />
          </div>
          <div style={{ display: "grid", gap: 22, padding: "26px 28px" }}>
            <div style={{ justifySelf: "end", maxWidth: "88%", padding: "14px 20px", borderRadius: "20px 20px 6px 20px", background: C.accentSoft, color: C.text, fontSize: 26, opacity: q, transform: `translateY(${(1 - q) * 14}px)` }}>
              {chat.question}
            </div>
            <div style={{ display: "grid", gap: 14 }}>
              {chat.steps.map((s, i) => {
                const vis = p(frame, stepAt(i), 6, OUT);
                const done = frame >= doneAt(i);
                const out = p(frame, doneAt(i), 6);
                return (
                  <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start", opacity: vis, transform: `translateY(${(1 - vis) * 10}px)` }}>
                    <StepMark state={done ? "check" : "spin"} rotation={(frame - stepAt(i)) * 24} />
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 24, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
                      <span style={{ fontSize: 22, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 740, opacity: out }}>{s.output}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "grid", gap: 10, fontSize: 26, lineHeight: 1.5, color: C.text }}>
              {lines.map((line, li) => (
                <p key={li} style={{ margin: 0, color: line[0]?.s.startsWith("•") ? C.strongMuted : C.text }}>
                  {line.map((tok, ti) => {
                    const k = w++;
                    const o = Math.min(1, Math.max(0, revealed - k));
                    const style = { opacity: o };
                    if (tok.kind === "cite") return <span key={ti} style={style}><Cite n={tok.s} /></span>;
                    if (tok.kind === "code")
                      return (
                        <span key={ti} style={{ ...style, padding: "1px 7px", borderRadius: 6, background: C.subtle, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {tok.s}
                        </span>
                      );
                    return (
                      <span key={ti} style={{ ...style, fontWeight: tok.kind === "strong" ? 500 : 400, whiteSpace: tok.s.includes("-") ? "nowrap" : undefined }}>
                        {tok.s}
                      </span>
                    );
                  })}
                </p>
              ))}
              <div style={{ display: "grid", gap: 8, marginTop: 6, paddingTop: 14, borderTop: `1px solid ${C.hairline}`, opacity: sources }}>
                {chat.citations.map((c) => (
                  <div key={c.n} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Cite n={String(c.n)} />
                    <span style={{ fontSize: 22, color: C.muted }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ position: "absolute", left: 28, right: 28, bottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between", height: 64, padding: "0 10px 0 22px", border: `1px solid ${C.hairline}`, borderRadius: 18, color: C.muted, fontSize: 22 }}>
            <span>Ask about a held refund, a certificate or a run…</span>
            <span style={{ display: "inline-grid", placeItems: "center", width: 42, height: 42, borderRadius: 12, background: C.accent }}>
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
