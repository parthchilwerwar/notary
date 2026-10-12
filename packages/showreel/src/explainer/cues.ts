// The Explainer's sound cue sheet (absolute frame → effect) and the music's ducking curve. Pure:
// used by the composition (Sound.tsx) and by scripts/explainer-audio.ts, which renders the music bed
// and checks the full mix offline with the same numbers.
import type { SfxName } from "../v2/cues";
import { allShots, clipEventFrames, closeStats, P } from "./plan";
import { section, SECTIONS, TOTAL } from "./timeline";

export type XCue = { frame: number; sfx: SfxName; gain: number; label: string };

export function xcues(): XCue[] {
  const out: XCue[] = [];
  const add = (id: (typeof SECTIONS)[number]["id"], rel: number, sfx: SfxName, gain: number, label: string) => out.push({ frame: section(id).from + Math.round(rel), sfx, gain, label });
  add("intro", P.intro.dive - 2, "dive", 0.45, "dive into the page");
  // Title cards: a whoosh as the number flies in, a soft pop as it docks.
  for (const s of SECTIONS.slice(1)) {
    out.push({ frame: s.from + 1, sfx: "whoosh", gain: 0.26, label: `title ${s.id}` });
    out.push({ frame: s.from + 30, sfx: "pop", gain: 0.12, label: `title docks ${s.id}` });
  }
  for (const shot of allShots()) {
    add(shot.section, shot.from, "whoosh", 0.14, `cut to ${shot.clipId}`);
    for (const f of clipEventFrames(shot, "click")) add(shot.section, f, "click", 0.42, `click in ${shot.clipId}`);
    for (const f of clipEventFrames(shot, "hover")) add(shot.section, f, "tick", 0.1, `hover in ${shot.clipId}`);
    for (const f of clipEventFrames(shot, "callout")) add(shot.section, f, "move", 0.18, `callout in ${shot.clipId}`);
  }
  add("problem", P.problem.disagree, "blip", 0.2, "docs ≠ API");
  add("notary", P.notary.read - 8, "whoosh", 0.2, "step bar docks");
  add("notary", P.notary.certificate, "stamp", 0.36, "certificate");
  add("notary", P.notary.moves, "blip", 0.22, "guard: no certificate");
  add("notary", P.notary.guard + 4, "pop", 0.2, "held");
  add("notary", P.notary.person, "confirm", 0.18, "a person reviews");
  for (const at of [P.stack.crust, P.stack.models, P.stack.aws]) add("stack", at - 6, "whoosh", 0.18, "stack phase");
  add("stack", P.stack.four + 4, "pop", 0.16, "dodo certificates");
  add("neatlogs", P.neatlogs.prediction, "tick", 0.28, "prediction logged");
  add("neatlogs", P.neatlogs.abstained, "pop", 0.2, "abstained");
  add("entire", P.entire.zero, "stamp", 0.36, "0 unguarded");
  add("entire", P.entire.zero + 4, "chime", 0.3, "0 unguarded");
  add("cfo", P.cfo.exports - 4, "whoosh", 0.2, "export card");
  // Count-ups: a tick per step of each number, then a pop as it lands.
  for (const st of closeStats()) {
    const steps = st.decimals ? 6 : Math.max(1, st.value);
    for (let k = 0; k < steps; k++) add("close", st.at - 2 + Math.round(20 * (1 - (1 - (k + 1) / steps) ** (1 / 3))), "tick", 0.14, `count ${st.key}`);
    add("close", st.at + 18, "pop", 0.2, `lands ${st.key}`);
  }
  add("close", P.close.sky, "dive", 0.4, "rise to the sky");
  add("close", P.close.moves + 10, "chime", 0.34, "final chime");
  const sorted = out.filter((c) => c.frame >= 0 && c.frame < TOTAL).sort((a, b) => a.frame - b.frame || b.gain - a.gain);
  // One whoosh per transition: drop a whoosh within 12 frames of an earlier one.
  return sorted.filter((c, i) => c.sfx !== "whoosh" || !sorted.slice(0, i).some((d) => d.sfx === "whoosh" && c.frame - d.frame < 12));
}

/** Speech envelope per frame (0 silent … 1 speaking), fast attack, slow release. */
export function speechEnvelope(): Float32Array {
  const on = new Float32Array(TOTAL);
  for (const s of SECTIONS) for (const w of s.words) for (let f = s.from + w.from - 3; f <= s.from + w.to + 4; f++) if (f >= 0 && f < TOTAL) on[f] = 1;
  const env = new Float32Array(TOTAL);
  let v = 0;
  for (let f = 0; f < TOTAL; f++) {
    // Look ahead 4 frames so the bed is already down when a word starts.
    const target = Math.max(on[f]!, on[Math.min(TOTAL - 1, f + 4)]!);
    v = target > v ? Math.min(target, v + 0.3) : Math.max(target, v - 0.045);
    env[f] = v;
  }
  return env;
}

/** Music gain at a frame: −12 dB under speech, full in the gaps (the bed itself swells in intro/close). */
export const DUCK_DB = -12;
export function musicGainAt(env: Float32Array, frame: number): number {
  const e = env[Math.max(0, Math.min(env.length - 1, frame))]!;
  return 10 ** ((DUCK_DB * e) / 20);
}
