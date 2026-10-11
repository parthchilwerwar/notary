// The v2 film. One continuous camera: sky → (cursor clicks "Open dashboard") → dive through the
// clouds onto the real dashboard (the run without Notary) → the proof → back into the dashboard for
// the run with Notary (the certificate flies onto the row it covers, the held refund, the chart
// morph) → Notary Chat (the cursor types the question) → back up into the sky. Every number and
// record comes from `data` (src/data.json); the web app's components render it.
import { MemoryRouter } from "react-router";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import "../web";
import "../fonts";
import { CloudFilter, Clouds, FRONT } from "../components/Clouds";
import { Frame } from "../components/Frame";
import type { ShowreelData } from "../data-schema";
import { C, CAMERA, IN, LINE, mix, p } from "../theme";
import { camTransform, toScreen, track, type Cam } from "./camera";
import { ChartCard } from "./Chart";
import { Cursor, pointerAt, pressAt, type Move, type Pt } from "./Cursor";
import { ChatView, Dashboard, FRAME_H, FRAME_W, HeldCard, RunView, Stat } from "./Dashboard";
import { CertifyCard, Headings2, PROOF_SCALE, Proof2, StepBar2 } from "./Proof";
import { Sky } from "./Sky";
import { Soundtrack } from "./Soundtrack";
import { V } from "./timeline";
import { WashCard, Seal } from "@web/ui";

const TRAVEL = 1460;
const ROW_H = 64;
const LIST_TOP = 546; // local y of the first transcript row (Run page layout)
const LIST_X = 349; // local x of the row title column

const cam = (c: Partial<Cam> & Pick<Cam, "cx" | "cy" | "s">): Cam => ({ rx: 0, ry: 0, dy: 0, o: 1, ...c });

// Run without Notary.
const NAIVE: readonly (readonly [number, Cam])[] = [
  [V.dashIn, cam({ cx: 800, cy: 490, s: 0.72, rx: 32, dy: 480, o: 0 })],
  [V.dashIn + 14, cam({ cx: 800, cy: 490, s: 0.86, rx: 12, dy: 120, o: 1 })],
  [V.rowsStart - 2, cam({ cx: 800, cy: 490, s: 0.98 })],
  [V.rowsStart + 16, cam({ cx: 930, cy: 600, s: 1.48 })],
  [V.rowsEnd, cam({ cx: 930, cy: 640, s: 1.5 })],
  [V.dashOut, cam({ cx: 930, cy: 640, s: 1.5 })],
  [V.dashOut + 14, cam({ cx: 930, cy: 640, s: 1.12, rx: -10, dy: -330, o: 0 })],
];
// Run with Notary, then the chat.
const GUARDED: readonly (readonly [number, Cam])[] = [
  [V.enforce - 2, cam({ cx: 930, cy: 700, s: 1.05, rx: 22, dy: 360, o: 0 })],
  [V.enforce + 18, cam({ cx: 930, cy: 690, s: 1.45 })],
  [V.chartIn - 2, cam({ cx: 930, cy: 690, s: 1.45 })],
  [V.chartIn + 10, cam({ cx: 1300, cy: 560, s: 1.0 })],
  [V.enforceOut - 2, cam({ cx: 1300, cy: 560, s: 1.0 })],
  [V.chatNav, cam({ cx: 800, cy: 490, s: 1.0 })],
  [V.chatPage + 2, cam({ cx: 800, cy: 490, s: 1.0 })],
  [V.composerClick - 2, cam({ cx: 930, cy: 440, s: 1.18 })],
  [V.typeEnd, cam({ cx: 930, cy: 470, s: 1.24 })],
  [V.send + 2, cam({ cx: 930, cy: 420, s: 1.24 })],
  [V.streamEnd, cam({ cx: 930, cy: 380, s: 1.3 })],
];

/** Transcript scroll of the guarded run: q12 in view for the certificate, then back up to q03. */
const scrollOf = (frame: number) => mix(p(frame, V.scrollUp, 12, CAMERA), 560, 0);

export function Film(data: ShowreelData) {
  const frame = useCurrentFrame();
  const d = data.dashboard;
  // ---- the big camera between sky and page (same as v1)
  const camera = p(frame, V.diveStart, V.diveDur, CAMERA) * (1 - p(frame, V.pullStart, V.pullDur, CAMERA));
  const drift = interpolate(frame, [0, V.diveStart + V.diveDur], [0, 22], { extrapolateRight: "clamp" }) * (1 - p(frame, V.pullStart, V.pullDur, CAMERA));
  const lift = camera * TRAVEL + drift;
  const pageY = (1 - camera) * 640;

  // ---- dashboard cameras
  const naiveCam = track(frame, NAIVE);
  const guardedCam = track(frame, GUARDED);
  const inNaive = frame >= V.dashIn && frame < V.dashOut + 16;
  const inGuarded = frame >= V.enforce - 2;
  const onChat = frame >= V.chatPage;
  const rowsNaive = interpolate(frame, [V.rowsStart, V.rowsEnd], [0, d.naive.rows.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const shownNaive = d.naive.rows.slice(0, Math.ceil(rowsNaive));
  const unsafeSoFar = Math.min(d.naive.unsafe, shownNaive.filter((r) => r.tone === "unsafe").length);
  const naiveScroll = Math.max(0, (rowsNaive - 7) * ROW_H) * 0.0; // the list grows downward; the camera follows instead
  const scroll = scrollOf(frame);
  const heldKey = d.held.rowKey;
  const coverKey = d.guarded.rows.find((r) => r.title.includes(` ${data.certificate.covers} `))?.key;
  const coverIndex = d.guarded.rows.findIndex((r) => r.key === coverKey);
  const heldIndex = d.guarded.rows.findIndex((r) => r.key === heldKey);
  const HELD_CARD_H = 150;
  const rowY = (i: number) => LIST_TOP + i * ROW_H + (i > heldIndex ? HELD_CARD_H : 0) - scroll;

  // ---- cursor (screen coordinates; targets inside the dashboard follow its camera)
  const heroBtn: Pt = { x: 845, y: 676 };
  const inDash = (x: number, y: number) => (f: number) => toScreen(track(f, GUARDED), x, y);
  const moves: Move[] = [
    { from: V.cursorIn, at: V.clickOpen - 4, to: () => heroBtn, bend: 0.2 },
    { from: V.heldFocus - 14, at: V.heldFocus - 2, to: inDash(LIST_X + 120, rowY(heldIndex) + 12), bend: -0.15 },
    { from: V.approveHover - 6, at: V.approveHover, to: (f) => toScreen(track(f, GUARDED), 1318, rowY(heldIndex) + 166), bend: 0.12 },
    { from: V.chartIn + 8, at: V.chatNav + 2, to: inDash(96, 276), bend: 0.18 },
    { from: V.chatPage + 1, at: V.composerClick - 1, to: inDash(800, 663), bend: -0.12 },
    { from: V.typeEnd - 1, at: V.send - 1, to: inDash(1273, 663), bend: 0.1 },
    { from: V.send + 4, at: V.streamEnd, to: () => ({ x: 1560, y: 900 }), bend: 0.1 },
  ];
  const clicks = [
    { at: V.clickOpen, ...heroBtn },
    { at: V.heldFocus, ...inDash(LIST_X + 120, rowY(heldIndex) + 12)(V.heldFocus) },
    { at: V.chatNav + 4, ...inDash(96, 276)(V.chatNav + 4) },
    { at: V.composerClick, ...inDash(800, 663)(V.composerClick) },
    { at: V.send, ...inDash(1273, 663)(V.send) },
  ];
  const pos = pointerAt(frame, { x: 1780, y: 1120 }, moves);
  const press = pressAt(frame, clicks);
  const cursorOpacity = Math.min(p(frame, V.cursorIn - 2, 6), 1 - p(frame, V.clickOpen + 6, 8)) + Math.min(p(frame, V.heldFocus - 16, 6), 1 - p(frame, V.streamEnd - 2, 8));

  // ---- chat
  const typed = Math.round(interpolate(frame, [V.typeStart, V.typeEnd], [0, data.chat.question.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const sent = frame >= V.send + 1;
  const ev = data.chat.events;
  const steps = ev.filter((e) => e.type !== "text_delta" && e.type !== "citations" && e.type !== "done");
  const stepAt = (i: number) => V.streamStart + i * 2;
  const tail = V.streamStart + steps.length * 2 + 2;
  const answerWords = (ev.find((e) => e.type === "text_delta") as { text: string } | undefined)?.text.split(/(?<=\s)/) ?? [];
  const wordsShown = Math.round(interpolate(frame, [tail, tail + 10], [0, answerWords.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const events = [
    ...steps.filter((_, i) => frame >= stepAt(i)),
    ...(frame >= tail ? [{ type: "text_delta" as const, text: answerWords.slice(0, wordsShown).join("") }] : []),
    ...(frame >= tail + 10 ? ev.filter((e) => e.type === "citations") : []),
    ...(frame >= tail + 12 ? ev.filter((e) => e.type === "done") : []),
  ];

  // ---- certificate flight (proof stage → the covered row)
  const fly = p(frame, V.certFly, V.certLand - V.certFly, CAMERA);
  const cardFrom = { x: 186 + 178 * PROOF_SCALE, y: 372, s: PROOF_SCALE };
  const landing = toScreen(track(V.certLand, GUARDED), LIST_X, rowY(coverIndex) + 46);
  const cardTo = { x: landing.x, y: landing.y, s: 0.42 };
  const cardIn = p(frame, V.certify + 2, 14);
  const cardVisible = frame >= V.certify && frame < V.certLand + 4;
  const chip = p(frame, V.certLand - 2, 8);

  return (
    <MemoryRouter>
      <AbsoluteFill style={{ background: C.page, overflow: "hidden" }}>
        <AbsoluteFill style={{ transform: `translateY(${pageY}px)` }}>
          <Frame color={C.hairline} node={C.hairline} fill={C.page} draw={p(frame, V.diveStart + 20, 30)} />
          <StepBar2 />
          <Headings2 />
          <Proof2 data={data} />

          {/* The dashboard, in depth. */}
          <AbsoluteFill style={{ perspective: 2200, perspectiveOrigin: "50% 40%" }}>
            {inNaive && (
              <div style={{ position: "absolute", left: 0, top: 0, width: FRAME_W, height: FRAME_H, transformOrigin: "0 0", transform: camTransform(naiveCam), opacity: naiveCam.o }}>
                <Dashboard active="run" address="127.0.0.1:5173/app/run">
                  <RunView
                    run={d.naive}
                    title="Run"
                    summary={`The agent without Notary · ${data.guarded.queueSize} requests`}
                    rows={rowsNaive}
                    scroll={naiveScroll}
                    stats={
                      <>
                        <Stat label="Actions processed" value={shownNaive.length} />
                        <Stat label="Unsafe actions" value={unsafeSoFar} note="Measured on Notary's evaluation suite" />
                        <Stat label="Credits spent" value={d.naive.credits?.used ?? null} of={d.naive.credits?.cap != null ? `of ${d.naive.credits.cap}` : undefined} />
                      </>
                    }
                  />
                </Dashboard>
              </div>
            )}
            {inGuarded && (
              <div style={{ position: "absolute", left: 0, top: 0, width: FRAME_W, height: FRAME_H, transformOrigin: "0 0", transform: camTransform(guardedCam), opacity: guardedCam.o * (1 - p(frame, V.pullStart + 8, 16, IN)) }}>
                <Dashboard active={onChat ? "chat" : "run"} hover={frame >= V.chatNav - 2 && frame < V.chatPage ? "chat" : undefined} press={pressAt(frame, [{ at: V.chatNav + 4 }])} address={`127.0.0.1:5173/app/${onChat ? "chat" : "run"}`}>
                  {onChat ? (
                    <ChatView
                      question={data.chat.question}
                      typed={typed}
                      sent={sent}
                      events={sent ? events : []}
                      caret={frame >= V.composerClick && !sent && Math.floor(frame / 8) % 2 === 0}
                      sendHover={frame >= V.send - 3 && frame <= V.send + 2}
                    />
                  ) : (
                    <RunView
                      run={d.guarded}
                      title="Run"
                      summary={`The agent with Notary · ${data.guarded.queueSize} requests`}
                      rows={d.guarded.rows.length}
                      scroll={scroll}
                      lifted={frame >= V.heldFocus - 4 && frame < V.enforceOut ? heldKey : undefined}
                      stats={
                        <>
                          <Stat label="Unsafe actions" value={d.guarded.unsafe} note="Measured on Notary's evaluation suite" />
                          <Stat label="Refunds held for review" value={Math.round(mix(p(frame, V.enforce + 8, 18, LINE), 0, data.guarded.refundsHeld))} />
                          <Stat label="Credits spent" value={d.guarded.credits?.used ?? null} of={d.guarded.credits?.cap != null ? `of ${d.guarded.credits.cap}` : undefined} />
                        </>
                      }
                      under={{
                        [heldKey]: <HeldCard held={d.held} hover={frame >= V.approveHover && frame < V.enforceOut ? "approve" : undefined} focus={p(frame, V.heldFocus, 6) * (1 - p(frame, V.enforceOut - 4, 6))} />,
                        ...(coverKey
                          ? {
                              [coverKey]: (
                                <div style={{ opacity: chip, transform: `scale(${mix(chip, 0.92, 1)})`, transformOrigin: "0 50%" }}>
                                  <WashCard wash="mint" padding="sm" className="run-held" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                    <Seal sha256={data.certificate.sha256} />
                                    <span style={{ fontSize: 13 }}>
                                      Covered by certificate <code>{data.certificate.id}</code> · {data.certificate.claimId} · {data.certificate.verdict}
                                    </span>
                                  </WashCard>
                                </div>
                              ),
                            }
                          : {}),
                      }}
                    />
                  )}
                </Dashboard>
              </div>
            )}
          </AbsoluteFill>

          {/* The certificate card: built in Certify, then flies onto the row it covers. */}
          {cardVisible && (
            <div
              style={{
                position: "absolute",
                left: mix(fly, cardFrom.x, cardTo.x),
                top: mix(fly, cardFrom.y, cardTo.y) - Math.sin(fly * Math.PI) * 120,
                width: 720,
                transformOrigin: "0 0",
                transform: `scale(${mix(fly, cardFrom.s, cardTo.s)}) rotate(${Math.sin(fly * Math.PI) * -4}deg)`,
                opacity: cardIn * (1 - p(frame, V.certLand - 2, 6)),
                filter: fly > 0 && fly < 1 ? `drop-shadow(0 ${24 * Math.sin(fly * Math.PI)}px 30px rgb(47 106 235 / 0.22))` : undefined,
              }}
            >
              <CertifyCard d={data.certificate} />
            </div>
          )}

          <ChartCard data={data} />
        </AbsoluteFill>

        {camera < 1 && <Sky lift={lift} github={data.github} hover={frame >= V.clickOpen - 6 && frame < V.diveStart + 6} press={press} />}
        {camera < 1 && (
          <>
            <CloudFilter id="clouds-front" scale={72} />
            <Clouds layer={FRONT} filterId="clouds-front" fieldHeight={500} fieldBottom={1080} width={1920} lift={lift} phase={420} />
          </>
        )}

        {cursorOpacity > 0.01 && <Cursor x={pos.x} y={pos.y} press={press} opacity={Math.min(1, cursorOpacity)} clicks={clicks} frame={frame} />}
        <Soundtrack data={data} />
      </AbsoluteFill>
    </MemoryRouter>
  );
}
