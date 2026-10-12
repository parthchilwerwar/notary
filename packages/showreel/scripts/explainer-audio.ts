// The Explainer's sound, rendered from code like the showreel's (scripts/audio.ts primitives, no
// samples): a calm ~3.5-minute music bed in D major that swells in the open and the close, the UI
// effects, and each delivered voice line decoded (Remotion's ffmpeg) and leveled. The full mix is then
// built offline exactly as Sound.tsx places it — voice, music ducked −12 dB under speech, every cue —
// and leveled to ≈ −14 LUFS integrated with peaks under −1 dBFS; the gains go to src/explainer/mix.json.
//
//   pnpm --filter @notary/showreel explainer:audio
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adsr, lufs, midi, mixInto, peakDb, pluck, readWav, reverb, rng, SR, sfx, stereo, wav, type Stereo } from "./audio";
import { remotionBinary } from "./lib";
import { musicGainAt, speechEnvelope, xcues } from "../src/explainer/cues";
import { P } from "../src/explainer/plan";
import { FPS, section, SECTIONS, TOTAL } from "../src/explainer/timeline";
import type { SfxName } from "../src/v2/cues";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const PUB = join(ROOT, "public");
const OUT_AUDIO = join(PUB, "explainer/audio");
const OUT_VOICE = join(PUB, "explainer/voice");
const MIX_JSON = join(ROOT, "src/explainer/mix.json");
const TMP = join(ROOT, "out/explainer-audio");

const N = Math.ceil((TOTAL / FPS) * SR);
const sec = (frame: number) => frame / FPS;

function limit(s: Stereo, ceilingDb: number) {
  const c = 10 ** (ceilingDb / 20);
  for (let i = 0; i < s.l.length; i++) {
    s.l[i] = c * Math.tanh(s.l[i]! / c);
    s.r[i] = c * Math.tanh(s.r[i]! / c);
  }
  return s;
}
const scale = (s: Stereo, g: number) => {
  for (let i = 0; i < s.l.length; i++) {
    s.l[i]! *= g;
    s.r[i]! *= g;
  }
  return s;
};
const copy = (s: Stereo): Stereo => ({ l: Float32Array.from(s.l), r: Float32Array.from(s.r) });

// ------------------------------------------------------------------------------- voice

function decode(src: string): Stereo {
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `${src.split("/").pop()}.wav`);
  execFileSync(remotionBinary("ffmpeg"), ["-v", "error", "-y", "-i", join(PUB, src), "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", out]);
  return readWav(readFileSync(out));
}

// ------------------------------------------------------------------------------- music

// 72 BPM, one chord per two bars, D major. Voicings as in the showreel bed, an octave of air on top.
const BPM = 72;
const BEAT = 60 / BPM;
const PROG = [
  [50, 57, 61, 64, 66], // Dmaj9
  [47, 54, 57, 62, 66], // Bm9
  [43, 50, 54, 59, 62], // Gmaj7
  [45, 52, 57, 59, 64], // Asus2
  [40, 47, 54, 55, 62], // Em9
  [43, 50, 54, 59, 64], // Gmaj9
  [47, 54, 57, 61, 64], // Bm11
  [45, 52, 57, 62, 64], // Asus4
];
const FINAL = [50, 57, 61, 64, 69]; // Dmaj9

/** 0…1 energy over the film: full in the open and the close, a quiet bed under the talk. */
function energyAt(t: number): number {
  const introEnd = sec(section("intro").dur);
  const closeSky = sec(section("close").from + P.close.sky);
  if (t < introEnd) return 1;
  if (t < introEnd + 2) return 1 - 0.5 * ((t - introEnd) / 2);
  if (t >= closeSky) return 1;
  if (t >= closeSky - 3) return 0.5 + 0.5 * ((t - (closeSky - 3)) / 3);
  return 0.5;
}

function music(): Stereo {
  const dry = stereo(N);
  const r = rng(23);
  const total = N / SR;
  const closeSky = sec(section("close").from + P.close.sky);
  const chordLen = BEAT * 8;
  // Chords up to the close, then the final Dmaj9 from the closing line to the end.
  const chords: { start: number; dur: number; notes: number[]; final: boolean }[] = [];
  for (let t = 0, i = 0; t < closeSky; t += chordLen, i++) chords.push({ start: t, dur: Math.min(chordLen, closeSky - t), notes: PROG[i % PROG.length]!, final: false });
  chords.push({ start: closeSky, dur: total - closeSky, notes: FINAL, final: true });

  for (const c of chords) {
    for (const [vi, note] of c.notes.entries()) {
      for (const det of [-0.1, 0.08]) {
        const f = midi(note + 12) * 2 ** (det / 12);
        let ph = r();
        const pan = 0.5 + (vi - 2) * 0.12 + det;
        const s0 = Math.floor(c.start * SR);
        const len = Math.floor((c.dur + 2) * SR);
        for (let i = 0; i < len && s0 + i < N; i++) {
          const t = i / SR;
          const env = adsr(t, c.dur, c.final ? 0.4 : 1.6, 1.2, 0.8, 2);
          ph += f / SR;
          ph -= Math.floor(ph);
          const tri = 1 - 4 * Math.abs(ph - 0.5);
          const saw = 2 * ph - 1;
          const v = (tri * 0.75 + saw * 0.25) * env * 0.045;
          dry.l[s0 + i]! += v * (1 - pan);
          dry.r[s0 + i]! += v * pan;
        }
      }
    }
    // Sub bass: the root, soft.
    const s0 = Math.floor(c.start * SR);
    const len = Math.floor((c.dur + 1.5) * SR);
    let ph = 0;
    for (let i = 0; i < len && s0 + i < N; i++) {
      ph += midi(c.notes[0]! - 12) / SR;
      const v = Math.sin(2 * Math.PI * ph) * adsr(i / SR, c.dur, 0.8, 1, 0.7, 1.5) * 0.09;
      dry.l[s0 + i]! += v;
      dry.r[s0 + i]! += v;
    }
  }
  // Brightness follows the energy (one-pole low-pass, cutoff 700 Hz … 2.6 kHz).
  for (const ch of [dry.l, dry.r]) {
    let y = 0;
    for (let i = 0; i < N; i++) {
      const cutoff = 700 + 1900 * energyAt(i / SR);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
      y += a * (ch[i]! - y);
      ch[i] = y;
    }
  }
  // Plucked arpeggio, eighth notes, only where there is energy to spare (sparser under the talk).
  const pattern = [1, 2, 3, 4, 3, 2, 1, 2];
  let k = 0;
  for (let t = 0; t < total - 1; t += BEAT / 2, k++) {
    const e = energyAt(t);
    const onBeat = Math.abs(t / BEAT - Math.round(t / BEAT)) < 1e-6;
    if (e < 0.6 && !onBeat) continue;
    if (e < 0.6 && k % 4 !== 0) continue;
    const c = [...chords].reverse().find((x) => t >= x.start)!;
    const note = c.notes[pattern[k % pattern.length]!]! + 12;
    const s = pluck(midi(note), 1.4, 300 + k, 0.4);
    const vel = (onBeat ? 0.85 : 0.6) * (0.35 + 0.65 * e);
    const pan = 0.5 + Math.sin(k * 1.3) * 0.28;
    const at = Math.floor(t * SR);
    for (let i = 0; i < s.length && at + i < N; i++) {
      dry.l[at + i]! += s[i]! * vel * 0.12 * (1 - pan);
      dry.r[at + i]! += s[i]! * vel * 0.12 * pan;
    }
  }
  // The final chord plucked up the voicing on the closing line.
  FINAL.forEach((note, i) => {
    const s = pluck(midi(note + 12), 2.2, 900 + i, 0.4);
    const at = Math.floor((closeSky + 0.35 + i * 0.06) * SR);
    for (let j = 0; j < s.length && at + j < N; j++) {
      dry.l[at + j]! += s[j]! * 0.13 * (0.4 + i * 0.12);
      dry.r[at + j]! += s[j]! * 0.13 * (1 - i * 0.12);
    }
  });
  const wet = reverb(dry, 1.3, 0.45);
  const out = stereo(N);
  mixInto(out, dry, 0.8);
  mixInto(out, wet, 0.38);
  // Level follows the energy too; fade in over 0.8 s, fade out over the last 2.5 s.
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const g = (0.55 + 0.45 * energyAt(t)) * Math.min(1, t / 0.8) * Math.min(1, Math.max(0, (total - t) / 2.5)) ** 1.4;
    out.l[i]! *= g;
    out.r[i]! *= g;
  }
  return out;
}

// ------------------------------------------------------------------------------- main

const TARGET = -14;
const CEILING = -1.2;

export async function generateExplainerAudio() {
  mkdirSync(OUT_AUDIO, { recursive: true });
  mkdirSync(OUT_VOICE, { recursive: true });
  const env = speechEnvelope();
  const cues = xcues();

  // Voice lines at their places.
  const voices = SECTIONS.filter((s) => s.voiceSrc).map((s) => ({ id: s.id, at: Math.round(sec(s.from + s.voiceAt) * SR), s: decode(s.voiceSrc!) }));
  const voiceTrack = stereo(N);
  for (const v of voices) mixInto(voiceTrack, v.s, 1, v.at);
  const vL = lufs(voiceTrack);

  // Music and effects, normalized on their own first.
  const m = music();
  const mL = lufs(m);
  const names = [...new Set(cues.map((c) => c.sfx))] as SfxName[];
  const fx = new Map<SfxName, Stereo>();
  for (const n of names) {
    const s = sfx(n);
    const padded = { l: new Float32Array(Math.max(s.l.length, 0.4 * SR)), r: new Float32Array(Math.max(s.r.length, 0.4 * SR)) };
    padded.l.set(s.l);
    padded.r.set(s.r);
    scale(s, 10 ** ((-16 - lufs(padded)) / 20));
    fx.set(n, limit(s, -1));
  }

  // Voice at −15 LUFS, the bed (unducked) at −21, effects at −16 × their cue gains: then the whole
  // mix is scaled to the target and checked.
  let gV = 10 ** ((-15 - vL) / 20);
  let gM = 10 ** ((-21 - mL) / 20);
  let gS = 0.5;
  const build = () => {
    const mix = stereo(N);
    const vt = limit(scale(copy(voiceTrack), gV), CEILING - 0.3);
    mixInto(mix, vt);
    for (let i = 0; i < N; i++) {
      const g = gM * musicGainAt(env, Math.floor((i / SR) * FPS));
      mix.l[i]! += m.l[i]! * g;
      mix.r[i]! += m.r[i]! * g;
    }
    for (const c of cues) mixInto(mix, fx.get(c.sfx)!, Math.min(1, c.gain * gS), Math.round(sec(c.frame) * SR));
    return mix;
  };
  let mix = build();
  for (let pass = 0; pass < 3; pass++) {
    const k = 10 ** ((TARGET - lufs(mix)) / 20);
    gV *= k;
    gM *= k;
    gS = Math.min(1, gS * k);
    mix = build();
    if (peakDb(mix) > CEILING) {
      // Pull everything down just enough for the peak (loudness then lands slightly under target).
      const d = 10 ** ((CEILING - peakDb(mix)) / 20);
      gV *= d;
      gM *= d;
      gS *= d;
      mix = build();
    }
    if (Math.abs(lufs(mix) - TARGET) < 0.3 && peakDb(mix) <= CEILING) break;
  }

  // Write: voices with their gain baked in (and limited), the music with its gain baked in.
  const voiceFiles: Record<string, string> = {};
  for (const v of voices) {
    const out = limit(scale(copy(v.s), gV), CEILING - 0.3);
    writeFileSync(join(OUT_VOICE, `${v.id}.wav`), wav(out));
    voiceFiles[v.id] = `explainer/voice/${v.id}.wav`;
  }
  const musicOut = scale(copy(m), gM);
  if (peakDb(musicOut) > -0.1) throw new Error("music bed would clip: lower the bed level");
  writeFileSync(join(OUT_AUDIO, "music.wav"), wav(musicOut));
  for (const [n, s] of fx) writeFileSync(join(OUT_AUDIO, `${n}.wav`), wav(s));
  writeFileSync(join(ROOT, "out/explainer-mix.wav"), wav(mix));

  const report = {
    totalSec: +(N / SR).toFixed(2),
    mixLufs: +lufs(mix).toFixed(1),
    mixPeakDb: +peakDb(mix).toFixed(1),
    voiceLufs: +lufs(limit(scale(copy(voiceTrack), gV), CEILING - 0.3)).toFixed(1),
    musicLufsUnducked: +lufs(musicOut).toFixed(1),
    duckDb: -12,
    cues: cues.length,
  };
  const mixJson = { ready: true, voice: voiceFiles, music: "explainer/audio/music.wav", musicGain: 1, sfxGain: +gS.toFixed(4), report };
  writeFileSync(MIX_JSON, `${JSON.stringify(mixJson, null, 1)}\n`);
  console.log(`voice lines: ${voices.map((v) => v.id).join(", ")}`);
  console.log(`mix: ${report.mixLufs} LUFS integrated, peak ${report.mixPeakDb} dBFS (voice ${report.voiceLufs} LUFS, bed unducked ${report.musicLufsUnducked} LUFS, ${cues.length} cues)`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateExplainerAudio();
