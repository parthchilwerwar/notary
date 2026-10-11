// The audio cue sheet: frame → sound, derived from the v2 timeline (and the data, for per-row and
// per-character cues). Shared by the composition (Soundtrack.tsx places each cue) and
// scripts/audio.ts (which renders the WAVs and checks the full mix offline).
import type { ShowreelData } from "../data-schema";
import { V } from "./timeline";

export const SFX = ["click", "move", "type", "pop", "tick", "blip", "whoosh", "stamp", "chime", "confirm", "dive"] as const;
export type SfxName = (typeof SFX)[number];
export type Cue = { frame: number; sfx: SfxName; gain: number; label: string };

export function cues(data: ShowreelData): Cue[] {
  const out: Cue[] = [];
  const add = (frame: number, sfx: SfxName, gain: number, label: string) => out.push({ frame: Math.round(frame), sfx, gain, label });

  // 1 · sky
  add(V.cursorIn, "move", 0.35, "cursor enters");
  add(V.clickOpen, "click", 0.9, "click Open dashboard");
  add(V.diveStart - 2, "dive", 0.8, "camera dives through the clouds");
  // 2 · the run without Notary: a soft tick per row, a low blip on every unsafe one
  const rows = data.dashboard.naive.rows;
  const step = (V.rowsEnd - V.rowsStart) / rows.length;
  rows.forEach((r, i) => {
    const f = V.rowsStart + i * step;
    if (r.tone === "unsafe") add(f, "blip", 0.42, `unsafe row ${r.title.split(" — ")[0]}`);
    else add(f, "tick", 0.3, `row ${r.title.split(" — ")[0]}`);
  });
  add(V.dashOut - 2, "whoosh", 0.55, "page recedes, proof begins");
  // 3 · proof
  add(V.predict + 8, "stamp", 0.45, "prediction stamped Committed");
  add(V.predict + 9, "pop", 0.3, "commit stamp");
  add(V.predict + 24, "blip", 0.6, "Mismatch");
  add(V.challenge - 2, "whoosh", 0.35, "to Challenge");
  add(V.challenge + 14, "chime", 0.55, "Survived");
  add(V.certify - 2, "whoosh", 0.35, "to Certify");
  add(V.certify + 10, "stamp", 0.85, "seal stamps");
  add(V.certFly, "whoosh", 0.5, "certificate flies to the run");
  // 4 · enforce
  add(V.certLand, "chime", 0.6, "certificate lands: Allowed");
  add(V.enforce + 10, "pop", 0.35, "Refunds held counter");
  add(V.heldFocus - 14, "move", 0.3, "cursor to the held refund");
  add(V.heldFocus, "click", 0.75, "click the held refund");
  add(V.heldFocus + 1, "confirm", 0.45, "held card focused");
  add(V.approveHover, "pop", 0.22, "hover Approve");
  add(V.chartIn, "whoosh", 0.4, "chart card");
  add(V.chartIn + 14, "pop", 0.35, "held stacks rise");
  // 5 · chat
  add(V.chartIn + 8, "move", 0.3, "cursor to the sidebar");
  add(V.chatNav + 4, "click", 0.75, "click Chat");
  add(V.chatPage, "whoosh", 0.3, "Chat page");
  add(V.composerClick, "click", 0.65, "click the composer");
  const q = data.chat.question.length;
  let last = -1;
  for (let f = V.typeStart; f <= V.typeEnd; f++) {
    const n = Math.round(((f - V.typeStart) / (V.typeEnd - V.typeStart)) * q);
    if (n !== last && f % 1 === 0 && n > 0) add(f, "type", 0.28 + ((n * 37) % 10) / 100, `type ${n}`);
    last = n;
  }
  add(V.send, "click", 0.8, "click Send");
  const steps = data.chat.events.filter((e) => e.type === "step_finished").length;
  for (let i = 0; i < steps; i++) add(V.streamStart + (i * 2 + 1) * 2, "tick", 0.32, `step ${i + 1} done`);
  add(V.streamStart + steps * 4 + 14, "chime", 0.38, "answer cited");
  // 6 · close
  add(V.pullStart - 2, "dive", 0.6, "camera rises to the sky");
  add(V.wordmark, "pop", 0.25, "wordmark");
  return out.sort((a, b) => a.frame - b.frame);
}

/** Music volume: −2.5 dB ducking around every cue (fast attack, slower release). */
export function duck(frame: number, all: readonly Cue[]): number {
  let d = 0;
  for (const c of all) {
    const t = frame - c.frame;
    if (t < -1 || t > 8) continue;
    d = Math.max(d, t < 0 ? 0.5 : 1 - t / 8);
  }
  return 1 - 0.25 * d;
}
