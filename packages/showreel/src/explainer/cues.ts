// The Explainer's sound cue sheet (absolute frame → effect) and the music's ducking curve. Pure:
// used by the composition (Sound.tsx) and by scripts/explainer-audio.ts, which renders the music bed
// and checks the full mix offline with the same numbers.
import type { SfxName } from "../v2/cues";
import { allShots, clipClickFrames, P } from "./plan";
import { section, SECTIONS, TOTAL } from "./timeline";

export type XCue = { frame: number; sfx: SfxName; gain: number; label: string };

export function xcues(): XCue[] {
  const out: XCue[] = [];
  const add = (id: (typeof SECTIONS)[number]["id"], rel: number, sfx: SfxName, gain: number, label: string) => out.push({ frame: section(id).from + Math.round(rel), sfx, gain, label });
  add("intro", P.intro.dive - 2, "dive", 0.45, "dive into the page");
  for (const s of SECTIONS.slice(2)) out.push({ frame: s.from - 4, sfx: "whoosh", gain: 0.28, label: `to ${s.id}` });
  for (const shot of allShots()) {
    for (const f of clipClickFrames(shot)) add(shot.section, f, "click", 0.45, `click in ${shot.clipId}`);
    add(shot.section, shot.from, "whoosh", 0.18, `cut to ${shot.clipId}`);
  }
  add("problem", P.problem.disagree, "blip", 0.22, "docs ≠ live");
  add("notary", P.notary.read - 8, "whoosh", 0.22, "step bar docks");
  add("notary", P.notary.certificate, "stamp", 0.4, "certificate");
  add("neatlogs", P.neatlogs.prediction, "tick", 0.3, "prediction logged");
  add("neatlogs", P.neatlogs.abstained, "pop", 0.22, "abstained");
  add("entire", P.entire.zero, "stamp", 0.38, "0 unguarded");
  add("entire", P.entire.zero + 4, "chime", 0.32, "0 unguarded");
  add("cfo", P.cfo.exports - 4, "whoosh", 0.22, "export card");
  add("close", P.close.zero, "chime", 0.34, "zero unsafe");
  add("close", P.close.sky, "dive", 0.4, "rise to the sky");
  // One whoosh per transition: drop a whoosh within 12 frames of an earlier one.
  const sorted = out.filter((c) => c.frame >= 0 && c.frame < TOTAL).sort((a, b) => a.frame - b.frame || b.gain - a.gain);
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
