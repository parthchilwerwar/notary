// The film: one continuous vertical camera. It opens on the sky, pushes down through the clouds
// onto the white page where the proof plays out (beats 2–5), then pulls back up into the sky for
// the close. Every number and record on screen comes from `data` (src/data.json, written by
// scripts/props.ts from the published, hash-verified records).
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import "./fonts";
import { CloudFilter, Clouds, FRONT } from "./components/Clouds";
import { Frame } from "./components/Frame";
import type { ShowreelData } from "./data-schema";
import { Chat } from "./scenes/Chat";
import { Enforce } from "./scenes/Enforce";
import { Headings, Proof, StepBar } from "./scenes/Proof";
import { Problem } from "./scenes/Problem";
import { Sky } from "./scenes/Sky";
import { C, CAMERA, p } from "./theme";
import { T } from "./timeline";

/** How far the sky travels when the camera moves to the page (px). */
const TRAVEL = 1460;

export function Showreel(data: ShowreelData) {
  const frame = useCurrentFrame();
  // 0 = looking at the sky, 1 = looking at the page.
  const camera = p(frame, T.pushStart, T.pushDur, CAMERA) * (1 - p(frame, T.pullStart, T.pullDur, CAMERA));
  // A slow drift before the push, so the camera is already moving when it dives (no dead hold).
  const drift = interpolate(frame, [0, T.pushStart + T.pushDur], [0, 22], { extrapolateRight: "clamp" }) * (1 - p(frame, T.pullStart, T.pullDur, CAMERA));
  const lift = camera * TRAVEL + drift;
  // The page rises from below as the camera comes down (and sinks as it leaves): parallax.
  const pageY = (1 - camera) * 640;
  const grid = p(frame, T.pushStart + 20, 30);
  return (
    <AbsoluteFill style={{ background: C.page, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `translateY(${pageY}px)` }}>
        <Frame color={C.hairline} node={C.hairline} fill={C.page} draw={grid} />
        <Problem data={data} />
        <StepBar />
        <Headings />
        <Proof data={data} />
        <Enforce data={data} />
        <Chat data={data} />
      </AbsoluteFill>
      {camera < 1 && <Sky lift={lift} github={data.github} />}
      {/* The front cloud bank rides above everything: the camera passes through it. */}
      {camera < 1 && (
        <>
          <CloudFilter id="clouds-front" scale={72} />
          <Clouds layer={FRONT} filterId="clouds-front" fieldHeight={500} fieldBottom={1080} width={1920} lift={lift} phase={420} />
        </>
      )}
    </AbsoluteFill>
  );
}
